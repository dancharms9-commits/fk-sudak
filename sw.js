// Typography v15; retain shell/data policy and make all three UI weights offline.
const CACHE="sudak-typography-v15";
const SHELL=["./","./index.html","./manifest.json","./assets/club-crest-final-original.png","./icon-192.png?v=final-crest-v7","./icon-512.png?v=final-crest-v7","./icon-maskable-512.png?v=final-crest-v7","./favicon.png?v=final-crest-v7","./apple-touch-icon.png?v=final-crest-v7"];
const PLAYER_PHOTOS=["./assets/players/vladimir-semenov.webp","./assets/players/andrey-gaydash.webp","./assets/players/anton-monakhov.webp","./assets/players/evgeniy-bredun.webp"];

const CLUB_BADGES=["936","1030","932","521","930","146","934","757","1028","117"].map(id=>"./assets/clubs/"+id+".png");
const UI_FONTS=["Regular","SemiBold","Bold"].map(weight=>"./assets/fonts/ibm-plex-sans/IBMPlexSans-"+weight+".woff2");

self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await cache.addAll([...SHELL,...PLAYER_PHOTOS,...CLUB_BADGES,...UI_FONTS].map(url=>new Request(url,{cache:"reload"})));
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
       [...PLAYER_PHOTOS,...CLUB_BADGES,...UI_FONTS].some(path=>new URL(path,self.location.href).href===url.href)){
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
