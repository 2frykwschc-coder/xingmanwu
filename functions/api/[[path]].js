// 星漫屋 API — Cloudflare Pages Functions
// 处理所有 /api/* 路由，操作 D1 数据库

const DEX_API = 'https://api.mangadex.org';
const DEX_HEADERS = { 'User-Agent': 'Xingmanwu/1.0 (Cloudflare Pages)' };

// 按标题语言过滤
function getRegion(m) {
  const nt = m.title_native || '';
  if (nt.match(/[\uAC00-\uD7AF]/)) return 'korean';
  return 'japanese';
}

// MangaDex 标题匹配评分
function scoreDexMatch(candidate, title) {
  const en = (candidate.attributes.title?.en || '').toLowerCase();
  const alt = (candidate.attributes.altTitles || []).flatMap(a => Object.values(a)).filter(Boolean).map(t => t.toLowerCase());
  const all = [en, ...alt];
  const tl = title.toLowerCase();
  if (all.some(t => t === tl)) return 100;
  if (all.some(t => t === tl)) return 90;
  if (all.some(t => t.startsWith(tl))) return 80;
  if (en.split(/[\s,;:.!?()\[\]{}]+/).some(w => w === tl) || alt.some(t => t.split(/[\s,;:.!?()\[\]{}]+/).some(w => w === tl))) return 50;
  if (!tl.includes(' ') && en.includes(tl)) return 30;
  return 0;
}

// 获取所有不同流派（D1 不支持 json_each，用 JS 处理）
async function getAllGenres(env) {
  const { results } = await env.DB.prepare("SELECT genres FROM manga WHERE genres IS NOT NULL AND genres != '[]'").all();
  const set = new Set();
  for (const r of results) {
    try {
      const arr = JSON.parse(r.genres);
      arr.forEach(g => { if (g) set.add(g.trim()); });
    } catch {}
  }
  return [...set].sort();
}

// ── 路由分发 ──
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;       // /api/manga, /api/manga/123, etc.
  const method = request.method;

  // CORS headers for all responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // ── 路由匹配 ──

    // GET /api/manga — 浏览（过滤/排序/分页）
    if (method === 'GET' && path === '/api/manga') {
      const q = url.searchParams.get('q') || '';
      const genre = url.searchParams.get('genre') || '';
      const format = url.searchParams.get('format') || '';
      const region = url.searchParams.get('region') || '';
      const sort = url.searchParams.get('sort') || 'popularity';
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const offset = (page - 1) * limit;

      let where = [];
      let params = [];

      if (q) {
        where.push('(title_romaji LIKE ?1 OR title_english LIKE ?1)');
      }
      if (genre) {
        where.push('genres LIKE ?2');
      }
      if (format) {
        where.push('format = ?3');
        params.push(format);
      }

      const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const sortMap = {
        score: 'score DESC',
        popularity: 'popularity DESC',
        favorites: 'favorites DESC',
        title: 'title_romaji',
        year: 'start_year DESC',
      };
      const orderBy = sortMap[sort] || 'popularity DESC';

      let sql = `SELECT id, title_romaji, title_english, title_native, cover_url, format, score, popularity, chapters, volumes, genres, manga_status FROM manga ${whereClause} ORDER BY ${orderBy}`;

      // 先查总数
      const countSql = `SELECT COUNT(*) as total FROM manga ${whereClause}`;
      
      let bindings = [];
      if (q) bindings.push(`%${q}%`);
      if (genre) bindings.push(`%"${genre}"%`);
      if (format) bindings.push(format);

      const countResult = await env.DB.prepare(countSql).bind(...bindings).first();
      let total = countResult?.total || 0;

      // 查数据
      sql += ` LIMIT ? OFFSET ?`;
      bindings.push(limit, offset);
      const { results } = await env.DB.prepare(sql).bind(...bindings).all();

      // 按地区过滤（JS 侧）
      let filtered = results;
      if (region === 'japanese') filtered = results.filter(m => getRegion(m) === 'japanese');
      else if (region === 'korean') filtered = results.filter(m => getRegion(m) === 'korean');

      // 如果地区过滤了，需要重新计算 total
      if (region) total = filtered.length;

      return json({
        data: filtered,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    }

    // GET /api/manga/:id — 详情
    if (method === 'GET' && path.match(/^\/api\/manga\/(\d+)$/)) {
      const id = path.match(/^\/api\/manga\/(\d+)$/)[1];
      const manga = await env.DB.prepare('SELECT * FROM manga WHERE id = ?').bind(parseInt(id)).first();
      if (!manga) return json({ error: 'not found' }, 404);

      if (manga.genres && typeof manga.genres === 'string') {
        try { manga.genres = JSON.parse(manga.genres); } catch {}
      }

      const collection = await env.DB.prepare('SELECT * FROM collections WHERE manga_id = ?').bind(parseInt(id)).first();
      const { results: altSources } = await env.DB.prepare('SELECT * FROM fix_alt WHERE manga_id = ? ORDER BY chapters DESC').bind(parseInt(id)).all();

      return json({ ...manga, collection: collection || null, alt_sources: altSources || [] });
    }

    // GET /api/genres
    if (method === 'GET' && path === '/api/genres') {
      const genres = await getAllGenres(env);
      return json(genres);
    }

    // GET /api/regions
    if (method === 'GET' && path === '/api/regions') {
      const { results } = await env.DB.prepare('SELECT title_native FROM manga').all();
      let jp = 0, kr = 0;
      for (const m of results) {
        getRegion(m) === 'korean' ? kr++ : jp++;
      }
      return json([
        { id: 'japanese', label: '🇯🇵 日漫', count: jp },
        { id: 'korean', label: '🇰🇷 韩漫', count: kr },
      ]);
    }

    // GET /api/suggestions
    if (method === 'GET' && path === '/api/suggestions') {
      const q = url.searchParams.get('q') || '';
      let data;
      if (q && q.length > 1) {
        const { results } = await env.DB.prepare(
          'SELECT id, title_romaji, title_english, cover_url, score, format FROM manga WHERE title_romaji LIKE ? OR title_english LIKE ? ORDER BY popularity DESC LIMIT 10'
        ).bind(`%${q}%`, `%${q}%`).all();
        data = results;
      } else {
        const hot = await env.DB.prepare(
          'SELECT id, title_romaji, cover_url, score, format FROM manga ORDER BY popularity DESC LIMIT 6'
        ).all();
        const fresh = await env.DB.prepare(
          'SELECT id, title_romaji, cover_url, score, format FROM manga ORDER BY id DESC LIMIT 6'
        ).all();
        data = { hot: hot.results, fresh: fresh.results };
      }
      return json({ data });
    }

    // GET /api/recent
    if (method === 'GET' && path === '/api/recent') {
      const { results } = await env.DB.prepare(
        'SELECT id, title_romaji, title_english, cover_url, score, popularity, format FROM manga ORDER BY id DESC LIMIT 20'
      ).all();
      return json({ data: results });
    }

    // GET /api/stats
    if (method === 'GET' && path === '/api/stats') {
      const totalManga = (await env.DB.prepare('SELECT COUNT(*) as c FROM manga').first()).c || 0;
      const totalCollected = (await env.DB.prepare('SELECT COUNT(*) as c FROM collections').first()).c || 0;
      const { results: statusCounts } = await env.DB.prepare('SELECT status, COUNT(*) as count FROM collections GROUP BY status').all();
      
      // 前 10 类型（不能用 json_each，从 JS 算）
      const { results: allGenres } = await env.DB.prepare("SELECT genres FROM manga WHERE genres IS NOT NULL AND genres != '[]'").all();
      const genreCount = {};
      for (const r of allGenres) {
        try { JSON.parse(r.genres).forEach(g => { const t = g.trim(); if (t) genreCount[t] = (genreCount[t] || 0) + 1; }); } catch {}
      }
      const topGenres = Object.entries(genreCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([genre, count]) => ({ genre, count }));

      return json({ totalManga, totalCollected, statusCounts, topGenres });
    }

    // GET /api/my-collections
    if (method === 'GET' && path === '/api/my-collections') {
      const status = url.searchParams.get('status') || '';
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const offset = (page - 1) * limit;

      let where = 'WHERE 1=1';
      let params = [];
      if (status) { where += ' AND c.status = ?'; params.push(status); }

      const total = (await env.DB.prepare(`SELECT COUNT(*) as t FROM collections c ${where}`).bind(...params).first()).t || 0;
      const { results } = await env.DB.prepare(
        `SELECT c.*, m.title_romaji, m.title_english, m.title_native, m.cover_url, m.format, m.chapters, m.volumes, m.score as ms, m.genres FROM collections c JOIN manga m ON m.id = c.manga_id ${where} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`
      ).bind(...params, limit, offset).all();

      return json({ data: results, total, page, totalPages: Math.ceil(total / limit) });
    }

    // POST /api/collection — 添加/更新收藏
    if (method === 'POST' && path === '/api/collection') {
      const body = await request.json();
      const { manga_id, status = 'plan_to_read', score = null, progress = 0, notes = '' } = body;
      if (!manga_id) return json({ error: 'no id' }, 400);

      const existing = await env.DB.prepare('SELECT id FROM collections WHERE manga_id = ?').bind(manga_id).first();
      if (existing) {
        await env.DB.prepare(
          "UPDATE collections SET status = ?, score = ?, progress = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE manga_id = ?"
        ).bind(status, score, progress, notes, manga_id).run();
      } else {
        await env.DB.prepare(
          "INSERT INTO collections(manga_id, status, score, progress, notes) VALUES(?, ?, ?, ?, ?)"
        ).bind(manga_id, status, score, progress, notes).run();
      }
      return json({ ok: 1 });
    }

    // DELETE /api/collection/:id
    if (method === 'DELETE' && path.match(/^\/api\/collection\/(\d+)$/)) {
      const id = path.match(/^\/api\/collection\/(\d+)$/)[1];
      await env.DB.prepare('DELETE FROM collections WHERE manga_id = ?').bind(parseInt(id)).run();
      return json({ ok: 1 });
    }

    // ============ MangaDex 代理相关 ============

    // GET /api/dex/search/:id — 搜索 MangaDex 映射
    if (method === 'GET' && path.match(/^\/api\/dex\/search\/(\d+)$/)) {
      const id = parseInt(path.match(/^\/api\/dex\/search\/(\d+)$/)[1]);

      // 先查缓存
      const cached = await env.DB.prepare('SELECT * FROM dex_mapping WHERE manga_id = ?').bind(id).first();
      if (cached) {
        let total = cached.total_chapters || 0;
        let readable = cached.readable_chapters || 0;
        if ((total === 0 || readable === 0) && cached.dex_id) {
          try {
            const feedRes = await fetch(`${DEX_API}/manga/${cached.dex_id}/feed?limit=0`, { headers: DEX_HEADERS });
            if (feedRes.ok) { const fd = await feedRes.json(); total = fd.total || 0; }
            if (total > 0) {
              for (let off = 0; off < 200 && off < total; off += 100) {
                const r = await fetch(`${DEX_API}/manga/${cached.dex_id}/feed?limit=100&offset=${off}`, { headers: DEX_HEADERS });
                if (!r.ok) break;
                const d = await r.json();
                for (const c of d.data || []) { if (c.attributes.pages > 0) readable++; }
              }
              await env.DB.prepare(
                'UPDATE dex_mapping SET total_chapters = ?, readable_chapters = ?, last_checked = ? WHERE manga_id = ?'
              ).bind(total, readable, new Date().toISOString(), id).run();
            }
          } catch {}
        }
        return json({
          found: true,
          manga: { id: cached.dex_id, title: cached.dex_title, status: readable > 0 ? '有内容' : '无内容', rating: null },
          chapterCount: total,
          hasReadableChapters: readable > 0,
          readableCount: readable,
        });
      }

      // 无缓存，在线搜索
      const manga = await env.DB.prepare('SELECT title_romaji, title_english, title_native FROM manga WHERE id = ?').bind(id).first();
      if (!manga) return json({ found: false });

      const terms = [manga.title_romaji, manga.title_english, manga.title_native].filter(Boolean);
      for (const t of [...terms]) {
        terms.push(t.replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g, '').trim());
        terms.push(t.split(/[:―–—]/)[0]?.trim());
      }
      const unique = [...new Set(terms.filter(Boolean))].slice(0, 6);

      let dexResult = null, chapterCount = 0, hasReadableChapters = false;
      for (const title of unique) {
        if (title.length < 2) continue;
        const r = await fetch(`${DEX_API}/manga?title=${encodeURIComponent(title)}&limit=20&order[relevance]=desc`, { headers: DEX_HEADERS });
        if (!r.ok) continue;
        const d = await r.json();
        if (d.data?.length) {
          let best = null, bestScore = 0;
          for (const c of d.data) {
            const s = scoreDexMatch(c, title);
            if (s > bestScore) { bestScore = s; best = c; }
          }
          if (!best || bestScore < 30) continue;
          const t = best.attributes.title;
          const final = t?.en || t?.ja || Object.values(best.attributes.altTitles?.[0] || {})[0] || title;
          dexResult = { id: best.id, title: final, rating: best.attributes.rating?.bayesian || null, status: best.attributes.status || null, score: bestScore };
          const feed = await fetch(`${DEX_API}/manga/${best.id}/feed?limit=0`, { headers: DEX_HEADERS });
          if (feed.ok) { const fd = await feed.json(); chapterCount = fd.total || 0; hasReadableChapters = chapterCount > 0; }
          try {
            await env.DB.prepare(
              'INSERT OR IGNORE INTO dex_mapping(manga_id, dex_id, dex_title, total_chapters, last_checked) VALUES(?, ?, ?, ?, ?)'
            ).bind(id, best.id, final, chapterCount, new Date().toISOString()).run();
          } catch {}
          break;
        }
      }
      return json({ found: !!dexResult, manga: dexResult, chapterCount, hasReadableChapters, searchTitles: unique });
    }

    // GET /api/dex/chapters/:dexId — 获取章节列表
    if (method === 'GET' && path.match(/^\/api\/dex\/chapters\/([a-f0-9-]+)$/)) {
      const dexId = path.match(/^\/api\/dex\/chapters\/([a-f0-9-]+)$/)[1];
      const offset = url.searchParams.get('offset') || '0';
      const limit = url.searchParams.get('limit') || '300';
      const r = await fetch(`${DEX_API}/manga/${dexId}/feed?order[chapter]=desc&limit=${limit}&offset=${offset}`, { headers: DEX_HEADERS });
      if (!r.ok) return json({ data: [] });
      const d = await r.json();
      const langNames = { en: '🇬🇧', zh: '🇨🇳', ja: '🇯🇵', ko: '🇰🇷', vi: '🇻🇳', fr: '🇫🇷', de: '🇩🇪', es: '🇪🇸', 'pt-br': '🇧🇷', id: '🇮🇩', th: '🇹🇭', ru: '🇷🇺', ar: '🇸🇦', it: '🇮🇹' };
      return json({
        data: (d.data || []).map(c => ({
          id: c.id, chapter: c.attributes.chapter, title: c.attributes.title,
          lang: langNames[c.attributes.translatedLanguage] || '🌐' + c.attributes.translatedLanguage,
          langCode: c.attributes.translatedLanguage,
          volume: c.attributes.volume,
          pages: c.attributes.pages, createdAt: c.attributes.createdAt,
        })),
        total: d.total || 0,
      });
    }

    // GET /api/dex/read/:chapterId — 获取阅读页
    if (method === 'GET' && path.match(/^\/api\/dex\/read\/([a-f0-9-]+)$/)) {
      const chapterId = path.match(/^\/api\/dex\/read\/([a-f0-9-]+)$/)[1];
      const r = await fetch(`${DEX_API}/at-home/server/${chapterId}`, { headers: DEX_HEADERS });
      if (!r.ok) return json({ error: 'not found' }, 404);
      const d = await r.json();
      return json({ baseUrl: d.baseUrl, hash: d.chapter.hash, pages: d.chapter.data });
    }

    // GET /api/dex/img/:hash/:filename — 代理 MangaDex 图片
    if (method === 'GET' && path.match(/^\/api\/dex\/img\/([^/]+)\/([^/]+)$/)) {
      const [, hash, filename] = path.match(/^\/api\/dex\/img\/([^/]+)\/([^/]+)$/);
      const urls = [];
      const base = url.searchParams.get('base');
      if (base) {
        const b = base.replace(/\/+$/, '');
        urls.push(`${b}/data/${hash}/${filename}`);
        urls.push(`${b}/data-saver/${hash}/${filename}`);
      }
      urls.push(`https://uploads.mangadex.org/data/${hash}/${filename}`);
      urls.push(`https://uploads.mangadex.org/data-saver/${hash}/${filename}`);
      urls.push(`https://mangadex.org/data/${hash}/${filename}`);
      urls.push(`https://mangadex.org/data-saver/${hash}/${filename}`);

      for (const imgUrl of urls) {
        try {
          const r = await fetch(imgUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Xingmanwu/1.0)' },
            signal: AbortSignal.timeout(15000),
          });
          if (!r.ok) continue;
          const blob = await r.blob();
          if (blob.size > 100) {
            return new Response(blob, {
              headers: { ...corsHeaders, 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=3600' },
            });
          }
        } catch {}
      }
      return new Response(null, { status: 404 });
    }

    // GET /api/ext/search/:id — 外部阅读源
    if (method === 'GET' && path.match(/^\/api\/ext\/search\/(\d+)$/)) {
      const id = path.match(/^\/api\/ext\/search\/(\d+)$/)[1];
      const manga = await env.DB.prepare('SELECT title_romaji, title_english, title_native FROM manga WHERE id = ?').bind(parseInt(id)).first();
      if (!manga) return json({ found: false });
      const title = manga.title_romaji || manga.title_english || '';
      const q = encodeURIComponent(title);
      const qJp = manga.title_native ? encodeURIComponent(manga.title_native) : q;
      return json({
        found: true, title,
        links: [
          { name: '🔍 Google', url: `https://www.google.com/search?q=${q}+read+online` },
          { name: '📖 MangaReader', url: `https://mangareader.to/search?keyword=${q}` },
          { name: '📖 MangaFire', url: `https://mangafire.to/search?q=${q}` },
          { name: '📖 Bato.to', url: `https://bato.to/search?word=${q}` },
          { name: '📖 Comick', url: `https://comick.io/search?q=${q}` },
          { name: '📖 更多源', url: `https://mangadex.org/search?q=${qJp}` },
        ],
      });
    }

    // GET /api/dex/alt-search/:id — 替代 MangaDex ID 搜索
    if (method === 'GET' && path.match(/^\/api\/dex\/alt-search\/(\d+)$/)) {
      const id = parseInt(path.match(/^\/api\/dex\/alt-search\/(\d+)$/)[1]);
      const manga = await env.DB.prepare('SELECT title_romaji, title_english, title_native, author FROM manga WHERE id = ?').bind(id).first();
      if (!manga) return json({ found: false });

      const terms = [manga.title_romaji, manga.title_english, manga.title_native].filter(Boolean);
      const simple = terms.map(t => t.split(/[:―–—]/)[0]?.trim()).filter(t => t && t.length > 3);
      const unique = [...new Set([...terms, ...simple].filter(Boolean))].slice(0, 5);

      let found = null;
      for (const title of unique) {
        if (title.length < 3) continue;
        const r = await fetch(`${DEX_API}/manga?title=${encodeURIComponent(title)}&limit=20&order[relevance]=desc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`, { headers: DEX_HEADERS });
        if (!r.ok) continue;
        const d = await r.json();
        if (!d.data?.length) continue;
        const current = await env.DB.prepare('SELECT dex_id FROM dex_mapping WHERE manga_id = ?').bind(id).first();
        const currentId = current?.dex_id || '';
        for (const c of d.data) {
          if (c.id === currentId) continue;
          const t = c.attributes.title;
          const displayTitle = t?.en || t?.ja || Object.values(c.attributes.altTitles?.[0] || {})[0] || title;
          try {
            const feedR = await fetch(`${DEX_API}/manga/${c.id}/feed?limit=0`, { headers: DEX_HEADERS, signal: AbortSignal.timeout(5000) });
            if (feedR.ok) { const fd = await feedR.json(); if (fd.total > 0) { found = { id: c.id, title: displayTitle, status: c.attributes.status || null, chapterCount: fd.total }; break; } }
          } catch {}
        }
        if (found) break;
        if (!found && d.data.length) {
          const first = d.data.find(c => c.id !== currentId);
          if (first) {
            const t = first.attributes.title;
            found = { id: first.id, title: t?.en || t?.ja || Object.values(first.attributes.altTitles?.[0] || {})[0] || title, status: first.attributes.status || null };
          }
        }
        if (found) break;
      }

      if (found) {
        try {
          const exists = await env.DB.prepare('SELECT * FROM dex_mapping WHERE manga_id = ?').bind(id).first();
          if (exists) {
            await env.DB.prepare('UPDATE dex_mapping SET dex_id = ?, total_chapters = ?, readable_chapters = 0, last_checked = ? WHERE manga_id = ?')
              .bind(found.id, found.chapterCount || 0, new Date().toISOString(), id).run();
          } else {
            await env.DB.prepare('INSERT INTO dex_mapping(manga_id, dex_id, dex_title, total_chapters, last_checked) VALUES(?, ?, ?, ?, ?)')
              .bind(id, found.id, found.title, found.chapterCount || 0, new Date().toISOString()).run();
          }
        } catch {}
      }
      return json({ found: !!found, alt: found, searchTitles: unique });
    }

    // POST /api/dex/alt-map — 手动映射替代 ID
    if (method === 'POST' && path === '/api/dex/alt-map') {
      const body = await request.json();
      const { manga_id, dex_id } = body;
      if (!manga_id || !dex_id) return json({ error: 'missing params' }, 400);
      const exists = await env.DB.prepare('SELECT * FROM dex_mapping WHERE manga_id = ?').bind(manga_id).first();
      if (exists) {
        await env.DB.prepare('UPDATE dex_mapping SET dex_id = ?, total_chapters = 0, readable_chapters = 0, last_checked = ? WHERE manga_id = ?')
          .bind(dex_id, new Date().toISOString(), manga_id).run();
      } else {
        await env.DB.prepare('INSERT INTO dex_mapping(manga_id, dex_id, dex_title, total_chapters, last_checked) VALUES(?, ?, ?, 0, ?)')
          .bind(manga_id, dex_id, '', new Date().toISOString()).run();
      }
      return json({ ok: 1 });
    }

    // GET /api/zero-chapters — 零章漫画列表
    if (method === 'GET' && path === '/api/zero-chapters') {
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const offset = (page - 1) * limit;
      const total = (await env.DB.prepare("SELECT COUNT(*) as c FROM manga WHERE (chapters IS NULL OR chapters = 0)").first()).c || 0;
      const { results } = await env.DB.prepare(
        'SELECT id, title_romaji, title_english, title_native, cover_url, format FROM manga WHERE (chapters IS NULL OR chapters = 0) ORDER BY popularity DESC LIMIT ? OFFSET ?'
      ).bind(limit, offset).all();
      return json({ data: results, total, page, totalPages: Math.ceil(total / limit) });
    }

    // POST /api/fix-alt — 记录替代源
    if (method === 'POST' && path === '/api/fix-alt') {
      const body = await request.json();
      const { manga_id, source, source_url, chapters = 0, source_title = '' } = body;
      await env.DB.prepare(
        "INSERT OR REPLACE INTO fix_alt(manga_id, source, source_url, chapters, source_title, updated_at) VALUES(?, ?, ?, ?, ?, datetime('now'))"
      ).bind(manga_id, source, source_url, chapters, source_title).run();
      return json({ ok: 1 });
    }

    // GET /api/fix-alt/:manga_id
    if (method === 'GET' && path.match(/^\/api\/fix-alt\/(\d+)$/)) {
      const mangaId = parseInt(path.match(/^\/api\/fix-alt\/(\d+)$/)[1]);
      const { results } = await env.DB.prepare('SELECT * FROM fix_alt WHERE manga_id = ? ORDER BY chapters DESC').bind(mangaId).all();
      return json(results || []);
    }

    // GET /api/fix-alt-summary
    if (method === 'GET' && path === '/api/fix-alt-summary') {
      const c = (await env.DB.prepare('SELECT COUNT(*) as c FROM fix_alt').first()).c || 0;
      const tc = (await env.DB.prepare('SELECT COALESCE(SUM(chapters), 0) as c FROM fix_alt').first()).c || 0;
      return json({ count: c, totalChapters: tc });
    }

    return json({ error: 'not found' }, 404);

  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
