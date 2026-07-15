import {initDB, default as db} from './db.js';
import {writeFileSync, existsSync} from 'fs';

await initDB();

// 读取零章漫画（不含已有的 fix_alt）
const zeros = db.all(`SELECT m.id, m.title_romaji as tr, m.title_english as te, m.title_native as tn FROM manga m WHERE (m.chapters IS NULL OR m.chapters=0) AND m.id NOT IN (SELECT manga_id FROM fix_alt) ORDER BY m.popularity ASC`);

writeFileSync('data/manga_index.json', JSON.stringify(zeros));
console.log(`📤 导出 ${zeros.length} 部零章漫画 → data/manga_index.json`);
