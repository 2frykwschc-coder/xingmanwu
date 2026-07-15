import database, { initDB } from './db.js';
await initDB();

function classify(m) {
  const nt = m.title_native || '';
  if (nt.match(/[\uAC00-\uD7AF]/)) return 'korean';
  if (nt) return 'japanese'; // has native text but not Korean → Japanese
  // No native title - all these formats are Japanese on AniList
  return 'japanese';
}

const all = database.all("SELECT id, title_native, format FROM manga");
const counts = {japanese:0, korean:0};
for (const m of all) {
  counts[classify(m)]++;
}
console.log('全部归类后:');
console.log('🇯🇵 日漫:', counts.japanese, Math.round(counts.japanese/all.length*1000)/10+'%');
console.log('🇰🇷 韩漫:', counts.korean, Math.round(counts.korean/all.length*1000)/10+'%');

// Quick check: verify Korean works have proper Korean format
const krWorks = database.all(`SELECT format, COUNT(*) as c FROM manga WHERE title_native GLOB '*[가-힣]*' GROUP BY format ORDER BY c DESC`);
console.log('\n韩文作品的格式:');
krWorks.forEach(f => console.log(' ', f.format||'NULL', '→', f.c));
