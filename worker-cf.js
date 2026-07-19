// Cloudflare Worker — 聚合站资源查询代理
const COMICK = "https://api.comick.io";
const USER_AGENT = "Xingmanwu/1.0 (Cloudflare Worker)";

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      "Content-Type": "application/json",
    }, headers),
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (path === "/check" || path === "/search") {
    const q = url.searchParams.get("q");
    if (!q || q.length < 2) {
      return json({ error: "need query" }, 400, corsHeaders);
    }

    const results = { query: q, sources: [], found: false };

    // 查 Comick
    try {
      const slug = q.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-")
        .replace(/-+/g, "-").replace(/^-|-$/g, "");

      let comickUrl = `${COMICK}/comic/${slug}`;
      let r = await fetch(comickUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });

      if (r.ok) {
        const data = await r.json();
        if (data && data.id) {
          const hid = data.hid || data.id;
          const chUrl = `${COMICK}/chapter/${hid}`;
          const chR = await fetch(chUrl, {
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

  if (path === "/") {
    return json({
      ok: true, name: "星漫屋 资源代理",
      endpoints: ["GET /check?q=标题"],
    }, 200, corsHeaders);
  }

  return json({ error: "not found" }, 404, corsHeaders);
}
