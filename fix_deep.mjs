import { initDB, default as db } from "./db.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "data", "fix_deep.txt");
const DEX_API = "https://api.mangadex.org";
const H = { "User-Agent": "Xingmanwu/1.0 (fix_deep)" };

await initDB();

const zeros = db.all(`
  SELECT d.manga_id, d.dex_id, m.title_romaji, m.title_english, m.title_native, m.format
  FROM dex_mapping d JOIN manga m ON m.id = d.manga_id
  WHERE d.total_chapters = 0 AND d.dex_id IS NOT NULL
  ORDER BY m.popularity DESC
`);

let total = zeros.length;
let checked = 0, fixed = 0;
try { const s = fs.readFileSync(STATE, "utf8").trim().split(","); checked = parseInt(s[0])||0; fixed = parseInt(s[1])||0; } catch(e) {}

const remaining = zeros.slice(checked);
console.log(`${total} zeros | checked: ${checked} | fixed: ${fixed} | remaining: ${remaining.length}`);
let batchChanges = 0;
const start = Date.now();

function saveState() { fs.writeFileSync(STATE, `${checked},${fixed}`); }
function saveDB() { db.save(); batchChanges = 0; }

async function getMangaDetail(dexId) {
  try {
    const r = await fetch(`${DEX_API}/manga/${dexId}?includes[]=manga`,
      { signal: AbortSignal.timeout(8000), headers: H });
    if (!r.ok) return null;
    const d = await r.json();
    return d.data;
  } catch(e) { return null; }
}

async function searchAndCheck(term, excludeId) {
  try {
    const r = await fetch(
      `${DEX_API}/manga?title=${encodeURIComponent(term)}&limit=15&contentRating[]=safe&contentRating[]=suggestive&order[relevance]=desc`,
      { signal: AbortSignal.timeout(8000), headers: H }
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.data?.length) return null;

    for (const m of d.data) {
      if (m.id === excludeId) continue;
      // Get full chapter count
      const f = await fetch(`${DEX_API}/manga/${m.id}/feed?limit=0`,
        { signal: AbortSignal.timeout(6000), headers: H });
      if (!f.ok) continue;
      const fd = await f.json();
      if (!fd.total) continue;
      
      const title = (m.attributes?.title?.en || m.attributes?.title?.ja || "").toLowerCase();
      const searchTerm = term.toLowerCase().trim();
      const baseTitle = title.split(/ *[:‑–—;♪♡⭐]| *\(.*?\)/)[0]?.trim();
      const baseSearch = searchTerm.split(/ *[:‑–—;♪♡⭐]| *\(.*?\)/)[0]?.trim();
      
      // Check match quality
      let isMatch = false;
      if (baseTitle && baseSearch) {
        if (baseTitle === baseSearch || baseTitle.includes(baseSearch) || baseSearch.includes(baseTitle)) {
          isMatch = true;
        } else {
          // Word overlap: at least 2 significant words match
          const words1 = baseTitle.split(/\s+/).filter(w => w.length > 3);
          const words2 = baseSearch.split(/\s+/).filter(w => w.length > 3);
          const overlap = words1.filter(w => words2.some(x => x === w || x.startsWith(w) || w.startsWith(x)));
          if (overlap.length >= Math.min(2, Math.min(words1.length, words2.length))) {
            isMatch = true;
          }
        }
      }
      
      if (isMatch) return { id: m.id, title: title.slice(0,80), chapters: fd.total };
    }
  } catch(e) {}
  return null;
}

for (const z of remaining) {
  checked++;
  let found = false;
  let bestMatch = null;

  // Step 1: Get manga detail with all titles + relationships
  const detail = await getMangaDetail(z.dex_id);
  
  if (detail) {
    const attrs = detail.attributes;
    const allTitles = [];
    
    // Collect ALL titles: primary + alt
    for (const key of ['en','ja','ko','zh','ru','fr','es','pt','de','it','th','vi']) {
      if (attrs.title?.[key]) allTitles.push(attrs.title[key]);
    }
    if (attrs.altTitles) {
      for (const at of attrs.altTitles) {
        for (const val of Object.values(at)) {
          if (typeof val === 'string') allTitles.push(val);
        }
      }
    }
    
    // Deduplicate and filter
    const uniqueTitles = [...new Set(allTitles)].filter(t => 
      t && t.length > 2 && !t.match(/^[\d\s,\.]+$/)
    ).slice(0, 12);  // Max 12 searches per entry
    
    // Search by each alt title
    for (const alt of uniqueTitles) {
      if (found) break;
      const result = await searchAndCheck(alt, z.dex_id);
      if (result) {
        // Accept with threshold: >20 for strict, else just log
        if (result.chapters >= 5) {
          bestMatch = result;
          found = true;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    
    // Step 2: Check relationships (same series, different entry)
    if (!found && detail.relationships) {
      for (const rel of detail.relationships) {
        if (rel.type === 'manga' && rel.id !== z.dex_id) {
          try {
            const f = await fetch(`${DEX_API}/manga/${rel.id}/feed?limit=0`,
              { signal: AbortSignal.timeout(5000), headers: H });
            if (f.ok) {
              const fd = await f.json();
              if (fd.total >= 5) {
                const rd = await fetch(`${DEX_API}/manga/${rel.id}`,
                  { signal: AbortSignal.timeout(4000), headers: H });
                if (rd.ok) {
                  const dd = await rd.json();
                  const mt = dd.data.attributes?.title?.en || dd.data.attributes?.title?.ja || "";
                  bestMatch = { id: rel.id, title: `[related] ${mt}`, chapters: fd.total };
                  found = true;
                }
              }
            }
          } catch(e) {}
          await new Promise(r => setTimeout(r, 200));
        }
      }
    }
  }

  // Step 3: If detail fetch failed or no alt titles found, try basic search
  if (!found) {
    const native = z.title_native || "";
    if (native && native.length > 2 && /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(native)) {
      const result = await searchAndCheck(native, z.dex_id);
      if (result && result.chapters >= 5) {
        bestMatch = result;
        found = true;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Save match
  if (bestMatch) {
    fixed++;
    batchChanges++;
    db.run("UPDATE dex_mapping SET dex_id=?, dex_title=?, total_chapters=?, readable_chapters=0, last_checked=? WHERE manga_id=?",
      [bestMatch.id, bestMatch.title.slice(0,100), bestMatch.chapters, new Date().toISOString(), z.manga_id]);
    if (fixed % 50 === 0 || fixed <= 5)
      console.log(`  ✅ #${checked}: ${(z.title_romaji||"").slice(0,22)} → ${bestMatch.title.slice(0,35)} (${bestMatch.chapters}ch)`);
  } else {
    db.run("UPDATE dex_mapping SET last_checked=? WHERE manga_id=?", [new Date().toISOString(), z.manga_id]);
  }

  if (batchChanges >= 10) saveDB();
  
  if (checked % 50 === 0) {
    const elapsed = ((Date.now() - start)/1000).toFixed(0);
    const rate = (checked/elapsed*60).toFixed(1);
    console.log(`${checked}/${total} | fixed: ${fixed} (${(fixed/Math.max(1,checked)*100).toFixed(1)}%) | ${elapsed}s | ${rate}/min`);
    saveState();
  }
}

saveDB();
saveState();
const elapsed = ((Date.now() - start)/1000).toFixed(0);
const nz = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0")[0].c;
const zleft = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0")[0].c;
console.log(`\nDONE! ${elapsed}s | Fixed: ${fixed} | NZ: ${nz} | Zeros: ${zleft}`);
