// 星漫屋 MangaDex 补章脚本
// 对零章漫画逐部搜索 MangaDex，补充章节数据
// 用法: node fix_via_mangadex.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname);
const DATA_DIR = join(BASE_DIR, 'data');
const LOG_PATH = join(DATA_DIR, 'fix_mangadex.log');
const OUTPUT = join(DATA_DIR, 'fix_mangadex.json');

const DEX_API = 'https://api.mangadex.org';
const USER_AGENT = 'Xingmanwu/1.0';
const DEX_HEADERS = { 'User-Agent': USER_AGENT, 'Accept': 'application/json' };

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  try { writeFileSync(LOG_PATH, line + '\n', { flag: 'a' }); } catch {}
}

async function fetchJSON(url) {
  const r = await fetch(url, { headers: DEX_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function scoreMatch(candidate, titles) {
  const attrs = candidate.attributes;
  const allTitles = [];
  if (attrs.title?.en) allTitles.push(attrs.title.en.toLowerCase());
  if (attrs.title?.ja) allTitles.push(attrs.title.ja.toLowerCase());
  if (attrs.altTitles) {
    for (const at of attrs.altTitles) {
      for (const v of Object.values(at)) if (typeof v === 'string') allTitles.push(v.toLowerCase());
    }
  }
  const description = attrs.description?.en?.toLowerCase?.() || '';
  
  let bestScore = 0;
  for (const t of titles) {
    const tl = t.toLowerCase().trim();
    if (!tl || tl.length < 2) continue;
    
    // Exact match
    if (allTitles.some(at => at === tl)) return 100;
    
    // Starts with
    if (allTitles.some(at => at.startsWith(tl))) bestScore = Math.max(bestScore, 90);
    else if (allTitles.some(at => tl.startsWith(at))) bestScore = Math.max(bestScore, 85);
    
    // Contains
    if (allTitles.some(at => at.includes(tl) || tl.includes(at))) bestScore = Math.max(bestScore, 75);
    
    // Word match
    const words = tl.split(/[\s,;:.!?()\[\]{}]+/).filter(w => w.length > 2);
    for (const w of words) {
      if (allTitles.some(at => at.includes(w))) bestScore = Math.max(bestScore, 60);
    }
    
    // Description match
    if (tl.length > 5 && description.includes(tl)) bestScore = Math.max(bestScore, 50);
  }
  
  return bestScore;
}

async function searchDex(id, romaji, english, native) {
  const titles = [romaji, english, native].filter(Boolean).map(t => t.trim());
  const uniqueTitles = [...new Set(titles)];
  
  // Try each title as search query
  for (const title of uniqueTitles.slice(0, 5)) {
    if (!title || title.length < 2) continue;
    
    const encoded = encodeURIComponent(title);
    const url = `${DEX_API}/manga?title=${encoded}&limit=20&order[relevance]=desc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
    
    try {
      const d = await fetchJSON(url);
      if (!d.data?.length) continue;
      
      let best = null, bestScore = 0;
      for (const c of d.data) {
        const s = scoreMatch(c, uniqueTitles);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      
      if (best && bestScore >= 60) {
        const t = best.attributes.title;
        const displayTitle = t?.en || t?.ja || Object.values(best.attributes.altTitles?.[0] || {})[0] || title;
        
        // Get chapter count
        let chapterCount = 0;
        try {
          const feed = await fetchJSON(`${DEX_API}/manga/${best.id}/feed?limit=0`);
          chapterCount = feed.total || 0;
        } catch {}
        
        return { 
          dex_id: best.id, 
          dex_title: displayTitle, 
          chapters: chapterCount,
          score: bestScore,
          status: best.attributes.status || null,
          search_title: title
        };
      }
    } catch (e) {
      // continue to next title
    }
  }
  
  return null;
}

async function getChapters(dexId) {
  try {
    const d = await fetchJSON(`${DEX_API}/manga/${dexId}/feed?limit=500&order[chapter]=desc&translatedLanguage[]=en&translatedLanguage[]=zh`);
    return (d.data || []).map(c => ({
      chapter: c.attributes.chapter,
      title: c.attributes.title,
      lang: c.attributes.translatedLanguage,
      pages: c.attributes.pages,
      id: c.id
    }));
  } catch {
    return [];
  }
}

// ── Main ──
async function main() {
  log('='.repeat(45));
  log('🌟 星漫屋 MangaDex 补章器');
  log('='.repeat(45));

  // Load manga index
  const indexPath = join(DATA_DIR, 'manga_index.json');
  if (!existsSync(indexPath)) {
    log('❌ manga_index.json 不存在！先跑 export_zeros.mjs');
    return;
  }
  
  const manga = JSON.parse(readFileSync(indexPath, 'utf-8'));
  log(`📥 加载 ${manga.length} 部零章漫画`);

  // Load existing results for resume
  let results = [];
  if (existsSync(OUTPUT)) {
    try { results = JSON.parse(readFileSync(OUTPUT, 'utf-8')); } catch {}
  }
  
  const existingIds = new Set(results.map(r => r.manga_id));
  const remaining = manga.filter(m => !existingIds.has(m.id));
  log(`📋 已有 ${results.length} 部结果，还需处理 ${remaining.length} 部`);
  
  let found = results.length;
  let failed = 0;
  
  for (let i = 0; i < remaining.length; i++) {
    const m = remaining[i];
    const title = m.tr || m.te || m.tn || '?';
    
    if (i % 20 === 0) {
      log(`  ── ${i+1}/${remaining.length} | 已找到 ${found} 部`);
    }
    
    try {
      const dexResult = await searchDex(m.id, m.tr, m.te, m.tn);
      
      if (dexResult) {
        const chapters = await getChapters(dexResult.dex_id);
        results.push({
          manga_id: m.id,
          our_title: title.slice(0, 30),
          dex_id: dexResult.dex_id,
          dex_title: dexResult.dex_title,
          chapter_count: dexResult.chapters,
          has_readable: chapters.filter(c => c.pages > 0).length,
          status: dexResult.status,
          match_score: dexResult.score,
        });
        found++;
        
        if (found % 10 === 0) {
          log(`  ✅ 找到第 ${found} 部: ${title.slice(0,20)} → ${dexResult.dex_title} (${dexResult.chapters}章)`);
        }
      } else {
        failed++;
        // Save occasional checkpoints
        if (failed % 50 === 0) {
          log(`  ❌ 第 ${failed} 部未匹配: ${title.slice(0,20)}`);
        }
      }
    } catch (e) {
      log(`  ⚠️ 搜索失败: ${title.slice(0,20)}: ${e.message.slice(0,50)}`);
    }
    
    // Save every 10
    if ((i + 1) % 10 === 0 || i === remaining.length - 1) {
      writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
    }
    
    // Rate limit: 1 request per ~1.2s (MangaDex rate limit is ~5 req/s)
    await new Promise(r => setTimeout(r, 1200));
  }
  
  writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
  
  log('');
  log('🎉 完成！');
  log(`  总处理: ${manga.length} 部`);
  log(`  找到: ${found} 部`);
  log(`  未匹配: ${manga.length - found} 部`);
  log(`  总章节: ${results.reduce((s, r) => s + r.chapter_count, 0)}`);
}

main().catch(e => log(`❌ ${e.message}`));
