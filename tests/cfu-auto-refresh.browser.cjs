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
// Roll the official table back one round for this synthetic older publication.
// The test must observe changed standings as well as the changed match result.
initial.calendar.standings.asOfRound=24;
for(const match of Object.values(official.calendar.matchesById).filter(m=>m.round===25)){
  for(const [side,other] of [['home','away'],['away','home']]){
    const row=initial.calendar.standings.rows.find(r=>r.teamId===match[side+'TeamId']);
    const own=match[side+'Score'],opponent=match[other+'Score'];
    row.played--;row.wins-=Number(own>opponent);row.draws-=Number(own===opponent);row.losses-=Number(own<opponent);
    row.goalsFor-=own;row.goalsAgainst-=opponent;row.goalDifference-=own-opponent;
    row.points-=own>opponent?3:own===opponent?1:0;
  }
}
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
    assert.equal(await page.evaluate(()=>CFU_PREMIER.standings.asOfRound),24);
    assert.equal(await page.evaluate(()=>CFU_PREMIER.standings.rows[0].points),46);
    await page.evaluate(()=>{window.__controller=navigator.serviceWorker.controller;window.__marker='open-cfu'});
    published=structuredClone(official);published.sync.lastAttemptAt=new Date(revision).toISOString();
    rffk.updated=new Date(Date.parse(seed.updated)+60000).toISOString();
    await poll();
    assert.equal(await page.locator('.cfu-center-score b').innerText(),'2:0');
    assert.equal(await page.locator('.cfu-center-status').innerText(),'Матч завершен');
    assert.equal(await page.evaluate(()=>CFU_PREMIER.standings.asOfRound),25);
    assert.equal(await page.evaluate(()=>CFU_PREMIER.standings.rows[0].points),49);
    assert((await page.locator('#match').innerText()).includes('Данные КФС проверены:'));
    assert.equal(await page.evaluate(()=>CFU_MATCH_DETAILS.matchesById['cfu:match:18767'].goals.length),2);
    assert.equal(await page.evaluate(()=>Object.keys(PLATFORM.teamsById).length),11);
    assert.equal(await page.evaluate(()=>Object.keys(MATCH_DETAILS).length),16);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('sudak-data-v1')).updated),rffk.updated);
    assert(await page.evaluate(()=>window.__marker==='open-cfu'&&window.__controller===navigator.serviceWorker.controller));
    // Count the real calls and retain actual DOM nodes across unchanged polls.
    await page.locator('#nav button[data-t="table"]').click();
    await page.locator('.cfu-table').waitFor();
    await page.evaluate(()=>{
      window.__perf={stringify:0,snapshotStringify:0,writes:0,render:0,table:0};
      window.__tableNode=document.querySelector('.cfu-table');
      const stringify=JSON.stringify,setItem=Storage.prototype.setItem,fullRender=render,tableRender=renderChampionship;
      JSON.stringify=function(value,...args){
        __perf.stringify++;if(value&&(value.updated&&value.table||value.calendar&&value.details))__perf.snapshotStringify++;
        return stringify.call(this,value,...args);
      };
      Storage.prototype.setItem=function(...args){__perf.writes++;return setItem.apply(this,args)};
      render=function(...args){__perf.render++;return fullRender(...args)};
      renderChampionship=function(...args){__perf.table++;return tableRender(...args)};
    });
    for(let i=0;i<3;i++)await poll();
    assert.deepEqual(await page.evaluate(()=>({...__perf})),{stringify:0,snapshotStringify:0,writes:0,render:0,table:0});
    assert(await page.evaluate(()=>__tableNode===document.querySelector('.cfu-table')&&__tableNode.isConnected));
    published.sync.lastSuccessAt=new Date(revision).toISOString();await poll();
    assert.equal(await page.evaluate(()=>__perf.snapshotStringify),1);
    assert.equal(await page.evaluate(()=>__perf.writes),1);
    assert.equal(await page.evaluate(()=>__perf.table),0);
    assert.equal(await page.evaluate(()=>__perf.render),0);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('sudak-cfu-sync-v1')).sync.lastSuccessAt),published.sync.lastSuccessAt);
    assert.equal(await page.locator('#table [data-cfu-status]').innerHTML(),await page.evaluate(()=>cfuStatusNote()));
    published.sync.error='Source conflict';await poll();
    assert((await page.locator('#table [data-cfu-status]').innerText()).includes('конфликт'));
    published.sync.error=null;published.sync.pending=[key];await poll();
    assert((await page.locator('#table [data-cfu-status]').innerText()).includes('Ожидается официальное подтверждение'));
    published.sync.pending=[];
    published.calendar.sourceMetadata.sections.table.checkedAt='2026-11-12T02:00:00Z';await poll();
    assert.equal(await page.locator('[data-cfu-table-checked]').innerText(),'12.11.2026');
    assert(!(await page.locator('#table [data-cfu-status]').innerText()).includes('Ожидается официальное подтверждение'));
    assert(await page.evaluate(()=>__tableNode===document.querySelector('.cfu-table')&&__tableNode.isConnected));
    assert.equal(await page.evaluate(()=>__perf.table),0);
    await page.evaluate(()=>{location.hash='#match=cfu%3Amatch%3A18767'});
    await page.locator('.cfu-center-score b').waitFor();
    await page.evaluate(()=>{window.__scoreNode=document.querySelector('.cfu-center-score')});
    published.details.matchesById[key].checkedAt='2026-11-12T02:00:00Z';await poll();
    assert.equal(await page.locator('[data-cfu-protocol-checked]').innerText(),'12.11.2026');
    assert(await page.evaluate(()=>__scoreNode===document.querySelector('.cfu-center-score')&&__scoreNode.isConnected));
    console.log('PASS operation counters: 3 equal RFFK/CFU polls = 0 stringify/storage/full/table renders; CFU metadata retains real table and score nodes');
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
