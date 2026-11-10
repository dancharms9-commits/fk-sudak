/* Before/after audit on the real local application. No production data writes. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),phase=process.env.DESIGN_PHASE||'after';
const out=path.resolve(process.env.DESIGN_SCREENSHOT_DIR||path.join(root,'docs/design-polish'),phase);
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
const captureMetrics=()=>{
 const box=e=>{const r=e.getBoundingClientRect();return {height:r.height,top:r.top,bottom:r.bottom,width:r.width}};
 const visible=e=>e.getClientRects().length>0;
 const active=document.querySelector('main>section.on'),navTop=document.querySelector('#nav').getBoundingClientRect().top;
 const rows=[...active.querySelectorAll('.champ-match,.club-roster-player')].filter(visible);
 const fullyVisible=rows.filter(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=navTop});
 const controls=[...active.querySelectorAll('button,select,input,a,summary')].filter(visible);
 return {scrollWidth:document.documentElement.scrollWidth,width:innerWidth,scrollY,navTop,
  rows:rows.map(box),fullyVisibleRows:fullyVisible.length,
  hero:active.querySelector('.center-hero,.club-hero,.player-hero')?box(active.querySelector('.center-hero,.club-hero,.player-hero')):null,
  filters:active.querySelector('.champ-filters')?box(active.querySelector('.champ-filters')):null,
  toolbar:active.querySelector('.champ-rounds')?{top:box(active.querySelector('.champ-rounds')).top,bottom:box(active.querySelector('#champ-match-count')).bottom}:null,
  controls:controls.map(e=>({text:(e.getAttribute('aria-label')||e.textContent).trim().slice(0,70),tag:e.tagName,...box(e)})),
  overflowing:controls.filter(e=>{const r=e.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5}).map(e=>e.className)};
};
(async()=>{
 fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/fk-sudak/`;
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
 const metrics=[],errors=[];
 try{
  for(const theme of ['dark','light'])for(const width of [320,390,768,1440]){
   const c=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
   await c.addInitScript(theme=>{localStorage.setItem('sudak-theme',theme);Date.now=()=>Date.parse('2026-11-10T12:00:00Z')},theme);
   await c.route('https://rffk-roo.ru/**',r=>r.abort());
   const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
   await p.goto(base);await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
   const route=hash=>p.evaluate(hash=>{history.replaceState({},'',hash);applyRoute();scrollTo(0,0)},hash);
   const shot=async(name)=>{
    await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('main>section.on img,header img')].map(i=>i.decode().catch(()=>{})));await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))});
    const m=await p.evaluate(captureMetrics);metrics.push({screen:name,theme,width,...m});
    assert.equal(m.scrollWidth,width,name+' horizontal overflow');assert.deepEqual(m.overflowing,[],name+' clipped controls');
    await p.screenshot({path:path.join(out,`${name}-${theme}-${width}.png`),animations:'disabled'});
   };
   await shot('home');
   await route('#table');await p.evaluate(()=>{CHAMP_STATE.view='standings';renderChampionship()});await shot('standings');
   await p.evaluate(()=>{CHAMP_STATE.view='calendar';CHAMP_STATE.round='18';CHAMP_STATE.team='all';CHAMP_STATE.status='all';renderChampionship()});await shot('calendar');
   await p.locator('#champ-team').selectOption('141');await p.locator('#champ-status').selectOption('played');await shot('filters');
   await route('#team=936');await shot('kashtan');
   await p.locator('#team .club-roster-player').first().evaluate(e=>scrollTo(0,scrollY+e.getBoundingClientRect().top-24));await shot('roster');
   await route('#player=rffk-146&team=936&competition=4&season=22&from=team');await shot('popov');
   await route('#match=rffk-38771&from=table');await shot('finished');
   await route('#match=4%3A2026%3A20%3A117%3A141&from=table');await shot('scheduled');
   if(phase==='after'){
    assert.equal(await p.locator('#match .center-timeline li,#match .center-lineup-list li').count(),0);
    assert.equal(await p.locator('#match .center-hero').innerText().then(t=>(t.match(/запланирован/gi)||[]).length),1);
    await p.evaluate(()=>{CHAMP_STATE.team='all';CHAMP_STATE.status='all';CHAMP_STATE.round='18'});
    await route('#table');await p.locator('#champ-round').selectOption('18');
    assert((await p.locator('#table .champ-tabs button').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h===44),'Default tab labels stay on one line');
    // Every calendar action retains a 44px target, including both club links.
    const sizes=await p.locator('#table .champ-match a,#table button,#table select').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({text:e.textContent.trim(),h:e.getBoundingClientRect().height,w:e.getBoundingClientRect().width})));
    for(const s of sizes)assert(s.h>=44&&s.w>=44,JSON.stringify(s));
   }
   await c.close();
  }
  if(phase==='after'){
   const c=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width:320,height:844}});
   await c.route('https://rffk-roo.ru/**',r=>r.abort());
   await c.route('**/assets/clubs/*.png',r=>r.abort());
   const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+'#table');
   await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
   await p.evaluate(()=>{CHAMP_STATE.view='calendar';CHAMP_STATE.round='19';renderChampionship()});
   await p.locator('#champ-round').selectOption('18');
   const first=p.locator('[data-champ-match]').first(),key=await first.locator('a[data-match]').getAttribute('data-match');
   const date=await first.locator('.champ-date').boundingBox();await p.mouse.click(date.x+date.width/2,date.y+date.height/2);
   assert.equal(await p.evaluate(()=>currentRoute().key),key,'Date area opens the same center as score');
   await p.locator('#match-back').click();
   await first.locator('a[data-match]').focus();await p.keyboard.press('Enter');
   assert.equal(await p.evaluate(()=>currentRoute().key),key);await p.locator('#match-back').click();
   for(const theme of ['light','dark']){
    await p.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const round of ['18','19','20','22']){
     await p.locator('#champ-round').selectOption(round);
     for(const status of ['all','played','upcoming']){
      await p.locator('#champ-status').selectOption(status);
      assert.equal(await p.locator('[data-champ-match]').count(),await p.evaluate(()=>selectedChampMatches().length));
     }
    }
    await p.locator('#champ-status').selectOption('all');await p.locator('#champ-round').selectOption('18');
    for(const id of ['141','936','1030','932','521','930','146','934','757','1028','117','all']){
     await p.locator('#champ-team').selectOption(id);
     assert.equal(await p.locator('[data-champ-match]').count(),await p.evaluate(()=>selectedChampMatches().length));
    }
    // Simulate enlarged system text without widening the 320px container.
    await p.evaluate(()=>{
     CHAMP_STATE.round='18';renderChampionship();
     document.querySelectorAll('#table .champ-team,#table .champ-score,#table .champ-meta,#table select,#table button').forEach(e=>{e.style.fontSize=parseFloat(getComputedStyle(e).fontSize)*1.5+'px'});
    });
    const m=await p.evaluate(captureMetrics);assert.equal(m.scrollWidth,320);assert.deepEqual(m.overflowing,[]);
    await p.evaluate(()=>{history.replaceState({},'','#match=rffk-38771&from=table');applyRoute()});
    await p.evaluate(()=>document.querySelectorAll('.match-polish b,.match-polish .num,.match-polish small,.match-polish .match-meta').forEach(e=>{e.style.fontSize=parseFloat(getComputedStyle(e).fontSize)*1.5+'px'}));
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),320);
    await p.waitForFunction(()=>!document.querySelector('.match-polish .center-badge img'));
    assert.equal(await p.locator('.match-polish .center-badge img').count(),0,'Failed crests leave initials');
    await p.evaluate(()=>document.querySelectorAll('.match-polish [style]').forEach(e=>e.style.removeProperty('font-size')));
    await p.evaluate(()=>{history.replaceState({},'','#table');applyRoute()});
   }
   await c.close();console.log('PASS all club filters, status filters, technical/postponed/missing-date rounds, missing crests, 150% text at 320px in both themes');
  }
  fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
  assert.deepEqual(errors,[]);console.log(`PASS ${phase}: 9 screens × 4 widths × 2 themes, real PNGs and layout metrics`);
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
