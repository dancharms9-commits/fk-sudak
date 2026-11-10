/* Shared profile screen, real data and real service worker; no federation scraping. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const screenshots=process.env.ROSTER_SCREENSHOT_DIR;
let payload=data;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 if(pathname==='/data.json'){res.setHeader('Content-Type','application/json');return res.end(payload===data?fs.readFileSync(path.join(root,'data.json')):JSON.stringify(payload,null,1)+'\n')}
 const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
 res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/fk-sudak/`;
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
 const errors=[],requests=[];
 const context=async(sw='block')=>{
  const c=await browser.newContext({serviceWorkers:sw,reducedMotion:'reduce',viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await c.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-10T12:00:00Z')});
  await c.route('https://rffk-roo.ru/**',r=>r.abort());
  if(process.env.ROSTER_PORTRAIT_FIXTURE)await c.route(data.platform.playersById['146'].photoUrl,r=>r.fulfill({contentType:'image/jpeg',body:fs.readFileSync(process.env.ROSTER_PORTRAIT_FIXTURE)}));
  return c;
 };
 const ready=async p=>{await p.waitForFunction(()=>!loadingData&&hasNetworkData);await p.locator('#launch-splash').waitFor({state:'detached'})};
 const attach=p=>{p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>requests.push(r.url()))};
 const layout=async p=>{await p.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),await p.evaluate(()=>innerWidth));
  assert.equal(await p.locator('#nav button').count(),5);
  assert.equal(await p.locator('#player .player-hero').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
 };
 try{
  const c=await context(),p=await c.newPage();attach(p);
  await p.goto(base+'#team=936');await ready(p);
  const entry=p.locator('#team .club-roster-player[data-platform-player="146:936"]');
  await entry.scrollIntoViewIfNeeded();const scroll=await p.evaluate(()=>scrollY);const href=await entry.getAttribute('href');
  assert(href.startsWith('#player=rffk-146&team=936&competition=4&season=22'));
  await entry.click();await p.locator('#player.on').waitFor();assert.equal(await p.locator('#player-title').innerText(),data.platform.playersById['146'].name);
  assert.equal(await p.locator('#player-back').innerText(),'← К команде');assert.equal(await p.locator('#nav [data-t="table"]').getAttribute('aria-current'),'page');
  assert.equal(await p.locator('header .brand').isVisible(),false);
  await p.locator('#player-back').click();await p.locator('#team.on').waitFor();assert(Math.abs(await p.evaluate(()=>scrollY)-scroll)<3);
  assert(await entry.evaluate(el=>el===document.activeElement));await p.goForward();await p.locator('#player.on').waitFor();
  await p.reload();await ready(p);assert.equal(await p.locator('#player-title').innerText(),data.platform.playersById['146'].name);
  await p.locator('#player-back').click();await p.locator('#team.on').waitFor();
  console.log('PASS club roster → shared profile, explicit ID/season hash, Back/Forward/reload, scroll/focus, unchanged nav');
  for(const theme of ['light','dark'])for(const width of [320,390,768]){
   await p.setViewportSize({width,height:844});await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;localStorage.setItem('sudak-theme',theme)},theme);
   for(const tid of data.platform.competitionSeasons['4:22'].participantTeamIds.filter(id=>id!=='141')){
    const roster=data.platform.rosters['4:22:'+tid];const id=roster.playerIds[0]||roster.clubPlayerIds[0];
    await p.evaluate(h=>{location.hash=h},`#team=${tid}`);await p.locator('#team.on').waitFor();
    const el=p.locator(`#team .club-roster-player[data-platform-player="${id}:${tid}"]`);
    if(!await el.isVisible())await p.locator('#team .club-roster-extra').filter({has:el}).locator('summary').click();
    await el.click();await p.locator('#player.on').waitFor();await layout(p);
    const s=data.platform.playerSeasonStats[`${id}:${tid}:4:22`];
    assert.equal(await p.locator('#player [data-stat="league_goals"] b').innerText(),Number.isInteger(s?.goals)?String(s.goals):'—');
   }
   if(width===390&&screenshots){
    fs.mkdirSync(screenshots,{recursive:true});
    await p.evaluate(()=>{location.hash='#team=936'});await p.locator('#team.on').waitFor();
    await p.locator('#team .club-roster-player[data-platform-player="146:936"]').scrollIntoViewIfNeeded();
    await p.screenshot({path:path.join(screenshots,`kashtan-roster-${theme}-390.png`),animations:'disabled'});
    await p.locator('#team .club-roster-player[data-platform-player="146:936"]').click();await p.locator('#player.on').waitFor();
    await p.evaluate(async()=>{scrollTo(0,0);await Promise.all([...document.querySelectorAll('#player img')].map(i=>i.decode().catch(()=>{})))});
    await p.screenshot({path:path.join(screenshots,`kashtan-player-${theme}-390.png`),animations:'disabled'});
   }
  }
  console.log('PASS profiles from all 10 foreign rosters × 320/390/768 × light/dark; published goals match exact club context');
  for(const [tid,goals,minutes] of [['117','1','337'],['146','6','445']]){
   await p.goto(base+`#player=rffk-1698&team=${tid}&competition=4&season=22`);await ready(p);
   assert.equal(await p.locator('#player [data-stat="league_goals"] b').innerText(),goals);
   assert.equal(await p.locator('#player [data-stat="league_minutes"] b').innerText(),minutes);
   await p.locator('#player-back').click();await p.locator('#team.on').waitFor();assert.equal(await p.locator('#team-title').innerText(),data.platform.teamsById[tid].name);
  }
  for(const hash of ['#player=rffk-999999&team=936&competition=4&season=22','#player=rffk-1698&team=117&competition=4&season=20','#player=rffk-1698&team=1029&competition=4&season=22']){
   await p.goto(base+hash);await ready(p);assert.equal(await p.locator('#player-title').innerText(),'Футболист недоступен');
  }
  await p.goto(base+'#player=rffk-1698');await ready(p);assert((await p.locator('#player').innerText()).includes('Выберите клубный контекст'));
  assert.equal(await p.locator('#player [data-stat="league_goals"] b').innerText(),'—');
  // Existing Sudak deep link must retain the old profile, portrait and goal list.
  await p.goto(base+'#player=rffk-202&name=x&from=home');await ready(p);assert.equal(await p.locator('#player-title').innerText(),'Донской Илья');assert.equal(await p.locator('#player .player-goals').count(),1);
  console.log('PASS real transfer, direct contextual and context-free links, unknown/wrong-season IDs, old Sudak profile');
  // Synthetic missing field/history fixtures never enter the published JSON.
  payload=structuredClone(data);payload.platform.playerSeasonStats['1698:117:4:22'].minutes=null;
  await p.reload();await ready(p);await p.evaluate(()=>{location.hash='#player=rffk-1698&team=117&competition=4&season=22'});await p.locator('#player.on').waitFor();
  assert.equal(await p.locator('#player [data-stat="league_minutes"] b').innerText(),'—');assert.equal(await p.locator('#player [data-stat="league_yellow_cards"] b').innerText(),'0');
  const r=payload.platform.rosters['4:22:936'],unknown=r.unverifiedPlayerIds[0];
  if(unknown){await p.goto(base+`#player=rffk-${unknown}&team=936&competition=4&season=22`);await ready(p);assert((await p.locator('#player').innerText()).includes('не подтверждена'))}
  payload=data;await c.close();
  assert.equal(requests.filter(url=>/rffk-roo\.ru\/players\//.test(url)).length,0,'Opening profiles must never scrape federation pages');
  const off=await context('allow'),op=await off.newPage();attach(op);
  await op.goto(base+'#player=rffk-1698&team=117&competition=4&season=22');await ready(op);
  await op.evaluate(()=>navigator.serviceWorker.ready);await op.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await op.reload();await ready(op);await off.setOffline(true);await op.reload();
  await op.waitForFunction(()=>!loadingData&&hasSavedData);await op.locator('#launch-splash').waitFor({state:'detached'});
  assert.equal(await op.locator('#player [data-stat="league_goals"] b').innerText(),'1');
  await op.locator('#player-back').click();await op.locator('#team.on').waitFor();
  await op.locator('#team .club-roster-player[data-platform-player="1698:117"]').click();await op.locator('#player.on').waitFor();
  assert.equal(await op.locator('#player-title').innerText(),'Барканов Сергей');
  await off.close();assert.deepEqual(errors,[]);console.log('PASS null versus published zero, unverified list, actual SW offline roster/profile and zero JS errors');
  if(process.env.ROSTER_BASELINE_DATA){
   const measures=[];
   for(const [label,fixture] of [['before',JSON.parse(fs.readFileSync(process.env.ROSTER_BASELINE_DATA,'utf8'))],['after',data]]){
    payload=fixture;const mc=await context(),mp=await mc.newPage();attach(mp);await mp.goto(base);await ready(mp);
    assert.deepEqual(await mp.evaluate(()=>JSON.parse(localStorage.getItem('sudak-data-v1'))),fixture,'Whole snapshot fits persistent storage');
    const cdp=await mc.newCDPSession(mp);await cdp.send('HeapProfiler.collectGarbage');
    const heap=await cdp.send('Runtime.getHeapUsage');
    const metrics=await mp.evaluate(()=>({domReadyMs:performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,resource:performance.getEntriesByType('resource').filter(r=>r.name.includes('/data.json')).map(r=>({durationMs:r.duration,bytes:r.decodedBodySize})),nodes:document.querySelectorAll('*').length}));
    measures.push({label,jsonFileBytes:label==='before'?fs.statSync(process.env.ROSTER_BASELINE_DATA).size:fs.statSync(path.join(root,'data.json')).size,heapUsedBytes:heap.usedSize,heapTotalBytes:heap.totalSize,...metrics});await mc.close();
   }
   payload=data;if(screenshots)fs.writeFileSync(path.join(screenshots,'load-and-memory.json'),JSON.stringify(measures,null,2)+'\n');
   console.log('PASS payload and JS heap comparison (local ARM64, no throttling)',JSON.stringify(measures));
  }
 }finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
