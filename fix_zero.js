import { initDB, default as db } from './db.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(DIR, 'data', 'fix_zero_state.txt');
const DEX_API = 'https://api.mangadex.org';
const HEADERS = { 'User-Agent': 'Xingmanwu/1.0 (fix-zero)' };

await initDB();

let processed = 0, fixed = 0;
try {
  const parts = fs.readFileSync(STATE_FILE, 'utf8').trim().split(',');
  processed = parseInt(parts[0]) || 0;
  fixed = parseInt(parts[1]) || 0;
} catch(e) {}

// Get zero-chapter manga with dex_id
const all = db.all(`
  SELECT d.manga_id, d.dex_id, d.dex_title, m.title_romaji, m.title_english, m.title_native
  FROM dex_mapping d JOIN manga m ON m.id = d.manga_id
  WHERE d.total_chapters = 0 AND d.dex_id IS NOT NULL
  ORDER BY m.popularity DESC
`);
const total = all.length;
const remaining = all.slice(processed);
console.log(`${total} zero-chapter entries | ${processed} done | ${fixed} fixed so far`);

let doneThisRun = 0;
const start = Date.now();
const PER_BATCH = 20;
const MAX_BATCHES = 100; // 2000 per run
const DELAY = 400;

async function tryFix(entry) {
  const titles = [entry.title_romaji, entry.title_english, entry.title_native, entry.dex_title].filter(Boolean);
  const simple = titles.map(t => t.split(/[:―–—]/)[0]?.trim()).filter(t => t && t.length > 3);
  const terms = [...new Set([...titles, ...simple].filter(Boolean))].slice(0, 5);
  
  for (const title of terms) {
    if (title.length < 2) continue;
    try {
      const r = await fetch(
        `${DEX_API}/manga?title=${encodeURIComponent(title)}&limit=20&order[relevance]=desc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`,
        { headers: HEADERS, signal: AbortSignal.timeout(8000) }
      );
      if (!r.ok) continue;
      const d = await r.json();
      if (!d.data?.length) continue;
      
      for (const c of d.data) {
        if (c.id === entry.dex_id) continue;
        try {
          const feedR = await fetch(`${DEX_API}/manga/${c.id}/feed?limit=0`, {
            headers: HEADERS, signal: AbortSignal.timeout(5000)
          });
          if (feedR.ok) {
            const fd = await feedR.json();
            if (fd.total > 0) {
              const t = c.attributes.title;
              const displayTitle = t?.en || t?.ja || '';
              // Auto-update the mapping
              db.run('UPDATE dex_mapping SET dex_id=?,dex_title=?,total_chapters=?,readable_chapters=0,last_checked=? WHERE manga_id=?',
                [c.id, displayTitle, fd.total, new Date().toISOString(), entry.manga_id]);
              console.log(`  ✅ ${entry.title_romaji||entry.dex_title} → ${displayTitle} (${fd.total} ch)`);
              return true;
            }
          }
        } catch {}
      }
    } catch(e) { continue; }
  }
  // Mark as checked so we don't keep retrying
  try {
    db.run('UPDATE dex_mapping SET last_checked=? WHERE manga_id=?', [new Date().toISOString(), entry.manga_id]);
  } catch {}
  return false;
}

for (const entry of remaining) {
  if (doneThisRun >= PER_BATCH * MAX_BATCHES) break;
  
  const ok = await tryFix(entry);
  if (ok) fixed++;
  processed++;
  doneThisRun++;
  
  if (doneThisRun % PER_BATCH === 0) {
    db.save();
    fs.writeFileSync(STATE_FILE, `${processed},${fixed}`);
    const elapsed = ((Date.now() - start)/1000).toFixed(0);
    console.log(`${doneThisRun} done | fixed=${fixed} | ${elapsed}s | rate=${(fixed/Math.max(1,processed)*100).toFixed(0)}%`);
  }
  
  await new Promise(r => setTimeout(r, DELAY));
}

db.save();
fs.writeFileSync(STATE_FILE, `${processed},${fixed}`);

const elapsed = ((Date.now() - start)/1000).toFixed(0);
console.log(`\nDone: ${doneThisRun} in ${elapsed}s`);

const stillZero = db.all('SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0 AND dex_id IS NOT NULL')[0].c;
const nowNonZero = db.all('SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0')[0].c;
console.log(`Still zero: ${stillZero} | Now non-zero: ${nowNonZero} | Total fixed this run: ${fixed}`);
