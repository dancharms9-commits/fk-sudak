/* Real Chromium integration checks. Uses the existing Playwright setup.
 * Optional local renderer: PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE_PATH.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const root=path.resolve(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
assert.equal(manifest.background_color,manifest.theme_color);
assert.equal(manifest.display,'standalone');
assert.deepEqual(manifest.icons.map(icon=>icon.purpose),['any','any','maskable']);
const approvedSHA='31c854f9497403ceb37824a6115b4496dfd1f9d2984b859bb480f3d7d71bcba2';
assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,'assets/club-crest-original.png'))).digest('hex'),approvedSHA);
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const pathname=url.pathname.replace(/^\/fk-sudak(?=\/)/,'');
  const file=path.join(root,pathname==='/'?'index.html':pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  fs.readFile(file,(error,body)=>{
    if(error){res.writeHead(404);res.end();return}
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.json':'application/json','.js':'application/javascript','.png':'image/png'})[path.extname(file)]||'application/octet-stream');
    res.end(body);
  });
});
// Observe the production controller without changing its timing or entry points.
function observeLaunch(){
  window.launchTimes={};
  const times=window.launchTimes;
  new MutationObserver(()=>{
    const splash=document.getElementById('launch-splash');
    if(splash&&!splash.hidden&&times.shown===undefined)times.shown=performance.now();
    if(splash?.classList.contains('crest-ready')&&times.crest===undefined)times.crest=performance.now();
    if(document.querySelector('main')?.inert&&times.ready===undefined)times.ready=performance.now();
    if(splash?.classList.contains('is-leaving')&&times.leaving===undefined)times.leaving=performance.now();
    if(!splash&&times.shown!==undefined&&times.removed===undefined)times.removed=performance.now();
  }).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden','inert']});
  document.addEventListener('DOMContentLoaded',()=>requestAnimationFrame(()=>{
    times.firstFrameCovered=!!document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('#launch-splash');
  }));
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/fk-sudak/';
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  const errors=[];
  let context;
  const setup=async(options={})=>{
    if(context)await context.close();
    context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844},...options});
    await context.addInitScript(observeLaunch);
    await context.route('https://rffk-roo.ru/uploads/people/**',r=>r.fulfill({contentType:'image/jpeg',body:fs.readFileSync(path.join(root,'tests/fixtures/player-202.jpg'))}));
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    return page;
  };
  const completed=async page=>{
    await page.locator('#launch-splash').waitFor({state:'detached'});
    const times=await page.evaluate(()=>launchTimes);
    const start=Math.max(times.crest,times.ready);
    assert(times.removed-start>=3450&&times.removed-start<4300,JSON.stringify(times));
    assert(times.leaving-start>=2950&&times.leaving-start<3500,JSON.stringify(times));
    assert(times.firstFrameCovered,'The first app frame must be covered');
    assert.equal(await page.locator('header[inert],main[inert],nav[inert]').count(),0);
    assert.equal(await page.locator('#launch-error').isVisible(),false);
    assert.equal(await page.locator('#launch-canvas').count(),0,'Restore the normal page canvas after launch');
    return Math.round(times.removed-start);
  };
  try{
    // Cold document launches, both themes and motion settings, all target widths.
    for(const width of [320,390,768,1440])for(const colorScheme of ['light','dark'])for(const reducedMotion of ['no-preference','reduce']){
      const page=await setup({viewport:{width,height:844},colorScheme,reducedMotion});
      await page.goto(base,{waitUntil:'domcontentloaded'});
      await page.locator('#launch-splash.crest-ready').waitFor();
      await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
      assert(await page.locator('#launch-splash').isVisible(),'App data must be ready behind the splash');
      await page.waitForTimeout(600);
      const view=await page.evaluate(()=>{
        const splash=document.querySelector('#launch-splash'),image=splash.querySelector('img'),name=splash.querySelector('p');
        const r=image.getBoundingClientRect(),s=getComputedStyle(image),n=name.getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,
          r:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},
          n:{top:n.top,bottom:n.bottom},src:image.getAttribute('src'),natural:[image.naturalWidth,image.naturalHeight],
          fit:s.objectFit,opacity:s.opacity,animation:s.animationName,transition:getComputedStyle(splash).transitionDuration,
          background:getComputedStyle(splash).backgroundColor,canvas:getComputedStyle(document.documentElement).backgroundColor,
          theme:document.querySelector('meta[name="theme-color"]').content,blocked:document.querySelector('main').inert};
      });
      assert.equal(view.scroll,width);
      assert.equal(view.src,'assets/club-crest-original.png');
      assert.deepEqual(view.natural,[1024,1536]);assert.equal(view.fit,'contain');assert.equal(view.opacity,'1');
      assert.equal(view.background,'rgb(0, 19, 41)');assert(view.blocked);
      assert.equal(view.canvas,view.background);assert.equal(view.theme,manifest.background_color);
      assert(Math.abs((view.r.top+view.r.bottom)/2-view.height/2)<1,'Crest must share the OS screen centre');
      assert.equal(await page.locator('#launch-splash').count(),1,'Only one web splash');
      assert(Math.abs((view.r.left+view.r.right)/2-width/2)<1);
      assert(view.r.left>=0&&view.r.right<=width&&view.r.top>=24&&view.r.bottom<=view.n.top);
      assert(view.n.bottom<=view.height-39);
      assert(Math.abs(view.r.width/view.r.height-2/3)<.01,'Preserve original PNG aspect ratio');
      if(width<=390)assert(view.r.width/width>=.65&&view.r.width/width<=.701);
      if(reducedMotion==='reduce'){assert.equal(view.animation,'none');assert.equal(view.transition,'0s')}
      if(process.env.VISUAL_SCREENSHOT_DIR){
        fs.mkdirSync(process.env.VISUAL_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.VISUAL_SCREENSHOT_DIR,`launch-${width}-${colorScheme}-${reducedMotion}.png`)});
      }
      // Reduced motion keeps the static screen opaque through 3.0–3.5 s.
      if(reducedMotion==='reduce'){
        await page.waitForFunction(()=>document.querySelector('#launch-splash')?.classList.contains('is-leaving'));
        assert.equal(await page.locator('#launch-splash').evaluate(el=>getComputedStyle(el).opacity),'1');
      }
      console.log(`PASS launch ${width}px ${colorScheme} ${reducedMotion}: ${await completed(page)} ms`);
    }
    let page=await setup();
    await page.goto(base);await completed(page);
    await page.reload();console.log('PASS repeat document launch: '+await completed(page)+' ms');
    // Actual SPA navigation, data refresh and focus/visibility never add a new overlay.
    let recreated=0;
    await page.exposeFunction('reportSplash',()=>{recreated++});
    await page.evaluate(()=>new MutationObserver(records=>{
      if(records.some(r=>[...r.addedNodes].some(n=>n.id==='launch-splash')))window.reportSplash();
    }).observe(document.body,{childList:true,subtree:true}));
    await page.locator('#nav [data-t="squad"]').click();
    await page.locator('#squad [data-role="Полузащитники"]').click();
    const card=page.locator('#squad a[data-player]').last();
    await card.scrollIntoViewIfNeeded();
    const position=await page.evaluate(()=>scrollY);
    await card.click();await page.locator('#player.on').waitFor();
    await page.locator('#player-back').click();await page.locator('#squad.on').waitFor();
    assert.equal(await page.locator('#squad [aria-pressed="true"]').getAttribute('data-role'),'Полузащитники');
    assert(Math.abs(await page.evaluate(()=>scrollY)-position)<3);
    const hash=await page.evaluate(()=>location.hash);
    await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'))});
    await page.waitForFunction(()=>!loadingData);
    assert.equal(await page.evaluate(()=>location.hash),hash);
    await page.locator('#nav [data-t="matches"]').click();
    await page.locator('#matches [data-match]').first().click();await page.locator('#match.on').waitFor();
    await page.locator('#match-back').click();await page.locator('#matches.on').waitFor();
    for(const tab of ['home','table','news'])await page.locator(`#nav [data-t="${tab}"]`).click();
    assert.equal(recreated,0);assert.equal(await page.locator('#launch-splash').count(),0);
    console.log('PASS tabs, player/back/scroll/filter, protocols, focus and live refresh never replay splash');
    // Short landscape viewport: contain the entire artwork and label, no clipping.
    await page.setViewportSize({width:768,height:320});await page.reload();
    await page.locator('#launch-splash.crest-ready').waitFor();
    assert(await page.locator('.launch-crest').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=24&&r.bottom<=document.querySelector('.launch-name').getBoundingClientRect().top}));
    await completed(page);console.log('PASS short landscape viewport');
    // Slow network does not delay access to fallback UI; retry works without replay.
    page=await setup();
    let pending;
    await page.route('**/data.json?*',route=>{pending=route});
    await page.goto(base);await completed(page);
    assert(await page.locator('#home .home-intro').isVisible());
    assert(await page.evaluate(()=>loadingData));
    await pending.fulfill({status:503,body:'temporarily unavailable'});
    await page.locator('#retry-data').waitFor();
    assert((await page.locator('#upd').innerText()).includes('Нет свежих данных'));
    await page.unroute('**/data.json?*');await page.locator('#retry-data').click();
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    assert.equal(await page.locator('#launch-splash').count(),0);
    console.log('PASS slow/failed data: accessible app after 3500 ms, clear error and working retry');
    // Delayed PNG: keep the full brand interval after the actual crest loads.
    page=await setup();let release;
    await page.route('**/assets/club-crest-original.png',r=>{release=r});
    await page.goto(base,{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(700);assert(await page.locator('#launch-splash').isVisible());
    await release.continue();await completed(page);
    console.log('PASS slow crest download preserves full 3500 ms brand interval');
    // Real SW on a GitHub Pages-style subpath; cold shell precaches the PNG.
    page=await setup({serviceWorkers:'allow'});
    await page.goto(base);await completed(page);
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    const cached=await page.evaluate(async()=>{
      const cache=await caches.open('sudak-launch-v6');
      return (await cache.keys()).map(r=>new URL(r.url).pathname);
    });
    assert(cached.includes('/fk-sudak/assets/club-crest-original.png'));
    await context.setOffline(true);await page.reload();await completed(page);
    const offlineManifest=await page.evaluate(async()=>await (await fetch('manifest.json')).json());
    assert.equal(offlineManifest.background_color,manifest.background_color);
    assert.equal(offlineManifest.theme_color,manifest.theme_color);
    assert((await page.locator('#upd').innerText()).includes('Нет связи'));
    await page.locator('#nav [data-t="squad"]').click();assert.equal(await page.locator('#squad a[data-player]').count(),41);
    await page.locator('#squad a[data-player]').first().click();await page.locator('#player.on').waitFor();
    await page.locator('#player-back').click();await page.locator('#squad.on').waitFor();
    await page.evaluate(()=>localStorage.removeItem('sudak-data-v1'));await page.reload();await completed(page);
    assert((await page.locator('#upd').innerText()).includes('Нет свежих данных'));
    await context.setOffline(false);
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    console.log('PASS real SW offline launches with/without saved data, 41 profiles and reconnect');
    // A startup script error reveals recovery immediately instead of blocking UI.
    page=await setup();
    await page.route(base,r=>r.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8').replace('window.dispatchEvent(new Event("sudak:ready"));',"window.dispatchEvent(new ErrorEvent('error',{message:'simulated boot error'}));")}));
    await page.goto(base);await page.locator('#launch-error').waitFor();
    assert.equal(await page.locator('#launch-splash').count(),0);
    assert.equal(await page.locator('main[inert],nav[inert]').count(),0);
    await page.locator('#launch-continue').click();
    assert(await page.locator('#home .home-intro').isVisible());
    console.log('PASS startup error releases UI immediately and Continue works');
    // Broken image and stalled app boot release the UI with explicit recovery.
    page=await setup();await page.route('**/assets/club-crest-original.png',r=>r.abort());
    await page.goto(base);await page.locator('#launch-error').waitFor();
    assert.equal(await page.locator('#launch-splash').count(),0);
    await page.locator('#launch-continue').click();assert.equal(await page.locator('#launch-error').isVisible(),false);
    page=await setup();
    await page.route(base,r=>r.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8').replace('window.dispatchEvent(new Event("sudak:ready"));','/* simulated boot hang */')}));
    await page.goto(base);await page.locator('#launch-error').waitFor();
    assert.equal(await page.locator('#launch-splash').count(),0);
    assert(await page.evaluate(()=>performance.now()<10000));
    await page.unroute(base);await page.locator('#launch-retry').click();await completed(page);
    console.log('PASS image failure, bounded 8 s startup watchdog, continue and reload recovery');
    assert.deepEqual(errors,[],'Unexpected JavaScript errors');
    console.log('PASS approved crest hash unchanged; no JavaScript errors in all launch scenarios');
  }finally{if(context)await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());
