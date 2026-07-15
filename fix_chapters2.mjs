import { initDB, default as db } from "./db.js";
import { readFileSync } from "fs";

await initDB();
const list = JSON.parse(readFileSync("/tmp/dex_fix_list.json", "utf8"));
const total = list.length;
let processed = 0, fixed = 0;
const startTime = Date.now();
const D = 400; // delay between requests
let lastLog = 0;

console.log(`Fix chapters: ${total} manga`);

for (const item of list) {
  processed++;
  try {
    // Query manga feed without language filter
    const url = `https://api.mangadex.org/manga/${item.dex}/feed?limit=0`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {"User-Agent": "Xingmanwu/1.0"}
    });
    if (!r.ok) { 
      await new Promise(r => setTimeout(r, D));
      continue; 
    }
    const d = await r.json();
    const realTotal = typeof d.total === "number" ? d.total : 0;
    
    if (realTotal !== item.ch) {
      if (item.ch === 0 && realTotal > 0) {
        fixed++;
      }
      db.run("UPDATE dex_mapping SET total_chapters=? WHERE manga_id=?", [realTotal, item.id]);
    }
  } catch(e) {
    // Silently handle network errors
  }
  
  if (processed - lastLog >= 100) {
    lastLog = processed;
    const elapsed = ((Date.now()-startTime)/1000).toFixed(0);
    console.log(`${processed}/${total} | fixed=${fixed} | ${elapsed}s`);
  }
  
  await new Promise(r => setTimeout(r, D));
}

const elapsed = ((Date.now()-startTime)/1000).toFixed(0);
console.log(`\nDone! fixed=${fixed} | time=${elapsed}s`);

const stillZero = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0 AND dex_id IS NOT NULL")[0].c;
const nonZero = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0")[0].c;
console.log(`Still zero: ${stillZero} | Non-zero: ${nonZero}`);
