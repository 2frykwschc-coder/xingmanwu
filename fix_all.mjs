import { initDB, default as db } from "./db.js";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "data", "fix_count2.txt");

await initDB();

// Get ALL manga with dex_id that haven't been re-checked yet
const all = db.all(`
  SELECT d.manga_id as id, d.dex_id as dex, d.total_chapters as cur_ch
  FROM dex_mapping d
  WHERE d.dex_id IS NOT NULL
  ORDER BY d.total_chapters ASC, d.manga_id ASC
`);

let total = all.length;
let processed = 0, fixed = 0;

try {
  const parts = readFileSync(STATE, "utf8").trim().split(",");
  processed = parseInt(parts[0]) || 0;
  fixed = parseInt(parts[1]) || 0;
} catch(e) {}

const remaining = all.slice(processed);
console.log(`${total} total | done: ${processed} | fixed: ${fixed}`);
let start = Date.now();

for (const item of remaining) {
  processed++;
  try {
    const r = await fetch(`https://api.mangadex.org/manga/${item.dex}/feed?limit=0`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Xingmanwu/1.0" }
    });
    if (!r.ok) { await sleep(400); continue; }
    const d = await r.json();
    const realCh = d.total || 0;
    if (realCh !== item.cur_ch) {
      db.run("UPDATE dex_mapping SET total_chapters=? WHERE manga_id=?", [realCh, item.id]);
      if (item.cur_ch === 0 && realCh > 0) fixed++;
    }
  } catch(e) {}
  
  if (processed % 100 === 0) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`${processed}/${total} | fixed: ${fixed} | ${elapsed}s`);
    writeFileSync(STATE, `${processed},${fixed}`);
  }
  await sleep(300);
}

writeFileSync(STATE, `${processed},${fixed}`);
const nz = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0")[0].c;
const z = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0 AND dex_id IS NOT NULL")[0].c;
console.log(`\nDONE! Fixed: ${fixed} | Non-zero: ${nz} | Zero: ${z}`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
