// 批量资源探测: 给未探测漫画在 MangaDex 上找源, 结果写回线上 API
// 每次跑一个批次(默认300), 探测过的会从队列消失, 天然断点续跑
// 用法: node probe_res.mjs [batchSize]
const BASE = 'https://xingmanwu.pages.dev';
const KEY = 'xw-probe-7f2c9a41e6b8d305c17a4f9e2d8b0c63a5e1';
const DEX_API = 'https://api.mangadex.org';
const HEADERS = { 'User-Agent': 'Xingmanwu/1.0 (probe-res)' };

const BATCH = Math.min(parseInt(process.argv[2] || '300') || 300, 400);
const DELAY = 250;

function norm(s) {
  return String(s || '').toLowerCase().replace(/[―–—:;,.!?()[\]{}~]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function sharedWords(a, b) {
  const wa = norm(a).split(/\s+/).filter(w => w.length > 2);
  const wb = norm(b).split(/\s+/).filter(w => w.length > 2);
  return wa.filter(w => wb.includes(w));
}
function score(candidate, title) {
  const en = (candidate.attributes.title?.en || '').toLowerCase();
  const alt = (candidate.attributes.altTitles || []).flatMap(a => Object.values(a)).filter(Boolean).map(t => t.toLowerCase());
  const all = [en, ...alt];
  const tl = String(title || '').toLowerCase().trim();
  const ntl = norm(tl);
  if (!tl) return 0;
  if (all.some(t => norm(t) === ntl)) return 100;
  if (norm(en) === ntl || alt.some(t => norm(t) === ntl)) return 90;
  if (all.some(t => norm(t).startsWith(ntl) || ntl.startsWith(norm(t)))) return 70;
  const sw = sharedWords(en, tl);
  if (sw.length >= 2) return 60;
  if (sw.length === 1) return 40;
  if (!ntl.includes(' ') && en.includes(ntl)) return 30;
  return 0;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function dexSearch(term) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`${DEX_API}/manga?title=${encodeURIComponent(term)}&limit=10&order[relevance]=desc`, { headers: HEADERS, signal: ac.signal });
    clearTimeout(tid);
    if (r.status === 429) { await sleep(2000); return { retry: true }; }
    if (!r.ok) return {};
    return await r.json();
  } catch { clearTimeout(tid); return {}; }
}

async function tryMatch(entry) {
  const titles = [entry.title_romaji, entry.title_english, entry.title_native].filter(Boolean);
  const simple = titles.map(t => String(t).split(/[:―–—]/)[0]?.trim()).filter(t => t && t.length > 3);
  const terms = [...new Set([...titles, ...simple].filter(Boolean))].slice(0, 3);
  let best = null, bestScore = 0;
  for (const term of terms) {
    if (String(term).length < 2) continue;
    const d = await dexSearch(term);
    if (d.retry) { d2 = await dexSearch(term); continue; }
    if (!d.data?.length) continue;
    for (const cand of d.data) {
      for (const t of terms) {
        const s = score(cand, t);
        if (s > bestScore) { bestScore = s; best = cand; }
      }
    }
    if (bestScore === 0 && d.data[0]) {
      for (const t of terms) {
        if (sharedWords(d.data[0].attributes.title?.en || '', t).length >= 2) { best = d.data[0]; bestScore = 25; break; }
      }
    }
    if (bestScore >= 90) break;
  }
  if (!best || bestScore < 25) return { found: false };
  const t = best.attributes.title;
  const finalTitle = t?.en || t?.ja || '';
  let totalCh = 0;
  try {
    const feed = await fetch(`${DEX_API}/manga/${best.id}/feed?limit=0`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (feed.ok) { const fd = await feed.json(); totalCh = fd.total || 0; }
  } catch {}
  return { found: true, dex_id: best.id, dex_title: finalTitle, total: totalCh };
}

async function postResult(body) {
  try {
    await fetch(`${BASE}/api/probe/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Probe-Key': KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {}
}

const queueR = await fetch(`${BASE}/api/probe/queue?limit=${BATCH}`, { signal: AbortSignal.timeout(15000) });
const queue = (await queueR.json()).data || [];
if (!queue.length) { console.log('队列为空 — 全部探测完成 🎉'); process.exit(0); }
console.log(`本批 ${queue.length} 部 (未探测总数见下次队列)`);

let matched = 0, dead = 0, errs = 0;
const start = Date.now();
for (let i = 0; i < queue.length; i++) {
  const entry = queue[i];
  try {
    const res = await tryMatch(entry);
    if (res.found) { await postResult({ id: entry.id, found: true, ...res }); matched++; }
    else { await postResult({ id: entry.id, found: false }); dead++; }
  } catch { errs++; }
  if ((i + 1) % 25 === 0 || i === queue.length - 1) {
    const el = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`${i + 1}/${queue.length} | 找到源=${matched} 无源=${dead} 错误=${errs} | ${el}s`);
  }
  await sleep(DELAY);
}
console.log(`完成: ${queue.length} 部 | 找到源=${matched} 无源=${dead} 错误=${errs} | 共${((Date.now() - start) / 1000).toFixed(0)}s`);
