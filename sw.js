// Crest v4: утверждённая эмблема и PWA-иконки; data.json по-прежнему читается из сети.
const CACHE="sudak-crest-v4";
const SHELL=["./","./index.html","./manifest.json","./icon-192.png?v=crest-v4","./icon-512.png?v=crest-v4","./icon-maskable-512.png?v=crest-v4"];

self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await cache.addAll(SHELL.map(url=>new Request(url,{cache:"reload"})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith("sudak-")&&key!==CACHE)
      .map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  // data.json всегда читается из сети; при её отсутствии приложение
  // явно сообщает о недоступности свежих данных.
  if(url.pathname.endsWith("/data.json"))return;
  event.respondWith((async()=>{
    try{
      const response=await fetch(event.request,{cache:"no-store"});
      if(response.ok){
        const cache=await caches.open(CACHE);
        cache.put(event.request,response.clone()).catch(()=>{});
      }
      return response;
    }catch{
      return (await caches.match(event.request))||Response.error();
    }
  })());
});
