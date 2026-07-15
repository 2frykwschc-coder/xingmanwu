const API = 'https://graphql.anilist.co';

// 用不同排序方式绕过 5000 条分页限制
const QUERIES = [
  { label: '🔥 热门',      sort: 'POPULARITY_DESC' },
  { label: '📅 最新',     sort: 'START_DATE_DESC' },
  { label: '🆔 新版ID',   sort: 'ID_DESC' },
  { label: '🆔 早期ID',   sort: 'ID' },
  { label: '❤️ 收藏',     sort: 'FAVOURITES_DESC' },
  { label: '⭐ 评分',     sort: 'SCORE_DESC' },
  { label: '📈 趋势',     sort: 'TRENDING_DESC' },
];

function buildQuery(sort) {
  return `query ($page: Int) {
    Page(page: $page, perPage: 50) {
      media(type: MANGA, sort: [${sort}]) {
        id
        title { romaji english native }
        coverImage { large }
        bannerImage
        description
        format
        status
        startDate { year }
        genres
        tags { name }
        averageScore
        popularity
        favourites
        chapters
        volumes
      }
      pageInfo { currentPage lastPage hasNextPage }
    }
  }`;
}

async function fetchPage(query, page) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { page } })
  });
  if (!res.ok) {
    if (res.status === 429) {
      console.log('⏳ 速率限制，等待 60 秒...');
      await new Promise(r => setTimeout(r, 60000));
      return fetchPage(query, page);
    }
    const text = await res.text();
    if (text.includes('too large') || text.includes('exceeds maximum')) {
      return null; // page limit hit
    }
    throw new Error(text.substring(0, 100));
  }
  return res.json();
}

async function seed() {
  const { initDB, default: db } = await import('./db.js');
  await initDB();
  let totalCount = 0;

  const insertMany = db.transaction((list) => {
    for (const m of list) {
      try {
        db.run(
          `INSERT OR REPLACE INTO manga VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            m.id, m.title.romaji || '', m.title.english || '', m.title.native || '',
            m.coverImage?.large || '', m.bannerImage || '',
            (m.description || '').replace(/<[^>]*>/g, '').substring(0, 2000),
            m.format || '', m.status || '',
            m.startDate?.year || null,
            JSON.stringify(m.genres || []),
            JSON.stringify((m.tags || []).map(t => t.name)),
            m.averageScore ? m.averageScore / 10 : null,
            m.popularity || 0, m.favourites || 0,
            m.chapters || null, m.volumes || null,
            '', ''
          ]
        );
        totalCount++;
      } catch {}
    }
  });

  for (const { label, sort } of QUERIES) {
    const query = buildQuery(sort);
    console.log(`\n${label} (${sort})...`);

    for (let page = 1; page <= 100; page++) {
      try {
        const data = await fetchPage(query, page);
        if (!data) {
          console.log(`  ⚠️  第 ${page} 页超过限制`);
          break;
        }
        const pageData = data.data?.Page;
        const media = pageData?.media;
        if (!media?.length) {
          console.log(`  ✅ 完成（共 ${totalCount} 部）`);
          break;
        }
        console.log(`  📦 第 ${page} 页, 共 ${pageData?.pageInfo?.lastPage} 页 — ${totalCount} 部累积`);
        insertMany(media);

        if (!pageData?.pageInfo?.hasNextPage) {
          console.log(`  ✅ 完成: 最后一页`);
          break;
        }
        await new Promise(r => setTimeout(r, 700));
      } catch (e) {
        console.log(`  ❌ 第 ${page} 页: ${e.message.substring(0, 60)}`);
        await new Promise(r => setTimeout(r, 3000));
        break;
      }
    }
  }

  db.save();
  const realCount = db.get('SELECT COUNT(*) as c FROM manga').c;
  console.log(`\n🎉 全部完成！共入库 ${realCount} 部漫画（去重后）`);
}

seed().catch(e => { console.error('❌ 崩溃:', e); process.exit(1); });
