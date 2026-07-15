import {initDB,default as db} from "./db.js"; await initDB();
const zeros = db.all("SELECT d.manga_id as id,d.dex_id as dex,m.title_romaji as title FROM dex_mapping d JOIN manga m ON m.id=d.manga_id WHERE d.total_chapters=0 AND d.dex_id IS NOT NULL ORDER BY m.popularity DESC");
console.log("Zeros:", zeros.length);
// Just test first one
const z = zeros[0];
try {
  const r = await fetch("https://api.mangadex.org/manga/"+z.dex+"/feed?limit=0&order[createdAt]=desc", {signal:AbortSignal.timeout(10000),headers:{"User-Agent":"Xingmanwu/1.0"}});
  const d = await r.json();
  console.log("First:", z.title?.slice(0,30), "| ch:", d.total);
  if (d.total > 0) {
    db.run("UPDATE dex_mapping SET total_chapters=? WHERE manga_id=?", [d.total, z.id]);
    console.log("Updated!");
  }
} catch(e) {
  console.log("Error:", e.message);
}
const stillZero = db.all("SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters=0 AND dex_id IS NOT NULL")[0].c;
console.log("Still zero:", stillZero);
