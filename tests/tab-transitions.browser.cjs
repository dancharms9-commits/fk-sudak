/* Real animations, interruption, routing/state and v9 -> v10 offline shell. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const cacheName=fs.readFileSync(path.join(root,'sw.js'),'utf8').match(/const CACHE="([^"]+)"/)[1];
let previousWorker=false;
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
  if(previousWorker&&(pathname==='/'||pathname==='/index.html')){
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><p id=previous-shell>Cached v9 shell</p>');return;
  }
  const file=path.join(root,previousWorker&&pathname==='/sw.js'?'tests/fixtures/sw-match-v9.js':pathname==='/'?'index.html':pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);res.end();return}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.json':'application/json','.js':'application/javascript','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
const tabs=['home','matches','table','squad','news'];
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/fk-sudak/';
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  const errors=[];let context;
  const ready=async page=>{
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    await page.locator('#launch-splash').waitFor({state:'detached'});
    await settle(page);
  };
  const settle=page=>page.evaluate(async()=>{
    await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
    await new Promise(requestAnimationFrame);
  });
  const clean=async(page,tab)=>{
    assert.deepEqual(await page.evaluate(()=>({active:[...document.querySelectorAll('main section.on')].map(el=>el.id),
      stale:document.querySelectorAll('.tab-leaving,main section[inert],main section[aria-hidden="true"]').length,
      styles:[...document.querySelectorAll('main section')].some(el=>el.style.cssText.includes('--tab-')),
      opacity:getComputedStyle(document.querySelector('main section.on')).opacity,
      transform:getComputedStyle(document.querySelector('main section.on')).transform,
      pending:tabTransition!==null})),{active:[tab],stale:0,styles:false,opacity:'1',transform:'none',pending:false});
  };
  try{
    context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
    await context.route('https://rffk-roo.ru/uploads/people/**',r=>r.abort());
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await ready(page);
    // Assert state synchronously in the click task; then sample actual frames.
    for(const width of [320,390,768,1440])for(const colorScheme of ['light','dark'])for(const reducedMotion of ['no-preference','reduce']){
      await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme,reducedMotion});
      // Let viewport/media/font changes settle before measuring a transition.
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)});
      for(const tab of [...tabs,'home']){
        const frames=await page.evaluate(async({tab,reduce})=>{
          const old=document.querySelector('main section.on'),nav=document.querySelector('#nav');
          const before=nav.getBoundingClientRect().toJSON();
          nav.querySelector(`[data-t="${tab}"]`).click();
          const next=document.getElementById(tab),initialHeight=document.documentElement.scrollHeight;
          if(!next.classList.contains('on')||nav.querySelector('[aria-current="page"]').dataset.t!==tab)throw Error('Delayed navigation');
          const animations=next.getAnimations();
          if(old!==next&&animations.length!==(reduce?0:1))throw Error('Missing/extra incoming effect');
          if(animations.length&&animations[0].effect.getTiming().duration!==200)throw Error('Wrong duration');
          if(!reduce&&old!==next&&(!old.inert||old.getAttribute('aria-hidden')!=='true'))throw Error('Outgoing section must be inert');
          let count=0;
          do{
            await new Promise(requestAnimationFrame);count++;
            const n=nav.getBoundingClientRect().toJSON();
            if(n.top!==before.top||n.height!==before.height||n.left!==before.left||getComputedStyle(nav).transform!=='none')throw Error('Navigation moved');
            if(document.documentElement.scrollWidth>innerWidth)throw Error('Horizontal overflow');
            if(document.documentElement.scrollHeight!==initialHeight)throw Error(`Transition changes page height ${old.id}->${tab}: ${initialHeight}->${document.documentElement.scrollHeight}; old=${JSON.stringify(old.getBoundingClientRect())}; new=${JSON.stringify(next.getBoundingClientRect())}; leaving=${old.classList.contains('tab-leaving')}`);
            const opacity=Number(getComputedStyle(next).opacity)+(old.classList.contains('tab-leaving')?Number(getComputedStyle(old).opacity):0);
            if(opacity<.8)throw Error('Blank frame');
          }while(tabTransition&&count<90);
          if(tabTransition)throw Error('Animation stuck');
          return count;
        },{tab,reduce:reducedMotion==='reduce'});
        await clean(page,tab);assert(frames>0);
      }
      console.log(`PASS transitions ${width}px ${colorScheme} ${reducedMotion}: immediate nav, stable height/nav, opaque final frames`);
    }
    await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:390,height:844});
    // All 20 directions, followed by a burst without yielding and a burst while
    // the previous effects are halfway through. There is never an animation queue.
    for(const from of tabs)for(const to of tabs.filter(t=>t!==from)){
      await page.evaluate(t=>document.querySelector(`#nav [data-t="${t}"]`).click(),from);await settle(page);
      await page.evaluate(t=>document.querySelector(`#nav [data-t="${t}"]`).click(),to);await settle(page);await clean(page,to);
    }
    if(process.env.VISUAL_SCREENSHOT_DIR){
      fs.mkdirSync(process.env.VISUAL_SCREENSHOT_DIR,{recursive:true});
      for(const width of [320,390,768,1440])for(const colorScheme of ['light','dark']){
        await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme});
        await page.evaluate(()=>document.querySelector('#nav [data-t="home"]').click());await settle(page);
        await page.evaluate(()=>{
          document.querySelector('#nav [data-t="matches"]').click();
          for(const a of document.getAnimations()){a.pause();a.currentTime=70}
        });
        await page.screenshot({path:path.join(process.env.VISUAL_SCREENSHOT_DIR,`tabs-${width}-${colorScheme}.png`),animations:'allow'});
        await page.evaluate(()=>document.getAnimations().forEach(a=>a.play()));await settle(page);
      }
      await page.setViewportSize({width:390,height:844});
    }
    for(const delay of [0,16,80]){
      await page.evaluate(async({tabs,delay})=>{
        for(let i=0;i<25;i++){
          document.querySelector(`#nav [data-t="${tabs[i%5]}"]`).click();
          if(document.querySelectorAll('.tab-leaving').length>1||document.querySelectorAll('main section.on').length!==1)throw Error('Queued screens');
          if(document.getAnimations().filter(a=>a.effect.target.matches('main section')).length>2)throw Error('Queued animations');
          if(delay)await new Promise(r=>setTimeout(r,delay));
        }
      },{tabs,delay});
      await settle(page);await clean(page,'news');
    }
    await page.evaluate(()=>document.querySelector('#nav [data-t="table"]').click());
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>matchMedia('(prefers-reduced-motion: reduce)').matches&&tabTransition===null);
    await clean(page,'table');
    await page.emulateMedia({reducedMotion:'no-preference'});
    console.log('PASS all 20 tab directions, 75 rapid switches, mid-transition reduced-motion cancellation');
    // A filtered list survives actual DOM exit effects, history and player return.
    await page.locator('#nav [data-t="squad"]').click();await settle(page);
    await page.locator('#squad [data-role="Полузащитники"]').click();
    const card=page.locator('#squad a[data-player]').last();await card.scrollIntoViewIfNeeded();
    const scroll=await page.evaluate(()=>scrollY),name=await card.locator('.stats-name').innerText();
    await page.locator('#nav [data-t="table"]').click();
    // Back while still animating must restore the scroll and filtered DOM.
    await page.goBack();await page.locator('#squad.on').waitFor();await settle(page);
    assert.equal(await page.locator('#squad [aria-pressed="true"]').getAttribute('data-role'),'Полузащитники');
    assert(Math.abs(await page.evaluate(()=>scrollY)-scroll)<3);
    await card.click();await page.locator('#player.on').waitFor();
    assert.equal(await page.locator('#player-title').innerText(),name);
    await page.locator('#player-back').click();await page.locator('#squad.on').waitFor();
    assert(await card.evaluate(el=>el===document.activeElement));assert(Math.abs(await page.evaluate(()=>scrollY)-scroll)<3);
    // Entering a detail screen interrupts both section effects immediately.
    await page.locator('#nav [data-t="matches"]').click();
    await page.locator('#matches .result-link[data-match]').first().dispatchEvent('click',{button:0});
    await page.locator('#match.on').waitFor();
    assert.equal(await page.locator('.tab-leaving').count(),0);
    const details=page.locator('#match details').first();
    await details.evaluate(el=>el.open=true);
    const matchHash=await page.evaluate(()=>location.hash);
    await page.locator('#match a[data-player]').first().click();await page.locator('#player.on').waitFor();
    await page.locator('#player-back').click();await page.locator('#match.on').waitFor();
    assert.equal(await page.evaluate(()=>location.hash),matchHash);assert(await details.evaluate(el=>el.open));
    await page.locator('#match-back').click();await page.locator('#matches.on').waitFor();
    await page.goForward();await page.locator('#match.on').waitFor();
    await page.reload();await ready(page);assert.equal(await page.locator('#launch-splash').count(),0);
    assert.equal(await page.evaluate(()=>location.hash),matchHash);
    console.log('PASS filtered list scroll/focus, Back during transition, player/match return, expanded lineup, Forward and deep-link reload');
    await context.close();
    // Upgrade the actual preceding worker, then load cached v10 HTML offline.
    context=await browser.newContext({viewport:{width:390,height:844}});
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));
    previousWorker=true;await offline.goto(base+'manifest.json');
    await offline.evaluate(async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready});
    await offline.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
    assert(await offline.evaluate(async()=> (await caches.keys()).includes('sudak-match-v9')));
    assert(await offline.evaluate(async()=> (await (await (await caches.open('sudak-match-v9')).match('./')).text()).includes('previous-shell')));
    previousWorker=false;
    await offline.evaluate(async()=>{
      window.previousController=navigator.serviceWorker.controller;
      await (await navigator.serviceWorker.getRegistration()).update();
    });
    // Playwright 1.48 does not poll an async predicate; wait on the actual
    // controller/state synchronously, then inspect the completed cache.
    await offline.waitForFunction(()=>navigator.serviceWorker.controller!==window.previousController&&navigator.serviceWorker.controller?.state==='activated');
    assert.deepEqual(await offline.evaluate(()=>caches.keys()),[cacheName]);
    assert(await offline.evaluate(async cacheName=>{
      const cache=await caches.open(cacheName),response=await cache.match(new URL('./',location.href).href);
      if(!response)throw Error(JSON.stringify({cacheName,url:location.href,base:document.baseURI,keys:(await cache.keys()).map(r=>r.url),names:await caches.keys()}));
      const html=await response.text();
      return html.includes('data-launch-policy')&&html.includes('prepareTabTransition')&&!html.includes('previous-shell');
    },cacheName));
    await offline.goto(base);await ready(offline);
    await context.setOffline(true);await offline.reload();
    await offline.waitForFunction(()=>document.querySelector('#upd').textContent.includes('Нет связи'));
    assert.equal(await offline.locator('#launch-splash,#launch-canvas').count(),0);
    assert(await offline.evaluate(()=>typeof prepareTabTransition==='function'));
    for(const tab of tabs){await offline.locator(`#nav [data-t="${tab}"]`).click();await settle(offline);await clean(offline,tab)}
    await offline.locator('#nav [data-t="matches"]').click();await settle(offline);
    await offline.locator('#matches .result-link[data-match]').first().click();await offline.locator('#match.on').waitFor();
    assert.equal(await offline.locator('#match .center-timeline li').count(),data.match_details[[2026,data.res[0][0],data.res[0][1],data.res[0][5]].join('|')].events.length);
    assert.equal(await offline.locator('#match .center-lineup-team').count(),2);
    await context.setOffline(false);
    await offline.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    assert.equal(await offline.locator('#launch-splash').count(),0);
    console.log('PASS actual SW v9 -> v10: cached new controller/styles, offline reload/tabs/events/lineups, reconnect without splash');
    assert.deepEqual(errors,[]);console.log('PASS no JavaScript errors');
  }finally{if(context)await context.close();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server.close());
