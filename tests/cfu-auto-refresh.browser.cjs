/* Real SW + staged Pages: provisional -> official, stale CDN, offline/reconnect. */
const {disconnectServer}=require('./pwa-offline.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const root=path.resolve(__dirname,'../_site');
const official=JSON.parse(fs.readFileSync(path.join(root,'cfu-sync-2026.json'),'utf8'));
const seed=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const initial=structuredClone(official),key='cfu:match:18767';
// Synthetic pre-result publication; real confirmed publication is the staged fixture.
Object.assign(initial.calendar.matchesById[key],{homeScore:0,awayScore:0,status:null,statusLabel:null});
delete initial.details.matchesById[key];delete initial.details.sourceMetadata.sources[key];
initial.sync.pending=[key];
const revision=Date.parse(official.calendar.sourceMetadata.retrievedAt)+60000;
let published=initial,rffk=structuredClone(seed),status=200;
const seen=[];
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),pathname=url.pathname.replace(/^\/fk-sudak(?=\/)/,'');
  if(pathname==='/cfu-sync-2026.json'||pathname==='/data.json'){
    seen.push(url.href);
    res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'public,max-age=86400'});
    return res.end(status===200?JSON.stringify(pathname==='/data.json'?rffk:published):'Unavailable');
  }
  const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
  fs.readFile(file,(err,body)=>{
    if(err){res.writeHead(404);return res.end()}
    res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');
    res.end(body);
  });
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  const context=await browser.newContext({serviceWorkers:'allow',reducedMotion:'reduce',viewport:{width:390,height:844}});
  await context.route('https://rffk-roo.ru/**',r=>r.abort());
  await context.route('https://www.cfu2015.com/**',r=>r.abort());
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const ready=async()=>{
    await page.waitForFunction(()=>!!CFU_BUNDLE&&!CFU_LOADING&&!loadingData);
    await page.locator('#launch-splash').waitFor({state:'detached'});
  };
  const poll=async()=>{
    await page.evaluate(()=>refreshFootball(true));
    await page.waitForFunction(()=>!CFU_LOADING&&!loadingData);
  };
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}/fk-sudak/#match=cfu%3Amatch%3A18767`);
    await ready();await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    assert.equal(await page.locator('.cfu-center-score b').innerText(),'0:0');
    assert.equal(await page.locator('.cfu-center-status').innerText(),'Статус не подтверждён');
    await page.evaluate(()=>{window.__controller=navigator.serviceWorker.controller;window.__marker='open-cfu'});
    published=structuredClone(official);published.sync.lastAttemptAt=new Date(revision).toISOString();
    rffk.updated=new Date(Date.parse(seed.updated)+60000).toISOString();
    await poll();
    assert.equal(await page.locator('.cfu-center-score b').innerText(),'2:0');
    assert.equal(await page.locator('.cfu-center-status').innerText(),'Матч завершен');
    assert.equal(await page.evaluate(()=>CFU_PREMIER.standings.asOfRound),25);
    assert((await page.locator('#match').innerText()).includes('Данные КФС проверены:'));
    assert.equal(await page.evaluate(()=>CFU_MATCH_DETAILS.matchesById['cfu:match:18767'].goals.length),2);
    assert.equal(await page.evaluate(()=>Object.keys(PLATFORM.teamsById).length),11);
    assert.equal(await page.evaluate(()=>Object.keys(MATCH_DETAILS).length),16);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('sudak-data-v1')).updated),rffk.updated);
    assert(await page.evaluate(()=>window.__marker==='open-cfu'&&window.__controller===navigator.serviceWorker.controller));
    const latest=published.sync.lastAttemptAt;
    published=initial;await poll();
    assert.equal(await page.locator('.cfu-center-score b').innerText(),'2:0');
    assert.equal(await page.evaluate(()=>CFU_BUNDLE.sync.lastAttemptAt),latest);
    status=503;await poll();
    assert((await page.locator('#match').innerText()).includes('Не удалось получить свежие данные КФС'));
    const cached=await page.evaluate(async()=>{
      const urls=[];for(const name of await caches.keys())for(const req of await(await caches.open(name)).keys())urls.push(req.url);
      return urls;
    });
    assert(!cached.some(url=>new URL(url).pathname.endsWith('/cfu-sync-2026.json')));
    await context.setOffline(true);
    const reconnect=await disconnectServer(server);
    assert((await page.reload()).fromServiceWorker(),'Offline HTML must come from the actual service worker');
    await ready();
    assert.equal(await page.locator('.cfu-center-score b').innerText(),'2:0');
    assert.equal(await page.locator('.cfu-center-status').innerText(),'Матч завершен');
    status=200;
    published=structuredClone(official);published.sync.lastAttemptAt=new Date(revision+60000).toISOString();
    await reconnect();await context.setOffline(false);
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(stamp=>CFU_BUNDLE.sync.lastAttemptAt===stamp,published.sync.lastAttemptAt);
    assert.equal(await page.evaluate(()=>CFU_ERROR),'');
    assert.equal(await page.locator('#nav button').count(),5);
    assert(seen.filter(url=>url.includes('cfu-sync-2026.json')).every(url=>url.includes('?v=')));
    assert.deepEqual(errors,[]);
    console.log('PASS atomic CFU + RFFK Pages update, official 2:0/status/table/events, stale CDN/503, real SW offline reload and online event, five tabs, no JS errors');
  }finally{await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());
