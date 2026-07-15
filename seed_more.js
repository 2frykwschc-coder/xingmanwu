const API = 'https://graphql.anilist.co';
const QUERIES = [
  { label: '🆔 早期ID',   sort: 'ID' },
  { label: '❤️ 收藏',     sort: 'FAVOURITES_DESC' },
  { label: '⭐ 评分',     sort: 'SCORE_DESC' },
  { label: '📈 趋势',     sort: 'TRENDING_DESC' },
];

const QUERY_TMPL = `query ($page: Int) {
  Page(page: $page, perPage: 50) {
    media(type: MANGA, sort: [SORT_PLACEHOLDER]) {
      id title { romaji english native }
      coverImage { large } bannerImage description format status
      startDate { year } genres tags { name }
      averageScore popularity favourites chapters volumes
    }
    pageInfo { currentPage lastPage hasNextPage }
  }
}`;

async function fetchPage(query, page) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { page } })
  });
  if (!res.ok) {
    if (res.status === 429) {
      console.log('⏳ 速率限制，等60秒...');
      await new Promise(r => setTimeout(r, 60000));
      return fetchPage(query, page);
    }
    const text = await res.text();
    if (text.includes('too large') || text.includes('exceeds maximum')) return null;
    throw new Error(text.substring(0, 80));
  }
  return res.json();
}

const { initDB, default: db } = await import('./db.js');
await initDB();
let totalCount = db.get('SELECT COUNT(*) as c FROM manga').c;

const insertMany = db.transaction((list) => {
  for (const m of list) {
    try {
      db.run(`INSERT OR IGNORE INTO manga VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        m.id, m.title.romaji || '', m.title.english || '', m.title.native || '',
        m.coverImage?.large || '', m.bannerImage || '',
        (m.description || '').replace(/<[^>]*>/g, '').substring(0, 2000),
        m.format || '', m.status || '',
        m.startDate?.year || null,
        JSON.stringify(m.genres || []),
        JSON.stringify((m.tags || []).map(t => t.name)),
        m.averageScore ? m.averageScore / 10 : null,
        m.popularity || 0, m.favourites || 0,
        m.chapters || null, m.volumes || null, '', ''
      ]);
      totalCount++;
    } catch {}
  }
});

for (const { label, sort } of QUERIES) {
  const query = QUERY_TMPL.replace('SORT_PLACEHOLDER', sort);
  console.log(`\n${label} (${sort})...`);

  for (let page = 1; page <= 100; page++) {
    try {
      const data = await fetchPage(query, page);
      if (!data) { console.log(`  ⚠️  第${page}页超限`); break; }
      const pd = data.data?.Page, media = pd?.media;
      if (!media?.length) { console.log(`  ✅ 完成`); break; }
      insertMany(media);
      console.log(`  📦 第${page}/${pd.pageInfo.lastPage}页 — ${totalCount}部累积`);
      if (!pd.pageInfo.hasNextPage) { console.log(`  ✅ 完成`); break; }
      await new Promise(r => setTimeout(r, 750));
    } catch (e) {
      console.log(`  ❌ 第${page}页: ${e.message.substring(0, 50)}`);
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
  }
}

db.save();
const realCount = db.get('SELECT COUNT(*) as c FROM manga').c;
console.log(`\n🎉 完成！共 ${realCount} 部（新增 ${realCount - totalCount + 13150} 部）`);
