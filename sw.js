// Club-authorized player portraits v12: available even before a profile is visited.
const CACHE="sudak-player-photos-v12";
const SHELL=["./","./index.html","./manifest.json","./assets/club-crest-final-original.png","./icon-192.png?v=final-crest-v7","./icon-512.png?v=final-crest-v7","./icon-maskable-512.png?v=final-crest-v7","./favicon.png?v=final-crest-v7","./apple-touch-icon.png?v=final-crest-v7"];
const PLAYER_PHOTOS=["./assets/players/vladimir-semenov.webp","./assets/players/andrey-gaydash.webp","./assets/players/anton-monakhov.webp","./assets/players/evgeniy-bredun.webp"];

self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await cache.addAll([...SHELL,...PLAYER_PHOTOS].map(url=>new Request(url,{cache:"reload"})));
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
    // Versioned crest and local portraits are precached. Return them immediately
    // so a weak connection cannot delay artwork or request external photo hosts.
    if(url.pathname.endsWith("/assets/club-crest-final-original.png")||
       PLAYER_PHOTOS.some(path=>new URL(path,self.location.href).href===url.href)){
      const cached=await (await caches.open(CACHE)).match(event.request);
      if(cached)return cached;
    }
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
