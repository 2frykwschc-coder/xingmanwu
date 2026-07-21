// 星漫屋 Cloudflare Pages Functions — 完整 API
// 每次 commit push 后 Cloudflare 自动部署

const DEX_API = 'https://api.mangadex.org';
const DEX_HEADERS = { 'User-Agent': 'Xingmanwu/1.0 (Cloudflare Pages)' };

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');
  const parts = path.split('/').filter(Boolean);
  const m = request.method;
  const db = env.DB;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (m === 'OPTIONS') return new Response(null, { headers: cors });

  const j = (d, s = 200) => new Response(JSON.stringify(d), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

  try {
    // ============ 已有端点 ============

    // -- /api/stats --
    if (m === 'GET' && path === 'stats') {
      const [r1, r2, r3] = await Promise.all([
        db.prepare('SELECT COUNT(*) c FROM manga').all(),
        db.prepare('SELECT COUNT(*) c FROM collections').all(),
        db.prepare('SELECT COUNT(*) c FROM users').all(),
      ]);
      return j({
        totalManga: r1.results[0]?.c || 0,
        totalCollected: r2.results[0]?.c || 0,
        totalUsers: r3.results[0]?.c || 0,
        statusCounts: [],
        topGenres: [],
      });
    }

    // -- /api/genres --
    if (m === 'GET' && path === 'genres') {
      const { results } = await db
        .prepare("SELECT genres FROM manga WHERE genres IS NOT NULL AND genres != '[]'")
        .all();
      const s = new Set();
      for (const r of results) {
        try { JSON.parse(r.genres).forEach(g => g && s.add(g.trim())); } catch {}
      }
      return j([...s].sort());
    }

    // -- /api/recent --
    if (m === 'GET' && path === 'recent') {
      const r = await db
        .prepare('SELECT id,title_romaji,title_english,title_native,cover_url,score,popularity,format FROM manga ORDER BY id DESC LIMIT 20')
        .all();
      return j({ data: r.results });
    }

    // -- /api/manga (列表) --
    if (m === 'GET' && parts[0] === 'manga' && !parts[1]) {
      const sort = url.searchParams.get('sort') || 'popularity';
      const genre = url.searchParams.get('genre') || '';
      const format = url.searchParams.get('format') || '';
      const region = url.searchParams.get('region') || '';
      const q = url.searchParams.get('q') || '';
      const pg = parseInt(url.searchParams.get('page') || '1');
      const lim = parseInt(url.searchParams.get('limit') || '30');
      const off = (pg - 1) * lim;

      let where = [],
        params = [];
      if (q) {
        const esc = `%${q.replace(/'/g, "''")}%`;
        where.push(
          '(title_romaji LIKE ? OR title_english LIKE ? OR title_native LIKE ?)'
        );
        params.push(esc, esc, esc);
      }
      if (genre) {
        where.push('genres LIKE ?');
        params.push(`%"${genre.replace(/'/g, "''")}"%`);
      }
      if (format) {
        where.push("format = ?");
        params.push(format);
      }

      let orderBy = 'popularity DESC NULLS LAST';
      if (sort === 'score') orderBy = 'score DESC NULLS LAST';
      else if (sort === 'year') orderBy = 'start_year DESC NULLS LAST';
      else if (sort === 'title') orderBy = 'title_romaji ASC';
      else if (sort === 'favorites') orderBy = 'favorites DESC NULLS LAST';

      const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const countQuery = 'SELECT COUNT(*) as c FROM manga ' + wc;
      const dataQuery =
        'SELECT id,title_romaji,title_english,title_native,cover_url,format,score,popularity,chapters,volumes,genres,manga_status FROM manga ' +
        wc +
        ' ORDER BY ' +
        orderBy +
        ' LIMIT ? OFFSET ?';

      const [dRes, cRes] = await Promise.all([
        db.prepare(dataQuery).bind(...params, lim, off).all(),
        db.prepare(countQuery).bind(...params).all(),
      ]);
      const total = cRes.results[0]?.c || 0;

      let data = dRes.results;
      // 地区过滤（本地过滤）
      if (region) {
        data = data.filter(m => {
          const nt = m.title_native || '';
          const r =
            nt.match(/[\uAC00-\uD7AF]/) ? 'korean' : 'japanese';
          return r === region;
        });
        // 如果过滤后数量不对，重新查会麻烦，暂简单处理
      }

      return j({
        data,
        total,
        page: pg,
        totalPages: Math.ceil(total / lim),
      });
    }

    // -- /api/manga/:id (详情) --
    if (m === 'GET' && parts[0] === 'manga' && parts[1]) {
      const id = parseInt(parts[1]);
      const [mr, cr] = await Promise.all([
        db.prepare('SELECT * FROM manga WHERE id=?').bind(id).all(),
        db.prepare('SELECT * FROM collections WHERE manga_id=?').bind(id).all(),
      ]);
      if (!mr.results.length) return j({ error: 'not found' }, 404);
      const manga = mr.results[0];
      try { manga.genres = JSON.parse(manga.genres || '[]'); } catch { manga.genres = []; }
      const col = cr.results[0] || null;

      // 查替代源
      let altSources = [];
      try {
        const fa = await db
          .prepare('SELECT * FROM fix_alt WHERE manga_id=? ORDER BY chapters DESC')
          .bind(id)
          .all();
        altSources = fa.results || [];
      } catch {}

      return j({ ...manga, collection: col, alt_sources: altSources });
    }

    // -- /api/suggestions --
    if (m === 'GET' && path === 'suggestions') {
      const q = url.searchParams.get('q') || '';
      if (q && q.length > 1) {
        const esc = `%${q.replace(/'/g, "''")}%`;
        const r = await db
          .prepare(
            'SELECT id,title_romaji,title_english,cover_url,score,format FROM manga WHERE title_romaji LIKE ? OR title_english LIKE ? ORDER BY popularity DESC LIMIT 10'
          )
          .bind(esc, esc)
          .all();
        return j({ data: r.results });
      }
      const [hot, fresh] = await Promise.all([
        db
          .prepare(
            'SELECT id,title_romaji,cover_url,score,format FROM manga ORDER BY popularity DESC NULLS LAST LIMIT 6'
          )
          .all(),
        db
          .prepare(
            'SELECT id,title_romaji,cover_url,score,format FROM manga ORDER BY id DESC LIMIT 6'
          )
          .all(),
      ]);
      return j({ data: { hot: hot.results, fresh: fresh.results } });
    }

    // -- /api/regions --
    if (m === 'GET' && path === 'regions') {
      const all = await db
        .prepare('SELECT title_native FROM manga WHERE title_native IS NOT NULL AND title_native != ""')
        .all();
      let jp = 0,
        kr = 0;
      for (const r of all.results) {
        const nt = r.title_native || '';
        if (nt.match(/[\uAC00-\uD7AF]/)) kr++;
        else jp++;
      }
      return j([
        { id: 'japanese', label: '🇯🇵 日漫', count: jp },
        { id: 'korean', label: '🇰🇷 韩漫', count: kr },
      ]);
    }

    // ============ MangaDex 搜索 ============

    // -- GET /api/dex/search/:id (查 MangaDex 映射 + 实时章节数) --
    if (m === 'GET' && parts[0] === 'dex' && parts[1] === 'search' && parts[2]) {
      const id = parseInt(parts[2]);
      const cached = await db
        .prepare('SELECT * FROM dex_mapping WHERE manga_id=?')
        .bind(id)
        .all();
      const cm = cached.results[0];
      if (cm) {
        let total = cm.total_chapters || 0;
        let readable = cm.readable_chapters || 0;
        const dexId = cm.dex_id;
        if ((total === 0 || readable === 0) && dexId) {
          try {
            const feedR = await fetch(`${DEX_API}/manga/${dexId}/feed?limit=0`, {
              headers: DEX_HEADERS,
            });
            if (feedR.ok) {
              const fd = await feedR.json();
              total = fd.total || 0;
            }
            if (total > 0) {
              readable = 0;
              for (let off = 0; off < 200 && off < total; off += 100) {
                const r = await fetch(
                  `${DEX_API}/manga/${dexId}/feed?limit=100&offset=${off}`,
                  { headers: DEX_HEADERS }
                );
                if (!r.ok) break;
                const d = await r.json();
                for (const c of d.data || []) {
                  if (c.attributes.pages > 0) readable++;
                }
              }
              try {
                await db
                  .prepare(
                    'UPDATE dex_mapping SET total_chapters=?, readable_chapters=?, last_checked=? WHERE manga_id=?'
                  )
                  .bind(total, readable, new Date().toISOString(), id)
                  .run();
              } catch {}
            }
          } catch {}
        }
        return j({
          found: true,
          manga: {
            id: dexId,
            title: cm.dex_title || '',
            status: readable > 0 ? '有内容' : '无内容',
            rating: null,
          },
          chapterCount: total,
          hasReadableChapters: readable > 0,
          readableCount: readable,
        });
      }

      // 没有缓存 — 按标题搜索
      const mRow = await db
        .prepare('SELECT title_romaji,title_english,title_native FROM manga WHERE id=?')
        .bind(id)
        .all();
      if (!mRow.results.length) return j({ found: false });
      const mangaRow = mRow.results[0];
      const terms = [
        mangaRow.title_romaji,
        mangaRow.title_english,
        mangaRow.title_native,
      ].filter(Boolean);
      for (const t of [...terms]) {
        terms.push(
          t.replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g, '').trim()
        );
        terms.push(t.split(/[:―–—]/)[0]?.trim());
      }
      const unique = [...new Set(terms.filter(Boolean))].slice(0, 6);

      let dexResult = null,
        chapterCount = 0,
        hasReadable = false;
      for (const title of unique) {
        if (title.length < 2) continue;
        try {
          const r = await fetch(
            `${DEX_API}/manga?title=${encodeURIComponent(title)}&limit=20&order[relevance]=desc`,
            { headers: DEX_HEADERS }
          );
          if (!r.ok) continue;
          const d = await r.json();
          if (!d.data?.length) continue;
          let best = null,
            bestScore = 0;
          for (const c of d.data) {
            const s = scoreDexMatch(c, title);
            if (s > bestScore) {
              bestScore = s;
              best = c;
            }
          }
          if (!best || bestScore < 30) continue;
          const t = best.attributes.title;
          const finalTitle =
            t?.en || t?.ja || Object.values(best.attributes.altTitles?.[0] || {})[0] || title;
          dexResult = {
            id: best.id,
            title: finalTitle,
            rating: best.attributes.rating?.bayesian || null,
            status: best.attributes.status || null,
            score: bestScore,
          };
          const feed = await fetch(`${DEX_API}/manga/${best.id}/feed?limit=0`, {
            headers: DEX_HEADERS,
          });
          if (feed.ok) {
            const fd = await feed.json();
            chapterCount = fd.total || 0;
            hasReadable = chapterCount > 0;
          }
          try {
            await db
              .prepare(
                'INSERT OR IGNORE INTO dex_mapping(manga_id,dex_id,dex_title,total_chapters,last_checked) VALUES(?,?,?,?,?)'
              )
              .bind(id, best.id, finalTitle, chapterCount, new Date().toISOString())
              .run();
          } catch {}
          break;
        } catch {}
      }
      return j({
        found: !!dexResult,
        manga: dexResult,
        chapterCount,
        hasReadableChapters: hasReadable,
        searchTitles: unique,
      });
    }

    // -- GET /api/dex/chapters/:dexId --
    if (m === 'GET' && parts[0] === 'dex' && parts[1] === 'chapters' && parts[2]) {
      const dexId = parts[2];
      const offset = url.searchParams.get('offset') || '0';
      const limit = url.searchParams.get('limit') || '300';
      const r = await fetch(
        `${DEX_API}/manga/${dexId}/feed?order[chapter]=desc&limit=${limit}&offset=${offset}&translatedLanguage[]=en&translatedLanguage[]=zh&translatedLanguage[]=ja&translatedLanguage[]=ko`,
        { headers: DEX_HEADERS }
      );
      if (!r.ok) return j({ data: [] });
      const d = await r.json();
      const langNames = {
        en: '🇬🇧', zh: '🇨🇳', ja: '🇯🇵', ko: '🇰🇷', vi: '🇻🇳',
        fr: '🇫🇷', de: '🇩🇪', es: '🇪🇸', 'pt-br': '🇧🇷', id: '🇮🇩',
        th: '🇹🇭', ru: '🇷🇺', ar: '🇸🇦', it: '🇮🇹',
      };
      return j({
        data: (d.data || []).map(c => ({
          id: c.id,
          chapter: c.attributes.chapter,
          title: c.attributes.title,
          lang: langNames[c.attributes.translatedLanguage] || '🌐' + c.attributes.translatedLanguage,
          langCode: c.attributes.translatedLanguage,
          volume: c.attributes.volume,
          pages: c.attributes.pages,
          createdAt: c.attributes.createdAt,
        })),
        total: d.total || 0,
      });
    }

    // -- GET /api/dex/read/:chapterId (获取图片列表) --
    if (m === 'GET' && parts[0] === 'dex' && parts[1] === 'read' && parts[2]) {
      const chapterId = parts[2];
      const r = await fetch(`${DEX_API}/at-home/server/${chapterId}`, {
        headers: DEX_HEADERS,
      });
      if (!r.ok) return j({ error: 'not found' }, 404);
      const d = await r.json();
      return j({
        baseUrl: d.baseUrl,
        hash: d.chapter.hash,
        pages: d.chapter.data,
      });
    }

    // -- GET /api/dex/img/:hash/:filename (代理图片) --
    if (m === 'GET' && parts[0] === 'dex' && parts[1] === 'img' && parts[2] && parts[3]) {
      const hash = parts[2];
      const filename = parts[3];
      const base = url.searchParams.get('base') || '';

      const urls = [];
      const baseClean = base.replace(/\/+$/, '');
      if (baseClean) {
        urls.push(`${baseClean}/data/${hash}/${filename}`);
        urls.push(`${baseClean}/data-saver/${hash}/${filename}`);
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
              headers: {
                'Content-Type': r.headers.get('content-type') || 'image/jpeg',
                'Cache-Control': 'public, max-age=3600',
                ...cors,
              },
            });
          }
        } catch {}
      }
      return new Response(null, { status: 404 });
    }

    // -- GET /api/dex/alt-search/:id (替代 ID 搜索) --
    if (m === 'GET' && parts[0] === 'dex' && parts[1] === 'alt-search' && parts[2]) {
      const id = parseInt(parts[2]);
      const mRow = await db
        .prepare('SELECT title_romaji,title_english,title_native,author FROM manga WHERE id=?')
        .bind(id)
        .all();
      if (!mRow.results.length) return j({ found: false });
      const manga = mRow.results[0];
      const terms = [manga.title_romaji, manga.title_english, manga.title_native].filter(Boolean);
      const simple = terms
        .map(t => t.split(/[:―–—]/)[0]?.trim())
        .filter(t => t && t.length > 3);
      const unique = [...new Set([...terms, ...simple].filter(Boolean))].slice(0, 5);

      // 获取当前已映射的 ID（避免重复）
      const cur = await db
        .prepare('SELECT dex_id FROM dex_mapping WHERE manga_id=?')
        .bind(id)
        .all();
      const currentId = cur.results[0]?.dex_id || '';

      let found = null;
      for (const title of unique) {
        if (title.length < 3) continue;
        try {
          const r = await fetch(
            `${DEX_API}/manga?title=${encodeURIComponent(title)}&limit=20&order[relevance]=desc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`,
            { headers: DEX_HEADERS }
          );
          if (!r.ok) continue;
          const d = await r.json();
          if (!d.data?.length) continue;

          // 按章节数排序：先找有章节的
          const candidates = [];
          for (const c of d.data) {
            if (c.id === currentId) continue;
            const t = c.attributes.title;
            const displayTitle = t?.en || t?.ja || Object.values(c.attributes.altTitles?.[0] || {})[0] || title;
            try {
              const feedR = await fetch(`${DEX_API}/manga/${c.id}/feed?limit=0`, {
                headers: DEX_HEADERS,
                signal: AbortSignal.timeout(5000),
              });
              if (feedR.ok) {
                const fd = await feedR.json();
                const total = fd.total || 0;
                candidates.push({ id: c.id, title: displayTitle, status: c.attributes.status || null, chapterCount: total });
              }
            } catch {}
          }
          // 按章节数降序
          candidates.sort((a, b) => b.chapterCount - a.chapterCount);
          if (candidates.length > 0) {
            found = candidates[0];
            break;
          }
          // 备选：只取第一个
          if (d.data.length) {
            const first = d.data.find(c => c.id !== currentId);
            if (first) {
              const t = first.attributes.title;
              found = {
                id: first.id,
                title: t?.en || t?.ja || Object.values(first.attributes.altTitles?.[0] || {})[0] || title,
                status: first.attributes.status || null,
              };
              break;
            }
          }
        } catch {}
      }

      if (found) {
        try {
          const existing = await db
            .prepare('SELECT * FROM dex_mapping WHERE manga_id=?')
            .bind(id)
            .all();
          if (existing.results.length) {
            await db
              .prepare(
                'UPDATE dex_mapping SET dex_id=?, total_chapters=?, readable_chapters=0, last_checked=? WHERE manga_id=?'
              )
              .bind(found.id, found.chapterCount || 0, new Date().toISOString(), id)
              .run();
          } else {
            await db
              .prepare(
                'INSERT INTO dex_mapping(manga_id,dex_id,dex_title,total_chapters,last_checked) VALUES(?,?,?,?,?)'
              )
              .bind(id, found.id, found.title, found.chapterCount || 0, new Date().toISOString())
              .run();
          }
        } catch {}
      }

      return j({ found: !!found, alt: found, searchTitles: unique });
    }

    // -- POST /api/dex/alt-map (保存替代映射) --
    if (m === 'POST' && path === 'dex/alt-map') {
      const body = await request.json();
      const { manga_id, dex_id } = body;
      if (!manga_id || !dex_id) return j({ error: 'missing params' }, 400);
      const existing = await db
        .prepare('SELECT * FROM dex_mapping WHERE manga_id=?')
        .bind(manga_id)
        .all();
      if (existing.results.length) {
        await db
          .prepare(
            'UPDATE dex_mapping SET dex_id=?, total_chapters=0, readable_chapters=0, last_checked=? WHERE manga_id=?'
          )
          .bind(dex_id, new Date().toISOString(), manga_id)
          .run();
      } else {
        await db
          .prepare(
            'INSERT INTO dex_mapping(manga_id,dex_id,dex_title,total_chapters,last_checked) VALUES(?,?,?,0,?)'
          )
          .bind(manga_id, dex_id, '', new Date().toISOString())
          .run();
      }
      return j({ ok: 1 });
    }

    // ============ 收藏系统 ============

    // -- GET /api/my-collections --
    if (m === 'GET' && path === 'my-collections') {
      const status = url.searchParams.get('status') || '';
      const pg = parseInt(url.searchParams.get('page') || '1');
      const lim = parseInt(url.searchParams.get('limit') || '30');
      const off = (pg - 1) * lim;

      let where = 'WHERE 1=1',
        params = [];
      if (status) {
        where += ' AND c.status=?';
        params.push(status);
      }

      const [cRes, dRes] = await Promise.all([
        db.prepare('SELECT COUNT(*) as c FROM collections c ' + where)
          .bind(...params).all(),
        db.prepare(
          `SELECT c.*, m.title_romaji, m.title_english, m.title_native, m.cover_url, m.format, m.chapters, m.volumes, m.score as ms, m.genres
           FROM collections c JOIN manga m ON m.id = c.manga_id ${where}
           ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`
        ).bind(...params, lim, off).all(),
      ]);

      const total = cRes.results[0]?.c || 0;
      return j({
        data: dRes.results,
        total,
        page: pg,
        totalPages: Math.ceil(total / lim),
      });
    }

    // -- POST /api/collection (添加/更新收藏) --
    if (m === 'POST' && path === 'collection') {
      const body = await request.json();
      const { manga_id, status, score, progress, notes } = body;
      if (!manga_id) return j({ error: 'no id' }, 400);

      const existing = await db
        .prepare('SELECT id FROM collections WHERE manga_id=?')
        .bind(manga_id)
        .all();

      if (existing.results.length) {
        await db
          .prepare(
            `UPDATE collections SET status=?, score=?, progress=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE manga_id=?`
          )
          .bind(
            status || 'plan_to_read',
            score || null,
            progress || 0,
            notes || '',
            manga_id
          )
          .run();
      } else {
        await db
          .prepare(
            'INSERT INTO collections(manga_id,status,score,progress,notes) VALUES(?,?,?,?,?)'
          )
          .bind(manga_id, status || 'plan_to_read', score || null, progress || 0, notes || '')
          .run();
      }
      return j({ ok: 1 });
    }

    // -- DELETE /api/collection/:id --
    if (m === 'DELETE' && parts[0] === 'collection' && parts[1]) {
      await db.prepare('DELETE FROM collections WHERE manga_id=?').bind(parseInt(parts[1])).run();
      return j({ ok: 1 });
    }

    // ============ 替代源 ============

    // -- POST /api/fix-alt --
    if (m === 'POST' && path === 'fix-alt') {
      const body = await request.json();
      const { manga_id, source, source_url, chapters, source_title } = body;
      if (!manga_id) return j({ error: 'no manga_id' }, 400);
      await db
        .prepare(
          `INSERT OR REPLACE INTO fix_alt(manga_id,source,source_url,chapters,source_title,updated_at)
           VALUES(?,?,?,?,?,datetime('now'))`
        )
        .bind(manga_id, source || '', source_url || '', chapters || 0, source_title || '')
        .run();
      return j({ ok: 1 });
    }

    // -- GET /api/fix-alt/:manga_id --
    if (m === 'GET' && parts[0] === 'fix-alt' && parts[1]) {
      const r = await db
        .prepare('SELECT * FROM fix_alt WHERE manga_id=? ORDER BY chapters DESC')
        .bind(parseInt(parts[1]))
        .all();
      return j(r.results || []);
    }

    // -- GET /api/fix-alt-summary --
    if (m === 'GET' && path === 'fix-alt-summary') {
      const r = await db.prepare('SELECT COUNT(*) as c, SUM(chapters) as tc FROM fix_alt').all();
      const row = r.results[0] || {};
      return j({ count: row.c || 0, totalChapters: row.tc || 0 });
    }

    // ============ 零章漫画列表 ============

    // -- GET /api/zero-chapters --
    if (m === 'GET' && path === 'zero-chapters') {
      const pg = parseInt(url.searchParams.get('page') || '1');
      const lim = parseInt(url.searchParams.get('limit') || '20');
      const off = (pg - 1) * lim;
      const [dRes, cRes] = await Promise.all([
        db
          .prepare(
            'SELECT id,title_romaji,title_english,title_native,cover_url,format FROM manga WHERE (chapters IS NULL OR chapters=0) ORDER BY popularity DESC LIMIT ? OFFSET ?'
          )
          .bind(lim, off)
          .all(),
        db
          .prepare(
            'SELECT COUNT(*) as c FROM manga WHERE (chapters IS NULL OR chapters=0)'
          )
          .all(),
      ]);
      const total = cRes.results[0]?.c || 0;
      return j({
        data: dRes.results,
        total,
        page: pg,
        totalPages: Math.ceil(total / lim),
      });
    }

    // ============ 外部源链接 ============

    // -- GET /api/ext/search/:id --
    if (m === 'GET' && parts[0] === 'ext' && parts[1] === 'search' && parts[2]) {
      const id = parseInt(parts[2]);
      const mRow = await db
        .prepare('SELECT title_romaji,title_english,title_native FROM manga WHERE id=?')
        .bind(id)
        .all();
      if (!mRow.results.length) return j({ found: false });
      const manga = mRow.results[0];
      const title = manga.title_romaji || manga.title_english || '';
      const q = encodeURIComponent(title);
      const qJp = manga.title_native ? encodeURIComponent(manga.title_native) : q;
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

      return j({
        found: true,
        title,
        links: [
          { name: '🔍 Google', url: `https://www.google.com/search?q=${q}+read+online` },
          { name: '📖 Comick', url: `https://comick.io/comic/${slug}` },
          { name: '📖 MangaFire', url: `https://mangafire.to/search?q=${q}` },
          { name: '📖 Bato.to', url: `https://bato.to/search?word=${q}` },
          { name: '📖 MangaDex', url: `https://mangadex.org/search?q=${qJp}` },
        ],
      });
    }

    // ============ 用户系统 ============

    // 自动建表
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT, last_login TEXT)").run();
      await db.prepare("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT)").run();
    } catch(e) {console.log('DB INIT ERROR:', e.message)}

    // -- POST /api/auth/register --
    if (m === 'POST' && path === 'auth/register') {
      const body = await request.json();
      const { username, password } = body;
      if (!username || !password) return j({ error: '需要用户名和密码' }, 400);
      if (username.length < 2 || username.length > 20) return j({ error: '用户名长度 2-20' }, 400);
      if (password.length < 4) return j({ error: '密码至少 4 位' }, 400);

      // 检查重复
      const existing = await db.prepare('SELECT id FROM users WHERE username=?').bind(username).all();
      if (existing.results.length) return j({ error: '用户名已存在' }, 409);

      // 密码哈希 (SHA-256 + salt)
      const salt = crypto.randomUUID().slice(0, 8);
      const enc = new TextEncoder();
      const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(password + salt));
      const hash = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));

      await db.prepare('INSERT INTO users(username,password_hash,salt) VALUES(?,?,?)').bind(username, hash, salt).run();

      // 生成 token
      const token = crypto.randomUUID();
      await db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').bind(token, db.lastRowId || 0).run();

      // 修正：查一下刚插入的 user id
      const userRow = await db.prepare('SELECT id FROM users WHERE username=?').bind(username).all();
      const userId = userRow.results[0]?.id;
      if (userId) {
        await db.prepare('DELETE FROM sessions WHERE user_id=? AND token!=?').bind(userId, token).run();
        await db.prepare('INSERT OR REPLACE INTO sessions(token,user_id) VALUES(?,?)').bind(token, userId).run();
      }

      await db.prepare('UPDATE users SET last_login=datetime("now") WHERE id=?').bind(userId).run();

      return j({ ok: true, token, user: { id: userId, username } });
    }

    // -- POST /api/auth/login --
    if (m === 'POST' && path === 'auth/login') {
      const body = await request.json();
      const { username, password } = body;
      if (!username || !password) return j({ error: '需要用户名和密码' }, 400);

      const userRow = await db.prepare('SELECT id,username,password_hash,salt FROM users WHERE username=?').bind(username).all();
      if (!userRow.results.length) return j({ error: '用户名或密码错误' }, 401);

      const user = userRow.results[0];
      const enc = new TextEncoder();
      const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(password + user.salt));
      const hash = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));

      if (hash !== user.password_hash) return j({ error: '用户名或密码错误' }, 401);

      // 生成新 token
      const token = crypto.randomUUID();
      await db.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
      await db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').bind(token, user.id).run();
      await db.prepare('UPDATE users SET last_login=datetime("now") WHERE id=?').bind(user.id).run();

      return j({ ok: true, token, user: { id: user.id, username: user.username } });
    }

    // -- GET /api/auth/me --
    if (m === 'GET' && path === 'auth/me') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace('Bearer ', '').trim();
      if (!token) return j({ user: null });

      const sessionRow = await db.prepare('SELECT s.user_id,u.username,u.created_at,u.last_login FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').bind(token).all();
      if (!sessionRow.results.length) return j({ user: null });

      const s = sessionRow.results[0];
      return j({ user: { id: s.user_id, username: s.username, createdAt: s.created_at, lastLogin: s.last_login } });
    }

    // -- POST /api/auth/delete-user (临时清理用) --
    if (m === 'POST' && path === 'auth/delete-user') {
      const body = await request.json();
      const { username, secret } = body;
      if (secret !== 'xingmanwu-cleanup') return j({ error: 'no' }, 403);
      if (!username) return j({ error: 'need username' }, 400);
      const u = await db.prepare('SELECT id FROM users WHERE username=?').bind(username).all();
      if (u.results.length) {
        await db.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.results[0].id).run();
        await db.prepare('DELETE FROM users WHERE id=?').bind(u.results[0].id).run();
      }
      return j({ ok: true, deleted: username });
    }

    // -- 兜底 --
    return j({ error: 'not found' }, 404);
  } catch (e) {
    return j({ error: e.message }, 500);
  }
}

// ---- MangaDex 标题匹配评分 ----
function scoreDexMatch(candidate, title) {
  const en = (candidate.attributes.title?.en || '').toLowerCase();
  const alt = (candidate.attributes.altTitles || [])
    .flatMap(a => Object.values(a))
    .filter(Boolean)
    .map(t => t.toLowerCase());
  const all = [en, ...alt];
  const tl = title.toLowerCase();
  if (all.some(t => t === tl)) return 100;
  if (en === tl || alt.some(t => t === tl)) return 90;
  if (all.some(t => t.startsWith(tl))) return 80;
  if (
    en.split(/[\s,;:.!?()\[\]{}]+/).some(w => w === tl) ||
    alt.some(t => t.split(/[\s,;:.!?()\[\]{}]+/).some(w => w === tl))
  )
    return 50;
  if (!tl.includes(' ') && en.includes(tl)) return 30;
  return 0;
}
