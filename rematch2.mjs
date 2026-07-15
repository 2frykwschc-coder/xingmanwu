import { initDB, default as db } from "./db.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "data", "rematch2.txt");
const DEX_API = "https://api.mangadex.org";
const HEADERS = { "User-Agent": "Xingmanwu/1.0 (rematch2)" };

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
console.log(`${all.length} unmatched | ${processed} done | ${matched} matched | remaining: ${remaining.length}`);

const start = Date.now();
let doneThisRun = 0;
const MAX = 300; // Process 300 per run

async function buildTerms(entry) {
  let terms = [];
  const titles = [entry.title_english, entry.title_romaji, entry.title_native].filter(Boolean);
  
  for (const t of titles) {
    terms.push(t);
    // Remove subtitle after common separators
    let simple = t.split(/ *[:‑–—;♪♡⭐♡♤◆]| *[Ss]eason\s+\d+| *[Vv]ol\.?\s*\d+| *\(.*?\)| *【.*?】/)[0]?.trim();
    if (simple && simple !== t && simple.length > 2) terms.push(simple);
    // For Korean titles: try first 2 meaningful words
    let words = t.split(/\s+/).filter(w => w.length > 1);
    if (words.length >= 2) {
      terms.push(words.slice(0, 2).join(" "));
      terms.push(words.slice(0, 3).join(" "));
    }
    // Try first 5+ chars if title is long
    if (t.length > 8) {
      for (let i = 4; i <= Math.min(8, t.length); i++) {
        terms.push(t.slice(0, i));
      }
    }
  }
  return [...new Set(terms)].filter(t => t && t.length > 2).slice(0, 8);
}

async function tryMatch(entry) {
  const terms = await buildTerms(entry);
  
  for (const term of terms) {
    try {
      const r = await fetch(
        `${DEX_API}/manga?title=${encodeURIComponent(term)}&limit=10&contentRating[]=safe&contentRating[]=suggestive&order[relevance]=desc`,
        { signal: AbortSignal.timeout(10000), headers: HEADERS }
      );
      if (!r.ok) { await new Promise(r => setTimeout(r, 500)); continue; }
      const d = await r.json();
      if (!d.data?.length) continue;

      for (const m of d.data) {
        // Check all title variants for a match
        const allTitles = [m.attributes?.title?.en, m.attributes?.title?.ja, m.attributes?.title?.ko, m.attributes?.title?.zh]
          .filter(Boolean)
          .concat((m.attributes?.altTitles || []).flatMap(a => Object.values(a)).filter(Boolean))
          .map(t => t.toLowerCase());
        
        const searchTL = term.toLowerCase().trim();
        
        // Match: exact, contains, or significant word overlap
        let isMatch = allTitles.some(t => 
          t === searchTL || 
          t.includes(searchTL) || 
          searchTL.includes(t) ||
          t.split(/\s+/).filter(w => w.length > 3).some(w => searchTL.includes(w)) ||
          searchTL.split(/\s+/).filter(w => w.length > 3).some(w => t.includes(w))
        );
        
        if (!isMatch) {
          // For long titles, check if non-subtitle part overlaps
          const mainTitle = (m.attributes?.title?.en || "").toLowerCase();
          const base1 = mainTitle.split(/ *[:‑–—;♪♡⭐]/)[0]?.trim();
          const base2 = searchTL.split(/ *[:‑–—;♪♡⭐]/)[0]?.trim();
          if (base1 && base2 && (base1.includes(base2) || base2.includes(base1))) isMatch = true;
        }

        if (isMatch) {
          const f = await fetch(`${DEX_API}/manga/${m.id}/feed?limit=0`,
            { signal: AbortSignal.timeout(8000), headers: HEADERS });
          if (!f.ok) continue;
          const fd = await f.json();
          if (fd.total > 0) {  // Only accept entries with chapters
            matched++;
            const title = m.attributes?.title?.en || m.attributes?.title?.ja || "";
            db.run("INSERT INTO dex_mapping(manga_id, dex_id, dex_title, total_chapters, readable_chapters, last_checked) VALUES(?,?,?,?,0,?)",
              [entry.id, m.id, title, fd.total, new Date().toISOString()]);
            return true;
          }
        }
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

for (const entry of remaining) {
  if (doneThisRun >= MAX) break;
  const ok = await tryMatch(entry);
  if (ok) matched++;
  processed++;
  doneThisRun++;

  if (doneThisRun % 20 === 0) {
    const elapsed = ((Date.now() - start)/1000).toFixed(0);
    const rate = (doneThisRun/elapsed).toFixed(2);
    const hitRate = (matched/Math.max(1,processed)*100).toFixed(0);
    console.log(`${doneThisRun}/${MAX} | matched=${matched} (${hitRate}%) | ${elapsed}s | ${rate}/s`);
    fs.writeFileSync(STATE, `${processed},${matched}`);
  }
}

fs.writeFileSync(STATE, `${processed},${matched}`);
const elapsed = ((Date.now() - start)/1000).toFixed(0);
console.log(`\nDone: ${doneThisRun} in ${elapsed}s | matched ${matched} this run`);
const nz = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters>0")[0].c;
const nd = db.all("SELECT COUNT(*) as c FROM manga m LEFT JOIN dex_mapping d ON m.id=d.manga_id WHERE d.manga_id IS NULL")[0].c;
console.log(`NZ: ${nz} | Still ND: ${nd}`);
