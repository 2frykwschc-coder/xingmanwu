const API = 'https://graphql.anilist.co';
const QUERIES = [
  ['📖 话数多', 'CHAPTERS_DESC'],
  ['📚 卷数多', 'VOLUMES_DESC'],
  ['🕰️ 老作品', 'START_DATE'],
  ['📕 低人气', 'POPULARITY'],
  ['⭐ 低分', 'SCORE'],
  ['🔄 最近更新', 'UPDATED_AT_DESC'],
  ['❤️ 少收藏', 'FAVOURITES'],
];

const { initDB, default: db } = await import('./db.js');
await initDB();
let before = db.get('SELECT COUNT(*) as c FROM manga').c;

for (const [label, sort] of QUERIES) {
  console.log(`\n${label} (${sort})...`);
  for (let p = 1; p <= 100; p++) {
    const q = `query($p:Int){Page(page:$p,perPage:50){media(type:MANGA,sort:[${sort}]){id title{romaji}coverImage{large}description format status startDate{year}genres averageScore popularity favourites chapters volumes}pageInfo{hasNextPage}}}`;
    const res = await fetch(API, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ query: q, variables: { p } })
    });
    if (!res.ok) {
      if (res.status === 429) { console.log('⏳ 等60s...'); await new Promise(r=>setTimeout(r,60000)); p--; continue; }
      const t = await res.text(); console.log(`  ❌ 第${p}页: ${t.substring(0,40)}`); break;
    }
    const d = await res.json();
    const media = d.data?.Page?.media;
    if (!media?.length) { console.log(`  ✅ 无数据结束`); break; }

    let added = 0;
    for (const m of media) {
      try {
        db.run(`INSERT OR IGNORE INTO manga VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          m.id, m.title.romaji||'', '', '',
          m.coverImage?.large||'', '',
          (m.description||'').replace(/<[^>]*>/g,'').slice(0,2000),
          m.format||'', m.status||'', m.startDate?.year||null,
          JSON.stringify(m.genres||[]), '[]',
          m.averageScore?m.averageScore/10:null,
          m.popularity||0, m.favourites||0, m.chapters||null, m.volumes||null, '', ''
        ]);
        added++;
      } catch {}
    }
    db.save();

    const count = db.get('SELECT COUNT(*) as c FROM manga').c;
    console.log(`  📦 第${p}页 — 累计${count}部`);

    if (!d.data.Page.pageInfo.hasNextPage) { console.log(`  ✅ 完成`); break; }
    await new Promise(r => setTimeout(r, 1500)); // 保守一点防限速
  }
}

const after = db.get('SELECT COUNT(*) as c FROM manga').c;
console.log(`\n🎉 完成！共 ${after} 部（新增 ${after - before} 部）`);
