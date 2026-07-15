// Cloudflare Worker — 聚合站资源查询代理
// Worker 跑在 Cloudflare 网络内，可以绕过 Cloudflare 防护访问其他聚合站

const COMICK = "https://api.comick.io";
const CORSCORS = "https://corsproxy.io/?"; // 备用 CORS 代理
const USER_AGENT = "Xingmanwu/1.0 (Cloudflare Worker)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 头
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // GET /check?q=漫画标题 — 搜索聚合站是否有资源
    if (path === "/check" || path === "/search") {
      const q = url.searchParams.get("q");
      if (!q || q.length < 2) {
        return json({ error: "need query" }, 400, corsHeaders);
      }

      const results = {
        query: q,
        sources: [],
        found: false,
      };

      // 1. 查 Comick
      try {
        const slug = q.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");

        // 先试直接 slug 查
        let comickUrl = `${COMICK}/comic/${slug}`;
        let r = await fetch(comickUrl, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(8000),
        });

        if (r.ok) {
          const data = await r.json();
          if (data && data.id) {
            // 有这部漫画，查章节数
            const hid = data.hid || data.id;
            const chUrl = `${COMICK}/chapter/${hid}`;
            const chR = await fetch(chUrl, {
              headers: { "User-Agent": USER_AGENT },
              signal: AbortSignal.timeout(6000),
            });
            let chapterCount = 0;
            if (chR.ok) {
              const chData = await chR.json();
              if (Array.isArray(chData)) {
                chapterCount = chData.length;
              } else if (chData.total) {
                chapterCount = chData.total;
              } else if (chData.chapters) {
                chapterCount = chData.chapters.length;
              }
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

      // 2. 查 MangaFire
      try {
        const e = encodeURIComponent(q);
        const mfUrl = `https://mangafire.to/filter?keyword=${e}`;
        const r = await fetch(mfUrl, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(8000),
        });

        if (r.ok) {
          const text = await r.text();
          // MangaFire 是 SPA，看能否从 HTML 提取数据
          const match = text.match(/window\.__INITIAL_STATE__\s*=\s*({[^<]+})/);
          if (match) {
            try {
              const state = JSON.parse(match[1]);
              // 解析方式取决于 MangaFire 的页面结构
              results.sources.push({
                source: "MangaFire",
                url: `https://mangafire.to/filter?keyword=${e}`,
                note: "found page",
              });
              results.found = true;
            } catch (e) {
              results.sources.push({ source: "MangaFire", note: "page loaded, SPA data unavailable" });
            }
          } else {
            results.sources.push({ source: "MangaFire", url: `https://mangafire.to/filter?keyword=${e}` });
          }
        }
      } catch (e) {
        results.sources.push({ source: "MangaFire", error: e.message.slice(0, 50) });
      }

      return json(results, 200, corsHeaders);
    }

    // GET / — 健康检查
    if (path === "/") {
      return json({
        ok: true,
        name: "星漫屋 资源代理",
        endpoints: ["GET /check?q=标题", "GET /source/:name/:slug"],
        note: "部署后在前端 `public/js/app.js` 里改 WORKER_URL",
      }, 200, corsHeaders);
    }

    return json({ error: "not found" }, 404, corsHeaders);
  },
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}
