export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');
  const parts = path.split('/').filter(Boolean);
  const m = request.method;
  const db = env.DB;
  
  if (m === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  
  const j = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' } });
  
  try {
    // stats
    if (m === 'GET' && path === 'stats') {
      const [r1, r2] = await Promise.all([db.prepare('SELECT COUNT(*) c FROM manga').all(), db.prepare('SELECT COUNT(*) c FROM dex_mapping').all()]);
      return j({ totalManga: r1.results[0].c, totalCollected: 0, statusCounts: [], topGenres: [] });
    }
    
    // genres
    if (m === 'GET' && path === 'genres') {
      const { results } = await db.prepare("SELECT genres FROM manga WHERE genres IS NOT NULL AND genres != '[]'").all();
      const s = new Set();
      for (const r of results) { try { JSON.parse(r.genres).forEach(g => g && s.add(g.trim())); } catch {} }
      return j([...s].sort());
    }
    
    // recent
    if (m === 'GET' && path === 'recent') {
      const r = await db.prepare('SELECT * FROM manga ORDER BY id DESC LIMIT 48').all();
      return j({ data: r.results });
    }
    
    // manga list
    if (m === 'GET' && parts[0] === 'manga' && !parts[1]) {
      const sort = url.searchParams.get('sort') || 'popularity';
      const genre = url.searchParams.get('genre') || '';
      const format = url.searchParams.get('format') || '';
      const q = url.searchParams.get('q') || '';
      const pg = parseInt(url.searchParams.get('page') || '1');
      const lim = parseInt(url.searchParams.get('limit') || '30');
      const off = (pg - 1) * lim;
      
      let where = [], params = [];
      if (q) { const l = '%' + q.replace(/'/g, "''") + '%'; where.push('(title LIKE ? OR title_native LIKE ? OR author LIKE ?)'); params.push(l, l, l); }
      if (genre) { where.push('genres LIKE ?'); params.push('%' + genre.replace(/'/g, "''") + '%'); }
      if (format) { where.push("format='" + format.replace(/'/g, "''") + "'"); }
      
      let orderBy = 'popularity ASC NULLS LAST';
      if (sort === 'score') orderBy = 'score DESC NULLS LAST';
      else if (sort === 'year') orderBy = 'start_year DESC NULLS LAST';
      else if (sort === 'title') orderBy = 'title ASC';
      
      const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const d = await db.prepare('SELECT * FROM manga ' + wc + ' ORDER BY ' + orderBy + ' LIMIT ? OFFSET ?').bind(...params, lim, off).all();
      const cp = params.slice(0);
      const c = cp.length ? await db.prepare('SELECT COUNT(*) c FROM manga ' + wc).bind(...cp).all() : await db.prepare('SELECT COUNT(*) c FROM manga ' + wc).all();
      
      return j({ data: d.results, total: c.results[0].c, page: pg, totalPages: Math.ceil(c.results[0].c / lim), limit: lim });
    }
    
    // manga detail
    if (m === 'GET' && parts[0] === 'manga' && parts[1]) {
      const r = await db.prepare('SELECT * FROM manga WHERE id=?').bind(parseInt(parts[1])).all();
      if (!r.results.length) return j({ error: 'not found' }, 404);
      const mr = r.results[0];
      try { mr.genres = JSON.parse(mr.genres || '[]'); } catch { mr.genres = []; }
      return j({ ...mr, collection: null, suggestions: [] });
    }
    
    // suggestions
    if (m === 'GET' && path === 'suggestions') {
      const q = url.searchParams.get('q') || '';
      if (q) { const l = '%' + q.replace(/'/g, "''") + '%'; const r = await db.prepare('SELECT id,title,cover_url,score FROM manga WHERE title LIKE ? LIMIT 20').bind(l).all(); return j({ data: r.results }); }
      const [hot, fresh] = await Promise.all([
        db.prepare('SELECT id,title,cover_url,score FROM manga WHERE score IS NOT NULL ORDER BY score DESC NULLS LAST LIMIT 6').all(),
        db.prepare('SELECT id,title,cover_url,score FROM manga ORDER BY id DESC LIMIT 6').all()
      ]);
      return j({ data: { hot: hot.results, fresh: fresh.results } });
    }
    
    // regions
    if (m === 'GET' && path === 'regions') {
      const all = await db.prepare('SELECT id,title_native FROM manga WHERE title_native IS NOT NULL').all();
      let jp = 0, kr = 0;
      for (const r of all.results) {
        const nt = r.title_native || '';
        if (nt.match(/[\uAC00-\uD7AF]/)) kr++;
        else if (nt.match(/[\u4E00-\u9FFF]/)) jp++;
      }
      return j([{id:'jp',label:'日本',count:jp},{id:'kr',label:'韩国',count:kr},{id:'en',label:'欧美',count:0},{id:'other',label:'其他',count:0}]);
    }
    
    return j({error:'not found'}, 404);
  } catch(e) {
    return j({error:e.message}, 500);
  }
}
