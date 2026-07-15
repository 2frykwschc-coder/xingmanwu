import { initDB, default as db } from "./db.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "data", "fix_all_langs.txt");
const DEX_API = "https://api.mangadex.org";
const HEADERS = { "User-Agent": "Xingmanwu/1.0 (fix_all_langs)" };

await initDB();

const zeros = db.all(`
  SELECT d.manga_id, d.dex_id, m.title_romaji, m.title_english, m.title_native
  FROM dex_mapping d JOIN manga m ON m.id = d.manga_id
  WHERE d.total_chapters = 0 AND d.dex_id IS NOT NULL
  ORDER BY m.popularity DESC
`);

let total = zeros.length;
console.log(`Total zero-chapter: ${total}`);
let checked = 0, fixed = 0, foundCount = 0;
try { const s = fs.readFileSync(STATE, "utf8").trim().split(","); checked = parseInt(s[0])||0; fixed = parseInt(s[1])||0; } catch(e) {}

const remaining = zeros.slice(checked);
console.log(`Already checked: ${checked} | Fixed: ${fixed} | Remaining: ${remaining.length}`);

let batchChanges = 0;
const start = Date.now();

function saveState() { fs.writeFileSync(STATE, `${checked},${fixed}`); }
function saveDB() { db.save(); batchChanges = 0; }

for (const z of remaining) {
  checked++;
  let foundChapters = 0;
  let foundAlt = false;

  // Phase 1: Re-query existing dex_id with NO language filter
  try {
    const f = await fetch(`${DEX_API}/manga/${z.dex_id}/feed?limit=0`,
      { signal: AbortSignal.timeout(10000), headers: HEADERS });
    if (f.ok) {
      const fd = await f.json();
      if (fd.total > 0) {
        foundChapters = fd.total;
        foundCount++;
      }
    }
  } catch(e) {}

  // Phase 2: If existing dex_id has chapters in other languages, just update count
  if (foundChapters > 0) {
    fixed++;
    batchChanges++;
    db.run("UPDATE dex_mapping SET total_chapters=?, readable_chapters=0, last_checked=? WHERE manga_id=?",
      [foundChapters, new Date().toISOString(), z.manga_id]);
    if (fixed % 50 === 0)
      console.log(`  ✅ #${checked}: ${(z.title_romaji||z.title_english||"").slice(0,25)} → ${foundChapters}ch (other langs)`);
  } else {
    // Phase 3: Try alternative title search with lower threshold
    let terms = [];
    for (const t of [z.title_english, z.title_romaji, z.title_native].filter(Boolean)) {
      terms.push(t);
      // Remove subtitle
      let simple = t.split(/ *[:‑–—;♪♡⭐]| *[Ss]eason\s+\d+| *[Vv]ol\.?\s*\d+| *\(.*?\)| *【.*?】/)[0]?.trim();
      if (simple && simple !== t && simple.length > 2) terms.push(simple);
      // First 3 meaningful words
      let words = t.split(/\s+/).filter(w => w.length > 2).slice(0, 3);
      if (words.length >= 2) terms.push(words.join(" "));
      // For CJK: try just the native title
      if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(t)) {
        let nativeOnly = t.replace(/[^가-힣\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\s]/g, "").trim();
        if (nativeOnly.length > 1) terms.push(nativeOnly);
      }
    }
    terms = [...new Set(terms)].filter(t => t.length > 2).slice(0, 6);

    for (const term of terms) {
      if (foundChapters > 0) break;
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
          // Get feed in any language
          const f2 = await fetch(`${DEX_API}/manga/${m.id}/feed?limit=0`,
            { signal: AbortSignal.timeout(8000), headers: HEADERS });
          if (!f2.ok) continue;
          const fd2 = await f2.json();
          if (fd2.total > 0) {
            // Check title match
            const enTitle = (m.attributes?.title?.en || "").toLowerCase();
            const searchT = term.toLowerCase().trim();
            const baseEn = enTitle.split(/ *[:‑–—;♪♡⭐]/)[0]?.trim();
            const baseSearch = searchT.split(/ *[:‑–—;♪♡⭐]/)[0]?.trim();
            
            let isMatch = false;
            if (baseEn && baseSearch && (baseEn === baseSearch || baseEn.includes(baseSearch) || baseSearch.includes(baseEn))) {
              isMatch = true;
            } else {
              const words1 = baseEn?.split(/\s+/).filter(w => w.length > 3) || [];
              const words2 = baseSearch?.split(/\s+/).filter(w => w.length > 3) || [];
              if (words1.length > 0 && words2.length > 0) {
                const overlap = words1.filter(w => words2.some(x => x === w || x.startsWith(w) || w.startsWith(x)));
                if (overlap.length >= Math.min(2, Math.min(words1.length, words2.length))) {
                  isMatch = true;
                }
              }
            }
            
            if (isMatch) {
              foundChapters = fd2.total;
              fixed++;
              batchChanges++;
              const title = m.attributes?.title?.en || m.attributes?.title?.ja || "";
              db.run("UPDATE dex_mapping SET dex_id=?, dex_title=?, total_chapters=?, readable_chapters=0, last_checked=? WHERE manga_id=?",
                [m.id, title, fd2.total, new Date().toISOString(), z.manga_id]);
              console.log(`  ✅ #${checked}: ${(z.title_romaji||"").slice(0,25)} → ${title.slice(0,30)} (${fd2.total}ch) [alt found]`);
              break;
            }
          }
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 250));
    }

    // If still no chapters, just update last_checked
    if (foundChapters === 0) {
      db.run("UPDATE dex_mapping SET last_checked=? WHERE manga_id=?", [new Date().toISOString(), z.manga_id]);
    }
  }

  // Save periodically
  if (batchChanges >= 15) saveDB();

  if (checked % 100 === 0) {
    const elapsed = ((Date.now() - start)/1000).toFixed(0);
    const rate = (checked/elapsed*60).toFixed(1);
    console.log(`${checked}/${total} | fixed: ${fixed} (${(fixed/Math.max(1,checked)*100).toFixed(0)}%) | ${elapsed}s | ${rate}/min`);
    saveState();
  }
}

saveDB();
saveState();

const elapsed = ((Date.now() - start)/1000).toFixed(0);
const nz = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0")[0].c;
const zleft = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0")[0].c;
console.log(`\nDONE! ${elapsed}s | Fixed: ${fixed}/${checked} | NZ: ${nz} | Zeros left: ${zleft}`);
