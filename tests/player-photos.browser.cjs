/* Actual local WebP decoding + v11 -> v12 upgrade under a GitHub Pages subpath. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const photos=JSON.parse(fs.readFileSync(path.join(root,'docs/player-photo-permissions.json'),'utf8')).records;
const cacheName=fs.readFileSync(path.join(root,'sw.js'),'utf8').match(/const CACHE="([^"]+)"/)[1];
const screenshots=process.env.VISUAL_SCREENSHOT_DIR;
let previousWorker=false;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 const file=path.join(root,previousWorker&&pathname==='/sw.js'?'tests/fixtures/sw-route-v11.js':pathname==='/'?'index.html':pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 if(previousWorker&&(pathname==='/'||pathname==='/index.html')){
  res.setHeader('Content-Type','text/html');return res.end('<!doctype html><p id="old-shell">Cached v11</p>');
 }
 fs.readFile(file,(error,body)=>{
  if(error){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body);
 });
});
(async()=>{
 assert.equal(photos.length,4);assert.equal(new Set(photos.map(p=>p.player_id)).size,4);
 for(const p of photos){
  const bytes=fs.readFileSync(path.join(root,p.publication.local_asset));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),p.publication.sha256);
  assert.equal(p.rights.status,'authorized_by_club_representative');
 }
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/fk-sudak/';
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
 const errors=[],externalSourceRequests=[];
 try{
  let context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(photos.some(p=>p.image_url===r.url()))externalSourceRequests.push(r.url())});
  await context.route('https://rffk-roo.ru/uploads/people/**',r=>r.abort());
  const ready=async offline=>{
   await page.waitForFunction(offline=>{
    const text=document.querySelector('#upd')?.textContent||'';
    return offline?text.includes('Нет связи'):text.startsWith('Данные обновлены')&&!text.includes('Нет связи')&&!loadingData;
   },offline);
   await page.locator('#launch-splash').waitFor({state:'detached'});
  };
  const decode=async(locator,p)=>{
   // Older Chromium can reject decode() before a newly visible lazy image
   // starts its request after a viewport change. Wait for actual pixels first.
   await page.waitForFunction(src=>{
    const visible=[...document.images].filter(img=>img.getAttribute('src')===src&&img.getClientRects().length);
    return visible.length>0&&visible.every(img=>img.complete&&img.naturalWidth>0);
   },p.publication.local_asset);
   const result=await locator.evaluate(async img=>{await img.decode();const css=getComputedStyle(img);return {width:img.naturalWidth,height:img.naturalHeight,fit:css.objectFit,position:css.objectPosition,complete:img.complete}});
   assert.equal(result.complete,true);assert.equal(result.width,p.width);assert.equal(result.height,p.height);
   assert.equal(result.fit,'contain');assert.equal(result.position,'50% 50%');
   assert.equal(await locator.getAttribute('src'),p.publication.local_asset);
  };
  const check=async(offline,theme,width)=>{
   await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width,height:844});
   await page.evaluate(()=>{location.hash='#squad&role=all'});await page.locator('#squad.on').waitFor();
   assert.equal(await page.locator('#squad [data-player]').count(),41);
   for(const p of photos){
    const card=page.locator(`#squad [data-player="${p.player_id}"]`);await card.scrollIntoViewIfNeeded();
    await decode(card.locator('img.club-photo'),p);
    if(screenshots){fs.mkdirSync(screenshots,{recursive:true});await card.screenshot({path:path.join(screenshots,`card-${p.player_id}-${offline?'offline':'online'}-${theme}-${width}.png`)});}
    await card.click();await page.locator('#player.on').waitFor();
    assert.equal(await page.locator('#player-title').innerText(),p.name);
    await decode(page.locator('#player .player-avatar img.club-photo'),p);
    assert.equal(await page.locator('#player .photo-source').getAttribute('href'),p.source_page_url);
    const player=data.player_stats_2026.players.find(row=>row.profile_url===p.profile_url);
    for(const field of ['league_games','league_goals','league_minutes','league_starts','league_substitutions','league_penalty_goals'])
     assert.equal(await page.locator(`#player [data-stat="${field}"] b`).innerText(),String(player[field]??'—'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    await page.reload();await ready(offline);
    assert.equal(await page.locator('#player-title').innerText(),p.name);
    await decode(page.locator('#player .player-avatar img.club-photo'),p);
    if(screenshots&&width===390)await page.screenshot({path:path.join(screenshots,`profile-${p.player_id}-${offline?'offline':'online'}-${theme}.png`),fullPage:true});
    await page.locator('#player-back').click();await page.locator('#squad.on').waitFor();
   }
   console.log(`PASS 4 actual card/profile WebP images and reloads: ${offline?'offline':'online'} ${theme} ${width}px`);
  };
  await page.goto(base+'#squad');await ready(false);
  for(const theme of ['light','dark'])for(const width of [320,390,768,1440])await check(false,theme,width);
  assert.deepEqual(externalSourceRequests,[],'Local portraits must not hotlink their sources');
  await context.close();
  // Install the previous real worker. No new profile/portrait has been visited in this context.
  previousWorker=true;context=await browser.newContext({reducedMotion:'reduce'});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.evaluate(()=>navigator.serviceWorker.register("sw.js"));
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();
  // Complete requests handled by the previous worker before replacing it.
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
  await page.evaluate(data=>localStorage.setItem('sudak-data-v1',JSON.stringify(data)),data);
  assert(await page.evaluate(()=>caches.has('sudak-route-v11')));
  await page.evaluate(()=>{window.photoWorkerChanged=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{window.photoWorkerChanged=true})});
  previousWorker=false;await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update()});
  await page.waitForFunction(()=>window.photoWorkerChanged);
  // controllerchange can precede completion of activate.waitUntil cleanup.
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  const cacheState=await page.evaluate(async({name,paths})=>{
   const cache=await caches.open(name);const images=[];
   for(const src of paths){const response=await cache.match(src);images.push({src,ok:!!response?.ok,type:response?.headers.get('Content-Type'),bytes:response?Array.from(new Uint8Array(await response.arrayBuffer())):[]})}
   return {keys:await caches.keys(),images};
  },{name:cacheName,paths:photos.map(p=>p.publication.local_asset)});
  assert(!cacheState.keys.includes('sudak-route-v11'));
  for(const image of cacheState.images){
   assert(image.ok);assert.equal(image.type,'image/webp');
   const p=photos.find(p=>p.publication.local_asset===image.src);
   assert.equal(crypto.createHash('sha256').update(Buffer.from(image.bytes)).digest('hex'),p.publication.sha256);
  }
  assert.equal(await page.locator('#old-shell').count(),1,'Photos precached before opening the new app');
  console.log('PASS actual SW v11 -> v12: all 4 exact WebP files precached before any new portrait is visited; old cache removed');
  await context.setOffline(true);await page.reload();await ready(true);
  for(const theme of ['light','dark'])for(const width of [320,390,768,1440])await check(true,theme,width);
  await context.setOffline(false);await ready(false);
  await context.close();
  context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const p=photos[0];await context.route('**/'+p.publication.local_asset,r=>r.abort());
  await page.goto(base+'#player='+p.player_id+'&name='+encodeURIComponent(p.name));await ready(false);
  await page.waitForFunction(()=>!document.querySelector('#player .player-avatar img'));
  assert.equal(await page.locator('#player .player-avatar span').innerText(),'СВ');
  assert.deepEqual(errors,[]);console.log('PASS missing local image falls back to initials; 64 profile reloads and no JavaScript errors');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server.close());
