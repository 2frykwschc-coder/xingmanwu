// Minimal Worker test
addEventListener("fetch", event => {
  event.respondWith(new Response(JSON.stringify({ok:true, msg:"与术代理"}), {
    headers: {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}
  }));
});
