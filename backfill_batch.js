import { initDB, default as db } from './db.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DEX_DIR = dirname(fileURLToPath(import.meta.url));
const DEX_API = 'https://api.mangadex.org';
const DEX_HEADERS = { 'User-Agent': 'Xingmanwu/1.0' };
const STATE_PATH = join(DEX_DIR, 'data', 'backfill_state.txt');
const BATCH = 200;

await initDB();

let processed = 0, updated = 0, failed = 0, startId = 0;
try {
  const s = fs.readFileSync(STATE_PATH, 'utf8').trim();
  const p = s.split(',');
  processed = parseInt(p[0]) || 0;
  updated = parseInt(p[1]) || 0;
  startId = parseInt(p[2]) || 0;
} catch(e) {}

const all = db.all(
  'SELECT manga_id, dex_id FROM dex_mapping WHERE total_chapters = 0 AND dex_id IS NOT NULL ORDER BY manga_id'
);
console.log('Total:', all.length, '| Processed:', processed, '| Remaining:', all.length - processed);

const remaining = all.slice(processed);
let batchDone = 0, lastMangaId = 0;
const startTime = Date.now();

for (const entry of remaining) {
  if (batchDone >= BATCH) break;
  lastMangaId = entry.manga_id;
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(`${DEX_API}/manga/${entry.dex_id}/feed?limit=0`, {
      headers: DEX_HEADERS,
      signal: ac.signal
    });
    clearTimeout(tm);
    if (r.ok) {
      const d = await r.json();
      const total = d.total || 0;
      db.run('UPDATE dex_mapping SET total_chapters=?,last_checked=? WHERE manga_id=?',
        [total, new Date().toISOString(), entry.manga_id]);
      if (total > 0) updated++;
    } else {
      failed++;
    }
  } catch(e) {
    failed++;
  }
  batchDone++;
  processed++;
  await new Promise(r => setTimeout(r, 200));
}

db.save();
fs.writeFileSync(STATE_PATH, `${processed},${updated},${lastMangaId}`);

const secs = ((Date.now() - startTime) / 1000).toFixed(0);
console.log(`Batch: ${batchDone} items, ok=${updated} fail=${failed} in ${secs}s`);
console.log(`State: ${processed}/${all.length} done`);

const z = db.all('SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0')[0].c;
const nz = db.all('SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0')[0].c;
console.log(`DB: ${z} zero, ${nz} non-zero`);
