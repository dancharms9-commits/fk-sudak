/* A stalled HTTP navigation distinguishes real SW offline from a false green
   caused by the worker fetching the live test server after setOffline(true). */
const baseline=process.env.SW_OFFLINE_BASELINE==='1';
if(baseline)delete process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS;
const {currentWorker,disconnectServer}=baseline?{}:require('./pwa-offline.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.env.SW_DIAGNOSTIC_DIR||'_state/sw-offline');
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'))),r=data.res[0],key=[2026,r[0],r[1],r[5]].join('|'),detail=data.match_details[key];
const hash='#match='+encodeURIComponent(key)+'&from=matches',cacheName=fs.readFileSync(path.join(root,'sw.js'),'utf8').match(/const CACHE="([^"]+)"/)[1];
let previous,offlineTransport=false,requests=[];
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');requests.push({url:req.url,offline:offlineTransport,at:Date.now()});
 // Keep the socket open: real offline SW fetch must reject before reaching it.
 if(offlineTransport&&(pathname==='/'||pathname==='/index.html'))return;
 const file=path.join(root,previous&&pathname==='/sw.js'?'tests/fixtures/'+previous:pathname==='/'?'index.html':pathname);
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');
  // Slow, valid font responses make the install/activate boundary observable.
  if(pathname.endsWith('.woff2'))setTimeout(()=>res.end(body),150);else res.end(body);
 });
});
(async()=>{
 fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/fk-sudak/`;
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{}),results=[];
 try{
  for(const fixture of baseline?['sw-home-v8.js']:['sw-home-v8.js','sw-matches-v14.js',null]){
   previous=fixture;offlineTransport=false;requests=[];const errors=[],context=await browser.newContext({serviceWorkers:'allow',viewport:{width:320,height:844}});
   let page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   const label=fixture||'fresh',diagnostic=await require('./sw-diagnostics.cjs')(context,page,path.join(out,label));let finished=false;
   try{
    await page.goto(base+'manifest.json');await page.evaluate(async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready});await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    previous=null;
    if(baseline){
     await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update()});
     const early=await page.waitForFunction(async name=>(await caches.keys()).includes(name)&&!(await caches.keys()).includes('sudak-home-v8'),cacheName);
     diagnostic.record('legacy-wait-result',{value:await early.jsonValue()});
    }else await currentWorker(page,cacheName);
    await page.goto(base+hash,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!loadingData&&!!localStorage.getItem('sudak-data-v1'));await page.locator('#launch-splash').waitFor({state:'detached'});await page.evaluate(()=>document.fonts.ready);
    await diagnostic.snapshot('before-offline');
    const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
    await context.setOffline(true);offlineTransport=true;const reconnect=baseline?null:await disconnectServer(server);await diagnostic.snapshot('offline-set');
    if(baseline){
     let failure;try{await page.reload({waitUntil:'domcontentloaded'})}catch(e){failure=e}
     assert(failure?.name==='TimeoutError','Unfixed 1.48 must reach the stalled HTTP server');assert.match(failure.message,/domcontentloaded/);
     assert(requests.some(r=>r.offline&&new URL(r.url,base).pathname==='/fk-sudak/'));
     await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});
     await diagnostic.finish(failure);finished=true;results.push({fixture:label,reproduced:'reload TimeoutError at unchanged 30000ms',offlineNavigationReachedServer:true,offlineServerRequests:requests.filter(r=>r.offline)});
    }else{
     const verify=async()=>{
      await page.waitForFunction(()=>!loadingData);await page.locator('#launch-splash').waitFor({state:'detached'});await page.evaluate(()=>document.fonts.ready);
      assert.equal(await page.locator('.center-timeline li').count(),detail.events.length);assert.equal(await page.locator('.center-lineup-team').count(),2);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320);
      const fonts=await page.evaluate(()=>[...document.fonts].filter(f=>f.family==='IBM Plex Sans').map(f=>({weight:f.weight,status:f.status})));
      assert(fonts.length===3&&fonts.every(f=>f.status==='loaded'),'All three IBM weights loaded with HTTP cache disabled');
     };
     assert((await page.reload({waitUntil:'domcontentloaded'})).fromServiceWorker());await verify();
     await page.locator('#match .center-scorers a[data-player="rffk-202"]').first().click();await page.locator('#player.on').waitFor();await page.locator('#player-back').click();await page.locator('#match.on').waitFor();
     // Cold worker restart + a new document while still offline. Storage stays
     // intact, but both HTTP cache and the old JS execution context are gone.
     await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');await page.close();page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
     const cold=await context.newCDPSession(page);await cold.send('Network.enable');await cold.send('Network.setCacheDisabled',{cacheDisabled:true});
     assert((await page.goto(base+hash,{waitUntil:'domcontentloaded'})).fromServiceWorker());await verify();
     assert((await page.reload({waitUntil:'domcontentloaded'})).fromServiceWorker());await verify();
     assert(!requests.some(r=>r.offline&&(new URL(r.url,base).pathname==='/fk-sudak/'||r.url.endsWith('.woff2'))),'Offline HTML/fonts must never reach the HTTP server');
     assert.deepEqual(errors,[]);results.push({fixture:label,offlineReload:true,coldWorkerRestart:true,newDocument:true,repeatedReopen:true,httpCacheDisabled:true,fontWeights:3,offlineHtmlAndFontServerRequests:0});
     await diagnostic.finish();finished=true;offlineTransport=false;await reconnect();
    }
    console.log('PASS',baseline?'unfixed timeout reproduced':label+' → '+cacheName+'; real offline reload/cold start/reopen/fonts');
   }catch(e){if(!finished)await diagnostic.finish(e);throw e}finally{await context.close()}
  }
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({platform:process.platform,node:process.version,chromium:browser.version(),baseline,results},null,2)+'\n');
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
