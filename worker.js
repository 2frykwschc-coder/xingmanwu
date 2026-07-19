// Cloudflare Worker — 星漫屋资源查询 + 聚合站代理
// 部署: wrangler deploy worker.js --name xingmanwu-proxy

const COMICK = "https://api.comick.io";
const USER_AGENT = "Xingmanwu/1.0 (Cloudflare Worker)";

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
  });
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // GET /check?q=标题 — 查 Comick 是否有资源
  if (path === "/check" || path === "/search") {
    const q = url.searchParams.get("q");
    if (!q || q.length < 2) return json({ error: "need query" }, 400, corsHeaders);

    const results = { query: q, sources: [], found: false };

    try {
      const slug = q.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-")
        .replace(/-+/g, "-").replace(/^-|-$/g, "");

      const r = await fetch(`${COMICK}/comic/${slug}`, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });

      if (r.ok) {
        const data = await r.json();
        if (data && data.id) {
          const hid = data.hid || data.id;
          const chR = await fetch(`${COMICK}/chapter/${hid}`, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(6000),
          });
          let chapterCount = 0;
          if (chR.ok) {
            const chData = await chR.json();
            if (Array.isArray(chData)) chapterCount = chData.length;
            else if (chData.total) chapterCount = chData.total;
            else if (chData.chapters) chapterCount = chData.chapters.length;
          }
          results.sources.push({
            source: "Comick",
            url: `https://comick.io/comic/${slug}`,
            title: data.title || data.slug || slug,
            chapters: chapterCount,
          });
          if (chapterCount > 0) results.found = true;
        }
      }
    } catch (e) {
      results.sources.push({ source: "Comick", error: e.message.slice(0, 50) });
    }

    return json(results, 200, corsHeaders);
  }

  // GET /proxy?url=... — 代理获取任意页面（用于绕过 Cloudflare 防护）
  if (path === "/proxy") {
    const target = url.searchParams.get("url");
    if (!target) return json({ error: "need url param" }, 400, corsHeaders);

    try {
      const resp = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(15000),
      });

      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: Object.assign({
          "Content-Type": resp.headers.get("Content-Type") || "text/html",
        }, corsHeaders),
      });
    } catch (e) {
      return json({ error: e.message }, 502, corsHeaders);
    }
  }

  // GET / — 健康检查
  if (path === "/") {
    return json({
      ok: true, name: "星漫屋 资源代理",
      endpoints: ["GET /check?q=标题", "GET /proxy?url=..."],
    }, 200, corsHeaders);
  }

  return json({ error: "not found" }, 404, corsHeaders);
}
