const CACHE = 'escalacaofc-v2';

const LOCAL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/assets/css/styles.css',
  '/assets/js/app.js',
  '/firebase/config.js',
  '/assets/images/logo.png',
  '/assets/images/campao.png',
  '/assets/images/society.png',
  '/assets/images/mensalistas.png',
  '/assets/images/sorteio-lista.png',
  '/assets/images/sorteio-tampinhas.png',
  '/assets/images/premium.png',
  '/assets/images/ball.png',
  '/assets/images/dado-colete.png',
  '/assets/images/escalacao-blue.png',
  '/assets/images/tampinha-green.png',
  '/assets/images/tampinha-red.png',
  '/assets/images/tampinha-blue.png',
  '/assets/images/tampinha-yellow.png',
  '/assets/images/tampinha-purple.png',
  '/assets/images/tampinha-orange.png',
  '/assets/images/tampinha-pink.png',
  '/assets/images/tampinha-ciano.png',
  '/assets/images/tampinha-white.png',
  '/assets/images/tampinha-black.png',
  '/assets/images/tampinha-ouro.png',
  '/assets/images/icon-96.png',
  '/assets/images/icon-192.png',
  '/assets/images/icon-512.png',
  '/assets/images/apple-touch-icon.png',
  // Ícones de uniformes — Brasil
  '/assets/images/icones_uniformes/icones_uniformes_brasil/atlmg.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/cor.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/cru.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/fla.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/flu.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/gre.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/int.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/pal.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/san.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/sao.png',
  '/assets/images/icones_uniformes/icones_uniformes_brasil/vas.png',
  // Ícones de uniformes — Europa
  '/assets/images/icones_uniformes/icones_uniformes_europa/atletico_madrid.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/barcelona.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/bayern.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/chelsea.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/juventus.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/liverpool.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/man_city.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/man_united.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/milan.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/psg.png',
  '/assets/images/icones_uniformes/icones_uniformes_europa/real_madrid.png',
  // Ícones de uniformes — Seleções
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/alemanha.png',
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/argentina.png',
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/brasil.png',
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/equador.png',
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/espanha.png',
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/franca.png',
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/inglaterra.png',
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/japao.png',
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/mexico.png',
  '/assets/images/icones_uniformes/icones_uniformes_selecoes/portugal.png',
];

const EXTERNAL_ASSETS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@babel/standalone@7.23.10/babel.min.js',
];

// Instala e cacheia todos os assets locais + externos essenciais
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      await cache.addAll(LOCAL_ASSETS);
      // Assets externos: tenta cachear, ignora falhas individuais
      await Promise.allSettled(
        EXTERNAL_ASSETS.map(url =>
          fetch(url, { mode: 'cors' })
            .then(res => { if (res.ok) cache.put(url, res); })
            .catch(() => {})
        )
      );
    })
  );
  self.skipWaiting();
});

// Remove caches antigos ao ativar nova versão
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estratégia:
// - Assets locais e externos conhecidos → Cache First (offline funciona)
// - Firebase / Firestore / Auth → Network Only (SDK gerencia o próprio cache)
// - Tudo mais → Network First com fallback para cache
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Ignora requisições não-GET
  if (e.request.method !== 'GET') return;

  // Firebase SDKs e APIs — deixa o SDK do Firebase gerenciar
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.hostname.includes('firebaseinstallations.googleapis.com')
  ) return;

  // Assets locais e externos conhecidos → Cache First
  const isLocal = url.origin === self.location.origin;
  const isKnownExternal = EXTERNAL_ASSETS.includes(e.request.url);

  if (isLocal || isKnownExternal) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => {
          // Fallback: para navegação, retorna a shell do app
          if (e.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
      })
    );
    return;
  }

  // Google Fonts e outros externos → Network First com fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
