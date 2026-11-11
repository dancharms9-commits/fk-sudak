/* Upgrade the actual v14 worker, then load unvisited routes with the network off. */
const {currentWorker,disconnectServer}=require('./pwa-offline.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.env.TYPOGRAPHY_DIR||path.join(root,'docs/typography-refresh'));
const oldWorker=fs.readFileSync(path.join(__dirname,'fixtures/sw-matches-v14.js'));
let previous=true;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 if(pathname==='/sw.js'&&previous){res.setHeader('Content-Type','application/javascript');return res.end(oldWorker)}
 const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
async function actualFonts(p,selector){const c=await p.context().newCDPSession(p);await c.send('DOM.enable');await c.send('CSS.enable');const {root}=await c.send('DOM.getDocument');const {nodeId}=await c.send('DOM.querySelector',{nodeId:root.nodeId,selector});const r=await c.send('CSS.getPlatformFontsForNode',{nodeId});await c.detach();return r.fonts;}
(async()=>{
 fs.mkdirSync(path.join(out,'offline'),{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/fk-sudak/`;
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{}),results=[],errors=[];
 try{
  const c=await browser.newContext({serviceWorkers:'allow',reducedMotion:'reduce',viewport:{width:320,height:844}});let p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base,{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.evaluate(()=>navigator.serviceWorker.ready);await p.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert((await p.evaluate(()=>caches.keys())).includes('sudak-matches-v14'));
  previous=false;await currentWorker(p,'sudak-typography-v15');
  assert(!(await p.evaluate(()=>caches.keys())).includes('sudak-matches-v14'),'v14 cache retired after activation');
  const cached=await p.evaluate(async()=>{const c=await caches.open('sudak-typography-v15');return (await c.keys()).map(r=>r.url)});
  assert.equal(cached.filter(u=>u.endsWith('.woff2')).length,3,'All weights precached before visiting other screens: '+JSON.stringify(cached));
  // Close the document and bypass the HTTP cache. Only the SW cache can serve fonts.
  await p.close();await c.setOffline(true);const reconnect=await disconnectServer(server);p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));const cdp=await c.newCDPSession(p);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  for(const theme of ['dark','light'])for(const [name,hash]of [['home','#home'],['calendar','#table'],['kashtan','#team=936'],['popov','#player=rffk-146&team=936&competition=4&season=22&from=team'],['match','#match=rffk-38771&from=table']]){
   await p.goto(base+hash);await p.reload();await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});await p.evaluate(async theme=>{document.documentElement.dataset.theme=theme;await document.fonts.ready},theme);
   const fonts=await actualFonts(p,'main>section.on h2');assert(fonts.some(f=>f.isCustomFont&&f.familyName.startsWith('IBM Plex Sans')),`${name}: actual offline Cyrillic font`);
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),320);
   results.push({name,theme,fonts});await p.screenshot({path:path.join(out,'offline',`${name}-${theme}-320.png`),animations:'disabled'});
  }
  await reconnect();await c.setOffline(false);await p.reload();await p.waitForFunction(()=>hasNetworkData);await c.close();
  const fallback=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width:320,height:844}});await fallback.route('**/*.woff2',r=>r.abort());await fallback.route('https://rffk-roo.ru/**',r=>r.abort());
  const f=await fallback.newPage();await f.goto(base+'#team=930');await f.waitForFunction(()=>!loadingData&&!!PLATFORM);await f.locator('#launch-splash').waitFor({state:'detached'});await f.evaluate(()=>document.fonts.ready);
  const fonts=await actualFonts(f,'#team-title');assert(fonts.every(f=>!f.isCustomFont),'Failed font downloads use the system fallback');assert.equal(await f.evaluate(()=>document.documentElement.scrollWidth),320);results.push({name:'fallback',fonts});await fallback.close();assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'offline.json'),JSON.stringify({upgrade:'v14 → v15',httpCacheDisabled:true,originTransportDisconnected:true,swNetworkEvents:true,unvisitedRoutes:true,cachedFonts:cached.filter(u=>u.endsWith('.woff2')).map(u=>new URL(u).pathname),results,errors},null,2)+'\n');console.log('PASS v14→v15, all offline weights, cold documents, both themes, five direct routes, recovery and real system fallback');
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
