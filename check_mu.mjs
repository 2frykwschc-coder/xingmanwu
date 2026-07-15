import {initDB, default as db} from './db.js';
await initDB();

const cmp = db.all("SELECT f.manga_id, m.title_romaji, m.chapters as anilist_ch, f.chapters as mu_ch, f.source_title FROM fix_alt f JOIN manga m ON m.id=f.manga_id WHERE m.chapters IS NOT NULL AND m.chapters > 0 ORDER BY m.chapters DESC");
console.log('=== AniList 有章数 vs MangaUpdates ===');
cmp.forEach(c => {
  const diff = Math.abs(c.anilist_ch - c.mu_ch);
  const flag = diff > 100 ? ' ⚠️ 差很多' : diff > 10 ? ' ⚠️ 有差异' : '';
  console.log(String(c.title_romaji||'').slice(0,25).padEnd(27) + ' AL: ' + String(c.anilist_ch).padEnd(5) + ' MU: ' + String(c.mu_ch).padEnd(5) + ' | ' + String(c.source_title||'').slice(0,20) + flag);
});

console.log('');
console.log('=== AniList 零章 + MU 有数据 ===');
const zero = db.all("SELECT f.manga_id, m.title_romaji, m.chapters as anilist_ch, f.chapters as mu_ch FROM fix_alt f JOIN manga m ON m.id=f.manga_id WHERE (m.chapters IS NULL OR m.chapters=0) ORDER BY f.chapters DESC");
zero.forEach(c => {
  console.log(String(c.title_romaji||'').slice(0,25).padEnd(27) + ' AL: ' + String(c.anilist_ch||0).padEnd(5) + ' MU: ' + String(c.mu_ch).padEnd(5));
});
