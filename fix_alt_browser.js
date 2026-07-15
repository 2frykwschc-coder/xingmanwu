// ============================================================
// fix_alt_browser.mjs — 浏览器端云绕 Cloudflare 查源
// 用法：在你网站的详情页打开 F12 控制台，粘贴运行
// 注意：会批量查零章漫画，脚本自动跑，你让它挂后台就行
// ============================================================

const STEP = 20;       // 每批查 20 部
const WAIT = 2000;     // 每部间隔 2s（防封）
const API = window.location.origin;

// slug 化标题
const slug = t => t.toLowerCase()
  .replace(/[^a-z0-9\s-]/g,'')
  .replace(/\s+/g,'-').replace(/-+/g,'-')
  .replace(/^-|-$/g,'');

// POST 到服务器
const post = (url, data) => fetch(url, {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify(data)
});

// 查 Comick API（浏览器帮你过 Cloudflare ☁️）
async function checkComick(title, mangaId) {
  const s = slug(title);
  if (!s) return;
  
  try {
    // 1. 查漫画是否存在
    const r = await fetch(`https://api.comick.io/comic/${s}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return;
    
    const data = await r.json();
    if (!data || !data.id) return;
    
    const hid = data.hid || data.id;
    const slugStr = data.slug || s;
    
    // 2. 查章节数
    const chR = await fetch(`https://api.comick.io/comic/${hid}/chapters?limit=1`, {
      signal: AbortSignal.timeout(8000)
    });
    let chapters = 0;
    let chTitle = '';
    
    if (chR.ok) {
      const chData = await chR.json();
      if (Array.isArray(chData)) {
        chapters = chData.length;
        chTitle = chData[0]?.chap || '';
      } else if (chData.total) {
        chapters = chData.total;
        chTitle = chData.chapters?.[0]?.title || '';
      } else if (chData.limit && chData.total) {
        chapters = chData.total;
      }
    }
    
    if (chapters > 0) {
      const url = `https://comick.io/comic/${slugStr}`;
      console.log(`✅ ${title.slice(0,25).padEnd(25)} → Comick (${chapters}话) ${url}`);
      
      // 报告到服务器
      await post(API + '/api/fix-alt', {
        manga_id: mangaId,
        source: 'comick',
        source_url: url,
        chapters: chapters,
        source_title: data.title || s
      });
    }
  } catch(e) {
    // 超时/失败 跳过
  }
}

// 查 MangaFire（浏览器帮你过）
async function checkMangaFire(title, mangaId) {
  const e = encodeURIComponent(title);
  try {
    const r = await fetch(`https://mangafire.to/filter?keyword=${e}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return;
    
    const text = await r.text();
    const match = text.match(/window\.__INITIAL_STATE__\s*=\s*({[^<]+})/);
    if (match) {
      console.log(`🔍 ${title.slice(0,25).padEnd(25)} → MangaFire 查到页面`);
    }
  } catch(e) {}
}

// 主循环
async function run() {
  console.log('🔄 开始查零章漫画...');
  console.log(`每次 ${STEP} 部，每部间隔 ${WAIT/1000}s`);
  console.log('让它挂后台跑，不用管它');
  console.log('');
  
  let page = 1;
  let total = 0;
  let found = 0;
  
  while (true) {
    // 从服务器拿一批零章漫画
    const r = await fetch(`${API}/api/zero-chapters?page=${page}&limit=${STEP}`);
    if (!r.ok) break;
    const data = await r.json();
    const list = data.data || [];
    if (list.length === 0) break;
    
    for (const m of list) {
      await sleep(WAIT);
      const title = m.title_romaji || m.title_english;
      if (!title) continue;
      
      total++;
      process.stdout.write(`[${total}] ${title.slice(0,20)}... `);
      
      await checkComick(title, m.id);
      // await checkMangaFire(title, m.id); // 暂时关掉，MangaFire 是 SPA 解析麻烦
      
      if (m.id % 5 === 0) {
        process.stdout.write(`\n`);
      }
    }
    
    page++;
    
    // 每 5 页休息 10 秒
    if (page % 5 === 0) {
      console.log(`\n⏸️ 休息 10s（已查 ${total} 部）...`);
      await sleep(10000);
    }
  }
  
  console.log(`\n🎉 完成！共查 ${total} 部`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 启动
run().catch(e => console.error('❌', e));
