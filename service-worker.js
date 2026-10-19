/* =========================================================
   service-worker.js · PWA 离线能力（新增）
   策略：
   1. 应用外壳（HTML/CSS/JS/manifest）安装时预缓存，离线可打开
   2. 页面导航：网络优先 → 失败回落缓存的 index.html
   3. 静态资源：缓存优先 + 后台更新（stale-while-revalidate）
   4. DeepSeek 接口请求：完全不拦截、不缓存（离线由页面提示）
   ========================================================= */

const VERSION = "ddh-shell-v1.0.0"; // 每次发版改这里即可让新缓存生效

const SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/store.js",
  "./js/personas.js",
  "./js/main.js",
  "./js/engine.js",
  "./js/panel.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

/* ---------- 安装：预缓存应用外壳 ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // 逐个 add：单个文件 404 也不会让整个安装失败
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch (err) {
            /* 忽略缺失资源 */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

/* ---------- 激活：清掉旧版本缓存 ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

/* ---------- 页面可主动要求新 SW 接管 ---------- */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/* ---------- 请求拦截 ---------- */
const API_HOST = "api.deepseek.com";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }

  // 1) API 请求一律直连：离线时让 fetch 自然失败，由页面给出中文提示
  if (url.hostname === API_HOST) return;

  // 2) 只处理同源 GET
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // 3) 页面导航：网络优先，离线回落缓存
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(VERSION);
          cache.put("./index.html", fresh.clone());
          return fresh;
        } catch (err) {
          const cache = await caches.open(VERSION);
          return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
        }
      })()
    );
    return;
  }

  // 4) 静态资源：缓存优先 + 后台更新
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || new Response("", { status: 504 });
    })()
  );
});