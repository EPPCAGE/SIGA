// ─── Service Worker — SIGA ───────────────────────────────────────────
// Para forçar atualização em todos os usuários: incremente CACHE_VERSION abaixo.
// Exemplo: 'siga-v1' → 'siga-v2'
const CACHE_VERSION = 'siga-v4';

// ── Install: ativa imediatamente sem esperar abas antigas fecharem ────────────
self.addEventListener('install', () => {
  self.skipWaiting();
});

// ── Activate: remove caches antigos e assume controle de todas as abas ───────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => {
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first para HTML (sempre pega versão mais nova) ─────────────
// Para outros assets (imagens, fontes CDN) deixa o browser gerenciar.
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return; // só intercepta navegação HTML

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Guarda cópia fresca no cache para uso offline
        const clone = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => {
        // Offline: serve do cache
        return caches.match(event.request);
      })
  );
});
