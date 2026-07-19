"""通过 Cloudflare Worker 代理重建 MangaKatana 目录"""
import urllib.request, urllib.parse, json, re, time, os, sys

BASE_DIR = os.path.expanduser("~/.openclaw/workspace/sites/星漫屋")
CATALOG_PATH = os.path.join(BASE_DIR, "data", "mk_catalog.json")
PROXY_URL = "https://xingmanwu-proxy.rtxn7yj57c.workers.dev/proxy?url="

def fetch(url):
    proxy_target = PROXY_URL + urllib.parse.quote(url, safe='')
    req = urllib.request.Request(proxy_target, headers={"User-Agent": "Xingmanwu/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")
    sys.stdout.flush()

log("🚀 通过 Worker 重建 MangaKatana 目录...")

catalog = {}
page = 1
MAX_PAGES = 350
empty_pages = 0

while page <= MAX_PAGES:
    try:
        html = fetch(f"https://mangakatana.com/page/{page}")
        
        titles = re.findall(r'<h3 class="title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)', html)
        
        if not titles:
            empty_pages += 1
            if empty_pages >= 5:
                log(f"⛔ 连续 {empty_pages} 页无数据，结束")
                break
        else:
            empty_pages = 0
            for href, title in titles:
                key = title.strip().lower()
                if key not in catalog:
                    catalog[key] = {"url": href.strip(), "title": title.strip()}

        if page % 50 == 0 or page == 1:
            log(f"  扫到 {page} 页, 已收录 {len(catalog)} 部")

        page += 1
        time.sleep(1)
    except Exception as e:
        log(f"  ⚠️ page/{page}: {str(e)[:60]}")
        time.sleep(3)
        page += 1

log(f"✅ 完成！共扫 {page-1} 页, {len(catalog)} 部漫画")

# 保存
with open(CATALOG_PATH, "w", encoding="utf-8") as f:
    json.dump(catalog, f, ensure_ascii=False)
log(f"📝 已保存到 {CATALOG_PATH}")
