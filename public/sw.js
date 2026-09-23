const CACHE='ordergrid-product-v57';
const ASSETS=[
  './','./index.html','./styles.css?v=57','./finance.css?v=57','./premium.css?v=57','./overview-premium.css?v=57','./dashboard.css?v=57',
  './customer.css?v=57','./control-center.css?v=57','./workspace-premium.css?v=57','./fulfilment.css?v=57','./gst-premium.css?v=57','./bulk-premium.css?v=57',
  './app.js?v=57','./dashboard.js?v=57','./funding.js?v=57','./rewards.js?v=57','./bulk.js?v=57','./notifications.js?v=57',
  './control-center.js?v=57','./navigation.js?v=57','./fulfilment.js?v=57','./gst.js?v=57',
  './wizard.js?v=57','./manifest.webmanifest','./app-icon.svg'
];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin===self.location.origin&&url.pathname.startsWith('/api/'))return;
  event.respondWith(
    fetch(event.request).then(response=>{
      if(response.ok&&event.request.url.startsWith('http')){
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put(event.request,copy));
      }
      return response;
    }).catch(()=>caches.match(event.request).then(hit=>hit||caches.match('./index.html')))
  );
});