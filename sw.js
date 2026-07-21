/**
 * Service Worker — 离线缓存 + 通知调度
 * 版本: v1
 */
const CACHE_NAME = 'med-reminder-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/storage.js',
  '/js/notifications.js',
  '/js/app.js'
];

// ====== 安装 ======
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('部分资源预缓存失败:', err);
      });
    })
  );
  self.skipWaiting();
});

// ====== 激活 ======
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// ====== 请求拦截：缓存优先 ======
self.addEventListener('fetch', (event) => {
  // 跳过非 GET 请求
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, clone);
        });
        return response;
      }).catch(() => {
        // 网络不可用时，返回缓存的 index.html（SPA fallback）
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
        return new Response('离线状态', { status: 503 });
      });
    })
  );
});

// ====== 消息处理 ======
let notificationTimer = null;

self.addEventListener('message', (event) => {
  if (!event.data) return;

  switch (event.data.type) {
    case 'schedule':
      // 收到主线程的下次提醒时间
      if (notificationTimer) {
        clearTimeout(notificationTimer);
        notificationTimer = null;
      }

      const { delay, dose, date } = event.data;
      if (!dose || delay <= 0 || delay > 86400000) return; // 忽略无效或超长延迟

      // 在 SW 中设置定时器（iOS 上通常活不过30秒，但聊胜于无）
      notificationTimer = setTimeout(() => {
        self.registration.showNotification('💊 服药提醒', {
          body: `${dose.medicationName} — ${dose.scheduledTime}`,
          tag: `sw-dose-${dose.medicationId}-${date}-${dose.scheduledTime}`,
          requireInteraction: true,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="24" fill="%2334C759"/><text x="60" y="80" text-anchor="middle" font-size="64">💊</text></svg>',
          vibrate: [200, 100, 200]
        });

        // 尝试唤醒所有客户端
        self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => {
            client.postMessage({ type: 'notification-triggered', dose, date });
          });
        });
      }, delay);
      break;

    case 'skip':
      if (notificationTimer) {
        clearTimeout(notificationTimer);
        notificationTimer = null;
      }
      break;
  }
});

// ====== 通知点击 ======
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      // 如果已有打开的窗口，聚焦它
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          return client.focus();
        }
      }
      // 否则打开新窗口
      return self.clients.openWindow('/');
    })
  );
});
