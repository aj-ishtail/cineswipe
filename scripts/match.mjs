// Prepares movies.json for the app. Runs on GitHub (see .github/workflows/match.yml)
// with the TMDB key from the TMDB_TOKEN secret.
//
//   watchlist.csv  -> films      every watchlist film, with poster, director, cast and so on
//   ratings.csv    -> wild       "wildcards": films similar to the ones rated 4 stars or higher
//                  -> hints      a line on watchlist cards, e.g. "From the director of ..."
//   watched.csv    -> keeps films that were already watched out of the wildcards
//
// Anything already looked up is reused, so weekly runs only fetch what is new.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';

const TOKEN = (process.env.TMDB_TOKEN || '').trim();
if (!TOKEN) { console.error('TMDB_TOKEN secret is missing. Add it in Settings > Secrets and variables > Actions.'); process.exit(1); }

const SEED_MIN_RATING = 4;   // films rated this or higher are used to find similar films
const MAX_SEEDS = 400;
const WILD_POOL = 80;        // how many wildcards to keep ready for the app
const MIN_VOTES = 50;        // skip very obscure TMDB entries with too little data
const SEED_CACHE = 'scripts/seed-cache.json';

const GENRES = {28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',10770:'TV Movie',53:'Thriller',10752:'War',37:'Western'};
const COUNTRY_SHORT = {'United States of America':'USA','United Kingdom':'UK','South Korea':'S. Korea','Korea':'S. Korea','Russian Federation':'Russia','Hong Kong SAR China':'Hong Kong','Czech Republic':'Czechia'};

/* ---------- reading the Letterboxd files ---------- */
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i+1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
const keyOf = i => String(i.name).toLowerCase() + '|' + (i.year || 0);
function readList(path) {
  const rows = parseCSV(readFileSync(path, 'utf8'));
  if (!rows.length) return [];
  const head = rows.shift().map(x => x.trim().toLowerCase());
  const ni = head.indexOf('name'), yi = head.indexOf('year'), ri = head.indexOf('rating'), di = head.indexOf('date');
  if (ni < 0) throw new Error(path + ' has no Name column');
  const seen = new Set();
  return rows.map(r => ({name: (r[ni] || '').trim(), year: parseInt(r[yi], 10) || 0, rating: parseFloat(r[ri]) || 0, date: r[di] || ''}))
    .filter(x => x.name && !seen.has(keyOf(x)) && seen.add(keyOf(x)));
}
// Loose title form for comparing TMDB titles with Letterboxd titles: lowercase, letters and digits only.
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

/* ---------- TMDB ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tmdb(path, params) {
  const url = new URL('https://api.themoviedb.org/3' + path);
  const headers = {accept: 'application/json'};
  if (TOKEN.startsWith('eyJ')) headers.Authorization = 'Bearer ' + TOKEN; else url.searchParams.set('api_key', TOKEN);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await fetch(url, {headers}); }
    catch (e) { if (attempt < 4) { await sleep(800 * (attempt + 1)); continue; } throw e; }
    if (r.status === 401) throw new Error('auth');
    if ((r.status === 429 || r.status >= 500) && attempt < 4) { await sleep((parseFloat(r.headers.get('Retry-After')) || attempt + 1) * 1000); continue; }
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
}
async function findHit(item) {
  const base = {query: item.name, include_adult: 'false', language: 'en-US'};
  let results = (await tmdb('/search/movie', item.year ? {...base, year: item.year} : base)).results || [];
  if (!results.length && item.year) {
    const r = (await tmdb('/search/movie', base)).results || [];
    results = r.filter(x => Math.abs((parseInt((x.release_date || '').slice(0, 4), 10) || 0) - item.year) <= 1);
  }
  if (!results.length) return null;
  const want = item.name.toLowerCase();
  return results.find(x => [x.title, x.original_title].some(t => t && t.toLowerCase() === want)) || results[0];
}
const directorsOf = d => [...new Set(((d.credits && d.credits.crew) || []).filter(c => c.job === 'Director').map(c => c.name))];
const castOf = (d, n) => ((d.credits && d.credits.cast) || []).slice(0, n).map(c => c.name);
function filmFrom(d, key, fallback) {
  const vids = ((d.videos && d.videos.results) || []).filter(v => v.site === 'YouTube');
  const pick = vids.find(v => v.type === 'Trailer' && v.official) || vids.find(v => v.type === 'Trailer') || vids.find(v => v.type === 'Teaser');
  return {
    key, id: d.id, title: d.title || fallback.name,
    year: (d.release_date || '').slice(0, 4) || String(fallback.year || ''),
    poster: d.poster_path || '', overview: d.overview || '',
    g: (d.genres || []).map(g => g.id),
    runtime: d.runtime || 0,
    genres: (d.genres || []).map(g => GENRES[g.id] || g.name),
    directors: directorsOf(d).slice(0, 2),
    cast: castOf(d, 3),
    countries: (d.production_countries || []).map(c => COUNTRY_SHORT[c.name] || c.name).slice(0, 2),
    trailer: pick ? 'https://www.youtube.com/watch?v=' + pick.key : ''
  };
}
const DETAIL = {language: 'en-US', append_to_response: 'videos,credits', include_video_language: 'en,null'};
async function lookupFilm(item) {
  const hit = await findHit(item);
  if (!hit) return null;
  return filmFrom(await tmdb('/movie/' + hit.id, DETAIL), keyOf(item), item);
}
// For a highly rated film: who made it, who is in it, and what TMDB recommends next to it.
async function lookupSeed(item) {
  const hit = await findHit(item);
  if (!hit) return null;
  const d = await tmdb('/movie/' + hit.id, {language: 'en-US', append_to_response: 'credits,recommendations'});
  return {
    id: d.id, title: d.title || item.name, directors: directorsOf(d).slice(0, 2), cast: castOf(d, 5),
    recs: ((d.recommendations && d.recommendations.results) || []).filter(r => !r.adult).map(r => ({
      id: r.id, title: r.title || '', ot: r.original_title || '', year: parseInt((r.release_date || '').slice(0, 4), 10) || 0, votes: r.vote_count || 0
    }))
  };
}
// Runs fn over items, 5 at a time. Returns the items whose lookup failed; stops everything if the key is rejected.
async function runPool(items, fn) {
  const failed = []; let i = 0, authFail = false;
  await Promise.all(Array.from({length: 5}, async () => {
    while (i < items.length && !authFail) {
      const item = items[i++];
      try { await fn(item); } catch (e) { if (e.message === 'auth') authFail = true; else failed.push(item); }
    }
  }));
  if (authFail) { console.error('TMDB rejected the key. Check the TMDB_TOKEN secret.'); process.exit(1); }
  return failed;
}

/* ---------- step 1: the watchlist ---------- */
async function matchWatchlist(list, old) {
  const known = new Map((old.films || []).map(f => [f.key, f]));
  const todo = list.filter(i => !known.has(keyOf(i)));
  console.log(`Watchlist: ${list.length} films, ${list.length - todo.length} already matched, ${todo.length} to look up`);
  const found = new Map();
  const failed = await runPool(todo, async item => { found.set(keyOf(item), await lookupFilm(item)); });
  const films = [], unmatched = [], ids = new Set();
  for (const item of list) {           // keep watchlist order; films removed from the list drop out
    const k = keyOf(item), f = known.get(k) || found.get(k);
    if (f) { if (!ids.has(f.id)) { ids.add(f.id); films.push(f); } }
    else if (found.has(k)) unmatched.push({name: item.name, year: item.year});   // looked up, TMDB had nothing
  }
  console.log(`Watchlist: ${films.length} matched, ${unmatched.length} not on TMDB, ${failed.length} lookups failed (retried next run)`);
  return {films, unmatched};
}

/* ---------- step 2: taste, from ratings.csv ---------- */
async function loadSeeds(ratings) {
  const top = ratings.filter(r => r.rating >= SEED_MIN_RATING)
    .sort((a, b) => b.rating - a.rating || (a.date < b.date ? 1 : -1)).slice(0, MAX_SEEDS);
  const cache = existsSync(SEED_CACHE) ? JSON.parse(readFileSync(SEED_CACHE, 'utf8')) : {};
  const todo = top.filter(r => !(keyOf(r) in cache));
  console.log(`Ratings: ${ratings.length} rated, ${top.length} rated ${SEED_MIN_RATING}+ stars, ${todo.length} to look up`);
  const failed = await runPool(todo, async item => { cache[keyOf(item)] = await lookupSeed(item); });
  if (failed.length) console.log(`Ratings: ${failed.length} lookups failed (retried next run)`);
  writeFileSync(SEED_CACHE, JSON.stringify(cache));
  return top.map(r => ({rating: r.rating, name: r.name, seed: cache[keyOf(r)]})).filter(s => s.seed);
}

// "From the director of X" / "With Y, from X" lines for watchlist cards.
function addHints(films, seeds) {
  const byDirector = new Map(), byActor = new Map();
  for (const s of seeds) {             // seeds are sorted best-rated first, so the first entry per person is the best one
    for (const p of s.seed.directors) if (!byDirector.has(p)) byDirector.set(p, s);
    for (const p of s.seed.cast) { if (!byActor.has(p)) byActor.set(p, []); byActor.get(p).push(s); }
  }
  let n = 0;
  for (const f of films) {
    delete f.hint;
    const dir = (f.directors || []).find(p => byDirector.has(p));
    if (dir) { const s = byDirector.get(dir); f.hint = {k: 'dir', p: dir, t: s.seed.title, r: s.rating}; n++; continue; }
    const actor = (f.cast || []).filter(p => byActor.has(p)).sort((a, b) => byActor.get(b).length - byActor.get(a).length)[0];
    if (actor) { const list = byActor.get(actor); f.hint = {k: 'cast', p: actor, t: list[0].seed.title, r: list[0].rating, n: list.length}; n++; }
  }
  console.log(`Hints: ${n} of ${films.length} watchlist films share a director or actor with a highly rated film`);
}

async function buildWildcards(seeds, films, lists, old) {
  // Everything that must not come back as a suggestion: watched, rated, or already on the watchlist.
  const seen = new Set(), seenIds = new Set([...films.map(f => f.id), ...seeds.map(s => s.seed.id)]);
  for (const item of lists.flat()) seen.add(norm(item.name) + '|' + item.year);
  const isSeen = r => seenIds.has(r.id) || [r.title, r.ot].some(t => t && [r.year - 1, r.year, r.year + 1].some(y => seen.has(norm(t) + '|' + y)));

  // Score every recommended film: better-rated seeds count more, and so do films recommended by several seeds.
  const scores = new Map();
  for (const s of seeds) {
    const weight = s.rating - 3;       // 4 stars -> 1, 4.5 -> 1.5, 5 -> 2
    s.seed.recs.forEach((r, idx) => {
      if (!r.year || r.votes < MIN_VOTES || isSeen(r)) return;
      const e = scores.get(r.id) || {rec: r, score: 0, from: []};
      e.score += weight * (1 - idx / 40);
      e.from.push({t: s.seed.title, r: s.rating});
      scores.set(r.id, e);
    });
  }
  const top = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, WILD_POOL);
  const known = new Map((old.wild || []).map(f => [f.id, f]));
  const todo = top.filter(e => !known.has(e.rec.id));
  console.log(`Wildcards: ${scores.size} candidates, keeping the best ${top.length}, ${todo.length} to look up`);
  const failed = await runPool(todo, async e => {
    known.set(e.rec.id, filmFrom(await tmdb('/movie/' + e.rec.id, DETAIL), 'wild|' + e.rec.id, {name: e.rec.title, year: e.rec.year}));
  });
  if (failed.length) console.log(`Wildcards: ${failed.length} lookups failed (retried next run)`);
  const wild = [];
  for (const e of top) {
    const f = known.get(e.rec.id);
    if (!f || !f.poster) continue;
    wild.push({...f, because: e.from.sort((a, b) => b.r - a.r).slice(0, 2)});
  }
  return wild;
}

async function main() {
  const old = existsSync('movies.json') ? JSON.parse(readFileSync('movies.json', 'utf8')) : {};
  const list = readList('watchlist.csv');
  const {films, unmatched} = await matchWatchlist(list, old);

  let wild = [];
  if (existsSync('ratings.csv')) {
    const ratings = readList('ratings.csv');
    const watched = existsSync('watched.csv') ? readList('watched.csv') : [];
    if (!watched.length) console.log('No watched.csv found: only rated films are kept out of the wildcards.');
    const seeds = await loadSeeds(ratings);
    addHints(films, seeds);
    wild = await buildWildcards(seeds, films, [ratings, watched, list], old);
  } else {
    for (const f of films) delete f.hint;
    console.log('No ratings.csv found: skipping wildcards and hints.');
  }
  writeFileSync('movies.json', JSON.stringify({updated: new Date().toISOString(), films, unmatched, wild}));
  console.log(`Wrote movies.json: ${films.length} watchlist films, ${wild.length} wildcards`);
}
main();
