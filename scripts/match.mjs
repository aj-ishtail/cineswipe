// Looks up every film in watchlist.csv on TMDB and writes movies.json for the app.
// Runs on GitHub (see .github/workflows/match.yml) with the key from the TMDB_TOKEN secret.
// Films already in movies.json are reused, so weekly runs only look up new titles.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';

const TOKEN = (process.env.TMDB_TOKEN || '').trim();
if (!TOKEN) { console.error('TMDB_TOKEN secret is missing. Add it in Settings > Secrets and variables > Actions.'); process.exit(1); }

const GENRES = {28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',10770:'TV Movie',53:'Thriller',10752:'War',37:'Western'};
const COUNTRY_SHORT = {'United States of America':'USA','United Kingdom':'UK','South Korea':'S. Korea','Korea':'S. Korea','Russian Federation':'Russia','Hong Kong SAR China':'Hong Kong','Czech Republic':'Czechia'};

export function parseCSV(text) {
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
function readWatchlist(path) {
  const rows = parseCSV(readFileSync(path, 'utf8'));
  const head = rows.shift().map(x => x.trim().toLowerCase());
  const ni = head.indexOf('name'), yi = head.indexOf('year');
  if (ni < 0) throw new Error('watchlist.csv has no Name column');
  const seen = new Set();
  return rows.map(r => ({name: (r[ni] || '').trim(), year: parseInt(r[yi], 10) || 0}))
    .filter(x => x.name && !seen.has(keyOf(x)) && seen.add(keyOf(x)));
}

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
async function lookup(item) {
  const base = {query: item.name, include_adult: 'false', language: 'en-US'};
  let results = (await tmdb('/search/movie', item.year ? {...base, year: item.year} : base)).results || [];
  if (!results.length && item.year) {
    const r = (await tmdb('/search/movie', base)).results || [];
    results = r.filter(x => Math.abs((parseInt((x.release_date || '').slice(0, 4), 10) || 0) - item.year) <= 1);
  }
  if (!results.length) return null;
  const want = item.name.toLowerCase();
  const hit = results.find(x => [x.title, x.original_title].some(t => t && t.toLowerCase() === want)) || results[0];
  const d = await tmdb('/movie/' + hit.id, {language: 'en-US', append_to_response: 'videos,credits', include_video_language: 'en,null'});
  const vids = ((d.videos && d.videos.results) || []).filter(v => v.site === 'YouTube');
  const pick = vids.find(v => v.type === 'Trailer' && v.official) || vids.find(v => v.type === 'Trailer') || vids.find(v => v.type === 'Teaser');
  const crew = (d.credits && d.credits.crew) || [], cast = (d.credits && d.credits.cast) || [];
  return {
    key: keyOf(item), id: d.id, title: d.title || item.name,
    year: (d.release_date || '').slice(0, 4) || String(item.year || ''),
    poster: d.poster_path || '', overview: d.overview || '',
    g: (d.genres || []).map(g => g.id),
    runtime: d.runtime || 0,
    genres: (d.genres || []).map(g => GENRES[g.id] || g.name),
    directors: [...new Set(crew.filter(c => c.job === 'Director').map(c => c.name))].slice(0, 2),
    cast: cast.slice(0, 3).map(c => c.name),
    countries: (d.production_countries || []).map(c => COUNTRY_SHORT[c.name] || c.name).slice(0, 2),
    trailer: pick ? 'https://www.youtube.com/watch?v=' + pick.key : ''
  };
}

async function main() {
  const list = readWatchlist('watchlist.csv');
  const old = existsSync('movies.json') ? JSON.parse(readFileSync('movies.json', 'utf8')) : {films: []};
  const known = new Map(old.films.map(f => [f.key, f]));
  const films = [], unmatched = [], failed = [];
  const todo = list.filter(i => !known.has(keyOf(i)));
  console.log(`${list.length} films in watchlist, ${list.length - todo.length} already matched, ${todo.length} to look up`);

  const found = new Map();
  let i = 0, authFail = false;
  await Promise.all(Array.from({length: 5}, async () => {
    while (i < todo.length && !authFail) {
      const item = todo[i++];
      try { found.set(keyOf(item), await lookup(item)); }
      catch (e) { if (e.message === 'auth') authFail = true; else failed.push(item); }
    }
  }));
  if (authFail) { console.error('TMDB rejected the key. Check the TMDB_TOKEN secret.'); process.exit(1); }

  const ids = new Set();
  for (const item of list) {           // keep watchlist order; films removed from the list drop out
    const k = keyOf(item);
    const f = known.get(k) || found.get(k);
    if (f) { if (!ids.has(f.id)) { ids.add(f.id); films.push(f); } }
    else if (found.has(k)) unmatched.push(item);   // looked up, TMDB had nothing
  }
  writeFileSync('movies.json', JSON.stringify({updated: new Date().toISOString(), films, unmatched}));
  console.log(`Wrote movies.json: ${films.length} films, ${unmatched.length} not on TMDB, ${failed.length} lookups failed (retried next run)`);
  if (failed.length) console.log('Failed:', failed.map(f => f.name).join(', '));
}
main();
