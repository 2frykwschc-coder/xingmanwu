import { initDB, default as db } from './db.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(DIR, 'data', 'rematch_state.txt');
const DEX_API = 'https://api.mangadex.org';
const HEADERS = { 'User-Agent': 'Xingmanwu/1.0 (rematch)' };

await initDB();

let processed = 0, matched = 0;
try {
  const parts = fs.readFileSync(STATE_FILE, 'utf8').trim().split(',');
  processed = parseInt(parts[0]) || 0;
  matched = parseInt(parts[1]) || 0;
} catch(e) {}

// Get manga without dex_id
const all = db.all(`
  SELECT m.id, m.title_romaji, m.title_english, m.title_native
  FROM manga m LEFT JOIN dex_mapping d ON m.id = d.manga_id
  WHERE d.manga_id IS NULL
  ORDER BY m.popularity DESC
`);
const total = all.length;
const remaining = all.slice(processed);
console.log(`${total} need matching | ${processed} done | ${matched} matched so far`);

let doneThisRun = 0;
const start = Date.now();
const BATCH = 200;
const MAX_BATCHES = 100; // 20000 per run
const DELAY = 300; // slightly faster

// Normalize: lowercase, replace common separators with space, collapse whitespace
function norm(s) {
  return s.toLowerCase().replace(/[―–—:;,.!?()\[\]{}~]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sharedWords(a, b) {
  const wa = norm(a).split(/\s+/).filter(w => w.length > 2);
  const wb = norm(b).split(/\s+/).filter(w => w.length > 2);
  return wa.filter(w => wb.includes(w));
}

function score(candidate, title) {
  const en = (candidate.attributes.title?.en || '').toLowerCase();
  const alt = (candidate.attributes.altTitles || []).flatMap(a => Object.values(a)).filter(Boolean).map(t => t.toLowerCase());
  const all = [en, ...alt];
  const tl = title.toLowerCase().trim();
  const ntl = norm(tl);
  if (!tl) return 0;
  // Exact matches (normalized)
  if (all.some(t => norm(t) === ntl)) return 100;
  if (norm(en) === ntl || alt.some(t => norm(t) === ntl)) return 90;
  // Prefix/starts-with (normalized)
  if (all.some(t => norm(t).startsWith(ntl) || ntl.startsWith(norm(t)))) return 70;
  // Word-level match: shared significant words
  const sw = sharedWords(en, tl);
  if (sw.length >= 2) return 60;
  if (sw.length === 1) return 40;
  // Fallback: en substring (only for short terms without spaces)
  if (!ntl.includes(' ') && en.includes(ntl)) return 30;
  return 0;
}

async function tryMatch(entry) {
  const titles = [entry.title_romaji, entry.title_english, entry.title_native].filter(Boolean);
  const simple = titles.map(t => t.split(/[:―–—]/)[0]?.trim()).filter(t => t && t.length > 3);
  const terms = [...new Set([...titles, ...simple].filter(Boolean))].slice(0, 3);
  
  let best = null, bestScore = 0;
  
  for (const term of terms) {
    if (term.length < 2) continue;
    try {
      const ac = new AbortController();
      const tid = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(`${DEX_API}/manga?title=${encodeURIComponent(term)}&limit=10&order[relevance]=desc`, {
        headers: HEADERS, signal: ac.signal
      });
      clearTimeout(tid);
      if (!r.ok) { await new Promise(r => setTimeout(r, 500)); continue; }
      const d = await r.json();
      if (!d.data?.length) continue;
      // Score each result against all search terms
      for (const c of d.data) {
        for (const t of terms) {
          const s = score(c, t);
          if (s > bestScore) { bestScore = s; best = c; }
        }
      }
      // If scoring found nothing but the first result shares at least 2
      // significant words with the search term, accept it (catches cases like
      // 'ib: Instant Bullet' → 'ib - instant bullet' while avoiding false
      // positives like "King's Maker" → "Bite Maker ~Ousama no Omega~")
      if (bestScore === 0 && d.data[0]) {
        for (const t of terms) {
          const sw = sharedWords(d.data[0].attributes.title?.en || '', t);
          if (sw.length >= 2) {
            best = d.data[0];
            bestScore = 25;
            break;
          }
        }
      }
      if (bestScore >= 90) break;
    } catch(e) { continue; }
  }
  
  if (best && bestScore >= 25) {
    const t = best.attributes.title;
    const finalTitle = t?.en || t?.ja || '';
    try {
      const feed = await fetch(`${DEX_API}/manga/${best.id}/feed?limit=0`, { headers: HEADERS });
      let totalCh = 0;
      if (feed.ok) { const fd = await feed.json(); totalCh = fd.total || 0; }
      db.run('INSERT INTO dex_mapping(manga_id, dex_id, dex_title, total_chapters, last_checked) VALUES(?,?,?,?,?)',
        [entry.id, best.id, finalTitle, totalCh, new Date().toISOString()]);
      return true;
    } catch(e) { return false; }
  }
  return false;
}

for (const entry of remaining) {
  if (doneThisRun >= BATCH * MAX_BATCHES) break;
  
  const ok = await tryMatch(entry);
  if (ok) matched++;
  processed++;
  doneThisRun++;
  
  // Batch save
  if (doneThisRun % 20 === 0) {
    db.save();
    fs.writeFileSync(STATE_FILE, `${processed},${matched}`);
    const elapsed = ((Date.now() - start)/1000).toFixed(0);
    const pct = (doneThisRun / Math.min(remaining.length, BATCH * MAX_BATCHES) * 100).toFixed(1);
    console.log(`${doneThisRun} done | matched=${matched} | ${elapsed}s | ${pct}%`);
  }
  
  await new Promise(r => setTimeout(r, DELAY));
}

db.save();
fs.writeFileSync(STATE_FILE, `${processed},${matched}`);

const elapsed = ((Date.now() - start)/1000).toFixed(0);
const rate = doneThisRun > 0 ? (doneThisRun/elapsed).toFixed(1) : 'N/A';
console.log(`\nDone: ${doneThisRun} in ${elapsed}s (${rate}/s) | matched ${matched}`);

const stillNeed = db.all('SELECT COUNT(*) as c FROM manga m LEFT JOIN dex_mapping d ON m.id=d.manga_id WHERE d.manga_id IS NULL')[0].c;
console.log(`Still unmatched: ${stillNeed}`);

// Run more if there's time
if (stillNeed > 0 && doneThisRun >= BATCH * MAX_BATCHES) {
  console.log('More work to do on next run');
}
