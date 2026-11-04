/* Exercise staged Pages output, hourly data-only deployments and real SW/cache. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(process.env.PAGES_SITE_ROOT||path.join(__dirname,'../_site'));
const seed=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
let published=structuredClone(seed),status=200;
const requests=[];
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const pathname=url.pathname.replace(/^\/fk-sudak(?=\/)/,'');
  if(pathname==='/data.json'){
    requests.push(url.href);
    res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'public,max-age=86400'});
    return res.end(status===200?JSON.stringify(published):'<html>Unavailable</html>');
  }
  const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
  fs.readFile(file,(err,body)=>{
    if(err){res.writeHead(404);return res.end()}
    res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');
    res.end(body);
  });
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  const context=await browser.newContext({serviceWorkers:'allow',reducedMotion:'reduce'});
  await context.route('https://rffk-roo.ru/**',r=>r.abort());
  await context.addInitScript(()=>{
    const interval=window.setInterval.bind(window),clock=Date.now.bind(Date);
    window.__advance=0;Date.now=()=>clock()+window.__advance;
    window.setInterval=(callback,ms,...args)=>{
      if(ms===5*60*1000)window.__poll=async()=>{window.__advance+=16000;return callback(...args)};
      return interval(callback,ms,...args);
    };
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const ready=async()=>{
    await page.waitForFunction(()=>!loadingData&&!!CHAMPIONSHIP?.calendar?.matches.length);
    await page.locator('#launch-splash').waitFor({state:'detached'});
  };
  const revision=async()=>page.evaluate(()=>JSON.parse(localStorage.getItem('sudak-data-v1')).updated);
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}/fk-sudak/#table`);await ready();
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await page.locator('[data-champ-view="calendar"]').click();
    await page.locator('#champ-round').selectOption('18');
    await page.locator('#champ-team').selectOption('141');
    await page.evaluate(()=>{window.__marker='open-PWA';window.__controller=navigator.serviceWorker.controller});
    published=structuredClone(seed);
    published.updated=new Date(Date.parse(seed.updated)+60000).toISOString();
    published.coach+=' · refreshed';
    await page.evaluate(()=>window.__poll());
    await page.waitForFunction(stamp=>JSON.parse(localStorage.getItem('sudak-data-v1')).updated===stamp,published.updated);
    assert.equal(await revision(),published.updated);
    assert.equal(await page.locator('#champ-round').inputValue(),'18');
    assert.equal(await page.locator('#champ-team').inputValue(),'141');
    assert(await page.evaluate(()=>window.__marker==='open-PWA'&&window.__controller===navigator.serviceWorker.controller));
    assert.equal(new Set(requests).size,requests.length,'Every poll bypasses the HTTP cache, despite max-age=86400');
    const cached=await page.evaluate(async()=>{
      const urls=[];for(const name of await caches.keys())for(const req of await (await caches.open(name)).keys())urls.push(req.url);
      return urls;
    });
    assert(!cached.some(url=>new URL(url).pathname.endsWith('/data.json')),'SW must never cache hourly data');
    console.log('PASS staged /fk-sudak/ site: five-minute poll receives data-only deployment, filters and same SW/controller survive, HTTP and SW cache cannot pin old JSON');
    const latest=published.updated;
    published=structuredClone(seed);await page.evaluate(()=>window.__poll());
    await page.waitForFunction(()=>!loadingData);assert.equal(await revision(),latest,'A delayed CDN response cannot roll back saved data');
    status=503;await page.evaluate(()=>window.__poll());await page.waitForFunction(()=>!loadingData);
    assert.equal(await revision(),latest,'An HTTP error cannot replace last-good data');
    await context.setOffline(true);await page.reload();await ready();
    assert.equal(await revision(),latest);
    assert.equal(await page.locator('#champ-round').inputValue(),'18');
    assert.equal(await page.locator('#champ-team').inputValue(),'141');
    assert.equal(await page.evaluate(()=>Object.values(MATCH_DETAILS).filter(m=>m.status==='available').length),16);
    assert.equal(await page.evaluate(()=>Object.values(SQUAD).flat().length),41);
    assert.equal(await page.evaluate(()=>CHAMPIONSHIP.calendar.rounds.length),22);
    const offlinePortrait=await page.evaluate(async()=>{const r=await fetch('assets/players/vladimir-semenov.webp');return r.ok&&(await r.blob()).size>0});
    assert(offlinePortrait);
    await context.setOffline(false);status=200;
    published=structuredClone(seed);published.updated=new Date(Date.parse(seed.updated)+120000).toISOString();
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(stamp=>JSON.parse(localStorage.getItem('sudak-data-v1')).updated===stamp,published.updated);
    assert.deepEqual(errors,[]);
    console.log('PASS stale CDN + HTTP 503 preserve last-good data; offline reload retains 16 protocols, 41 profiles, portraits and 22 rounds; reconnect updates without reload');
  }finally{await context.close();await browser.close();await new Promise(r=>server.close(r))}
})().catch(error=>{console.error(error);process.exitCode=1});
