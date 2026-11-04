/* Real browser + SW; optional PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE_PATH. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const root=path.resolve(__dirname,'..');
const shellCache=fs.readFileSync(path.join(root,'sw.js'),'utf8').match(/const CACHE="([^"]+)"/)[1];
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const screenshots=process.env.VISUAL_SCREENSHOT_DIR;
const featuredDuration=page=>page.locator('#home .home-next').evaluate(el=>parseFloat(getComputedStyle(el).transitionDuration));
let previousWorker=false;
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
  const file=path.join(root,previousWorker&&pathname==='/sw.js'?'tests/fixtures/sw-launch-v7.js':pathname==='/'?'index.html':pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  fs.readFile(file,(error,body)=>{
    if(error){res.writeHead(404);res.end();return}
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.json':'application/json','.js':'application/javascript','.png':'image/png'})[path.extname(file)]||'application/octet-stream');
    res.end(body);
  });
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/fk-sudak/';
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  const errors=[];
  let context;
  try{
    context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
    // Keep selection tests deterministic when the 2026 season eventually ends.
    await context.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-04T12:00:00Z')});
    await context.route('https://rffk-roo.ru/uploads/people/**',r=>r.abort());
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    let fixture=data;
    await page.route('**/data.json?*',r=>r.fulfill({json:fixture}));
    const load=async()=>{
      if(page.url().startsWith(base))await page.evaluate(()=>localStorage.clear());
      await page.goto(base);
      await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
      await page.locator('#launch-splash').waitFor({state:'detached'});
      await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
    };
    await load();
    for(const width of [320,390,768,1440])for(const colorScheme of ['light','dark'])for(const reducedMotion of ['no-preference','reduce']){
      await page.emulateMedia({colorScheme,reducedMotion});await page.setViewportSize({width,height:844});
      // Chromium 130 may retain theme-transition objects until its next frame,
      // even with a 0.01 ms reduced-motion duration. Wait for actual completion.
      await page.evaluate(async()=>{
        scrollTo(0,0);await new Promise(requestAnimationFrame);
        await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
        await new Promise(requestAnimationFrame);
      });
      const layout=await page.evaluate(()=>{
        const root=document.documentElement;
        const clipped=[...document.querySelectorAll('#home a,#home h2,#home h3,#home .home-teams span,#home .home-player span')]
          .filter(el=>el.clientWidth>0&&el.scrollWidth>el.clientWidth+1).map(el=>el.className||el.tagName);
        return {width:innerWidth,scroll:root.scrollWidth,clipped,columns:getComputedStyle(document.querySelector('.home-grid')).gridTemplateColumns.split(' ').length};
      });
      assert.equal(layout.width,layout.scroll);assert.deepEqual(layout.clipped,[]);
      assert.equal(layout.columns,width<768?1:2);
      assert.equal(await page.locator('#home .home-news .news a').count(),3);
      assert.equal(await page.locator('#home .home-next[data-match]').count(),1);
      assert.equal(await page.locator('#home .home-result').count(),1);
      assert.equal(await page.locator('#home .home-standing-top>b').innerText(),'2\nместо');
      assert.deepEqual(await page.locator('#home .home-metrics dd').allTextContents(),['16','40','+33']);
      if(reducedMotion==='reduce'){
        assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
        const duration=await featuredDuration(page);
        assert(duration<=.00001,'Reduced-motion card transition must be effectively instant');
        await page.evaluate(()=>homeMotion(document.querySelector('#home')));
        assert.equal(await page.locator('#home').evaluate(el=>el.getAnimations({subtree:true}).length),0);
      }
      await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
      const clearance=await page.evaluate(()=>document.querySelector('#home').getBoundingClientRect().bottom<=document.querySelector('#nav').getBoundingClientRect().top);
      assert(clearance,'Home must clear bottom navigation');
      if(screenshots){fs.mkdirSync(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,`dashboard-${width}-${colorScheme}-${reducedMotion}.png`),fullPage:true})}
    }
    console.log('PASS dashboard 320/390/768/1440 × light/dark × motion/reduce: readable names, no overflow, navigation clearance');
    await page.setViewportSize({width:390,height:844});
    const featured=page.locator('#home .home-next');
    await featured.click();await page.locator('#match.on').waitFor();
    assert((await page.locator('#match').innerText()).includes('Матч запланирован'));
    assert((await page.locator('#match').innerText()).includes('УОР'));
    assert(!((await page.locator('#match').innerText()).includes('0 : 0')));
    await page.locator('#match-back').click();await page.locator('#home.on').waitFor();
    assert(await featured.evaluate(el=>el===document.activeElement));
    await page.locator('#home .home-result').click();await page.locator('#match.on').waitFor();
    assert.equal(await page.locator('#match .center-timeline li.is-goal').count(),data.match_details[[2026,...[data.res[0][0],data.res[0][1],data.res[0][5]]].join('|')].goals.length);
    await page.locator('#match-back').click();await page.locator('#home.on').waitFor();
    const leader=page.locator('#home a[data-player]').first();
    const leaderName=await leader.locator('span').nth(2).textContent();
    await leader.scrollIntoViewIfNeeded();const homeScroll=await page.evaluate(()=>scrollY);
    const leaderURL=await leader.getAttribute('href');
    await leader.click();await page.locator('#player.on').waitFor();
    assert.equal(await page.locator('#player-title').innerText(),leaderName);
    assert.equal(await page.locator('#player-back').innerText(),'← На главную');
    assert.equal(await page.locator('#nav [data-t="home"]').getAttribute('aria-current'),'page');
    await page.locator('#player-back').click();await page.locator('#home.on').waitFor();
    assert(await leader.evaluate(el=>el===document.activeElement));assert(Math.abs(await page.evaluate(()=>scrollY)-homeScroll)<3);
    await page.goto(base+leaderURL);await page.locator('#launch-splash').waitFor({state:'detached'});
    await page.locator('#player-back').click();await page.locator('#home.on').waitFor();
    for(const tab of ['table','squad','news']){
      await page.locator(`#home [data-home-tab="${tab}"]`).click();await page.locator(`#${tab}.on`).waitFor();
      await page.goBack();await page.locator('#home.on').waitFor();
    }
    assert.deepEqual(await page.locator('#home .home-news .news a').evaluateAll(links=>links.map(a=>a.href)),data.news.slice(0,3).map(n=>n[3]));
    console.log('PASS upcoming/result/profile deep links, home Back with focus/scroll, table/squad/news links');
    // Tab crossfade replaces the initial home effect; unchanged refresh never restarts it.
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
    await page.locator('#nav [data-t="matches"]').click();await page.locator('#nav [data-t="home"]').click();
    await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
    assert.equal(await page.evaluate(()=>document.querySelector('#home').getAnimations({subtree:true}).length),0);
    const revision=()=>new Date(Date.parse(data.updated)+60000).toISOString();
    fixture={...structuredClone(data),updated:revision()};
    fixture.table[1][3]=41;
    await leader.focus();const beforeScroll=await page.evaluate(()=>scrollY);
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>document.querySelectorAll('.home-metrics dd')[1].textContent==='41');
    assert(await page.locator('#home a[data-player]').first().evaluate(el=>el===document.activeElement));
    assert(Math.abs(await page.evaluate(()=>scrollY)-beforeScroll)<3);
    await page.route('**/data.json?*',r=>r.fulfill({status:503,body:'unavailable'}));
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.locator('#retry-data').waitFor();assert((await page.locator('#upd').innerText()).includes('Нет связи'));
    assert.equal(await page.locator('.home-metrics dd').nth(1).innerText(),'41');
    console.log('PASS fresh data updates in place, focused link/scroll preserved, failed update retains last values');
    // Published final score replaces the open upcoming match through the same route.
    await page.unroute('**/data.json?*');
    fixture=structuredClone(data);
    await page.route('**/data.json?*',r=>r.fulfill({json:fixture}));
    await load();await page.locator('#home .home-next').click();await page.locator('#match.on').waitFor();
    const planned=fixture.next.shift();
    fixture.res.unshift([planned[0],planned[1],2,1,planned[2],planned[3]]);
    fixture.updated=new Date(Date.parse(data.updated)+120000).toISOString();
    await page.evaluate(()=>{Date.now=()=>Date.parse('2026-11-15T12:00:00Z');window.dispatchEvent(new Event('online'))});
    await page.waitForFunction(()=>document.querySelector('#match .num')?.textContent==='1');
    assert.equal(await page.locator('#match .num').nth(1).innerText(),'2');
    await page.locator('#match-back').click();await page.locator('#home.on').waitFor();
    assert((await page.locator('#home .home-next').innerText()).includes('Сталкер'));
    assert((await page.locator('#home .home-result').innerText()).includes('УОР'));
    await page.evaluate(()=>{TABLE=[];renderHome()});
    assert((await page.locator('#home .home-standing').innerText()).includes('Положение клуба пока недоступно'));
    console.log('PASS published result replaces open fixture, next fixture advances, missing standing has an explicit empty state');
    // Missing optional statistics/news/protocols, then no future calendar, then no matches.
    await page.unroute('**/data.json?*');await page.route('**/data.json?*',r=>r.fulfill({json:fixture}));
    fixture=structuredClone(data);fixture.next=[];fixture.news=[];delete fixture.player_stats_2026;fixture.match_details={};
    await load();
    assert.equal(await page.locator('#home a[data-match]').count(),1);assert.equal(await page.locator('#home .home-result').count(),0);
    assert((await page.locator('#home .home-next').innerText()).includes('Завершён'));
    assert.equal(await page.locator('#home a[data-player]').count(),0);assert.equal(await page.locator('#home .home-news .news a').count(),0);
    await page.locator('#home a[data-match]').click();await page.locator('#match.on').waitFor();
    assert((await page.locator('#match').innerText()).includes('Протокол матча недоступен'));
    fixture.res=[];await load();
    assert.equal(await page.locator('#home a[data-match]').count(),0);assert((await page.locator('#home').innerText()).includes('Матчи пока не опубликованы'));
    console.log('PASS no future games without duplicate result, partial/empty data without fabricated stats/news');
    await context.close();
    // Actual service worker, not intercepted fetches: reload the installed shell offline.
    context=await browser.newContext({serviceWorkers:'allow',viewport:{width:320,height:844}});
    await context.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-04T12:00:00Z')});
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));
    previousWorker=true;
    await offline.goto(base+'manifest.json');
    await offline.evaluate(async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready});
    await offline.waitForFunction(()=>!!navigator.serviceWorker.controller);
    assert(await offline.evaluate(async()=>(await caches.keys()).includes('sudak-launch-v7')));
    previousWorker=false;
    await offline.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration();await reg.update()});
    await offline.waitForFunction(async(cacheName)=>{const keys=await caches.keys();return keys.includes(cacheName)&&!keys.includes('sudak-launch-v7')},shellCache);
    console.log('PASS actual approved v7 worker upgrades to current shell without changing crest assets');
    await offline.goto(base,{waitUntil:'domcontentloaded'});await offline.locator('#launch-splash').waitFor({state:'detached'});
    await offline.waitForFunction(()=>!!navigator.serviceWorker.controller&&localStorage.getItem('sudak-data-v1'));
    await context.setOffline(true);await offline.reload({waitUntil:'domcontentloaded'});await offline.locator('#launch-splash').waitFor({state:'detached'});
    assert((await offline.locator('#upd').innerText()).includes('Нет связи'));
    assert.equal(await offline.locator('#home .home-leader').count(),3);
    await offline.locator('#home a[data-player]').first().click();await offline.locator('#player.on').waitFor();
    await offline.locator('#player-back').click();await offline.locator('#home.on').waitFor();
    await offline.locator('#home .home-next').click();await offline.locator('#match.on').waitFor();
    await offline.locator('#match-back').click();await offline.locator('#home.on').waitFor();
    assert.equal(await offline.evaluate(()=>document.documentElement.scrollWidth),320);
    await context.setOffline(false);await offline.waitForFunction(()=>document.querySelector('#retry-data').hidden);
    assert.equal(await offline.locator('#launch-splash').count(),0);
    console.log('PASS real SW: offline dashboard/profiles/fixtures, reconnect without reloading or repeating splash');
    assert.deepEqual(errors,[]);console.log('PASS no JavaScript errors');
  }finally{if(context)await context.close();await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
