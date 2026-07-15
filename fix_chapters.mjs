import { initDB, default as db } from "./db.js";
import { readFileSync } from "fs";

await initDB();

const list = JSON.parse(readFileSync("/tmp/dex_fix_list.json", "utf8"));
const total = list.length;
let processed = 0, fixed = 0;
const startTime = Date.now();

console.log(`Fixing ${total} manga chapter counts...`);

for (const item of list) {
  processed++;
  try {
    const r = await fetch("https://api.mangadex.org/manga/" + item.dex + "/feed?limit=0", {
      signal: AbortSignal.timeout(10000),
      headers: {"User-Agent": "Xingmanwu/1.0"}
    });
    if (!r.ok) { await new Promise(r => setTimeout(r, 500)); continue; }
    const d = await r.json();
    const realTotal = d.total || 0;
    if (realTotal !== item.ch) {
      db.run("UPDATE dex_mapping SET total_chapters=? WHERE manga_id=?", [realTotal, item.id]);
      if (item.ch === 0 && realTotal > 0) fixed++;
    }
  } catch(e) {}
  if (processed % 200 === 0) {
    db.save();
    const elapsed = ((Date.now()-startTime)/1000).toFixed(0);
    console.log(`${processed}/${total} | FIXED: ${fixed} | ${elapsed}s`);
  }
  await new Promise(r => setTimeout(r, 300));
}
db.save();
const elapsed = ((Date.now()-startTime)/1000).toFixed(0);
console.log(`\nDONE! ${fixed} entries fixed. Time: ${elapsed}s`);
console.log(`Before zeros: ${list.filter(l => l.ch === 0).length} | Now should be less`);

const stillZero = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0 AND dex_id IS NOT NULL")[0].c;
const nonZero = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0")[0].c;
console.log(`Still zero: ${stillZero}`);
console.log(`Non-zero: ${nonZero}`);
