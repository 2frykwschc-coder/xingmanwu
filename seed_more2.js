const API = 'https://graphql.anilist.co';
const QUERIES = [
  ['📕 低人气',   'POPULARITY'],
  ['⭐ 低分',     'SCORE'],
  ['📖 话数多',   'CHAPTERS_DESC'],
  ['📚 卷数多',   'VOLUMES_DESC'],
  ['🕰️ 老作品',   'START_DATE'],
  ['🔄 最近更新', 'UPDATED_AT_DESC'],
  ['❤️ 少收藏',   'FAVOURITES'],
];

const { initDB, default: db } = await import('./db.js');
await initDB();
let before = db.get('SELECT COUNT(*) as c FROM manga').c;

async function fetchPage(sort, page) {
  const query = `query($p:Int){Page(page:$p,perPage:50){media(type:MANGA,sort:[${sort}]){id title{romaji}coverImage{large}description format status startDate{year}genres averageScore popularity favourites chapters volumes}pageInfo{hasNextPage}}}`;
  const res = await fetch(API, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ query, variables: { p: page } })
  });
  if (!res.ok) {
    if (res.status === 429) { console.log('⏳ 等60s...'); await new Promise(r=>setTimeout(r,60000)); return fetchPage(sort,page); }
    const text = await res.text();
    if (text.includes('exceeds')) return null;
    throw new Error(text.substring(0,60));
  }
  return res.json();
}

let newCount = 0;
for (const [label, sort] of QUERIES) {
  console.log(`\n${label} (${sort})...`);
  for (let p = 1; p <= 100; p++) {
    try {
      const data = await fetchPage(sort, p);
      if (!data) { console.log(`  ⚠️ 第${p}页超限`); break; }
      const media = data.data?.Page?.media;
      if (!media?.length) { console.log(`  ✅ 无数据`); break; }
      
      for (const m of media) {
        try {
          db.run(`INSERT OR IGNORE INTO manga VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
            m.id, m.title.romaji||'', '', '',
            m.coverImage?.large||'', '',
            (m.description||'').replace(/<[^>]*>/g,'').slice(0,2000),
            m.format||'', m.status||'', m.startDate?.year||null,
            JSON.stringify(m.genres||[]), '[]',
            m.averageScore ? m.averageScore/10 : null,
            m.popularity||0, m.favourites||0, m.chapters||null, m.volumes||null, '', ''
          ]);
          newCount++;
        } catch {}
      }
      db.save();
      
      console.log(`  📦 第${p}页 — ${newCount}部新增`);
      if (!data.data.Page.hasNextPage) { console.log(`  ✅ 完成`); break; }
      await new Promise(r => setTimeout(r, 750));
    } catch(e) {
      console.log(`  ❌ 第${p}页: ${e.message.substring(0,40)}`);
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
  }
}

const after = db.get('SELECT COUNT(*) as c FROM manga').c;
console.log(`\n🎉 完成！共 ${after} 部（新增 ${after - before} 部）`);
