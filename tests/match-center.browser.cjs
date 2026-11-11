/* Real protocol data + independent edge fixtures; actual SW upgrade and offline reload. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const first=data.res[0],key=r=>[2026,r[0],r[1],r[5]].join('|'),id=key(first),detail=data.match_details[id];
const shellCache=fs.readFileSync(path.join(root,'sw.js'),'utf8').match(/const CACHE="([^"]+)"/)[1];
let oldWorker=false,diagnostic;
const server=http.createServer((req,res)=>{
  diagnostic?.record('server-request',{url:req.url,oldWorker});
  const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
  const file=path.join(root,oldWorker&&pathname==='/sw.js'?'tests/fixtures/sw-home-v8.js':pathname==='/'?'index.html':pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);res.end();return}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.json':'application/json','.js':'application/javascript','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/fk-sudak/';
  const hash='#match='+encodeURIComponent(id)+'&from=matches';
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  let context;const errors=[];
  try{
    context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
    await context.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-04T12:00:00Z')});
    await context.route('https://rffk-roo.ru/uploads/people/**',r=>r.abort());
    let fixture=data,navigation=0;
    await context.route('**/data.json?*',r=>r.fulfill({json:fixture}));
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    const ready=async()=>{await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));await page.locator('#launch-splash').waitFor({state:'detached'})};
    const load=async(target=hash)=>{
      if(page.url().startsWith(base))await page.evaluate(()=>localStorage.clear());
      const url=new URL(base+target);url.searchParams.set('match-test',String(++navigation));
      await page.goto(url.href,{waitUntil:'domcontentloaded'});await ready();
    };
    const go=async(target)=>{await page.evaluate(hash=>{history.pushState({},'',hash);applyRoute()},target);await page.locator('#match.on').waitFor()};
    await load();
    for(const width of [320,390,768,1440])for(const colorScheme of ['light','dark'])for(const reducedMotion of ['no-preference','reduce']){
      await page.emulateMedia({colorScheme,reducedMotion});await page.setViewportSize({width,height:844});
      await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))});
      const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,clipped:[...document.querySelectorAll('#match .tm,#match .center-score,#match .center-info dd,#match .center-player,#match .center-lineup-team,#match .goal-player')].filter(el=>el.clientWidth&&el.scrollWidth>el.clientWidth+1).map(el=>el.className)}));
      assert.equal(bounds.width,bounds.scroll);assert.deepEqual(bounds.clipped,[]);
      assert.deepEqual(await page.locator('#match .num').allTextContents(),[String(detail.home_score),String(detail.away_score)]);
      assert.equal(await page.locator('#match .center-scorers li').count(),detail.goals.length);
      assert.equal(await page.locator('#match .center-timeline li').count(),detail.events.length);
      assert.equal(await page.locator('#match .center-lineup-team').count(),2);
      assert.equal(await page.locator('#match .center-badge img').getAttribute('src'),'icon-192.png?v=final-crest-v7');
      assert.equal(await page.locator('#match .center-protocol').getAttribute('href'),detail.source_url);
      assert.equal(await page.locator('#match .center-statistics').count(),0);
      if(reducedMotion==='reduce'){
        await page.evaluate(()=>homeMotion(document.querySelector('#match')));
        assert.equal(await page.locator('#match').evaluate(el=>el.getAnimations({subtree:true}).length),0);
      }
      await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
      assert(await page.evaluate(()=>document.querySelector('#match .center-protocol').getBoundingClientRect().bottom<=document.querySelector('#nav').getBoundingClientRect().top));
      if(process.env.VISUAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.VISUAL_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.VISUAL_SCREENSHOT_DIR,`match-${width}-${colorScheme}-${reducedMotion}.png`),fullPage:true})}
    }
    console.log('PASS match centre: real goals/cards/substitutions/lineups, source, 4 widths × 2 themes × 2 motion modes, no overflow/overlap');
    await page.setViewportSize({width:390,height:844});
    // Every original identity/source is retained, including home/away score order.
    for(const row of data.res){
      await go('#match='+encodeURIComponent(key(row))+'&from=matches');
      const protocol=data.match_details[key(row)];
      assert.equal(await page.locator('.center-protocol').getAttribute('href'),protocol.source_url);
      assert.equal(await page.locator('.center-scorers li').count(),protocol.goals.length);
      assert.equal(await page.locator('.center-timeline li.is-goal').count(),protocol.goals.length);
    }
    console.log('PASS all '+data.res.length+' old protocol routes and source links retained');
    await go(hash);
    const donor=page.locator('#match .center-timeline a[data-player="rffk-202"]').first();
    await donor.scrollIntoViewIfNeeded();const centerScroll=await page.evaluate(()=>scrollY),entry=await donor.getAttribute('data-match-player'),deep=await donor.getAttribute('href');
    await donor.click();await page.locator('#player.on').waitFor();assert.equal(await page.locator('#player-title').innerText(),'Донской Илья');
    assert.equal(await page.locator('#player-back').innerText(),'← К матчу');
    assert.equal(await page.locator('#nav [data-t="matches"]').getAttribute('aria-current'),'page');
    const goal=page.locator('#player .player-goal').last();await goal.scrollIntoViewIfNeeded();const profileScroll=await page.evaluate(()=>scrollY);
    await goal.click();await page.locator('#match.on').waitFor();
    await page.locator('#match .center-scorers a[data-player]').first().click();await page.locator('#player.on').waitFor();
    assert.equal(await page.locator('#nav [data-t="matches"]').getAttribute('aria-current'),'page');
    await page.locator('#player-back').click();await page.locator('#match.on').waitFor();
    await page.locator('#match-back').click();await page.locator('#player.on').waitFor();
    assert(Math.abs(await page.evaluate(()=>scrollY)-profileScroll)<3);
    await page.locator('#player-back').click();await page.locator('#match.on').waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.matchPlayer),entry);assert(Math.abs(await page.evaluate(()=>scrollY)-centerScroll)<3);
    // Direct profile URL and reload preserve its parent match, without relying on history state.
    const direct=await context.newPage();direct.on('pageerror',e=>errors.push(e.message));await direct.goto(base+deep,{waitUntil:'domcontentloaded'});
    await direct.locator('#launch-splash').waitFor({state:'detached'});await direct.locator('#player-back').click();await direct.locator('#match.on').waitFor();
    assert.equal(await direct.locator('.center-protocol').getAttribute('href'),detail.source_url);await direct.close();
    await page.locator('#nav [data-t="matches"]').click();
    const upcoming=page.locator('#matches a[data-match]').filter({hasText:data.next[0][1]}).first();await upcoming.click();await page.locator('#match.on').waitFor();
    assert.equal(await page.locator('#match .num').count(),0);assert((await page.locator('#match').innerText()).includes('Матч не начался'));
    await page.locator('#match-back').click();await page.locator('#matches.on').waitFor();assert(await upcoming.evaluate(el=>el===document.activeElement));
    await page.locator('#nav [data-t="home"]').click();await page.locator('#home .home-result').click();await page.locator('#match.on').waitFor();await page.locator('#match-back').click();await page.locator('#home.on').waitFor();
    console.log('PASS calendar/home/profile entry, nested match→profile→goal→profile→match, exact focus/scroll and deep-link Back');
    // Old offline shape: only actual goals; no placeholders for unavailable blocks.
    fixture=structuredClone(data);const legacy=fixture.match_details[id];delete legacy.events;delete legacy.events_complete;delete legacy.lineups;delete legacy.time;legacy.venue='';fixture.res[0][4]='';delete legacy.goals[0].minute;
    await load();
    assert.equal(await page.locator('.center-lineups').count(),0);assert.equal(await page.locator('.center-timeline li').count(),5);
    assert.equal(await page.locator('.center-timeline.is-timed').count(),0);assert((await page.locator('.center-events').innerText()).includes('Минуты части событий не указаны'));
    assert(!(await page.locator('.center-info').innerText()).includes('Стадион'));assert(!(await page.locator('.center-info').innerText()).includes('15:00'));
    fixture.match_details[id].goals[0].type='own_goal';fixture.match_details[id].goals[0].player='Донской И.';await load();
    assert((await page.locator('.center-scorers li').first().innerText()).includes('Автогол'));
    assert((await page.locator('.center-scorers li').first().innerText()).includes('В пользу ФК «Саки»'));
    await page.locator('.center-scorers li').first().locator('a[data-player="rffk-202"]').click();await page.locator('#player.on').waitFor();
    assert.equal(await page.locator('#player [data-stat="league_goals"] b').innerText(),'5');
    fixture=structuredClone(data);delete fixture.match_details[id].lineups;
    const actual=fixture.player_stats_2026.players.find(p=>p.name==='Донской Илья');fixture.player_stats_2026.players.push({...actual,name:'Донской Иван',profile_url:'https://rffk-roo.ru/players/999999/'});
    await load();assert.equal(await page.locator('#match a[data-player="rffk-202"]').count(),0);
    fixture=structuredClone(data);fixture.match_details={};await load();assert.equal(await page.locator('.center-timeline').count(),0);assert.equal(await page.locator('.center-lineups').count(),0);assert((await page.locator('#match').innerText()).includes('Протокол матча недоступен'));
    console.log('PASS legacy/partial data, missing time/stadium/lineup/timeline/stats, penalties, own goal not added to personal stats, homonyms');
    fixture=structuredClone(data);await load();
    const bench=page.locator('details[data-center-list="away-bench"]');await bench.locator('summary').click();
    const player=bench.locator('a[data-player]').first();await player.focus();const openScroll=await page.evaluate(()=>scrollY),focusID=await player.getAttribute('data-match-player');
    fixture.updated=new Date(Date.parse(data.updated)+60000).toISOString();fixture.match_details[id].round+=' · обновлено';
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.querySelector('.center-round')?.textContent.includes('обновлено'));
    assert(await bench.evaluate(el=>el.open));assert.equal(await page.evaluate(()=>document.activeElement.dataset.matchPlayer),focusID);assert(Math.abs(await page.evaluate(()=>scrollY)-openScroll)<3);
    console.log('PASS fresh data updates open match without resetting expanded bench, focus or scroll');
    await context.close();
    context=await browser.newContext({serviceWorkers:'allow',viewport:{width:320,height:844}});
    const offline=await context.newPage();offline.on('pageerror',e=>errors.push(e.message));
    diagnostic=await require('./sw-diagnostics.cjs')(context,offline,process.env.VISUAL_SCREENSHOT_DIR);
    oldWorker=true;await offline.goto(base+'manifest.json');await offline.evaluate(async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready});await offline.waitForFunction(()=>!!navigator.serviceWorker.controller);
    oldWorker=false;await offline.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update()});
    await diagnostic.snapshot('update-returned');
    await offline.waitForFunction(async name=>{const keys=await caches.keys();return keys.includes(name)&&!keys.includes('sudak-home-v8')},shellCache);
    await diagnostic.snapshot('cache-wait-returned');
    await offline.goto(base+hash,{waitUntil:'domcontentloaded'});await offline.locator('#launch-splash').waitFor({state:'detached'});await offline.waitForFunction(()=>!!localStorage.getItem('sudak-data-v1'));
    await diagnostic.snapshot('before-offline');await context.setOffline(true);await diagnostic.snapshot('offline-set');
    try{await offline.reload({waitUntil:'domcontentloaded'});await offline.locator('#launch-splash').waitFor({state:'detached'})}catch(error){await diagnostic.finish(error);diagnostic=null;throw error}
    await diagnostic.snapshot('offline-reload-completed');
    assert((await offline.locator('#upd').innerText()).includes('Нет связи'));assert.equal(await offline.locator('.center-timeline li').count(),detail.events.length);
    assert.equal(await offline.locator('.center-lineup-team').count(),2);await offline.locator('#match .center-scorers a[data-player="rffk-202"]').first().click();await offline.locator('#player.on').waitFor();await offline.locator('#player-back').click();await offline.locator('#match.on').waitFor();
    await offline.evaluate(()=>localStorage.clear());await offline.reload({waitUntil:'domcontentloaded'});await offline.locator('#launch-splash').waitFor({state:'detached'});assert((await offline.locator('#match').innerText()).includes('Протокол матча недоступен'));
    await context.setOffline(false);await offline.waitForFunction(()=>document.querySelector('.center-timeline li'));
    assert.equal(await offline.locator('#launch-splash').count(),0);assert.equal(await offline.locator('.center-protocol').getAttribute('href'),detail.source_url);
    console.log('PASS actual SW v8→v9, saved match/lineups/events/profiles offline, clear missing-cache state and reconnect');
    await diagnostic.finish();diagnostic=null;
    assert.deepEqual(errors,[]);console.log('PASS no JavaScript errors');
  }finally{if(context)await context.close();await browser.close();server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
