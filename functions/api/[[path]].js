// Pages Function — handles /api/*, proxies to API Worker
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  const apiPath = url.pathname.replace('/api/', '') + url.search;
  const workerUrl = 'https://xingmanwu-api.rtxn7yj57c.workers.dev/' + apiPath;

  try {
    const resp = await fetch(workerUrl, {
      method: method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
      body: method === 'POST' ? request.body : null
    });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
    });
  }
}
