const CACHE='ordergrid-product-v19';
const ASSETS=[
  './','./index.html','./styles.css','./finance.css','./premium.css','./dashboard.css','./overview-premium.css',
  './customer.css','./control-center.css','./automation-center.css','./fulfilment.css',
  './app.js','./dashboard.js','./funding.js','./rewards.js','./bulk.js',
  './control-center.js','./automation-center.js','./navigation.js','./fulfilment.js',
  './wizard.js','./manifest.webmanifest','./app-icon.svg'
];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  event.respondWith(
    fetch(event.request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE).then(cache=>cache.put(event.request,copy));
      return response;
    }).catch(()=>caches.match(event.request).then(hit=>hit||caches.match('./index.html')))
  );
});