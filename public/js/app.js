// 部署 Worker 后把 URL 填这里，留空则跳过
const WORKER_URL = ''; // e.g. 'https://xingmanwu-proxy.xxx.workers.dev'

let st={page:'home',bp:1,cp:1};const $=id=>document.getElementById(id),api=async u=>(await fetch(u)).json(),post=(u,d)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}),del=u=>fetch(u,{method:'DELETE'});let sugTimer;
async function showSuggestions(){const q=document.getElementById('s').value.trim();if(q.length>1){filterSuggestions();return}try{const d=await api('/api/suggestions');renderSuggestions(d.data)}catch{}}
async function filterSuggestions(){clearTimeout(sugTimer);sugTimer=setTimeout(async()=>{const q=document.getElementById('s').value.trim();if(!q){showSuggestions();return}if(q.length<2){$('sd').style.display='none';return}try{const d=await api('/api/suggestions?q='+encodeURIComponent(q));renderFiltered(d.data)}catch{}},300)}
function renderSuggestions(d){if(!d){$('sd').style.display='none';return}$('sd').style.display='block';$('sd').innerHTML=(d.hot?.length?`<div class=sd-section>🔥 热门推荐</div>${d.hot.map(m=>sdItem(m)).join('')}`:'')+(d.fresh?.length?`<div class=sd-section>🆕 最新入库</div>${d.fresh.map(m=>sdItem(m)).join('')}`:'')||'<div style=padding:12px;text-align:center;color:var(--text-dim)>暂无推荐</div>'}
function renderFiltered(list){if(!list?.length){$('sd').style.display='none';return}$('sd').style.display='block';$('sd').innerHTML=`<div class=sd-section>🔍 搜索结果</div>${list.map(m=>sdItem(m)).join('')}`}
function sdItem(m){const t=(m.title_romaji||'').replace(/'/g,'\\u0027');return`<div class=sd-item onclick="searchSuggest('${t}')"><img src="${m.cover_url||''}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 28 38%22><rect fill=%22%23222%22 width=%2228%22 height=%2238%22/></svg>'" loading=lazy><span class=sd-title>${m.title_romaji||'未知'}</span>${m.score?`<span class=sd-score>⭐${m.score.toFixed(1)}</span>`:''}</div>`}
function searchSuggest(t){document.getElementById('s').value=t;$('sd').style.display='none';doSearch()}
function navigate(p){document.querySelectorAll('.page').forEach(e=>e.classList.remove('active'));const m={'home':'ph','browse':'pb','collections':'pc','stats':'ps'};$(m[p]||'ph').classList.add('active');st.page=p;window.scrollTo({top:0});if(p==='home')loadHome();if(p==='browse')loadBrowse();if(p==='collections')loadCollections();if(p==='stats')loadStats();}
function doSearch(){navigate('browse');st.bp=1;loadBrowse();}
async function loadHome(){try{const s=await api('/api/stats'),r=await api('/api/recent');$('hs').innerHTML=`<span>📚${(s.totalManga||0).toLocaleString()}部</span><span>❤️${s.totalCollected||0}部已收藏</span>`;renderGrid(r.data||[],'rg')}catch{$('hs').innerHTML='<span>⏳加载中</span>'}}
async function loadBrowse(){const g=$('bg');g.innerHTML='<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-dim)">⏳</div>';const s=$('ss').value,f=$('gf').value,f2=$('ff').value,r=$('rf').value,q=document.getElementById('s').value.trim();let u=`/api/manga?page=${st.bp}&limit=30&sort=${s}`;if(q)u+=`&q=${encodeURIComponent(q)}`;if(f)u+=`&genre=${encodeURIComponent(f)}`;if(f2)u+=`&format=${f2}`;if(r)u+=`&region=${r}`;try{const d=await api(u);renderGrid(d.data,'bg');renderPagination(d,'bp',p=>{st.bp=p;loadBrowse()})}catch{g.innerHTML='<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-dim)">❌</div>'}try{const gs=await api('/api/genres'),sel=$('gf');if(sel.options.length<=1)gs.forEach(g=>{const o=document.createElement('option');o.value=g;o.textContent=g;sel.appendChild(o)})}catch{}try{const rs=await api('/api/regions'),sel=$('rf');if(sel.options.length<=1)rs.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.label+' ('+r.count+')';sel.appendChild(o)})}catch{}}
async function loadCollections(){const l=$('cl'),p=$('cp');l.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-dim)">⏳</div>';const s=$('cs').value;let u=`/api/my-collections?page=${st.cp}&limit=30`;if(s)u+=`&status=${s}`;try{const d=await api(u);if(!d.data?.length){l.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-dim)">还没有收藏<br><br><button class="btn btn-primary" onclick=navigate(\'browse\')>去浏览</button></div>';p.innerHTML='';return}const sm={reading:'📖在看',completed:'✅看完',plan_to_read:'📌想看',on_hold:'⏸️搁置',dropped:'❌弃番'};l.innerHTML=d.data.map(i=>`<div class="collection-item" style="border-left:3px solid ${i.status==='reading'?'#4fc3f7':i.status==='completed'?'#81c784':i.status==='plan_to_read'?'#ffb74d':'#888'}">
<img class="mini-cover" src="${i.cover_url||''}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 140%22><rect fill=%22%23222%22 width=%22100%22 height=%22140%22/><text x=%2250%22 y=%2270%22 fill=%22%23666%22 font-size=%2230%22 text-anchor=%22middle%22>📚</text></svg>'">
<div class=col-info><div class=col-title>${i.title_romaji||'未知'}</div>
<div class=col-meta>${i.chapters?i.progress+'/'+i.chapters+'话':''}${i.score?'⭐'+i.score:''}</div></div>
<div class=col-actions>
<select class=col-status-select onchange="col(${i.manga_id},this.value)">${Object.entries(sm).map(([k,v])=>`<option value=${k} ${i.status===k?'selected':''}>${v}</option>`).join('')}</select>
<button class="btn btn-sm btn-secondary" onclick="view(${i.manga_id})">详情</button>
<button class="btn btn-sm btn-secondary" onclick="rm(${i.manga_id})">🗑️</button></div></div>`).join('');
renderPagination(d,'cp',p=>{st.cp=p;loadCollections()})}catch{l.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-dim)">❌</div>'}}
async function loadStats(){try{const s=await api('/api/stats');const sm={reading:'📖在看',completed:'✅看完',plan_to_read:'📌想看',on_hold:'⏸️搁置',dropped:'❌弃番'};let h=`<div class=stats-grid><div class=stat-card><div class=num>${(s.totalManga||0).toLocaleString()}</div><div class=label>📚漫画总数</div></div><div class=stat-card><div class=num>${s.totalCollected||0}</div><div class=label>❤️已收藏</div></div>${(s.statusCounts||[]).map(x=>`<div class=stat-card><div class=num>${x.count}</div><div class=label>${sm[x.status]||x.status}</div></div>`).join('')}</div>`;if(s.topGenres?.length){const mx=Math.max(...s.topGenres.map(g=>g.count));h+=`<div class=stats-chart><h3>🏷️热门类型TOP10</h3>${s.topGenres.map(g=>`<div class=bar-item><span class=bar-label>${g.genre}</span><div class=bar-track><div class=bar-fill style="width:${(g.count/mx)*100}%"></div></div><span class=bar-count>${g.count}</span></div>`).join('')}</div>`}$('sc').innerHTML=h}catch{$('sc').innerHTML='<div style="text-align:center;padding:40px;color:var(--text-dim)">⏳</div>'}}
function renderGrid(list,id){const e=$(id);if(!list?.length){e.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-dim)">暂无数据</div>';return}e.innerHTML=list.map(m=>`<div class=manga-card onclick="view(${m.id})"><img class=cover src="${m.cover_url||''}" loading=lazy onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 140%22><rect fill=%22%23222%22 width=%22100%22 height=%22140%22/><text x=%2250%22 y=%2270%22 fill=%22%23666%22 font-size=%2230%22 text-anchor=%22middle%22>📚</text></svg>'"><div class=info><div class=title>${m.title_romaji||'未知'}</div><div class=meta><span class=${m.score?'score':''}>${m.score?'⭐'+m.score.toFixed(1):'暂无'}</span><span>${m.chapters?m.chapters+'话':''}</span></div></div></div>`).join('')}
function renderPagination(d,id,fn){const e=$(id);if(!d.totalPages||d.totalPages<=1){e.innerHTML='';return}const p=d.page,tp=d.totalPages;let b=[];if(p>1)b.push({t:'◀',p:p-1});let s=Math.max(1,p-2),en=Math.min(tp,p+2);if(s>1){b.push({t:'1',p:1});if(s>2)b.push({t:'...'})}for(let i=s;i<=en;i++)b.push({t:String(i),p:i,a:i===p});if(en<tp){if(en<tp-1)b.push({t:'...'});b.push({t:String(tp),p:tp})}if(p<tp)b.push({t:'▶',p:p+1});e.innerHTML=`<div class=pagination-info>第 ${p} / ${tp} 页 · 共 ${d.total||0} 部</div><div class=pagination-btns>${b.map(b=>b.t==='...'?'<span style="color:var(--text-dim);padding:6px">...</span>':`<button class="${b.a?'active':''}" onclick="(${fn.toString()})(${b.p})">${b.t}</button>`).join('')}</div>`}



function slugify(t){return t.toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'')}
function extLinks(d){const t=d.title_romaji||d.title_english||'';if(!t)return'';const s=slugify(t);const e=encodeURIComponent(t);let h='<div class=ext-links><div class=ext-links-title>📖 外部阅读</div>';
// 如果服务器返回了 alt_sources（浏览器脚本查到的），优先显示
if(d.alt_sources?.length){for(const a of d.alt_sources){h+=`<a class="ext-link ext-link-found" href="${a.source_url}" target=_blank rel=noopener>${a.source} (${a.chapters}话)</a>`}}else{h+=`<a class="ext-link" href="https://comick.io/comic/${s}" target=_blank rel=noopener>Comick</a>`;h+=`<a class="ext-link" href="https://mangafire.to/manga/${s}" target=_blank rel=noopener>MangaFire</a>`}
h+=`<a class="ext-link" href="https://mangadex.org/search?q=${e}" target=_blank rel=noopener>MangaDex</a></div>`;
// 如果配了 Worker，异步查活数据
if(WORKER_URL&&!d.chapters&&!d.alt_sources?.length){fetch(WORKER_URL+'/check?q='+e).then(r=>r.json()).then(r=>{if(!r||!r.found||!r.sources)return;const el=$('mc').querySelector('.ext-links');if(!el)return;let h2='<div class=ext-links><div class=ext-links-title>📖 外部阅读</div>';for(const s of r.sources){if(s.chapters>0){h2+=`<a class="ext-link ext-link-found" href="${s.url}" target=_blank rel=noopener>${s.source} (${s.chapters}话)</a>`}else{h2+=`<a class="ext-link" href="${s.url}" target=_blank rel=noopener>${s.source}</a>`}}h2+=`<a class="ext-link" href="https://mangadex.org/search?q=${e}" target=_blank rel=noopener>MangaDex</a></div>`;el.outerHTML=h2}).catch(()=>{})}return h}

async function view(id){const m=$('modal'),c=$('mc');m.classList.add('active');document.body.style.overflow='hidden';c.innerHTML='<div style="text-align:center;padding:40px">⏳</div>';try{const d=await api('/api/manga/'+id),cl=d.collection||{};const sm={reading:'📖在看',completed:'✅看完',plan_to_read:'📌想看',on_hold:'⏸️搁置',dropped:'❌弃番'},fm={MANGA:'漫画',NOVEL:'小说',ONE_SHOT:'短篇',MANHWA:'韩漫',MANHUA:'国漫'},sn={FINISHED:'已完结',RELEASING:'连载中',NOT_YET_RELEASED:'未发布',CANCELLED:'已取消'};c.innerHTML=`<div class=modal-topbar><button class="btn btn-secondary btn-sm" onclick="closeModal()">← 返回</button><div class=modal-top-title>${d.title_romaji||'详情'}</div></div>${d.banner_url?`<img src=${d.banner_url} style=width:100%;max-height:300px;object-fit:cover onerror=this.style.display='none'>`:''}<button class=modal-close onclick=closeModal()>✕</button><div class=modal-body style=display:flex;gap:20px;flex-wrap:wrap><div style=width:180px;flex-shrink:0><img src=${d.cover_url} style=width:100%;border-radius:8px onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 280%22><rect fill=%22%23222%22 width=%22200%22 height=%22280%22/><text x=%22100%22 y=%22140%22 fill=%22%23666%22 font-size=%2240%22 text-anchor=%22middle%22>📚</text></svg>'"><div style=margin-top:12px>${
cl.id?`<select class=col-status-select style=width:100% onchange="col(${d.id},this.value)">${Object.entries(sm).map(([k,v])=>`<option value=${k} ${cl.status===k?'selected':''}>${v}</option>`).join('')}</select><button class="btn btn-sm btn-secondary" style="width:100%;margin-top:6px;background:rgba(229,115,115,.2);color:#e57373" onclick="rm(${d.id})">🗑️移除</button>`
:`<button class="btn btn-primary btn-sm" style=width:100%;padding:10px onclick="add(${d.id},'plan_to_read')">📌想看</button><button class="btn btn-primary btn-sm" style=width:100%;padding:10px;margin-top:6px onclick="add(${d.id},'reading')">📖在看</button>`}
<button class="btn btn-primary btn-sm" style=width:100%;padding:10px;margin-top:6px onclick="openReader(${d.id})">📖 在线阅读</button></div></div>
<div style=flex:1;min-width:200px><div class=detail-title>${d.title_romaji||'未知'}</div>${d.title_english?`<div class=detail-eng>${d.title_english}</div>`:''}${d.score?`<div class=detail-score>⭐${d.score.toFixed(1)}<small>/10</small></div>`:''}
<div class=detail-meta>${d.format?`<span class=tag>📋${fm[d.format]||d.format}</span>`:''}${d.manga_status?`<span class=tag>${sn[d.manga_status]||d.manga_status}</span>`:''}${d.chapters?`<span class=tag>📖${d.chapters}话</span>`:''}${d.volumes?`<span class=tag>📚${d.volumes}卷</span>`:''}${d.start_year?`<span class=tag>📅${d.start_year}</span>`:''}${d.popularity?`<span class=tag>🔥#${d.popularity}</span>`:''}${d.author?`<span class=tag>✍️${d.author}</span>`:''}</div>
${d.genres?.length?`<div class=genre-tags>${d.genres.map(g=>`<span class=tag>${g}</span>`).join('')}</div>`:''}
<div class=detail-desc>${d.description?d.description.slice(0,600)+(d.description.length>600?'...':''):'暂无简介'}</div>${extLinks(d)}</div></div>`}catch{c.innerHTML='<div style="text-align:center;padding:40px">❌</div>'}}

async function openReader(id){
  closeModal();
  const r=$('reader'),c=$('rc');
  r.classList.add('active');document.body.style.overflow='hidden';
  
  // Step 1: Try MangaDex first
  c.innerHTML='<div style=text-align:center;padding:40px>🔍 搜索资源...</div>';
  
  async function tryMangaDex(id){
    const dex=await api('/api/dex/search/'+id);
    if(!dex.found||!dex.manga) return null;
    if(!dex.hasReadableChapters) return {title:dex.manga.title,readable:[]};
    const ch=await api('/api/dex/chapters/'+dex.manga.id+'?limit=500');
    const readable=(ch.data||[]).filter(x=>x.pages>0);
    return {title:dex.manga.title,readable};
  }
  
  try{
    let result=await tryMangaDex(id);
    
    // If MangaDex found but no readable chapters, auto-retry with alternative ID
    if(result&&!result.readable.length){
      c.innerHTML='<div style=text-align:center;padding:40px>🔍 尝试其他版本...</div>';
      const alt=await api('/api/dex/alt-search/'+id);
      if(alt.found&&alt.alt){
        // New mapping auto-saved on server, re-try
        result=await tryMangaDex(id);
      }
    }
    
    // If still not found at all, try MangaDex search with alt
    if(!result){
      const alt=await api('/api/dex/alt-search/'+id);
      if(alt.found&&alt.alt){
        result=await tryMangaDex(id);
      }
    }
    
    if(!result||!result.readable.length){
      const ext=await api('/api/ext/search/'+id);
      const t=result?.title||'未知';
      c.innerHTML=`<div style=padding:20px><div class=reader-topbar><button class="btn btn-secondary btn-sm" onclick="closeReader()">← 返回</button><div class=r-title>${t}</div></div><div style=text-align:center><h3 style=margin-top:20px>📖 ${t}</h3><p style="margin:20px 0;color:var(--text-dim)">该作品暂无可读章节</p><p style="font-size:13px;color:var(--text-dim);margin-bottom:16px">试试在以下网站看：</p>${ext.links.map(l=>`<button class="btn btn-sm ${l.name.includes('Google')||l.name.includes('官译')?'btn-primary':'btn-secondary'}" style=margin:4px onclick="window.open('${l.url}')">${l.name}</button>`).join('')}<br><br><button class="btn btn-secondary" onclick="closeReader()">返回</button></div></div>`;
      return;
    }
    
    rd.chapterList=result.readable;
    
    const firstCh=result.readable[0];
    c.innerHTML=`<div style=padding:20px><div class=reader-topbar><button class="btn btn-secondary btn-sm" onclick="closeReader()">← 返回</button><div class=r-title>${result.title}</div></div><div class=detail-meta style=margin:12px><span class=tag>📖${result.readable.length}话</span></div>
      <div style=text-align:center;margin:10px 0>
        ${firstCh?`<button class="btn btn-primary" onclick="readChapter('dex:${firstCh.id}',0)">📖 阅读最新</button>`:''}
      </div>
      <div class=chapter-list>${result.readable.map((x,i)=>`<div class=chapter-item onclick="readChapter('dex:${x.id}',${i})"><span class=ch-num>第${x.chapter}话</span>${x.title?`<span class=ch-title>${x.title}</span>`:''}<span class=ch-lang>${x.lang}</span><span class=ch-pages>${x.pages}页</span></div>`).join('')}</div></div>`;
  }catch(e){c.innerHTML=`<div style=text-align:center;padding:40px>❌ 加载失败<br><br><button class="btn btn-secondary" onclick="closeReader()">返回</button></div>`}
}

// Reader state
let rd={cid:null,hash:'',baseUrl:'',pages:[],currentPage:0,chapterList:[],currentCh:0,mode:'single'};

async function readChapter(cid,chIdx){
  const p=$('rp'),pm=$('rm'),rc=$('rc');
  rc.style.display='none';p.style.display='block';
  const cidClean=cid.replace(/^dex:/,'');
  rd.cid=cidClean;
  pm.innerHTML='<button class="btn btn-secondary btn-sm" onclick="backToChapters()">← 列表</button><span style=margin-left:10px;color:var(--text-dim);font-size:13px>⏳ 加载中...</span>';
  p.innerHTML='<div style=text-align:center;padding:40px>⏳</div>';
  try{
    const d=await api('/api/dex/read/'+cidClean);
    if(!d.pages?.length){p.innerHTML='<div style=text-align:center;padding:40px>❌ 无法加载<br><br><button class="btn btn-secondary" onclick="backToChapters()">← 返回章节列表</button></div>';return}
    rd.hash=d.hash;rd.baseUrl=d.baseUrl;
    rd.pages=d.pages.map(pg=>({file:pg}));
    rd.currentPage=0;
    if(chIdx!==undefined)rd.currentCh=chIdx;
    renderPage();
  }catch(e){p.innerHTML=`<div style=text-align:center;padding:40px>❌ 加载失败<br><br><button class="btn btn-secondary" onclick="backToChapters()">← 返回</button></div>`}
}

function imgUrl(pg){
  return '/api/dex/img/'+rd.hash+'/'+pg.file+'?base='+encodeURIComponent(rd.baseUrl);
}

function renderPage(){
  const p=$('rp'),pm=$('rm');
  const total=rd.pages.length,idx=rd.currentPage;
  if(idx>=total||idx<0)return;
  
  const prevCh=rd.currentCh>0?rd.chapterList[rd.currentCh-1]:null;
  const nextCh=rd.currentCh<rd.chapterList.length-1?rd.chapterList[rd.currentCh+1]:null;
  
  pm.innerHTML=`<div style=display:flex;align-items:center;gap:8px;flex-wrap:wrap>
    <button class="btn btn-secondary btn-sm" onclick="backToChapters()">← 列表</button>
    ${prevCh?`<button class="btn btn-secondary btn-sm" onclick="readChapter('${'dex:'+prevCh.id}',${rd.currentCh-1})">◀ 上话</button>`:''}
    ${nextCh?`<button class="btn btn-secondary btn-sm" onclick="readChapter('${'dex:'+nextCh.id}',${rd.currentCh+1})">下话 ▶</button>`:''}
    <span style=flex:1></span>
    <span style=color:var(--text-dim);font-size:13px>${idx+1}/${total}页</span>
    <button class="btn btn-secondary btn-sm" onclick='rd.mode=rd.mode==="single"?"scroll":"single";renderPage()'>${rd.mode==='single'?'📖 滚动':'📄 单页'}</button>
    <button class="btn btn-secondary btn-sm" onclick="closeReader()">✕</button>
  </div>`;
  
  if(rd.mode==='single'){
    const pg=rd.pages[idx];
    p.style.cursor='pointer';
    p.innerHTML=`
      <div style=display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 60px);padding:10px;position:relative>
        <div style=position:absolute;left:0;top:0;bottom:0;width:35%;z-index:10 onclick="prevPage()"></div>
        <img src="${imgUrl(pg)}" 
          onerror="var t=this;if(!t.dataset.r){t.dataset.r=1;this.style.opacity='0.4'}else{t.style.opacity='0.2'}"
          style=max-width:100%;max-height:calc(100vh - 80px);object-fit:contain;border-radius:4px;box-shadow:0 2px 20px rgba(0,0,0,.3)>
        <div onclick="nextPage()" style=position:absolute;right:0;top:0;bottom:0;width:35%;z-index:10></div>
        <div onclick="nextPage()" style=position:absolute;bottom:20px;left:50%;transform:translateX(-50%);z-index:10;
          background:rgba(0,0,0,.5);color:var(--text);padding:4px 16px;border-radius:20px;font-size:13px;cursor:pointer>
          ${idx+1}/${total} ▸
        </div>
      </div>`;
  } else {
    p.style.cursor='';
    p.innerHTML=rd.pages.map((pg,i)=>`
      <div class=reader-page style=text-align:center;padding:4px 0>
        <div style=color:var(--text-dim);font-size:11px;padding:4px>${i+1}/${total}</div>
        <img src="${imgUrl(pg)}" 
          onerror="var t=this;if(!t.dataset.r){t.dataset.r=1;this.style.opacity='0.4'}else{t.style.opacity='0.2'}"
          style=width:100%;max-width:800px;display:block;margin:0 auto;border-radius:4px>
      </div>`).join('');
    window.scrollTo({top:0});
  }
}

function nextPage(){
  if(rd.currentPage<rd.pages.length-1){
    rd.currentPage++;
    renderPage();
  } else {
    const nextCh=rd.currentCh<rd.chapterList.length-1?rd.chapterList[rd.currentCh+1]:null;
    if(nextCh) readChapter('dex:'+nextCh.id,rd.currentCh+1);
  }
}
function prevPage(){
  if(rd.currentPage>0){
    rd.currentPage--;
    renderPage();
  }
}

function backToChapters(){
  $('rc').style.display='block';$('rp').style.display='none';
  $('rm').innerHTML=`<button class="btn btn-secondary btn-sm" onclick="closeReader()">← 返回</button>`;
  rd={cid:null,hash:'',baseUrl:'',pages:[],currentPage:0,chapterList:[],currentCh:0,mode:'single'};
}
function closeReader(){$('reader').classList.remove('active');document.body.style.overflow='';$('rc').innerHTML='';$('rp').innerHTML='';$('rm').innerHTML='';$('modal').classList.remove('active')}
function closeModal(){$('modal').classList.remove('active');$('reader').classList.remove('active');document.body.style.overflow=''}
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeModal();closeReader()}
  if(e.key==='ArrowRight'||e.key===' '){e.preventDefault();if($('reader').classList.contains('active'))nextPage()}
  if(e.key==='ArrowLeft'){e.preventDefault();if($('reader').classList.contains('active'))prevPage()}
  if(e.key==='ArrowDown'){$('reader').querySelector('.reader-inner')?.scrollBy({top:400,behavior:'smooth'})}
  if(e.key==='ArrowUp'){$('reader').querySelector('.reader-inner')?.scrollBy({top:-400,behavior:'smooth'})}
});
async function add(id,s){await post('/api/collection',{manga_id:id,status:s});if(st.page==='collections')loadCollections();view(id)}
async function col(id,s){await post('/api/collection',{manga_id:id,status:s});if(st.page==='collections')loadCollections()}
async function rm(id){if(!confirm('确定移除？'))return;await del('/api/collection/'+id);closeModal();if(st.page==='collections')loadCollections()}
loadHome();
