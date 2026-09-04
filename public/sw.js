const CACHE = 'xingmanwu-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css?v=22',
  '/js/app.js?v=29',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 页面导航: 网络优先(永远拿最新版), 断网时回退缓存 — 修复"更新后永远看到旧页面"的缓存 bug
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put('/', clone));
        }
        return res;
      }).catch(() =>
        caches.match(e.request).then(r => r || caches.match('/'))
      )
    );
    return;
  }

  // API 请求: 网络优先, 绝不缓存
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() => new Response(
        JSON.stringify({error: '网络不可用'}),
        {status: 503, headers: {'Content-Type': 'application/json'}}
      ))
    );
    return;
  }

  // 静态资源(带 ?v= 版本号): 缓存优先, 版本号变了自然取新版
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match('/')))
  );
});
