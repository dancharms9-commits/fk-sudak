/* Run: npm install --no-save --package-lock=false playwright@1.48.2
 *      npx playwright install chromium && node tests/browser.cjs
 * Optional local renderer: PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE_PATH.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const key=r=>[2026,r[0],r[1],r[5]].join('|');
const first=data.res[0],firstKey=key(first);
const source=data.match_details[firstKey];
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.join(root,pathname==='/'?'index.html':pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  fs.readFile(file,(error,body)=>{
    if(error){res.writeHead(404);res.end();return}
    const ext=path.extname(file);
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.json':'application/json','.js':'application/javascript','.png':'image/png'})[ext]||'application/octet-stream');
    res.end(body);
  });
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  try{
    const errors=[];
    let context=await browser.newContext({serviceWorkers:"block"});
    let page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    let navigation=0;
    const load=async(url=base)=>{
      const target=new URL(url);target.searchParams.set("test",String(++navigation));
      await page.goto(target.href);
      await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    };
    const section=async(name)=>{
      await page.locator(`#nav [data-t="${name}"]`).click();
      await page.waitForFunction(name=>document.querySelector('main section.on')?.id===name,name);
    };
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:844});
      await load();
      assert.equal(await page.locator('#home a[data-match]').count(),1);
      await page.locator('#home a[data-match]').click();
      await page.locator('#match.on').waitFor();
      assert.equal(await page.locator('#match .goal-timeline li').count(),source.goals.length);
      assert.equal(await page.locator('#match .num').nth(0).innerText(),String(source.home_score));
      assert.equal(await page.locator('#match .num').nth(1).innerText(),String(source.away_score));
      if(source.goals.length)assert((await page.locator('#match').innerText()).includes(source.goals[0].player));
      if(source.status!=='available')assert((await page.locator('#match').innerText()).includes('Протокол матча недоступен'));
      assert((await page.locator('#match').innerText()).includes(source.date.split('-').reverse().join('.')));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,'Detail overflow at '+width);
      await page.locator('#match-back').click();
      await page.locator('#home.on').waitFor();
      assert.equal(await page.locator('#home a[data-match]').evaluate(el=>el===document.activeElement),true);
      await section('matches');
      assert.equal(await page.locator('#matches a[data-match]').count(),data.res.length);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,'Matches overflow at '+width);
      await page.locator('#matches a[data-match]').last().click();
      await page.locator('#match.on').waitFor();
      await page.locator('#match-back').click();
      await page.locator('#matches.on').waitFor();
      assert.equal(await page.locator('#matches a[data-match]').last().evaluate(el=>el===document.activeElement),true);
      assert((await page.evaluate(()=>window.scrollY))>0,'Back must restore scrolled match list');
      console.log('PASS layout, match links, away score and back/focus/scroll at '+width+'px');
    }
    await page.setViewportSize({width:390,height:844});
    await load();
    await section('matches');
    // Every result opens the protocol belonging to that result.
    for(let i=0;i<data.res.length;i++){
      const row=data.res[i],d=data.match_details[key(row)];
      await page.locator('#matches a[data-match]').nth(i).click();
      await page.locator('#match.on').waitFor();
      assert.equal(await page.locator('#match .goal-timeline li').count(),d.goals.length);
      if(d.source_url)assert.equal(await page.locator('#match .stats-source').getAttribute('href'),d.source_url);
      else assert.equal(await page.locator('#match .stats-source').count(),0);
      await page.goBack();
      await page.locator('#matches.on').waitFor();
    }
    console.log('PASS all '+data.res.length+' protocols, source URLs and browser Back');
    // Unavailable data remains a clickable result and never fabricates scorers.
    const missing=structuredClone(data);
    missing.match_details[firstKey].status='unavailable';
    missing.match_details[firstKey].goals=[];
    await page.route('**/data.json?*',r=>r.fulfill({json:missing}));
    await load(base+'/#match='+encodeURIComponent(firstKey)+'&from=matches');
    assert((await page.locator('#match').innerText()).includes('Протокол матча недоступен'));
    assert.equal(await page.locator('#match .goal-timeline li').count(),0);
    await page.locator('#match-back').click();
    await page.locator('#matches.on').waitFor();
    const legacy=structuredClone(data);delete legacy.match_details;
    await page.unroute('**/data.json?*');
    await page.route('**/data.json?*',r=>r.fulfill({json:legacy}));
    await load();
    await page.locator('#home a[data-match]').click();
    assert((await page.locator('#match').innerText()).includes('Протокол матча недоступен'));
    await page.unroute('**/data.json?*');
    console.log('PASS unavailable protocol and compatibility with legacy data.json');
    // Verified 0:0 uses an explicit no-goals state.
    const zero=structuredClone(data);zero.res[0][2]=0;zero.res[0][3]=0;
    Object.assign(zero.match_details[firstKey],{status:'available',goals:[],home_score:0,away_score:0});
    await page.route('**/data.json?*',r=>r.fulfill({json:zero}));
    await load(base+'/#match='+encodeURIComponent(firstKey));
    assert((await page.locator('#match').innerText()).includes('В этом матче голов не было'));
    await page.unroute('**/data.json?*');
    // Data refresh updates the open protocol without leaving its route.
    await load(base+'/#match='+encodeURIComponent(firstKey)+'&from=home');
    const fresh=structuredClone(data);fresh.updated=new Date(Date.parse(data.updated)+60000).toISOString();
    fresh.match_details[firstKey].status='unavailable';
    fresh.match_details[firstKey].goals=[];
    await page.route('**/data.json?*',r=>r.fulfill({json:fresh}));
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>document.querySelector('#match').textContent.includes('Протокол матча недоступен'));
    assert.equal(await page.locator('main section.on').getAttribute('id'),'match');
    // A stale response must not roll the dataset back.
    await page.unroute('**/data.json?*');
    await page.route('**/data.json?*',r=>r.fulfill({json:data}));
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>!loadingData);
    assert((await page.locator('#match').innerText()).includes('Протокол матча недоступен'));
    await page.unroute('**/data.json?*');
    console.log('PASS direct links, 0:0, live protocol refresh and stale-data protection');
    await load();
    await section('table');
    assert.equal(await page.locator('#table tbody tr').count(),data.table.length);
    await section('squad');
    assert.equal(await page.locator('.stats-player').count(),data.player_stats_2026.players.length);
    await page.locator('[data-role="Вратари"]').click();
    assert.equal(await page.locator('.stats-player').count(),data.player_stats_2026.players.filter(p=>p.position==='Вратари').length);
    await section('news');
    assert.equal(await page.locator('#news a').count(),data.news.length);
    await page.emulateMedia({colorScheme:'dark'});
    await section('matches');
    await page.locator('#matches a[data-match]').first().click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    await page.emulateMedia({colorScheme:'light'});
    // Separate context permits real service-worker requests (which bypass route mocks).
    await context.close();
    context=await browser.newContext({viewport:{width:390,height:844}});
    page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    await load(base+'/#match='+encodeURIComponent(firstKey)+'&from=matches');
    // New routes use only hash fragments: the existing PWA shell still works offline.
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
    assert(await page.evaluate(async()=>!!(await navigator.serviceWorker.getRegistration())));
    assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'),'manifest.json');
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    await context.setOffline(true);
    await page.locator('#match-back').click();
    await page.locator('#matches.on').waitFor();
    await page.locator('#matches a[data-match]').first().click();
    assert.equal(await page.locator('#match .goal-timeline li').count(),source.goals.length);
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.includes('Нет свежих данных'));
    assert((await page.locator('#match').innerText()).includes('Протокол матча недоступен'));
    await context.setOffline(false);
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    assert.equal(await page.locator('#match .goal-timeline li').count(),source.goals.length);
    console.log('PASS standings, player stats/filter, news, dark mode, PWA offline shell and reconnect');
    assert.deepEqual(errors,[],'Browser script errors');
    console.log('PASS no browser JavaScript errors');
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server.close());
