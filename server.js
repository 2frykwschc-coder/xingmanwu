import express from'express';import database,{initDB}from'./db.js';import{join,dirname}from'path';import{fileURLToPath}from'url';
const app=express();const PORT=3001;
const db = database;
const DEX_API = 'https://api.mangadex.org';

function getRegion(m){
  const nt=m.title_native||'';
  if(nt.match(/[\uAC00-\uD7AF]/))return'korean';
  return'japanese';
}

app.use(express.json());app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next()});app.use(express.static(join(dirname(fileURLToPath(import.meta.url)),'public')));

app.get('/api/manga',(req,res)=>{try{
  const{q,genre,format,region,sort='popularity',page='1',limit='30'}=req.query,off=(+page-1)*+limit;
  let w=[],p=[];
  if(q){w.push('(title_romaji LIKE ? OR title_english LIKE ?)');const l=`%${q}%`;p.push(l,l)}
  if(genre){w.push('genres LIKE ?');p.push(`%"${genre}"%`)}
  if(format){w.push('format=?');p.push(format)}
  const wc=w.length?'WHERE '+w.join(' AND '):'';
  const ord=({score:'score DESC',popularity:'popularity DESC',favorites:'favorites DESC',title:'title_romaji',year:'start_year DESC'})[sort]||'popularity DESC';
  const allRows=db.all(`SELECT id,title_romaji,title_english,title_native,cover_url,format,score,popularity,chapters,volumes,genres,manga_status FROM manga ${wc} ORDER BY ${ord}`,p);
  let filtered=allRows;
  if(region==='japanese')filtered=allRows.filter(m=>getRegion(m)==='japanese');
  else if(region==='korean')filtered=allRows.filter(m=>getRegion(m)==='korean');
  const total=filtered.length;
  const data=filtered.slice(off,off+ +limit);
  res.json({data,total,page:+page,totalPages:Math.ceil(total/+limit)});
}catch(e){res.json({data:[],total:0,page:1,totalPages:0})}});

function scoreDexMatch(candidate,title){
  const en=(candidate.attributes.title?.en||'').toLowerCase();
  const alt=(candidate.attributes.altTitles||[]).flatMap(a=>Object.values(a)).filter(Boolean).map(t=>t.toLowerCase());
  const all=[en,...alt];
  const tl=title.toLowerCase();
  if(all.some(t=>t===tl))return 100;
  if(en===tl||alt.some(t=>t===tl))return 90;
  if(all.some(t=>t.startsWith(tl)))return 80;
  if(en.split(/[\s,;:.!?()\[\]{}]+/).some(w=>w===tl)||alt.some(t=>t.split(/[\s,;:.!?()\[\]{}]+/).some(w=>w===tl)))return 50;
  if(!tl.includes(' ')&&en.includes(tl))return 30;
  return 0;
}
const DEX_HEADERS={'User-Agent':'Xingmanwu/1.0 (manga tracker)'};

// Check cached mapping first (instant lookup, with on-demand chapter count)
async function dexSearchCached(id){
  const m=db.get('SELECT * FROM dex_mapping WHERE manga_id=?',[id]);
  if(!m)return null;
  let total=m.total_chapters||0,readable=m.readable_chapters||0;
  // If no cached readable count, do on-demand fetch
  if((total===0||readable===0)&&m.dex_id){
    try{
      const dexId=m.dex_id;
      const feed=await fetch(`${DEX_API}/manga/${dexId}/feed?limit=0`,{headers:DEX_HEADERS});
      if(feed.ok){const fd=await feed.json();total=fd.total||0;}
      if(total>0){
        // Count readable chapters (first 200)
        for(let off=0;off<200&&off<total;off+=100){
          const r=await fetch(`${DEX_API}/manga/${dexId}/feed?limit=100&offset=${off}`,{headers:DEX_HEADERS});
          if(!r.ok)break;const d=await r.json();
          for(const c of d.data||[]){if(c.attributes.pages>0)readable++;}
        }
        // Save back to cache
        try{db.run('UPDATE dex_mapping SET total_chapters=?,readable_chapters=?,last_checked=? WHERE manga_id=?',[total,readable,new Date().toISOString(),id]);db.save()}catch{}
      }
    }catch{}
  }
  return{
    found:true,
    manga:{id:m.dex_id,title:m.dex_title,status:readable>0?'有内容':'无内容',rating:null},
    chapterCount:total,
    hasReadableChapters:readable>0,
    readableCount:readable
  };
}

app.get('/api/dex/search/:id',async(req,res)=>{
  try{
    // Try cached mapping first (instant)
    const cached=await dexSearchCached(req.params.id);
    if(cached)return res.json(cached);
    
    const m=db.get('SELECT title_romaji,title_english,title_native FROM manga WHERE id=?',[req.params.id]);
    if(!m)return res.json({found:false});
    const terms=[m.title_romaji,m.title_english,m.title_native].filter(Boolean);
    for(const t of[...terms]){
      terms.push(t.replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g,'').trim());
      terms.push(t.split(/[:―–—]/)[0]?.trim());
    }
    for(const t of[...terms].filter(Boolean)){
      const p=t.split(/[:―–—]/);
      if(p.length>1)terms.push(p[0].trim());
    }
    const unique=[...new Set(terms.filter(Boolean))].slice(0,6);
    let dexResult=null,chapterCount=0,hasReadableChapters=false;
    for(const title of unique){
      if(title.length<2)continue;
      const r=await fetch(`${DEX_API}/manga?title=${encodeURIComponent(title)}&limit=20&order[relevance]=desc`,{headers:DEX_HEADERS});
      if(!r.ok)continue;
      const d=await r.json();
      if(d.data?.length){
        let best=null,bestScore=0;
        for(const c of d.data){
          const s=scoreDexMatch(c,title);
          if(s>bestScore){bestScore=s;best=c;}
        }
        if(!best||bestScore<30)continue;
        const t=best.attributes.title;
        const final=t?.en||t?.ja||Object.values(best.attributes.altTitles?.[0]||{})[0]||title;
        dexResult={id:best.id,title:final,rating:best.attributes.rating?.bayesian||null,status:best.attributes.status||null,score:bestScore};
        const feed=await fetch(`${DEX_API}/manga/${best.id}/feed?limit=0`,{headers:DEX_HEADERS});
        if(feed.ok){const fd=await feed.json();chapterCount=fd.total||0;hasReadableChapters=chapterCount>0}
        // Auto-save to mapping table for future
        try{db.run('INSERT OR IGNORE INTO dex_mapping(manga_id,dex_id,dex_title,total_chapters,last_checked) VALUES(?,?,?,?,?)',[req.params.id,best.id,final,chapterCount,new Date().toISOString()]);db.save()}catch{}
        break;
      }
    }
    res.json({found:!!dexResult,manga:dexResult,chapterCount,hasReadableChapters,searchTitles:unique});
  }catch(e){res.json({found:false,error:e.message})}
});

app.get('/api/dex/chapters/:dexId',async(req,res)=>{
  try{
    const{offset='0',limit='300'}=req.query;
    const r=await fetch(`${DEX_API}/manga/${req.params.dexId}/feed?order[chapter]=desc&limit=${limit}&offset=${offset}`,{headers:DEX_HEADERS});
    if(!r.ok)return res.json({data:[]});
    const d=await r.json();
    const langNames={en:'🇬🇧',zh:'🇨🇳',ja:'🇯🇵',ko:'🇰🇷',vi:'🇻🇳',fr:'🇫🇷',de:'🇩🇪',es:'🇪🇸','pt-br':'🇧🇷',id:'🇮🇩',th:'🇹🇭',ru:'🇷🇺',ar:'🇸🇦',el:'🇬🇷',ca:'🇪🇸',it:'🇮🇹',nl:'🇳🇱',pl:'🇵🇱',ro:'🇷🇴',he:'🇮🇱',tr:'🇹🇷',fil:'🇵🇭'};
    res.json({data:(d.data||[]).map(c=>({
      id:c.id,chapter:c.attributes.chapter,title:c.attributes.title,
      lang:langNames[c.attributes.translatedLanguage]||'🌐'+c.attributes.translatedLanguage,
      langCode:c.attributes.translatedLanguage,
      volume:c.attributes.volume,
      pages:c.attributes.pages,createdAt:c.attributes.createdAt
    })),total:d.total||0});
  }catch(e){res.json({data:[],error:e.message})}
});

app.get('/api/dex/read/:chapterId',async(req,res)=>{
  try{
    const r=await fetch(`${DEX_API}/at-home/server/${req.params.chapterId}`,{headers:DEX_HEADERS});
    if(!r.ok)return res.status(404).json({error:'not found'});
    const d=await r.json();
    res.json({
      baseUrl:d.baseUrl,
      hash:d.chapter.hash,
      pages:d.chapter.data
    });
  }catch(e){res.json({error:e.message})}
});

// Proxy MangaDex images through our server (try multiple CDN sources)
app.get('/api/dex/img/:hash/:filename',async(req,res)=>{
  const{hash,filename}=req.params;
  const urls=[];
  // 1. Provided base URL
  if(req.query.base){
    const base=req.query.base.replace(/\/+$/,'');
    urls.push(`${base}/data/${hash}/${filename}`);
    // Also try with /data/ directly appended (some CDN URLs differ)
    urls.push(`${base}/data-saver/${hash}/${filename}`);
  }
  // 2. Try uploads CDN (MangaDex legacy)
  urls.push(`https://uploads.mangadex.org/data/${hash}/${filename}`);
  urls.push(`https://uploads.mangadex.org/data-saver/${hash}/${filename}`);
  // 3. Try with "uploads" removed (modern MangaDex CDN pattern)
  urls.push(`https://mangadex.org/data/${hash}/${filename}`);
  urls.push(`https://mangadex.org/data-saver/${hash}/${filename}`);
  
  for(const url of urls){
    try{
      const ac=new AbortController();
      const tm=setTimeout(()=>ac.abort(),15000);
      const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Xingmanwu/1.0)'},signal:ac.signal});
      clearTimeout(tm);
      if(!r.ok)continue;
      const buf=await r.arrayBuffer();
      if(buf.byteLength>100){
        res.set('Content-Type',r.headers.get('content-type')||'image/jpeg');
        res.set('Cache-Control','public,max-age=3600');
        return res.end(Buffer.from(buf));
      }
    }catch{}
  }
  res.status(404).end();
});

// External reading search - returns links to major reading sites
app.get('/api/ext/search/:id',async(req,res)=>{
  try{
    const m=db.get('SELECT title_romaji,title_english,title_native FROM manga WHERE id=?',[req.params.id]);
    if(!m)return res.json({found:false});
    const title=m.title_romaji||m.title_english||'';
    const q=encodeURIComponent(title);
    const qJp=m.title_native ? encodeURIComponent(m.title_native) : q;
    res.json({
      found:true,
      title,
      links:[
        {name:'🔍 Google', url:`https://www.google.com/search?q=${q}+read+online`},
        {name:'📖 MangaPlus (官译)', url:title.includes(' ') ? `https://mangaplus.shueisha.co.jp/search?q=${q}` : `https://mangaplus.shueisha.co.jp/search?q=${q}`},
        {name:'📖 MangaReader', url:`https://mangareader.to/search?keyword=${q}`},
        {name:'📖 MangaFire', url:`https://mangafire.to/search?q=${q}`},
        {name:'📖 Bato.to', url:`https://bato.to/search?word=${q}`},
        {name:'📖 Comick', url:`https://comick.io/search?q=${q}`},
        {name:'📖 更多源',url:`https://mangadex.org/search?q=${qJp}`}
      ]
    });
  }catch(e){res.json({found:false})}
});

// Alternative ID search: try to find another MangaDex ID for zero-chapter manga
app.get('/api/dex/alt-search/:id',async(req,res)=>{
  try{
    const m=db.get('SELECT title_romaji,title_english,title_native,author FROM manga WHERE id=?',[req.params.id]);
    if(!m)return res.json({found:false});
    const terms=[m.title_romaji,m.title_english,m.title_native].filter(Boolean);
    const simple=terms.map(t=>t.split(/[:―–—]/)[0]?.trim()).filter(t=>t&&t.length>3);
    const unique=[...new Set([...terms,...simple].filter(Boolean))].slice(0,5);
    let found=null;
    for(const title of unique){
      if(title.length<3)continue;
      const r=await fetch(`${DEX_API}/manga?title=${encodeURIComponent(title)}&limit=20&order[relevance]=desc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`,{headers:DEX_HEADERS});
      if(!r.ok)continue;
      const d=await r.json();
      if(!d.data?.length)continue;
      const current=db.get('SELECT dex_id FROM dex_mapping WHERE manga_id=?',[req.params.id]);
      const currentId=current?.dex_id||'';
      // Try each candidate, check if they have chapters
      for(const c of d.data){
        if(c.id===currentId)continue;
        const t=c.attributes.title;
        const displayTitle=t?.en||t?.ja||Object.values(c.attributes.altTitles?.[0]||{})[0]||title;
        // Quick check if it has chapters
        try{
          const feedR=await fetch(`${DEX_API}/manga/${c.id}/feed?limit=0`,{headers:DEX_HEADERS,signal:AbortSignal.timeout(5000)});
          if(feedR.ok){
            const fd=await feedR.json();
            if(fd.total>0){
              found={id:c.id,title:displayTitle,status:c.attributes.status||null,chapterCount:fd.total};
              break;
            }
          }
        }catch{}
      }
      if(found)break;
      // Fallback: just return the first candidate even without checking chapters
      if(!found&&d.data.length){
        const first=d.data.find(c=>c.id!==currentId);
        if(first){
          const t=first.attributes.title;
          found={id:first.id,title:t?.en||t?.ja||Object.values(first.attributes.altTitles?.[0]||{})[0]||title,status:first.attributes.status||null};
        }
      }
      if(found)break;
    }
    if(found){
      // Auto-save if we found chapters
      try{
        const e=db.get('SELECT * FROM dex_mapping WHERE manga_id=?',[req.params.id]);
        if(e){
          db.run('UPDATE dex_mapping SET dex_id=?,total_chapters=?,readable_chapters=0,last_checked=? WHERE manga_id=?',
            [found.id,found.chapterCount||0,new Date().toISOString(),req.params.id]);
        }else{
          db.run('INSERT INTO dex_mapping(manga_id,dex_id,dex_title,total_chapters,last_checked) VALUES(?,?,?,?,?)',
            [req.params.id,found.id,found.title,found.chapterCount||0,new Date().toISOString()]);
        }
        db.save();
      }catch{}
    }
    res.json({found:!!found,alt:found,searchTitles:unique});
  }catch(e){res.json({found:false,error:e.message})}
});

// Save an alternative MangaDex ID mapping (overwrites old one)
app.post('/api/dex/alt-map',(req,res)=>{
  try{
    const{manga_id,dex_id}=req.body;
    if(!manga_id||!dex_id)return res.status(400).json({error:'missing params'});
    const e=db.get('SELECT * FROM dex_mapping WHERE manga_id=?',[manga_id]);
    if(e){
      db.run('UPDATE dex_mapping SET dex_id=?,total_chapters=0,readable_chapters=0,last_checked=? WHERE manga_id=?',[dex_id,new Date().toISOString(),manga_id]);
    }else{
      db.run('INSERT INTO dex_mapping(manga_id,dex_id,dex_title,total_chapters,last_checked) VALUES(?,?,?,0,?)',[manga_id,dex_id,'',new Date().toISOString()]);
    }
    db.save();
    res.json({ok:1});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/regions',(req,res)=>{
  try{
    const r=db.all('SELECT title_native FROM manga');
    let jp=0,kr=0;
    for(const m of r){getRegion(m)==='korean'?kr++:jp++}
    res.json([{id:'japanese',label:'🇯🇵 日漫',count:jp},{id:'korean',label:'🇰🇷 韩漫',count:kr}])
  }catch(e){res.json([])}
});

app.get('/api/manga/:id',(req,res)=>{try{let m=db.get('SELECT*FROM manga WHERE id=?',[req.params.id]);if(!m)return res.status(404).json({error:'not found'});const c=db.get('SELECT*FROM collections WHERE manga_id=?',[req.params.id]);if(m.genres)try{m.genres=JSON.parse(m.genres)}catch{};const fa=db.all('SELECT*FROM fix_alt WHERE manga_id=?',[req.params.id]);res.json({...m,collection:c||null,alt_sources:fa||[]})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/genres',(req,res)=>{try{res.json(db.all("SELECT DISTINCT trim(value)as g FROM manga,json_each(genres)WHERE genres!='[]' ORDER BY g").map(r=>r.g).filter(Boolean))}catch(e){res.json([])}});
app.post('/api/collection',(req,res)=>{try{const{manga_id,status,score,progress,notes}=req.body;if(!manga_id)return res.status(400).json({error:'no id'});const e=db.get('SELECT id FROM collections WHERE manga_id=?',[manga_id]);e?db.run('UPDATE collections SET status=?,score=?,progress=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE manga_id=?',[status||'plan_to_read',score||null,progress||0,notes||'',manga_id]):db.run('INSERT INTO collections(manga_id,status,score,progress,notes)VALUES(?,?,?,?,?)',[manga_id,status||'plan_to_read',score||null,progress||0,notes||'']);db.save();res.json({ok:1})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/collection/:id',(req,res)=>{db.run('DELETE FROM collections WHERE manga_id=?',[req.params.id]);db.save();res.json({ok:1})});
app.get('/api/my-collections',(req,res)=>{try{const{status,page='1',limit='30'}=req.query,off=(+page-1)*+limit;let w='WHERE 1=1',p=[];if(status){w+=' AND c.status=?';p.push(status)}const t=(db.get(`SELECT COUNT(*)as t FROM collections c ${w}`,p)||{}).t||0,r=db.all(`SELECT c.*,m.title_romaji,m.title_english,m.title_native,m.cover_url,m.format,m.chapters,m.volumes,m.score as ms,m.genres FROM collections c JOIN manga m ON m.id=c.manga_id ${w} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,[...p,+limit,off]);res.json({data:r,total:t,page:+page,totalPages:Math.ceil(t/+limit)})}catch(e){res.json({data:[],total:0,page:1,totalPages:0})}});
app.get('/api/stats',(req,res)=>{try{const tm=(db.get('SELECT COUNT(*)as c FROM manga')||{}).c||0,tc=(db.get('SELECT COUNT(*)as c FROM collections')||{}).c||0,sc=db.all('SELECT status,COUNT(*)as count FROM collections GROUP BY status'),tg=db.all("SELECT trim(value)as genre,COUNT(*)as count FROM manga,json_each(genres)WHERE genres!='[]' GROUP BY genre ORDER BY count DESC LIMIT 10");res.json({totalManga:tm,totalCollected:tc,statusCounts:sc,topGenres:tg})}catch(e){res.json({totalManga:0,totalCollected:0,statusCounts:[],topGenres:[]})}});
app.get('/api/suggestions',(req,res)=>{try{const{q}=req.query;if(q&&q.length>1){const l=`%${q}%`;const r=db.all('SELECT id,title_romaji,title_english,cover_url,score,format FROM manga WHERE title_romaji LIKE ? OR title_english LIKE ? ORDER BY popularity DESC LIMIT 10',[l,l]);res.json({data:r})}else{const hot=db.all('SELECT id,title_romaji,cover_url,score,format FROM manga ORDER BY popularity DESC LIMIT 6');const fresh=db.all('SELECT id,title_romaji,cover_url,score,format FROM manga ORDER BY id DESC LIMIT 6');res.json({data:{hot,fresh}})}}catch(e){res.json({data:[]})}});
app.get('/api/recent',(req,res)=>{res.json({data:db.all('SELECT id,title_romaji,title_english,cover_url,score,popularity,format FROM manga ORDER BY id DESC LIMIT 20')})});

// ── 浏览器查源工具 API ──

// 返回零章漫画列表（给浏览器脚本用）
app.get('/api/zero-chapters',(req,res)=>{try{
  const{page='1',limit='20'}=req.query,off=(+page-1)*+limit;
  const total=(db.get('SELECT COUNT(*)as c FROM manga WHERE (chapters IS NULL OR chapters=0)')||{}).c||0;
  const data=db.all('SELECT id,title_romaji,title_english,title_native,cover_url,format FROM manga WHERE (chapters IS NULL OR chapters=0) ORDER BY popularity DESC LIMIT ? OFFSET ?',[+limit,off]);
  res.json({data,total,page:+page,totalPages:Math.ceil(total/+limit)});
}catch(e){res.json({data:[],total:0,page:1,totalPages:0})}});

// 接收浏览器脚本的查源结果
app.post('/api/fix-alt',(req,res)=>{try{
  const{manga_id,source,source_url,chapters,source_title}=req.body;
  db.run('INSERT OR REPLACE INTO fix_alt(manga_id,source,source_url,chapters,source_title,updated_at)VALUES(?,?,?,?,?,datetime(\"now\"))',[manga_id,source,source_url,chapters||0,source_title||'']);
  db.save();
  res.json({ok:1});
}catch(e){res.status(500).json({error:e.message})}});

// 获取某部漫画的所有替代源
app.get('/api/fix-alt/:manga_id',(req,res)=>{try{
  const r=db.all('SELECT * FROM fix_alt WHERE manga_id=? ORDER BY chapters DESC',[req.params.manga_id]);
  res.json(r||[]);
}catch(e){res.json([])}});

// 替代源统计摘要
app.get('/api/fix-alt-summary',(req,res)=>{try{
  const c=(db.get('SELECT COUNT(*)as c FROM fix_alt')||{}).c||0;
  const tc=(db.get('SELECT SUM(chapters)as c FROM fix_alt')||{}).c||0;
  res.json({count:c,totalChapters:tc});
}catch(e){res.json({count:0,totalChapters:0})}});

await initDB();app.listen(PORT,'0.0.0.0',()=>{console.log(`✨ 星漫屋 http://localhost:${PORT}`)});
