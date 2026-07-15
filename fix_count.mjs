import { initDB, default as db } from "./db.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

(async () => {
  await initDB();
  
  const zeros = db.all(`
    SELECT d.manga_id as id, d.dex_id as dex, m.title_romaji as title 
    FROM dex_mapping d JOIN manga m ON m.id = d.manga_id 
    WHERE d.total_chapters = 0 AND d.dex_id IS NOT NULL 
    ORDER BY m.popularity DESC
  `);
  
  const total = zeros.length;
  let processed = 0, fixed = 0;
  const startTime = Date.now();
  const stateFile = join(__dirname, "data", "fix_ch_count.txt");
  let batchIdx = 0;
  
  // Resume from state
  try {
    const parts = fs.readFileSync(stateFile, "utf8").trim().split(",");
    processed = parseInt(parts[0]) || 0;
    fixed = parseInt(parts[1]) || 0;
  } catch(e) {}
  
  const remaining = zeros.slice(processed);
  console.log(`${total} zeros | done: ${processed} | fixed: ${fixed} | remaining: ${remaining.length}`);
  
  for (const z of remaining) {
    processed++;
    
    try {
      const r = await fetch(
        `https://api.mangadex.org/manga/${z.dex}/feed?limit=0&order[createdAt]=desc`,
        {
          signal: AbortSignal.timeout(12000),
          headers: { "User-Agent": "Xingmanwu/1.0" }
        }
      );
      
      if (!r.ok) {
        await sleep(500);
        continue;
      }
      
      const d = await r.json();
      const ch = d.total || 0;
      
      if (ch > 0) {
        db.run("UPDATE dex_mapping SET total_chapters=? WHERE manga_id=?", [ch, z.id]);
        fixed++;
      }
    } catch(e) {
      // Network error, skip
    }
    
    if (++batchIdx % 100 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = fixed > 0 ? (fixed / Math.max(1, processed) * 100).toFixed(0) : "0";
      console.log(`${processed}/${total} | fixed: ${fixed} (${rate}%) | ${elapsed}s`);
      fs.writeFileSync(stateFile, `${processed},${fixed}`);
    }
    
    await sleep(300);
  }
  
  // Save final state
  fs.writeFileSync(stateFile, `${processed},${fixed}`);
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const rate = fixed > 0 ? (fixed / Math.max(1, processed) * 100).toFixed(0) : "0";
  console.log(`\nDONE! ${elapsed}s`);
  console.log(`Fixed: ${fixed}/${processed} (${rate}%)`);
  
  const stillZero = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0 AND dex_id IS NOT NULL")[0].c;
  const nonZero = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0")[0].c;
  console.log(`Still zero: ${stillZero} | Non-zero: ${nonZero}`);
})();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
