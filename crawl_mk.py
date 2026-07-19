# 星漫屋 MangaKatana 爬虫 — 从 MangaKatana 获取零章漫画的章节数据
# 用法: python3 crawl_mk.py
#
# 输出: data/crawl_mk.json — 供 Node.js 脚本导入 DB
# 
# 原理：
#   1. 遍历 MangaKatana 所有漫画列表页 (/page/1 ~ /page/N)
#   2. 建立标题→URL 映射
#   3. 与星漫屋 JSON 数据匹配
#   4. 匹配上的获取章节数据 → 输出 JSON

import cloudscraper, re, json, os, time, sys, urllib.request, urllib.parse
from difflib import SequenceMatcher

# ── 配置 ──
BASE_DIR = os.path.expanduser("~/.openclaw/workspace/sites/星漫屋")
MANGA_JSON = os.path.join(BASE_DIR, "data", "manga_index.json")  # 由 Node 预先生成
OUTPUT_JSON = os.path.join(BASE_DIR, "data", "crawl_mk.json")
STATE_PATH = os.path.join(BASE_DIR, "data", "crawl_mk.txt")
LOG_PATH = os.path.join(BASE_DIR, "data", "crawl_mk.log")

WAIT = 1.0        # 章节页间隔
PAGE_WAIT = 1.5   # 翻页间隔
PROXY_URL = "https://xingmanwu-proxy.rtxn7yj57c.workers.dev/proxy?url="

scraper = cloudscraper.create_scraper(browser={"browser": "chrome", "platform": "windows", "desktop": True})

def log(msg):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(LOG_PATH, "a") as f:
        f.write(line + "\n")

def load_manga_index():
    """从 Node.js 生成的 manga 索引读取零章漫画"""
    if not os.path.exists(MANGA_JSON):
        log(f"⚠️  {MANGA_JSON} 不存在！请先运行: node export_zeros.mjs")
        return []
    with open(MANGA_JSON) as f:
        data = json.load(f)
    log(f"📥 加载 {len(data)} 部零章漫画")
    return data

def sim(a, b):
    """字符串相似度"""
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()

CATALOG_CACHE = os.path.join(BASE_DIR, "data", "mk_catalog.json")

def build_catalog():
    """遍历 MangaKatana 所有页面，优先用缓存"""
    if os.path.exists(CATALOG_CACHE):
        with open(CATALOG_CACHE) as f:
            cached = json.load(f)
        catalog = {k: [v["url"], v["title"]] for k, v in cached.items()}
        log(f"📥 Phase 1: 加载已缓存目录 ({len(catalog)} 部)")
        return catalog
    
    log("📥 Phase 1: 构建 MangaKatana 目录...")
    catalog = {}  # title_lower → [url, title]
    page = 1
    empty_pages = 0
    MAX_PAGES = 500  # 安全上限

    while page <= MAX_PAGES:
        try:
            r = scraper.get(f"https://mangakatana.com/page/{page}", timeout=12)
            if r.status_code != 200:
                break

            titles = re.findall(r'<h3 class="title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)', r.text)
            if not titles:
                empty_pages += 1
                if empty_pages >= 5:
                    break
            else:
                empty_pages = 0
                for href, title in titles:
                    key = title.strip().lower()
                    if key not in catalog:
                        catalog[key] = [href.strip(), title.strip()]

            if page % 20 == 0:
                log(f"  已扫 {page} 页, 共 {len(catalog)} 部")

            page += 1
            time.sleep(PAGE_WAIT)
        except Exception as e:
            log(f"  ⚠️  page/{page}: {e}")
            time.sleep(5)
            empty_pages += 1
            if empty_pages >= 5:
                break

    log(f"📚 扫描 {page-1} 页, 共 {len(catalog)} 部漫画")
    return catalog

def match_manga(zeros, catalog):
    """匹配零章漫画"""
    log(f"\n📥 Phase 2: 匹配 {len(zeros)} 部零章漫画...")
    matched = []
    
    for m in zeros:
        titles = []
        if m.get("tr"): titles.append(m["tr"].lower().strip())
        if m.get("te"): titles.append(m["te"].lower().strip())
        if m.get("tn"): titles.append(m["tn"].lower().strip())
        
        best = None
        best_score = 0
        
        for t in set(titles):
            if not t or len(t) < 3:
                continue
            # 精确匹配
            if t in catalog:
                best = catalog[t]
                best_score = 1.0
                break
            # 模糊匹配
            for key, val in catalog.items():
                s = sim(t, key)
                if s > best_score and s > 0.7:
                    best_score = s
                    best = val
        
        if best:
            matched.append({
                "id": m["id"],
                "our_title": m.get("tr") or m.get("te") or m.get("tn") or "?",
                "url": best[0],
                "mk_title": best[1]
            })
    
    log(f"  ✅ 匹配到 {len(matched)} 部")
    return matched

def fetch_via_proxy(url, retries=3):
    """通过 Cloudflare Worker 代理获取页面"""
    proxy_target = PROXY_URL + urllib.parse.quote(url, safe='')
    for attempt in range(retries):
        try:
            req = urllib.request.Request(proxy_target, headers={
                "User-Agent": "Xingmanwu/1.0"
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2)
            else:
                raise e
    return None

def fetch_chapters(matched):
    """获取章节数据"""
    log(f"\n📥 Phase 3: 获取章节数据...")
    results = []
    
    checked = 0
    # 读进度
    if os.path.exists(STATE_PATH):
        checked = int(open(STATE_PATH).read().strip())
        log(f"  📋 续跑: 已查 {checked}")
    
    for i, item in enumerate(matched):
        if i < checked:
            continue
        
        try:
            # 先用 Worker proxy 试
            html = None
            try:
                html = fetch_via_proxy(item["url"])
            except:
                # 不行就直连
                pass
            
            if not html:
                try:
                    r = scraper.get(item["url"], timeout=12)
                    if r.status_code == 200:
                        html = r.text
                except:
                    pass
            
            if not html:
                raise Exception("all methods failed")
            
            chapters = re.findall(r'class="chapter"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)', html)
            ch_count = len(chapters)
            
            if ch_count >= 3:  # 至少 3 章才有效
                results.append({
                    "manga_id": item["id"],
                    "source": "MangaKatana",
                    "source_url": item["url"],
                    "chapters": ch_count,
                    "source_title": item["mk_title"],
                    "our_title": item["our_title"][:30]
                })
                
                if len(results) % 10 == 0:
                    log(f"  ── {i+1}/{len(matched)} | 已找到 {len(results)} 部")
            
            time.sleep(WAIT)
        except Exception as e:
            log(f"  ⚠️  {item['our_title'][:20]}: {e}")
            time.sleep(3)
        
        # 存进度
        checked = i + 1
        if checked % 10 == 0:
            with open(STATE_PATH, "w") as f:
                f.write(str(checked))
    
    log(f"  ✅ 获取完成: {len(results)} 部有章节数据")
    return results

def main():
    log("="*45)
    log("🚀 星漫屋 MangaKatana 爬虫")
    log("="*45)
    
    # Phase 1: 目录
    catalog = build_catalog()
    
    # 存一份原始目录备用
    catalog_path = os.path.join(BASE_DIR, "data", "mk_catalog.json")
    serializable = {k: {"url": v[0], "title": v[1]} for k, v in catalog.items()}
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(serializable, f, ensure_ascii=False)
    log(f"  📝 目录已保存: {len(catalog)} 条")
    
    # Phase 2: 匹配
    zeros = load_manga_index()
    if not zeros:
        log("❌ 没有漫画数据，先跑 export_zeros.mjs")
        return
    
    matched = match_manga(zeros, catalog)
    
    # Phase 3: 章节
    if matched:
        results = fetch_chapters(matched)
        
        # 输出 JSON
        with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        
        log(f"\n🎉 完成!")
        log(f"  MangaKatana: {len(catalog)} 部")
        log(f"  匹配: {len(matched)} 部")
        log(f"  有章节: {len(results)} 部")
        log(f"  输出: {OUTPUT_JSON}")
    else:
        log("\n⚠️ 没有匹配")
    
    # 清理状态文件
    if os.path.exists(STATE_PATH):
        os.remove(STATE_PATH)

if __name__ == "__main__":
    main()
