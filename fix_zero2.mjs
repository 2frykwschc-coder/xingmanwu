import { initDB, default as db } from "./db.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "data", "fix_zero2.txt");
const DEX_API = "https://api.mangadex.org";
const HEADERS = { "User-Agent": "Xingmanwu/1.0 (fixzero2)" };

await initDB();

const zeros = db.all(`
  SELECT d.manga_id, d.dex_id, m.title_romaji, m.title_english, m.title_native
  FROM dex_mapping d JOIN manga m ON m.id = d.manga_id
  WHERE d.total_chapters = 0 AND d.dex_id IS NOT NULL
  ORDER BY m.popularity DESC
`);

let total = zeros.length;
let processed = 0, fixed = 0;
try { const s = fs.readFileSync(STATE, "utf8").trim().split(","); processed = parseInt(s[0])||0; fixed = parseInt(s[1])||0; } catch(e) {}

// Already processed entries have last_checked set, skip them
const toCheck = zeros.filter(z => {
  const r = db.all("SELECT last_checked FROM dex_mapping WHERE manga_id=?", [z.manga_id]);
  return !r[0]?.last_checked;
});

// Or use the state file offset if no unprocessed entries
const remaining = toCheck.length > 0 ? toCheck : zeros.slice(processed);
const remaining2 = zeros.slice(processed);

console.log(`${total} total zeros | state says ${processed} done, ${fixed} fixed`);
console.log(`Unchecked zeros: ${toCheck.length} | Remaining from offset: ${remaining2.length}`);
const start = Date.now();

for (const z of remaining) {
  processed++;
  let found = false;

  let terms = [
    z.title_romaji?.split(/[:‑–—;♪♡⭐]/)[0]?.trim(),
    z.title_english?.split(/[:‑–—;♪♡⭐]/)[0]?.trim(),
    z.title_native,
    z.title_romaji,
    z.title_english,
  ].filter(Boolean);
  terms = [...new Set(terms)].filter(t => t.length > 2);

  for (const term of terms) {
    if (found) break;
    try {
      const r = await fetch(
        `${DEX_API}/manga?title=${encodeURIComponent(term)}&limit=20&contentRating[]=safe&contentRating[]=suggestive&order[relevance]=desc`,
        { signal: AbortSignal.timeout(10000), headers: HEADERS }
      );
      if (!r.ok) continue;
      const d = await r.json();
      if (!d.data?.length) continue;

      for (const m of d.data) {
        if (m.id === z.dex_id) continue;
        const f = await fetch(`${DEX_API}/manga/${m.id}/feed?limit=0`,
          { signal: AbortSignal.timeout(8000), headers: HEADERS });
        if (!f.ok) continue;
        const fd = await f.json();
        if (fd.total > 20) {
          found = true;
          fixed++;
          const title = m.attributes?.title?.en || m.attributes?.title?.ja || "";
          db.run("UPDATE dex_mapping SET dex_id=?, dex_title=?, total_chapters=?, readable_chapters=0, last_checked=? WHERE manga_id=?",
            [m.id, title, fd.total, new Date().toISOString(), z.manga_id]);
          if (processed <= 5 || processed % 100 === 0) 
            console.log(`  ✅ #${processed} ${(z.title_romaji||z.title_english||"").slice(0,25)} → ${title.slice(0,30)} (${fd.total}ch)`);
          break;
        }
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 350));
  }

  if (!found) {
    db.run("UPDATE dex_mapping SET last_checked=? WHERE manga_id=?", [new Date().toISOString(), z.manga_id]);
  }

  if (processed % 50 === 0) {
    const elapsed = ((Date.now() - start)/1000).toFixed(0);
    const rate = (processed/elapsed*60).toFixed(1);
    console.log(`${processed}/${total} | fixed: ${fixed} (${(fixed/Math.max(1,processed)*100).toFixed(0)}%) | ${elapsed}s | ${rate}/min`);
    fs.writeFileSync(STATE, `${processed},${fixed}`);
  }
}

fs.writeFileSync(STATE, `${processed},${fixed}`);
const nz = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0")[0].c;
const zrem = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0 AND dex_id IS NOT NULL")[0].c;
console.log(`\nDONE! Fixed: ${fixed}/${processed} | NZ: ${nz} | Z: ${zrem}`);
