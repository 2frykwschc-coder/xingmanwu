import { initDB, default as db } from './db.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(DIR, 'data', 'backfill_state.txt');
const DEX_API = 'https://api.mangadex.org';
const HEADERS = { 'User-Agent': 'Xingmanwu/1.0' };
const PER_BATCH = 200;
const MAX_BATCHES = 10;  // 2000 items per run
const DELAY_MS = 200;

await initDB();

let processed = 0, updated = 0;
try {
  const parts = fs.readFileSync(STATE_FILE, 'utf8').trim().split(',');
  processed = parseInt(parts[0]) || 0;
  updated = parseInt(parts[1]) || 0;
} catch(e) {}

const all = db.all(
  'SELECT manga_id, dex_id FROM dex_mapping WHERE total_chapters = 0 AND dex_id IS NOT NULL ORDER BY manga_id'
);
const total = all.length;
const remaining = all.slice(processed);
console.log(`${total} total | ${processed} done | ${remaining.length} remaining`);

let doneThisRun = 0;
const start = Date.now();

for (const entry of remaining) {
  if (doneThisRun >= PER_BATCH * MAX_BATCHES) break;
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 6000);
    const r = await fetch(`${DEX_API}/manga/${entry.dex_id}/feed?limit=0`, {
      headers: HEADERS, signal: ac.signal
    });
    if (r.ok) {
      const d = await r.json();
      const totalCh = d.total || 0;
      db.run('UPDATE dex_mapping SET total_chapters=?,last_checked=? WHERE manga_id=?',
        [totalCh, new Date().toISOString(), entry.manga_id]);
      if (totalCh > 0) updated++;
    }
  } catch(e) {}
  processed++;
  doneThisRun++;
  
  if (doneThisRun % PER_BATCH === 0) {
    db.save();
    fs.writeFileSync(STATE_FILE, `${processed},${updated}`);
    const elapsed = ((Date.now() - start)/1000).toFixed(0);
    console.log(`${doneThisRun}/${remaining.length} | ok=${updated} | ${elapsed}s | ${(processed/total*100).toFixed(1)}%`);
  }
  await new Promise(r => setTimeout(r, DELAY_MS));
}

// Final save
db.save();
fs.writeFileSync(STATE_FILE, `${processed},${updated}`);

const elapsed = ((Date.now() - start)/1000).toFixed(0);
console.log(`\nDone: ${doneThisRun} items in ${elapsed}s (${(doneThisRun/elapsed).toFixed(1)}/s)`);

const z = db.all('SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0')[0].c;
const nz = db.all('SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0')[0].c;
console.log(`DB: ${z} zero | ${nz} non-zero | ${(processed/total*100).toFixed(1)}% complete`);
