import { initDB, default as db } from "./db.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "data", "rematch3.txt");
const DEX_API = "https://api.mangadex.org";
const HEADERS = { "User-Agent": "Xingmanwu/1.0 (rematch3)" };

await initDB();

let processed = 0, matched = 0;
try { const s = fs.readFileSync(STATE, "utf8").trim().split(","); processed = parseInt(s[0])||0; matched = parseInt(s[1])||0; } catch(e) {}

const all = db.all(`
  SELECT m.id, m.title_romaji, m.title_english, m.title_native, m.format
  FROM manga m LEFT JOIN dex_mapping d ON m.id = d.manga_id
  WHERE d.manga_id IS NULL
  ORDER BY m.popularity DESC
`);

const remaining = all.slice(processed);
let thisRunMatched = 0;
console.log(`${all.length} unmatched | processed: ${processed} | matched: ${matched} | remaining: ${remaining.length}`);

const start = Date.now();
const MAX = 200; // Process 200 per run
let batchChanges = 0;

function saveState() { fs.writeFileSync(STATE, `${processed},${matched}`); }
function saveDB() { db.save(); batchChanges = 0; }

function buildTerms(entry) {
  let terms = [];
  const titles = [entry.title_english, entry.title_romaji, entry.title_native].filter(Boolean);
  
  for (const t of titles) {
    terms.push(t);
    // Remove subtitle after common separators
    let simple = t.split(/ *[:‑–—;♪♡⭐]| *[Ss]eason\s+\d+| *[Vv]ol\.?\s*\d+| *\(.*?\)| *【.*?】/)[0]?.trim();
    if (simple && simple !== t && simple.length > 2) terms.push(simple);
    // Try first 2-3 words
    let words = t.split(/\s+/).filter(w => w.length > 2).slice(0, 3);
    if (words.length >= 2) terms.push(words.join(" "));
  }
  return [...new Set(terms)].filter(t => t && t.length > 3).slice(0, 5);
}

async function tryMatch(entry) {
  const terms = buildTerms(entry);
  
  for (const term of terms) {
    try {
      const r = await fetch(
        `${DEX_API}/manga?title=${encodeURIComponent(term)}&limit=10&contentRating[]=safe&contentRating[]=suggestive&order[relevance]=desc`,
        { signal: AbortSignal.timeout(10000), headers: HEADERS }
      );
      if (!r.ok) { await new Promise(r => setTimeout(r, 300)); continue; }
      const d = await r.json();
      if (!d.data?.length) continue;

      for (const m of d.data) {
        const en = (m.attributes?.title?.en || "").toLowerCase();
        const searchTL = term.toLowerCase().trim();
        const baseEn = en.split(/ *[:‑–—;♪♡⭐]/)[0]?.trim();
        const baseSearch = searchTL.split(/ *[:‑–—;♪♡⭐]/)[0]?.trim();
        
        // Match: exact or significant overlap in base titles
        let isMatch = false;
        if (baseEn && baseSearch && (baseEn === baseSearch || baseEn.includes(baseSearch) || baseSearch.includes(baseEn))) {
          isMatch = true;
        }
        if (!isMatch) {
          // Check word overlap (at least 2 significant words)
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
          const f = await fetch(`${DEX_API}/manga/${m.id}/feed?limit=0`,
            { signal: AbortSignal.timeout(8000), headers: HEADERS });
          if (!f.ok) continue;
          const fd = await f.json();
          if (fd.total > 0) {
            matched++;
            thisRunMatched++;
            batchChanges++;
            const title = m.attributes?.title?.en || m.attributes?.title?.ja || "";
            db.run("INSERT INTO dex_mapping(manga_id, dex_id, dex_title, total_chapters, readable_chapters, last_checked) VALUES(?,?,?,?,0,?)",
              [entry.id, m.id, title, fd.total, new Date().toISOString()]);
            if (matched <= 10 || matched % 100 === 0)
              console.log(`  ✅ #${processed+1}: ${(entry.title_romaji||"").slice(0,25)} → ${title.slice(0,30)} (${fd.total}ch)`);
            
            // Save periodically
            if (batchChanges >= 10) saveDB();
            return true;
          }
        }
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

for (const entry of remaining) {
  if (thisRunMatched >= MAX) break;
  processed++;
  await tryMatch(entry);
  
  if (thisRunMatched > 0 && thisRunMatched % 20 === 0) {
    const elapsed = ((Date.now() - start)/1000).toFixed(0);
    console.log(`${thisRunMatched}/${MAX} matched this run | global: ${matched}/${processed} (${(matched/Math.max(1,processed)*100).toFixed(0)}%) | ${elapsed}s`);
    saveState();
  }
}

// Final save
saveDB();
saveState();

const elapsed = ((Date.now() - start)/1000).toFixed(0);
console.log(`\nDone: ${thisRunMatched} matched in ${elapsed}s`);
const nz = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0")[0].c;
const nd = db.all("SELECT COUNT(*) as c FROM manga m LEFT JOIN dex_mapping d ON m.id=d.manga_id WHERE d.manga_id IS NULL")[0].c;
console.log(`NZ: ${nz} | ND: ${nd} | Still need: ${11000-nz}`);
