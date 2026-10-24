/**
 * Service Worker：让「掷一个」能离线打开、能装到桌面。
 *
 * 策略刻意分开：
 *   导航请求（打开页面）—— 网络优先，失败回退缓存的 index.html。
 *     vite 构建出来的 JS 文件名带 hash，所以新版本上线后只要拿到新的
 *     index.html 就会自动引用新资源；网络优先保证不会一直用旧壳。
 *   静态资源（带 hash 的 assets）—— 缓存优先。
 *     文件名带 hash 意味着内容不会变，可以放心长期缓存。
 *
 * 没有要缓存 API 数据 —— 这个站本来就没有后端请求，数据全在 localStorage。
 */
// 每次发布 +1（v2/v3…）：activate 靠缓存名差异清理旧资产，
// 名字不变则旧版本的 hash 条目会永远留在缓存里逐版累积。
const CACHE = 'zhiyige-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

// 首次访问即断网、或 install 失败后断网：给人话，而不是浏览器原生错误页
const OFFLINE_PAGE = new Response(
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><title>掷一个</title>' +
  '<body style="margin:0;min-height:100vh;display:grid;place-content:center;text-align:center;' +
  'font-family:system-ui,sans-serif;background:#f7f3ec;color:#2f2a25;padding:2rem">' +
  '<h1 style="font-size:20px">现在没有网络</h1>' +
  '<p style="font-size:14px;color:#7d7469">数据都在本机，连上网后刷新即可。</p></body></html>',
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      // 装好立刻接管，避免用户要刷新两次才生效。
      // addAll 是原子操作：任一资源失败整个 shell 都不缓存，此时让 install
      // 失败（浏览器会择机重试），而不是激活一个空壳 SW。
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 只管自己源下的请求；外链（比如以后加天气 API）不碰
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 只有 2xx 才配当离线壳：404/502 页存进去，离线用户看到的就是错误页
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || OFFLINE_PAGE))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
