const CACHE_NAME = 'kare-lojistik-v1';

// Önbelleğe alınacak statik kaynaklar (sadece yerel dosyalar)
const STATIC_ASSETS = [
  './index.html',
  './manifest.json'
];

// Kurulum: statik dosyaları önbelleğe al
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Aktivasyon: eski önbellekleri temizle
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: önce ağdan dene, başarısız olursa önbellekten sun
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firebase, CDN ve harici kaynaklar için her zaman ağı kullan
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('cdn') ||
    url.hostname.includes('cdnjs') ||
    url.hostname.includes('jsdelivr') ||
    url.hostname.includes('fonts')
  ) {
    return; // Tarayıcının varsayılan davranışına bırak
  }

  // Yerel dosyalar için: önce ağ, yoksa önbellek
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Başarılı yanıtı önbelleğe de kaydet
        if (response && response.status === 200) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
