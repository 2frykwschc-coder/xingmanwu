// fix_mu.mjs — 从 MangaUpdates API 查零章漫画的章节数
// MangaUpdates 没有 Cloudflare，可以直接从这台机器访问
// 
// 用法: node fix_mu.mjs

import { initDB, default as db } from "./db.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "data", "fix_mu.txt");

const MU_API = "https://api.mangaupdates.com/v1/series";
const WAIT_MS = 1000;  // 每部间隔 1 秒（尊重 rate limit）
const BATCH_LOG = 5;   // 每 5 条输出一次

await initDB();

// 读状态
let checked = 0, fixed = 0;
let idx = 0;
if (fs.existsSync(STATE)) {
  const [c, f] = fs.readFileSync(STATE, "utf-8").trim().split(",").map(Number);
  checked = c || 0;
  fixed = f || 0;
} else {
  // 从 fix_alt 表恢复已找到数量
  const alt = db.get('SELECT COUNT(*)as c FROM fix_alt');
  fixed = alt?.c || 0;
}
console.log(`📋 续跑: 已查 ${checked}, 已找到 ${fixed}`);

// 获取所有零章漫画（不含已有替代源的）
let zeros;
console.log("📥 读取零章漫画列表...");

// 获取所有零章漫画（跳过已有替代源的）
const allZeros = db.all(
  `SELECT m.id, m.title_romaji, m.title_english, m.title_native 
   FROM manga m 
   WHERE (m.chapters IS NULL OR m.chapters=0)
   AND m.id NOT IN (SELECT manga_id FROM fix_alt)
   ORDER BY m.popularity DESC`
);
console.log(`📥 共 ${allZeros.length} 部零章漫画 (已跳过 ${(db.get('SELECT COUNT(*)as c FROM fix_alt')||{}).c||0} 部已有替代源的)`);

// 主循环
const startTime = Date.now();
let lastReport = Date.now();

for (let i = checked; i < allZeros.length; i++) {
  idx = i;
  const m = allZeros[i];
  const title = m.title_romaji || m.title_english || m.title_native;
  if (!title || title.length < 2) {
    checked++;
    continue;
  }

  try {
    // Step 1: 搜索 MangaUpdates
    const searchRes = await fetch(`${MU_API}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ search: title, perPage: 3 }),
      signal: AbortSignal.timeout(10000)
    });

    if (!searchRes.ok) {
      checked++;
      await sleep(WAIT_MS);
      continue;
    }

    const searchData = await searchRes.json();
    const results = searchData?.results || [];
    
    // 找最匹配的
    let bestMatch = null;
    let bestScore = 0;
    const tl = title.toLowerCase();

    for (const r of results) {
      const rec = r.record;
      const rt = (rec.title || "").toLowerCase();
      
      // 计算匹配分数
      let score = 0;
      if (rt === tl) score = 100;
      else if (rt.startsWith(tl) || tl.startsWith(rt)) score = 80;
      else if (rt.includes(tl) || tl.includes(rt)) score = 60;
      else {
        const words = tl.split(/\s+/);
        const matchWords = words.filter(w => rt.includes(w) && w.length > 2);
        score = (matchWords.length / words.length) * 50;
      }

      if (rec.type === "Manga" || rec.type === "Manhwa" || rec.type === "Manhua") {
        score += 10; // 优先漫画类型
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = rec;
      }
    }

    if (!bestMatch || bestScore < 30) {
      checked++;
      await sleep(WAIT_MS);
      continue;
    }

    // Step 2: 获取系列详情（拿 latest_chapter）
    const detailRes = await fetch(`${MU_API}/${bestMatch.series_id}`, {
      headers: { "User-Agent": "Xingmanwu/1.0" },
      signal: AbortSignal.timeout(10000)
    });

    if (!detailRes.ok) {
      checked++;
      await sleep(WAIT_MS);
      continue;
    }

    const detail = await detailRes.json();
    const chapters = detail.latest_chapter || 0;

    if (chapters > 0) {
      // 存到 fix_alt 表
      const sourceUrl = `https://www.mangaupdates.com/series/${bestMatch.url?.split("/").pop() || bestMatch.series_id}`;
      db.run(
        "INSERT OR REPLACE INTO fix_alt(manga_id, source, source_url, chapters, source_title, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
        [m.id, "MangaUpdates", sourceUrl, chapters, bestMatch.title || title]
      );
      db.save();
      fixed++;
      console.log(`✅ #${i+1}: ${(title).slice(0,25).padEnd(25)} → MU (${chapters}话) ${bestMatch.title?.slice(0,25)}`);
    } else {
      // 0 章，不存
    }

    checked++;
  } catch(e) {
    // 超时/错误跳过
    checked++;
  }

  // 等待（避免 rate limit）
  await sleep(WAIT_MS);

  // 每 N 条保存状态
  if (checked % BATCH_LOG === 0 && fixed > 0) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const rate = (checked / (elapsed / 60)).toFixed(1);
    console.log(`  ── ${checked}/${allZeros.length} | fixed: ${fixed} | ${elapsed}s | ${rate}/min`);
    fs.writeFileSync(STATE, `${checked},${fixed}`);
  }
}

// 完成
const totalTime = Math.floor((Date.now() - startTime) / 1000);
console.log(`\n🎉 完成！`);
console.log(`  检查: ${checked}/${allZeros.length}`);
console.log(`  找到: ${fixed} 部`);
console.log(`  用时: ${Math.floor(totalTime/60)}分${totalTime%60}秒`);
fs.writeFileSync(STATE, `${checked},${fixed}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
