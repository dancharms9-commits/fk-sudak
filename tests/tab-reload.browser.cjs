/* Observe from document creation, before the production inline scripts/DCL.
 * Run with the same Playwright/Chromium environment as the existing suites.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const cacheName=fs.readFileSync(path.join(root,'sw.js'),'utf8').match(/const CACHE="([^"]+)"/)[1];
const tabs=['home','matches','table','squad','news'];
let previousWorker=false;
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
  const file=path.join(root,previousWorker&&pathname==='/sw.js'?'tests/fixtures/sw-tabs-v10.js':pathname==='/'?'index.html':pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  if(previousWorker&&(pathname==='/'||pathname==='/index.html')){
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><p id=previous-shell>Cached v10 shell</p>');return;
  }
  fs.readFile(file,(error,body)=>{
    if(error){res.writeHead(404);res.end();return}
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.json':'application/json','.js':'application/javascript','.png':'image/png'})[path.extname(file)]||'application/octet-stream');
    res.end(body);
  });
});

function observeInitialContent(){
  const probe=window.initialContent={samples:[],animations:[],ready:false,done:false};
  const sample=source=>{
    const covered=!!document.querySelector('#launch-splash:not([hidden])');
    const sections=[...document.querySelectorAll('main>section')].filter(el=>el.textContent.trim()).map(el=>{
      const css=getComputedStyle(el),rect=el.getBoundingClientRect();
      return {id:el.id,display:css.display,opacity:Number(css.opacity),transform:css.transform,
        visible:css.display!=='none'&&css.visibility!=='hidden'&&Number(css.opacity)>0&&rect.width>0&&rect.height>0,
        leaving:el.classList.contains('tab-leaving')};
    });
    if(sections.length)probe.samples.push({source,time:performance.now(),state:document.readyState,covered,
      active:document.querySelector('main>section.on')?.id,sections});
  };
  // Record the creation of effects even if a slow test runner misses their frames.
  const animate=Element.prototype.animate;
  Element.prototype.animate=function(keyframes,options){
    if(this.closest('main'))probe.animations.push({id:this.id||this.dataset.homeBlock,
      state:document.readyState,keyframes,options});
    return animate.call(this,keyframes,options);
  };
  const observer=new MutationObserver(()=>sample('mutation'));
  observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden']});
  window.addEventListener('sudak:ready',()=>{sample('ready');probe.ready=true},{once:true});
  document.addEventListener('DOMContentLoaded',()=>sample('DOMContentLoaded'),{once:true});
  let readyFrame;
  function frame(time){
    sample('frame');
    if(probe.ready&&!document.querySelector('#launch-splash')){
      readyFrame??=time;
      // Include every rAF through the entire old 200 ms crossfade.
      if(time-readyFrame>=300){observer.disconnect();probe.done=true;return}
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/fk-sudak/';
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  let context;const errors=[];
  const setup=async(options={})=>{
    if(context)await context.close();
    context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844},...options});
    await context.addInitScript(observeInitialContent);
    await context.route('https://rffk-roo.ru/uploads/people/**',r=>r.abort());
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return page;
  };
  const ready=async page=>{
    await page.waitForFunction(()=>initialContent.done);
    await page.locator('#launch-splash').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    await settle(page);
  };
  const settle=page=>page.evaluate(async()=>{
    await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
    await new Promise(requestAnimationFrame);
  });
  const check=async(page,section,label,{reload=true}={})=>{
    await page.waitForFunction(()=>initialContent.done);
    const probe=await page.evaluate(()=>initialContent);
    if(process.env.VISUAL_SCREENSHOT_DIR){
      fs.mkdirSync(process.env.VISUAL_SCREENSHOT_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.VISUAL_SCREENSHOT_DIR,label+'.json'),JSON.stringify(probe,null,2));
    }
    assert(probe.samples.some(s=>s.source==='ready'&&s.state==='loading'),'Probe must run before DOMContentLoaded');
    const frames=probe.samples.filter(s=>s.source==='frame'&&!s.covered&&s.sections.some(el=>el.visible));
    assert(frames.length>0,'Must observe actual content frames');
    const wrong=probe.samples.filter(s=>!s.covered&&s.sections.some(el=>el.visible&&el.id!==section));
    assert.equal(wrong.length,0,label+': wrong initial content: '+JSON.stringify(wrong.slice(0,2)));
    assert(frames.every(s=>s.active===section),label+': wrong active route');
    assert(frames.every(s=>s.sections.find(el=>el.id===section)?.opacity===1),label+': partially transparent initial content');
    assert(probe.samples.filter(s=>s.source==='frame'&&probe.ready&&!s.covered).every(s=>s.sections.some(el=>el.id===section&&el.visible)),label+': blank content frame');
    if(reload)assert.equal(probe.animations.length,0,label+': initial load must not animate: '+JSON.stringify(probe.animations));
    assert(!probe.animations.some(a=>a.keyframes.some(f=>f.transform)),label+': initial tab transition');
    if(reload){
      assert.equal(await page.evaluate(()=>performance.getEntriesByType('navigation')[0].type),'reload');
      assert(probe.samples.every(s=>!s.covered),label+': repeated splash');
    }
    assert.equal(await page.locator('main>section.on').getAttribute('id'),section);
    assert.equal(await page.locator('.tab-leaving').count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  };
  try{
    // This is the red test: open app -> switch from home -> real document reload.
    let page=await setup();await page.goto(base);await ready(page);
    await page.locator('#nav [data-t="squad"]').click();await settle(page);
    await page.reload();await check(page,'squad','regression-squad-reload');
    console.log('PASS early reload regression: no home in any initial sample/frame');
    // The synchronous inline script is the only producer of section contents.
    // Empty parser-time sections cannot paint home before that task selects a route.
    const shellSections=[...html.matchAll(/<section id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)];
    assert.equal(shellSections.length,7);
    assert(shellSections.every(([,id,content])=>content===''),'Parser shell has no populated default route');
    assert(/restoreSavedData\(\);\s*render\(\);\s*applyRoute\(true\);/.test(html),'Render and route must share a synchronous inline task');
    // All five actual tab clicks/reloads, every requested viewport/theme/motion.
    for(const width of [320,390,768,1440])for(const colorScheme of ['light','dark'])for(const reducedMotion of ['no-preference','reduce']){
      await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme,reducedMotion});
      for(const tab of tabs){
        await page.locator(`#nav [data-t="${tab}"]`).click();await settle(page);
        await page.reload();await check(page,tab,`${width}-${colorScheme}-${reducedMotion}-${tab}`);
      }
      console.log(`PASS early online reloads: ${width}px ${colorScheme} ${reducedMotion}, all five tabs`);
    }
    // Real deep links and reloads, with and without locally saved data.
    await page.emulateMedia({reducedMotion:'no-preference'});
    const row=data.res[0],matchKey=[2026,row[0],row[1],row[5]].join('|');
    const player=data.player_stats_2026.players.find(p=>p.profile_url?.endsWith('/202/'));
    assert(player,'Stable real player fixture');
    const deepLinks=[['match',await page.locator('#matches .result-link').first().getAttribute('href')],
      ['player',await page.locator('#squad a[data-player="rffk-202"]').getAttribute('href')]];
    for(const saved of [false,true])for(const [section,hash] of deepLinks){
      if(!saved)await page.evaluate(()=>localStorage.removeItem('sudak-data-v1'));
      await page.goto(base+'?direct='+section+'-'+saved+hash);await ready(page);
      await check(page,section,`direct-${section}-${saved}`,{reload:false});
      if(section==='match')assert.equal(await page.locator('#match .center-timeline li').count(),data.match_details[matchKey].events.length);
      else assert.equal(await page.locator('#player-title').innerText(),player.name);
      if(!saved)await page.evaluate(()=>localStorage.removeItem('sudak-data-v1'));
      await page.reload();await check(page,section,`reload-${section}-${saved}`);
    }
    console.log('PASS direct profile/match and reloads, with/without saved data');
    // Warm an actually installed v10 worker, update it, then disable the network.
    page=await setup({serviceWorkers:'allow'});
    previousWorker=true;await page.goto(base+'manifest.json');
    await page.evaluate(async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready});
    await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
    assert.deepEqual(await page.evaluate(()=>caches.keys()),['sudak-tabs-v10']);
    assert(await page.evaluate(async()=> (await (await (await caches.open('sudak-tabs-v10')).match('./')).text()).includes('previous-shell')));
    previousWorker=false;
    await page.evaluate(async()=>{
      window.previousController=navigator.serviceWorker.controller;
      await (await navigator.serviceWorker.getRegistration()).update();
    });
    await page.waitForFunction(()=>navigator.serviceWorker.controller!==window.previousController&&navigator.serviceWorker.controller?.state==='activated');
    assert.deepEqual(await page.evaluate(()=>caches.keys()),[cacheName]);
    for(const url of ['./','./index.html']){
      const cached=await page.evaluate(async({cacheName,url})=>(await (await (await caches.open(cacheName)).match(url)).text()),{cacheName,url});
      assert.equal(cached,html,'Complete new HTML/CSS/JS shell after v10 update: '+url);
    }
    await page.goto(base);await ready(page);
    await context.setOffline(true);
    for(const width of [320,390,768,1440])for(const colorScheme of ['light','dark'])for(const reducedMotion of ['no-preference','reduce']){
      await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme,reducedMotion});
      for(const tab of tabs){
        await page.locator(`#nav [data-t="${tab}"]`).click();await settle(page);
        await page.reload();await check(page,tab,`offline-${width}-${colorScheme}-${reducedMotion}-${tab}`);
        await page.waitForFunction(()=>document.querySelector('#upd').textContent.includes('Нет связи'));
      }
      console.log(`PASS early offline reloads after v10 update: ${width}px ${colorScheme} ${reducedMotion}, all five tabs`);
    }
    await page.emulateMedia({reducedMotion:'no-preference'});
    for(const [section,hash] of deepLinks){
      await page.evaluate(hash=>{history.pushState({},'',hash);applyRoute()},hash);await settle(page);
      await page.reload();await check(page,section,'offline-'+section);
      if(section==='match'){
        assert.equal(await page.locator('#match .center-timeline li').count(),data.match_details[matchKey].events.length);
        assert.equal(await page.locator('#match .center-lineup-team').count(),2);
      }else assert.equal(await page.locator('#player-title').innerText(),player.name);
    }
    await context.setOffline(false);
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    assert.equal(await page.locator('#launch-splash').count(),0);
    assert.deepEqual(errors,[],'Unexpected JavaScript errors');
    console.log('PASS exact v10 -> v11 cached shell, offline details/events/lineups, reconnect; no JavaScript errors');

  }finally{if(context)await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());
