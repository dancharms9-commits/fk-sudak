/* Real Chromium, GitHub Pages subpath, mobile themes, history and actual offline SW. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),rawData=fs.readFileSync(path.join(root,'data.json')),data=JSON.parse(rawData);
const screenshots=process.env.CLUB_SCREENSHOT_DIR;
let payload=data;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 if(pathname==='/data.json'){res.setHeader('Content-Type','application/json');return res.end(payload===data?rawData:JSON.stringify(payload))}
 const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
 res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/fk-sudak/`;
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
 const errors=[],requests=[];
 const ready=async page=>{await page.waitForFunction(()=>!loadingData&&hasNetworkData);await page.locator('#launch-splash').waitFor({state:'detached'})};
 const attach=page=>{page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()))};
 const newContext=async(serviceWorkers='block')=>{
  const c=await browser.newContext({serviceWorkers,reducedMotion:'reduce',viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await c.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-10T12:00:00Z')});
  await c.route('https://rffk-roo.ru/**',r=>r.abort());return c;
 };
 try{
  const c=await newContext(),page=await c.newPage();attach(page);
  await page.goto(base+'#table');await ready(page);
  assert.equal(await page.locator('#table tbody a[data-team]').count(),11);
  assert.deepEqual(await page.locator('#table tbody a[data-team]').evaluateAll(links=>links.map(a=>a.dataset.team).sort()),[...data.platform.competitionSeasons['4:22'].participantTeamIds].sort());
  const kashtan=page.locator('#table a[data-team="936"]');await kashtan.focus();await kashtan.press('Enter');
  await page.locator('#team.on').waitFor();assert.equal(await page.locator('#team-title').innerText(),'СК «Каштан»');
  assert.equal(await page.locator('#team .club-city').innerText(),'Каштановое');
  assert.deepEqual(await page.locator('#team .club-metrics dd').allTextContents(),['1','51','17']);
  assert.equal(await page.locator('#team .club-hero img').getAttribute('src'),'assets/clubs/936.png');
  await page.locator('#team .club-hero img').evaluate(img=>img.decode());
  assert.equal(await page.locator('#team .club-roster-player').count(),new Set([...data.platform.rosters['4:22:936'].playerIds,...(data.platform.rosters['4:22:936'].clubPlayerIds||[])]).size);
  assert.equal(await page.locator('#nav button').count(),5);
  assert.equal(await page.locator('#nav [data-t="table"]').getAttribute('aria-current'),'page');
  assert.equal(await page.locator('header .brand').isVisible(),false);
  assert.equal(await page.locator('#team a[href="https://rffk-roo.ru/teams/936/"]').count(),1);
  await page.locator('#team-back').click();await page.locator('#table.on').waitFor();assert(await kashtan.evaluate(el=>el===document.activeElement));
  await page.goForward();await page.locator('#team.on').waitFor();await page.reload();await ready(page);assert.equal(await page.locator('#team-title').innerText(),'СК «Каштан»');
  await page.locator('#team-back').click();await page.locator('#table.on').waitFor();
  console.log('PASS Kashtan from table by keyboard, source and official crest, back focus, forward and reload');
  for(const id of data.platform.competitionSeasons['4:22'].participantTeamIds){
   await page.goto(base+'#team='+id);await ready(page);
   if(id==='141'){await page.locator('#home.on').waitFor();assert.equal(await page.locator('#team.on').count(),0)}
   else {await page.locator('#team.on').waitFor();assert.equal(await page.locator('#team-title').innerText(),data.platform.teamsById[id].name);assert.equal(await page.locator('#team .club-roster-player').count(),new Set([...data.platform.rosters['4:22:'+id].playerIds,...(data.platform.rosters['4:22:'+id].clubPlayerIds||[])]).size)}
  }
  for(const id of ['1029','258','0','no-such-team']){await page.goto(base+'#team='+id);await ready(page);assert.equal(await page.locator('#team-title').innerText(),'Команда недоступна');assert.equal(await page.locator('#team [data-team]').count(),0)}
  console.log('PASS all 11 direct club routes, Sudak home alias, unknown/unconfirmed IDs are unavailable');
  // Club-to-club history, Sudak alias, nested protocol return.
  await page.goto(base+'#team=936');await ready(page);
  await page.locator('#team .club-directory [data-team="146"]').click();assert.equal(await page.locator('#team-title').innerText(),'ФК «Саки»');
  await page.locator('#team-back').click();assert.equal(await page.locator('#team-title').innerText(),'СК «Каштан»');
  await page.locator('#team .club-directory [data-team="141"]').click();await page.locator('#home.on').waitFor();
  await page.goBack();await page.locator('#team.on').waitFor();
  await page.locator('#team .club-directory [data-team="146"]').click();
  const protocol=page.locator('#team [data-club-protocol]').first();
  assert.equal(await protocol.count(),1);await protocol.click();await page.locator('#match.on').waitFor();await page.locator('#match-back').click();await page.locator('#team.on').waitFor();assert.equal(await page.locator('#team-title').innerText(),'ФК «Саки»');
  // Existing championship calendar behavior and club name / badge links.
  await page.locator('#nav [data-t="table"]').click();await page.locator('[data-champ-view="calendar"]').click();
  await page.locator('#champ-round').selectOption('18');
  const calendarTeam=page.locator('#table a[data-team="936"]').first();await calendarTeam.locator('img').click();await page.locator('#team.on').waitFor();
  await page.locator('#team-back').click();await page.locator('#table.on').waitFor();assert.equal(await page.locator('#champ-round').inputValue(),'18');
  assert.equal(await page.locator('a[data-team="1029"],a[data-team="258"],a[data-team="0"]').count(),0);
  const centerCard=page.locator('#table div.champ-match').first();await centerCard.locator('.champ-score').scrollIntoViewIfNeeded();const scoreBox=await centerCard.locator('.champ-score').boundingBox();await page.mouse.click(scoreBox.x+scoreBox.width/2,scoreBox.y+scoreBox.height/2);await page.locator('#match.on').waitFor();
  const opponent=page.locator('#match .tm a[data-team]:not([data-team="141"])');
  assert.equal(await opponent.count(),1);await opponent.click();await page.locator('#team.on').waitFor();
  await page.locator('#team-back').click();await page.locator('#match.on').waitFor();
  console.log('PASS calendar emblem link, preserved round, match-center team link and nested returns; no unconfirmed club links');
  // All clubs use one renderer, both themes, narrow Android through desktop.
  for(const theme of ['light','dark'])for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:844});
   await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;localStorage.setItem('sudak-theme',theme)},theme);
   for(const id of data.platform.competitionSeasons['4:22'].participantTeamIds.filter(id=>id!=='141')){
    await page.goto(base+'#team='+id);await ready(page);
    await page.evaluate(async()=>{scrollTo(0,0);await document.fonts.ready;await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,`overflow ${id} ${theme} ${width}`);
    const overlaps=await page.locator('#team .club-hero').evaluate(el=>el.scrollWidth>el.clientWidth+1);assert.equal(overlaps,false);
   }
   if(width===390&&screenshots){
    fs.mkdirSync(screenshots,{recursive:true});
    for(const [id,name] of [['936','kashtan'],['141','sudak']]){
     await page.goto(base+'#team='+id);await ready(page);
     await page.evaluate(async()=>{scrollTo(0,0);await document.fonts.ready;await Promise.all([...document.images].filter(i=>i.getBoundingClientRect().height).map(i=>i.decode().catch(()=>{})))});
     await page.screenshot({path:path.join(screenshots,`${name}-${theme}-390.png`),animations:'disabled'});
    }
   }
  }
  await page.setViewportSize({width:390,height:844});await page.goto(base+'#team=936');await ready(page);
  const before=await page.locator('html').getAttribute('data-theme');await page.locator('#theme-toggle').click();assert.notEqual(await page.locator('html').getAttribute('data-theme'),before);
  await page.reload();await ready(page);assert.notEqual(await page.locator('html').getAttribute('data-theme'),before);
  assert.equal(requests.filter(url=>/rffk-roo\.ru\/players\//.test(url)).length,0,'Club pages must not fetch profiles');
  const metrics=await page.evaluate(()=>({data:performance.getEntriesByType('resource').filter(r=>r.name.includes('/data.json')).map(r=>({durationMs:r.duration,decodedBytes:r.decodedBodySize})),domReadyMs:performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd}));
  if(screenshots)fs.writeFileSync(path.join(screenshots,'mobile-load.json'),JSON.stringify(metrics,null,2)+'\n');
  console.log('PASS 10 club contexts × 4 widths × 2 themes; persistent theme control; no individual profile requests',JSON.stringify(metrics));
  // Clean legacy data and failed optional platform never break the existing home.
  const {platform,...legacy}=data;payload=legacy;
  const old=await newContext(),oldPage=await old.newPage();attach(oldPage);await oldPage.goto(base+'#team=936');await ready(oldPage);
  assert.equal(await oldPage.locator('#team-title').innerText(),'Команда недоступна');
  await oldPage.locator('#nav [data-t="home"]').click();await oldPage.locator('#home.on').waitFor();assert.equal(await oldPage.locator('#home .home-next').count(),1);
  await old.close();payload=data;
  // Broken local logo is non-blocking.
  await c.route('**/assets/clubs/936.png',r=>r.abort());await page.reload();await ready(page);
  await page.waitForFunction(()=>!document.querySelector('#team .club-hero img'));
  assert.equal(await page.locator('#team-title').innerText(),'СК «Каштан»');await c.close();
  console.log('PASS old JSON fallback, existing Sudak home and broken-image initials');
  const offline=await newContext('allow'),offPage=await offline.newPage();attach(offPage);
  await offPage.goto(base+'#team=936');await ready(offPage);await offPage.evaluate(()=>navigator.serviceWorker.ready);
  await offPage.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await offPage.reload();await ready(offPage);await offPage.locator('#team .club-hero img').evaluate(i=>i.decode());
  await offPage.waitForFunction(async()=>!!await caches.match(new URL('assets/clubs/936.png',document.baseURI).href));
  await offline.setOffline(true);await offPage.reload();
  await offPage.waitForFunction(()=>!loadingData&&hasSavedData);await offPage.locator('#launch-splash').waitFor({state:'detached'});
  assert.equal(await offPage.locator('#team-title').innerText(),'СК «Каштан»');
  assert.deepEqual(await offPage.locator('#team .club-metrics dd').allTextContents(),['1','51','17']);
  assert.equal(await offPage.locator('#team .club-hero img').evaluate(i=>i.complete&&i.naturalWidth>0),true);
  assert((await offPage.locator('#upd').innerText()).includes('Нет связи'));
  await offPage.locator('#team .club-directory [data-team="141"]').click();await offPage.locator('#home.on').waitFor();
  await offline.close();assert.deepEqual(errors,[]);console.log('PASS actual SW offline club reload, saved metrics/logo, Sudak return; zero JS errors');
 }finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
