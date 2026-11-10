/* All official match identities share the production renderer and offline shell. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const shots=process.env.MATCH_SCREENSHOT_DIR;
let payload=data;
const server=http.createServer((req,res)=>{
 const original=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 const before=original.startsWith('/before/'),pathname=before?original.slice(7):original;
 if(before&&pathname==='/'&&process.env.MATCH_BASELINE_HTML){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(fs.readFileSync(process.env.MATCH_BASELINE_HTML))}
 if(before&&pathname==='/data.json'&&process.env.MATCH_BASELINE_DATA){res.setHeader('Content-Type','application/json');return res.end(fs.readFileSync(process.env.MATCH_BASELINE_DATA))}
 if(pathname==='/data.json'){res.setHeader('Content-Type','application/json');return res.end(payload===data?fs.readFileSync(path.join(root,'data.json')):JSON.stringify(payload))}
 const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/fk-sudak/`;
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
 const errors=[],requests=[];
 const context=async(sw='block')=>{const c=await browser.newContext({serviceWorkers:sw,reducedMotion:'reduce',viewport:{width:390,height:844},isMobile:true,hasTouch:true});await c.route('https://rffk-roo.ru/**',r=>r.abort());return c};
 const attach=p=>{p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>requests.push(r.url()))};
 const ready=async p=>{await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'})};
 const go=async(p,key,extra='&from=table')=>p.evaluate(({key,extra})=>{history.replaceState({},'','#match='+encodeURIComponent(key)+extra);applyRoute()}, {key,extra});
 const key=m=>m.sourceMatchId?'rffk-'+m.sourceMatchId:m.matchId;
 const all=Object.values(data.platform.matchesById),prot=data.platform.protocolsByMatchId;
 const candidates=all.filter(m=>prot[m.matchId]&&m.homeTeamId!=='141'&&m.awayTeamId!=='141');
 const selected=candidates[0]||all.find(m=>prot[m.matchId]);
 const checkLayout=async p=>{await p.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),await p.evaluate(()=>innerWidth));assert.equal(await p.locator('#nav button').count(),5)};
 try{
  const c=await context(),p=await c.newPage();attach(p);await p.goto(base);await ready(p);
  for(const m of all){await go(p,key(m));assert.equal(await p.locator('#match.on').count(),1);assert((await p.locator('#match').innerText()).includes(data.platform.teamsById[m.homeTeamId].name));assert((await p.locator('#match').innerText()).includes(data.platform.teamsById[m.awayTeamId].name));assert.deepEqual(await p.locator('#match .num').allTextContents(),['finished','technical'].includes(m.status)?[String(m.homeScore),String(m.awayScore)]:[]);
   if(m.status==='scheduled'){assert.equal(await p.locator('#match .center-timeline li').count(),0);assert.equal(await p.locator('#match .center-lineup-list li').count(),0)}
  }
  console.log('PASS all '+all.length+' known match routes, scores, statuses and scheduled fixtures without invented events');
  const reps=[...new Set(Object.keys(data.platform.teamsById).map(tid=>all.find(m=>prot[m.matchId]&&[m.homeTeamId,m.awayTeamId].includes(tid))||all.find(m=>[m.homeTeamId,m.awayTeamId].includes(tid))))];
  for(const width of [320,390,768,1440])for(const theme of ['light','dark']){
   await p.setViewportSize({width,height:844});await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;localStorage.setItem('sudak-theme',theme)},theme);
   for(const m of reps){await go(p,key(m));await checkLayout(p)}
   if(width===390&&shots){fs.mkdirSync(shots,{recursive:true});await go(p,key(selected));await p.screenshot({path:path.join(shots,'universal-'+theme+'-390.png'),fullPage:true});const future=all.find(m=>m.status==='scheduled');await go(p,key(future));await p.screenshot({path:path.join(shots,'scheduled-'+theme+'-390.png'),fullPage:true});await p.evaluate(()=>{history.replaceState({},'','#match='+encodeURIComponent(matchKey(RES[0])));applyRoute()});await p.screenshot({path:path.join(shots,'sudak-legacy-'+theme+'-390.png'),fullPage:true})}
  }
  console.log('PASS 11 clubs × 4 mobile/tablet/desktop widths × 2 themes; five navigation tabs');
  await p.setViewportSize({width:390,height:844});
  await p.evaluate(tid=>{history.replaceState({},'','#team='+tid);applyRoute()}, selected.homeTeamId==='141'?selected.awayTeamId:selected.homeTeamId);
  const clubHash=await p.evaluate(()=>location.hash),entry=p.locator('#team a[data-club-protocol]').first(),target=await entry.getAttribute('data-match');await entry.click();assert.equal(await p.locator('#match.on').count(),1);await p.reload();await ready(p);await p.locator('#match-back').click();assert.equal(await p.evaluate(()=>location.hash),clubHash);
  await p.goto(base+'#match='+encodeURIComponent(key(selected))+'&from=table');await ready(p);
  const matchHash=await p.evaluate(()=>location.hash),player=p.locator('#match .center-lineup-list a[data-player]').first();
  const playerId=await player.getAttribute('data-player');await player.click();assert.equal(await p.locator('#player.on').count(),1);
  assert((await p.locator('#player').innerText()).includes('Подтверждённые матчи'));await p.reload();await ready(p);await p.locator('#player-back').click();assert.equal(await p.evaluate(()=>location.hash),matchHash);
  await p.locator('#match .center-lineup-list a[data-player]').first().click();const profileHash=await p.evaluate(()=>location.hash);
  await p.locator('#player a[data-match]').last().click();await p.reload();await ready(p);await p.locator('#match-back').click();assert.equal(await p.evaluate(()=>location.hash),profileHash);
  await p.goto(base+'#match='+encodeURIComponent(key(selected)));await ready(p);await p.locator('#match a[data-team]').first().click();assert(['team','home'].includes(await p.evaluate(()=>currentRoute().section)));await p.goBack();assert.equal(await p.locator('#match.on').count(),1);
  console.log('PASS club ↔ match ↔ official player, direct links, reload and browser history');
  // Text actors are unlinked; participation comes from the actual official sheet.
  await go(p,key(selected));assert.equal(await p.locator('#match .center-timeline a[data-player]').count(),0);
  const partial=structuredClone(data),m=partial.platform.matchesById[selected.matchId],sheet=partial.platform.protocolsByMatchId[selected.matchId];sheet.events=sheet.events.filter(e=>!['goal','penalty','own_goal'].includes(e.type));sheet.eventsComplete=false;sheet.goalsComplete=false;payload=partial;
  await p.evaluate(()=>localStorage.clear());await p.reload();await ready(p);assert.equal(await p.locator('#match .center-lineup-team').count(),2);assert.equal(await p.locator('#match .center-timeline li').count(),sheet.events.length);
  for(const unknown of ['rffk-99999999','4:2026:1:0:141']){await go(p,unknown);assert((await p.locator('#match').innerText()).includes('пока недоступны'));assert.equal(await p.locator('#match .num').count(),0)}
  payload=data;
  console.log('PASS partial protocol and unresolved match IDs');
  const oldRow=data.res[0],oldId=[2026,oldRow[0],oldRow[1],oldRow[5]].join('|'),perfMatch=all.find(m=>m.sourceMatchId===String(data.match_details[oldId]?.id))||selected;
  const metrics={environment:'Local ARM64 Chromium; loopback HTTP, no network throttling; JS heap, not Android process RSS'};
  for(const mode of ['before','after']){
   if(mode==='before'&&(!process.env.MATCH_BASELINE_HTML||!process.env.MATCH_BASELINE_DATA))continue;
   const bc=await context(),bp=await bc.newPage();attach(bp);
   await bp.goto(base+(mode==='before'?'before/':''));await ready(bp);
   const jsonTimes=await bp.evaluate(async()=>{const rows=[];for(let i=0;i<5;i++){const start=performance.now(),r=await fetch('data.json?bench='+i,{cache:'no-store'}),body=await r.text(),received=performance.now();JSON.parse(body);const parsed=performance.now();rows.push({fetchMs:received-start,parseMs:parsed-received,bytes:new TextEncoder().encode(body).length});}return rows});
   const timings=[];
   for(let i=0;i<7;i++)timings.push(await bp.evaluate(({key,before})=>new Promise(resolve=>{history.replaceState({},'','#home');applyRoute();const start=performance.now();const target=before?matchKey(RES[0]):key;history.replaceState({},'','#match='+encodeURIComponent(target));applyRoute();requestAnimationFrame(()=>resolve(performance.now()-start))}),{key:key(perfMatch),before:mode==='before'}));
   const devtools=await bc.newCDPSession(bp);await devtools.send('HeapProfiler.collectGarbage');const memory=await devtools.send('Runtime.getHeapUsage');
   metrics[mode]={domContentLoadedMs:await bp.evaluate(()=>performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd),json:jsonTimes,openMatchMs:timings,memory,storedBytes:await bp.evaluate(()=>new Blob([localStorage.getItem('sudak-data-v1')]).size)};
   await bc.close();
  }
  if(shots)fs.writeFileSync(path.join(shots,'load-and-memory.json'),JSON.stringify(metrics,null,2)+'\n');console.log('METRICS '+JSON.stringify(metrics));
  assert(requests.every(url=>!/^https:\/\/rffk-roo.ru\/(matches|players|teams)\//.test(url)));
  await c.close();
  const offline=await context('allow'),o=await offline.newPage();attach(o);await o.goto(base+'#match='+encodeURIComponent(key(selected)));await ready(o);await o.evaluate(()=>navigator.serviceWorker.ready);await o.waitForFunction(()=>!!navigator.serviceWorker.controller);await offline.setOffline(true);
  for(const tid of Object.keys(data.platform.teamsById).filter(id=>id!=='141'))assert.equal(await o.evaluate(async tid=>(await fetch('assets/clubs/'+tid+'.png')).ok,tid),true);
  await o.reload();await ready(o);assert.equal(await o.locator('#match .center-lineup-team').count(),2);assert.deepEqual(await o.locator('#match .num').allTextContents(),[String(selected.homeScore),String(selected.awayScore)]);for(const m of all){await go(o,key(m));assert.deepEqual(await o.locator('#match .num').allTextContents(),['finished','technical'].includes(m.status)?[String(m.homeScore),String(m.awayScore)]:[]);if(m.status==='scheduled')assert.equal(await o.locator('#match .center-timeline li,#match .center-lineup-list li').count(),0)}
  await go(o,key(selected));await o.locator('#match .center-lineup-list a[data-player]').first().click();assert.equal(await o.locator('#player.on').count(),1);await offline.close();
  console.log('PASS real SW offline reload, all 100 match routes/scores/statuses, lineups and player navigation');assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
