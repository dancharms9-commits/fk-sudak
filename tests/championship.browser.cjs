/* Real DOM, data refresh and actual SW v12 -> v13, including GitHub Pages scope. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const cacheName=fs.readFileSync(path.join(root,'sw.js'),'utf8').match(/const CACHE="([^"]+)"/)[1];
let oldWorker=false,servedData=data;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 if(pathname==='/data.json'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(servedData))}
 const file=path.join(root,oldWorker&&pathname==='/sw.js'?'tests/fixtures/sw-photos-v12.js':pathname==='/'?'index.html':pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/fk-sudak/';
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
 const errors=[];
 const attach=page=>page.on('pageerror',e=>errors.push(e.message));
 const ready=async page=>{
  await page.waitForFunction(()=>!loadingData&&CHAMPIONSHIP?.calendar?.matches.length===113);
  await page.locator('#launch-splash').waitFor({state:'detached'});
 };
 const tab=async(page,name)=>{await page.locator('[data-champ-view="'+name+'"]').click();await page.locator('#champ-panel').waitFor()};
 const layout=async page=>{
  const r=await page.evaluate(async()=>{
   await document.fonts.ready;await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
   const clipped=[...document.querySelectorAll('#table button,#table select,#table input,#table .champ-scorer,#table .champ-match')].filter(el=>el.getClientRects().length).filter(el=>{const r=el.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5}).map(el=>el.className);
   return {width:innerWidth,scroll:document.documentElement.scrollWidth,clipped};
  });assert.equal(r.scroll,r.width,'Page horizontal overflow');assert.deepEqual(r.clipped,[]);
 };
 try{
  const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
  await context.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-04T12:00:00Z')});
  await context.route('https://rffk-roo.ru/**',r=>r.abort());
  const page=await context.newPage();attach(page);
  await page.goto(base+'#table');await ready(page);
  assert.equal(await page.locator('#nav button').count(),5);
  assert.equal(await page.locator('[data-t="table"]').innerText(),'Чемпионат');
  assert.equal(await page.locator('[data-t="table"] svg').count(),1);
  for(const colorScheme of ['light','dark'])for(const width of [320,390,768,1440]){
   await page.emulateMedia({colorScheme});await page.setViewportSize({width,height:844});
   for(const name of ['standings','calendar','scorers']){await tab(page,name);await layout(page);
    if(name==='calendar'){
      const tops=await page.locator('.champ-rounds').evaluate(el=>[...el.querySelectorAll('button,select')].map(n=>n.getBoundingClientRect().top));
      assert(Math.max(...tops)-Math.min(...tops)<1,'Round buttons and select share one row');
    }
    if(process.env.VISUAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.VISUAL_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.VISUAL_SCREENSHOT_DIR,`champ-${name}-${colorScheme}-${width}.png`),fullPage:true})}
   }
  }
  console.log('PASS three championship panels × 4 widths × both themes, no overflow, 5 existing navigation buttons');
  await page.setViewportSize({width:390,height:844});
  await tab(page,'calendar');assert.equal(await page.locator('#champ-round').inputValue(),'19');
  await page.locator('[data-champ-step="-1"]').click();assert.equal(await page.locator('#champ-round').inputValue(),'18');
  await page.locator('[data-champ-step="1"]').click();assert.equal(await page.locator('#champ-round').inputValue(),'19');
  await page.locator('#champ-round').selectOption('18');assert.equal(await page.locator('[data-champ-match]').count(),5);
  const technical=page.locator('[data-champ-match="4:2026:18:521:757"]');assert((await technical.innerText()).includes('3:0'));assert((await technical.innerText()).includes('Тех. победа'));
  await technical.locator('summary').click();assert((await technical.innerText()).includes('Стадион не указан'));
  const foreign=page.locator('details[data-champ-match]').filter({hasText:'СТО-Газель'});await foreign.locator('summary').click();assert((await foreign.locator('a').getAttribute('href')).includes('/matches/38763/'));
  await page.locator('#champ-team').selectOption('141');assert.equal(await page.locator('[data-champ-match]').count(),1);
  const match=page.locator('#table a[data-match]');await match.scrollIntoViewIfNeeded();const scroll=await page.evaluate(()=>scrollY);
  await match.click();await page.locator('#match.on').waitFor();assert.equal(await page.locator('#match .center-scorers li').count(),5);
  assert.equal(await page.locator('#nav [data-t="table"]').getAttribute('aria-current'),'page');
  await page.locator('#match-back').click();await page.locator('#table.on').waitFor();
  assert.equal(await page.locator('#champ-round').inputValue(),'18');assert.equal(await page.locator('#champ-team').inputValue(),'141');
  assert(Math.abs(await page.evaluate(()=>scrollY)-scroll)<3);
  await page.locator('#champ-team').selectOption('936');assert.equal(await page.locator('[data-champ-match]').count(),1);
  await page.locator('#champ-status').selectOption('upcoming');assert.equal(await page.locator('[data-champ-match]').count(),0);
  await page.locator('#champ-round').selectOption('19');assert.equal(await page.locator('[data-champ-match]').count(),1);
  assert(!(await page.locator('#champ-panel').innerText()).includes('0:0'));
  await tab(page,'scorers');assert.equal(await page.locator('[data-scorer]').count(),25);
  await page.locator('#champ-search').fill('семёнов ВЛАД');assert.equal(await page.locator('[data-scorer]').count(),1);
  assert.equal(await page.locator('#champ-search').evaluate(el=>el===document.activeElement),true);
  await page.locator('#champ-search').fill('');await page.locator('#champ-scorer-team').selectOption('141');
  await page.locator('#champ-search').fill('Донской');assert.equal(await page.locator('[data-scorer]').count(),1);
  await page.locator('#table a[data-player="rffk-202"]').click();await page.locator('#player.on').waitFor();assert.equal(await page.locator('#player-title').innerText(),'Донской Илья');
  assert.equal(await page.locator('#nav [data-t="table"]').getAttribute('aria-current'),'page');
  const goal=page.locator('#player .player-goal').first();await goal.click();await page.locator('#match.on').waitFor();
  assert.equal(await page.locator('#nav [data-t="table"]').getAttribute('aria-current'),'page');
  await page.locator('#match-back').click();await page.locator('#player.on').waitFor();
  await page.locator('#player-back').click();await page.locator('#table.on').waitFor();assert.equal(await page.locator('#champ-search').inputValue(),'Донской');
  await page.reload();await ready(page);assert.equal(await page.locator('#champ-search').inputValue(),'Донской');
  console.log('PASS round controls, independent filters, technical and unknown results, all 25 scorers, exact club routes and nested returns');
  await tab(page,'calendar');await page.locator('#champ-round').selectOption('18');await page.locator('#champ-team').selectOption('all');await page.locator('#champ-status').selectOption('all');
  await page.locator('details[data-champ-match]').first().locator('summary').click();
  await page.evaluate(()=>scrollTo(0,180));const before=await page.evaluate(()=>scrollY);
  servedData=JSON.parse(JSON.stringify(data));servedData.updated='2026-11-05T21:00:00Z';
  await page.evaluate(()=>refreshData(true));
  assert.equal(await page.locator('#champ-round').inputValue(),'18');assert.equal(await page.locator('details[data-champ-match][open]').count(),1);
  assert(Math.abs(await page.evaluate(()=>scrollY)-before)<3);
  console.log('PASS incoming data keeps round, filters, expanded match and scroll without reload');
  await context.close();servedData=data;
  // Actual prior cache is upgraded with the same shared-storage JSON snapshot.
  oldWorker=true;
  const swContext=await browser.newContext({serviceWorkers:'allow',reducedMotion:'reduce'});
  await swContext.route('https://rffk-roo.ru/**',r=>r.abort());
  const swPage=await swContext.newPage();attach(swPage);
  await swPage.goto(base+'#table');await ready(swPage);
  await swPage.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}))});
  assert((await swPage.evaluate(()=>caches.keys())).includes('sudak-player-photos-v12'));
  await tab(swPage,'calendar');await swPage.locator('#champ-round').selectOption('18');await swPage.locator('#champ-team').selectOption('141');
  oldWorker=false;await swPage.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update()});
  await swPage.waitForFunction(async name=>(await caches.keys()).includes(name)&&!(await caches.keys()).includes('sudak-player-photos-v12'),cacheName);
  assert.equal(await swPage.locator('#champ-round').inputValue(),'18');
  await swPage.reload();await ready(swPage);
  assert.equal(await swPage.locator('#champ-team').inputValue(),'141');
  await swContext.setOffline(true);await swPage.reload();await ready(swPage);
  assert.equal(await swPage.locator('[data-champ-match]').count(),1);
  await swPage.locator('#table a[data-match]').click();await swPage.locator('#match.on').waitFor();assert.equal(await swPage.locator('#match .center-scorers li').count(),5);
  await swPage.locator('#match-back').click();await tab(swPage,'scorers');assert.equal(await swPage.locator('[data-scorer]').count(),25);
  await swPage.locator('#champ-scorer-team').selectOption('141');await swPage.locator('#table a[data-player="rffk-202"]').click();await swPage.locator('#player.on').waitFor();
  assert.equal(await swPage.locator('#player-title').innerText(),'Донской Илья');
  await swContext.setOffline(false);await swPage.evaluate(()=>window.dispatchEvent(new Event('online')));
  await swPage.waitForFunction(()=>!loadingData&&!document.querySelector('#upd').textContent.includes('Нет связи'));
  assert.deepEqual(errors,[]);await swContext.close();
  console.log('PASS actual SW v12→v13, single current cache, offline reload/calendar/scorers/profile/protocol, reconnect, no JavaScript errors');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server.close());
