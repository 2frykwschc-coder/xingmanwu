// 星漫屋 爬虫系统 — 零章漫画章节补全工具
//
// 支持两个源：
//   - MangaUpdates (无 Cloudflare, 从本机可用)
//   - Comick API (有 Cloudflare, 需 VPS 或用户浏览器环境)
//
// 用法:
//   仅 MU 源:   node crawler.mjs
//   全部源:     node crawler.mjs --all
//   从第 N 部继续: state 自动续跑
//
// 环境要求: Node.js 18+, 需在星漫屋目录下运行

import { initDB, default as db } from "./db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, "data", "crawler.txt");
const LOG = path.join(__dirname, "data", "crawler.log");

const MU_API = "https://api.mangaupdates.com/v1/series";
const COMIK_API = "https://api.comick.io";

const WAIT_MS = 1500;       // 基本间隔
const SAVE_EVERY = 5;       // 每 5 部存一次
const MIN_CHAPTERS = 3;     // 少于这数不存（避免误匹配）

let checked = 0, fixed = 0;
let useComick = process.argv.includes("--all");

// ── 日志 ──
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
}

// ── 读状态 ──
function loadState() {
  if (fs.existsSync(STATE)) {
    const [c, f] = fs.readFileSync(STATE, "utf-8").trim().split(",").map(Number);
    checked = c || 0;
    fixed = f || 0;
  } else {
    fixed = (db.get("SELECT COUNT(*)as c FROM fix_alt")||{}).c || 0;
  }
  log(`📋 续跑: 已查 ${checked}, 已找到 ${fixed}, Comick=${useComick}`);
}

// ── 数据源 1: MangaUpdates ──
async function tryMU(manga) {
  const title = manga.title_romaji || manga.title_english || manga.title_native;
  if (!title || title.length < 2) return null;

  // 搜索
  const searchRes = await fetch(`${MU_API}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ search: title, perPage: 5 }),
    signal: AbortSignal.timeout(10000)
  });
  if (!searchRes.ok) return null;

  const searchData = await searchRes.json();
  const results = searchData?.results || [];
  if (!results.length) return null;

  // 找最佳匹配
  const tl = title.toLowerCase();
  let best = null, bestScore = 0;

  for (const r of results) {
    const rec = r.record;
    const rt = (rec.title || "").toLowerCase();
    let score = 0;
    
    if (rt === tl) score = 100;
    else if (rt.startsWith(tl) || tl.startsWith(rt)) score = 80;
    else if (rt.includes(tl) || tl.includes(rt)) score = 60;
    else {
      const words = tl.split(/\s+/).filter(w => w.length > 2);
      const matches = words.filter(w => rt.includes(w));
      score = words.length ? (matches.length / words.length) * 50 : 0;
    }
    
    // 优先漫画类型
    if (["Manga","Manhwa","Manhua"].includes(rec.type)) score += 10;
    
    if (score > bestScore) { bestScore = score; best = rec; }
  }

  if (!best || bestScore < 30) return null;

  // 获取详情（拿最新章数）
  const detailRes = await fetch(`${MU_API}/${best.series_id}`, {
    headers: { "User-Agent": "Xingmanwu/1.0" },
    signal: AbortSignal.timeout(10000)
  });
  if (!detailRes.ok) return null;

  const detail = await detailRes.json();
  const chapters = detail.latest_chapter || 0;
  if (chapters < MIN_CHAPTERS) return null;

  return {
    source: "MangaUpdates",
    source_url: `https://www.mangaupdates.com/series/${(best.url||"").split("/").pop() || best.series_id}`,
    chapters,
    source_title: best.title
  };
}

// ── 数据源 2: Comick API（需绕过 Cloudflare 的环境） ──
async function tryComick(manga) {
  const title = manga.title_romaji || manga.title_english || manga.title_native;
  if (!title) return null;

  const slug = title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!slug || slug.length < 2) return null;

  // 搜索漫画
  try {
    const searchRes = await fetch(`${COMIK_API}/comic/${slug}`, {
      headers: { "User-Agent": "Xingmanwu/1.0" },
      signal: AbortSignal.timeout(10000)
    });
    if (!searchRes.ok) {
      // 搜索模式
      const searchRes2 = await fetch(`${COMIK_API}/comic?q=${encodeURIComponent(title)}&limit=1`, {
        headers: { "User-Agent": "Xingmanwu/1.0" },
        signal: AbortSignal.timeout(10000)
      });
      if (!searchRes2.ok) return null;
      const data = await searchRes2.json();
      if (!data?.total) return null;
      const comp = data.data?.[0]?.comic || data[0]?.comic || data[0];
      if (!comp) return null;
      const hid = comp.hid || comp.slug;
      // 查章节数
      const chRes = await fetch(`${COMIK_API}/comic/${hid}/chapters?limit=1`, {
        headers: { "User-Agent": "Xingmanwu/1.0" },
        signal: AbortSignal.timeout(10000)
      });
      if (!chRes.ok) return null;
      const chData = await chRes.json();
      const totalCh = chData?.total || chData?.totalChapters || 0;
      if (totalCh < MIN_CHAPTERS) return null;
      return {
        source: "Comick",
        source_url: `https://comick.io/comic/${hid}`,
        chapters: totalCh,
        source_title: comp.title || title
      };
    }
    
    const comp = await searchRes.json();
    if (!comp) return null;
    const hid = comp.hid || comp.slug;
    const chRes = await fetch(`${COMIK_API}/comic/${hid}/chapters?limit=1`, {
      headers: { "User-Agent": "Xingmanwu/1.0" },
      signal: AbortSignal.timeout(10000)
    });
    if (!chRes.ok) return null;
    const chData = await chRes.json();
    const totalCh = chData?.total || chData?.totalChapters || 0;
    if (totalCh < MIN_CHAPTERS) return null;
    return {
      source: "Comick",
      source_url: `https://comick.io/comic/${hid}`,
      chapters: totalCh,
      source_title: comp.title || title
    };
  } catch {
    return null;
  }
}

// ── 写状态 ──
function saveState() {
  fs.writeFileSync(STATE, `${checked},${fixed}`);
}

// ── 主循环 ──
async function main() {
  await initDB();
  loadState();

  // 获取零章漫画（排除已有的）
  const allZeros = db.all(`
    SELECT m.id, m.title_romaji, m.title_english, m.title_native, m.popularity
    FROM manga m
    WHERE (m.chapters IS NULL OR m.chapters=0)
    AND m.id NOT IN (SELECT manga_id FROM fix_alt)
    ORDER BY m.popularity ASC
  `);

  log(`📥 共 ${allZeros.length} 部零章待查`);
  if (checked >= allZeros.length) {
    log("✅ 全部查完！");
    return;
  }

  const startTime = Date.now();
  let lastReport = Date.now();

  for (let i = checked; i < allZeros.length; i++) {
    const m = allZeros[i];
    const title = m.title_romaji || m.title_english || m.title_native || "?";
    let result = null;

    // Phase 1: MangaUpdates (always)
    result = await tryMU(m);
    await sleep(WAIT_MS);

    // Phase 2: Comick (if --all)
    if (!result && useComick) {
      result = await tryComick(m);
      await sleep(WAIT_MS);
    }

    if (result) {
      // 存到 fix_alt 表
      db.run(
        `INSERT OR REPLACE INTO fix_alt(manga_id, source, source_url, chapters, source_title, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [m.id, result.source, result.source_url, result.chapters, result.source_title || title]
      );
      
      // 也更新 manga 表里 chapters 字段
      db.run("UPDATE manga SET chapters=? WHERE id=? AND (chapters IS NULL OR chapters=0)", 
        [result.chapters, m.id]);
      
      db.save();
      fixed++;
      log(`✅ #${i+1}: ${title.slice(0,25).padEnd(25)} → ${result.source} (${result.chapters}话)`);
    } else {
      log(`  #${i+1}: ${title.slice(0,25).padEnd(25)} → 未找到`);
    }

    checked++;

    // 保存状态
    if (checked % SAVE_EVERY === 0) {
      saveState();
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const rate = elapsed > 0 ? (checked / (elapsed / 60)).toFixed(1) : "?";
      log(`  ── ${checked}/${allZeros.length} | fixed: ${fixed} | ${Math.floor(elapsed/60)}分${elapsed%60}秒 | ${rate}/min`);
    }
  }

  // 完成
  saveState();
  const totalTime = Math.floor((Date.now() - startTime) / 1000);
  log(`\n🎉 完成！`);
  log(`  检查: ${checked}/${allZeros.length}`);
  log(`  找到: ${fixed} 部`);
  log(`  用时: ${Math.floor(totalTime/60)}分${totalTime%60}秒`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(e => { log(`❌ 错误: ${e.message}`); process.exit(1); });
