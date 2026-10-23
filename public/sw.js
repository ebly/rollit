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
const CACHE = 'zhiyige-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      // 装好立刻接管，避免用户要刷新两次才生效
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
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
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || Response.error()))
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
