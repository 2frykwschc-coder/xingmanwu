import {initDB, default as db} from './db.js';
import {readFileSync} from 'fs';

await initDB();

const file = 'data/crawl_mk.json';
if (!require) {
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  console.log(`📥 导入 ${data.length} 条 MangaKatana 数据`);

  let imported = 0;
  for (const item of data) {
    db.run(
      `INSERT OR REPLACE INTO fix_alt(manga_id, source, source_url, chapters, source_title, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [item.manga_id, item.source, item.source_url, item.chapters, item.source_title || item.our_title]
    );
    db.run("UPDATE manga SET chapters=? WHERE id=? AND (chapters IS NULL OR chapters=0)", 
      [item.chapters, item.manga_id]);
    imported++;
  }
  db.save();
  console.log(`✅ 导入完成: ${imported} 部`);
}
