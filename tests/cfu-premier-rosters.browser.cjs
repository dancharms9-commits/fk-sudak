/* Targeted CFU Premier League roster/player scenario: 390px and 320px. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),shots=path.join(root,'_state/cfu-premier-rosters');
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 const file=path.join(root,pathname==='/'?'index.html':pathname.slice(1));
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
(async()=>{
 fs.mkdirSync(shots,{recursive:true});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/fk-sudak/';
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
 const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width:390,height:844},deviceScaleFactor:1});
 await context.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-11T12:00:00Z')});
 await context.route('https://rffk-roo.ru/**',r=>r.abort());
 await context.route('https://www.cfu2015.com/**',r=>r.abort());
 const page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const ready=async()=>{
  await page.waitForFunction(()=>!loadingData&&!!CFU_PREMIER&&!!CFU_ROSTERS&&!!CHAMPIONSHIP);
  await page.locator('#launch-splash').waitFor({state:'detached'});
 };
 const noOverflow=async(selector)=>{
  const result=await page.evaluate(selector=>{
   const elements=[...document.querySelectorAll(selector)];
   return {width:innerWidth,scroll:document.documentElement.scrollWidth,
    nav:document.querySelectorAll('#nav button').length,
    clipped:elements.filter(el=>el.scrollWidth>el.clientWidth+1).length};
  },selector);
  assert.equal(result.scroll,result.width,'Horizontal overflow');
  assert.equal(result.nav,5,'Bottom navigation must keep five tabs');
  assert.equal(result.clipped,0,'Roster content is clipped');
 };
 try{
  await page.goto(base+'#table');await ready();
  await page.locator('[data-competition="cfu"]').click();
  await page.locator('[data-cfu-view="teams"]').click();
  await page.locator('[data-team="cfu:team:tavriya"]').click();
  await page.locator('#team.on').waitFor();
  await page.locator('#cfu-roster-title').waitFor();
  const tavriya=page.locator('#team');
  assert((await tavriya.innerText()).includes('Состав · сезон 2026'));
  assert.equal(await page.locator('#team .cfu-roster-player').count(),32);
  assert((await page.locator('#team .cfu-deregistered').count())>0);
  assert((await tavriya.innerText()).includes('Проверено:'));
  assert.equal(await page.locator('#team a.cfu-source[href*="teams/tavriya/"]').count(),2);
  await noOverflow('#team .cfu-roster-player, #team .cfu-roster-body');
  await page.locator('#cfu-roster-title').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(shots,'tavriya-roster-390.png')});

  await page.locator('#team a[data-player="cfu:player:258"]').click();
  await page.locator('#player.on').waitFor();
  assert.equal(await page.locator('#player-title').innerText(),'Валентин Манякин');
  assert((await page.locator('#player').innerText()).includes('ФК "Таврия"'));
  assert((await page.locator('#player').innerText()).includes('Вратарь'));
  assert((await page.locator('#player').innerText()).includes('№ 1'));
  assert((await page.locator('#player').innerText()).includes('26.06.1997'));
  assert.equal(await page.locator('#player a[href="https://www.cfu2015.com/players/258/"]').count(),1);
  assert.equal(await page.locator('#player [data-stat]').count(),0);
  await noOverflow('#player .profile-secondary, #player .cfu-player-records li');
  await page.screenshot({path:path.join(shots,'player-258-390.png')});

  await page.goBack();
  await page.locator('#team.on').waitFor();
  assert.equal(await page.locator('#cfu-roster-title').count(),1);
  await page.locator('#team a[data-player="cfu:player:258"]').click();
  await page.locator('#player.on').waitFor();
  await page.locator('#player-back').click();
  await page.locator('#team.on').waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.player),'cfu:player:258');
  const direct=base+'#player=cfu%3Aplayer%3A258&team=cfu%3Ateam%3Atavriya&from=team';
  await page.goto(direct);await ready();
  assert.equal(await page.locator('#player-title').innerText(),'Валентин Манякин');
  await page.reload();await ready();
  assert.equal(await page.locator('#player-title').innerText(),'Валентин Манякин');
  await page.route('**/cfu-premier-rosters-2026.json*',r=>r.abort());
  await page.reload();await ready();
  assert.equal(await page.locator('#player-title').innerText(),'Валентин Манякин');
  assert.equal(await page.locator('#player a[href="https://www.cfu2015.com/players/258/"]').count(),1);
  await page.unroute('**/cfu-premier-rosters-2026.json*');

  await page.locator('#nav [data-t="table"]').click();
  await page.locator('#table.on').waitFor();
  await page.locator('[data-competition="rfk"]').click();
  await page.locator('#champ-panel').waitFor();
  assert.equal(await page.locator('#champ-panel').count(),1);
  assert.equal(await page.locator('#table .cfu-roster-player').count(),0);
  assert.equal(await page.locator('[data-competition="rfk"]').getAttribute('aria-pressed'),'true');

  await page.setViewportSize({width:320,height:844});
  await page.goto(base+'#team=cfu%3Ateam%3Afc-okean');await ready();
  await page.locator('#cfu-roster-title').waitFor();
  assert.equal(await page.locator('#team .cfu-roster-player').count(),45);
  assert((await page.locator('#team .cfu-deregistered').count())>0);
  await noOverflow('#team .cfu-roster-player, #team .cfu-roster-body');
  await page.locator('#cfu-roster-title').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(shots,'okean-roster-320.png')});

  assert.deepEqual(errors,[]);
  console.log('PASS CFU Tavriya roster/player 390, direct player + reload, Back, RFK switch, Okean roster 320, no overflow, no JS errors');
 }finally{await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());
