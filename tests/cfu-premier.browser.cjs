/* Short CFU Premier League UI scenario: 390px light + 320px dark. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),shots=path.join(root,'_state/cfu-premier-ui');
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
 await context.addInitScript(()=>{Date.now=()=>Date.parse('2026-11-10T12:00:00Z')});
 await context.route('https://rffk-roo.ru/**',r=>r.abort());
 await context.route('https://www.cfu2015.com/**',r=>r.abort());
 const page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const ready=async()=>{
  await page.waitForFunction(()=>!loadingData&&!!CFU_PREMIER&&!!CFU_ROSTERS&&!!CHAMPIONSHIP);
  await page.locator('#launch-splash').waitFor({state:'detached'});
 };
 const noOverflow=async()=>{
  const result=await page.evaluate(async()=>{
   await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const switchButtons=[...document.querySelectorAll('[data-competition]')].map(el=>el.getBoundingClientRect()).filter(r=>r.width>0&&r.height>0);
   return {width:innerWidth,scroll:document.documentElement.scrollWidth,
    nav:document.querySelectorAll('#nav button').length,
    switchHeights:switchButtons.map(r=>r.height),switchRight:Math.max(...switchButtons.map(r=>r.right))};
  });
  assert.equal(result.scroll,result.width,'Horizontal overflow');
  assert.equal(result.nav,5,'Bottom navigation must keep five tabs');
  assert(result.switchHeights.every(height=>height>=43.99),'Competition switch must be at least 44px high');
  assert(result.switchRight<=result.width+.5,'Competition switch clipped');
 };
 const openCfu=async()=>{
  await page.locator('[data-competition="cfu"]').click();
  await page.locator('#cfu-panel').waitFor();
 };
 try{
  await page.goto(base+'#table');await ready();
  assert.equal(await page.locator('[data-competition="rfk"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#champ-panel').count(),1);
  await openCfu();
  assert.equal(await page.locator('[data-competition="cfu"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-cfu-standing]').count(),7);
  assert((await page.locator('#cfu-panel').innerText()).includes('Официальная таблица после 24-го тура'));
  await noOverflow();
  await page.screenshot({path:path.join(shots,'cfu-table-390.png'),fullPage:true});

  await page.locator('[data-competition="rfk"]').click();
  await page.locator('#champ-panel').waitFor();
  assert.equal(await page.locator('#cfu-panel').count(),0);
  await openCfu();

  await page.locator('[data-cfu-view="calendar"]').click();
  await page.locator('#cfu-round').waitFor();
  assert.equal(await page.locator('#cfu-round').inputValue(),'26');
  assert.equal(await page.locator('#table [data-cfu-match]').count(),3);
  await page.locator('#cfu-round').selectOption('28');
  assert.equal(await page.locator('#table [data-cfu-match]').count(),3);
  for(const card of await page.locator('#table [data-cfu-match]').all()){
   const text=await card.innerText();
   assert(text.includes('Счёт не опубликован'));
   assert(!text.includes('Завершён')&&!text.includes('Отменён')&&!text.includes('Перенесён'));
   const source=card.locator('a.cfu-source');
   assert.equal(await source.getAttribute('target'),'_blank');
   assert.equal(await source.getAttribute('rel'),'noopener noreferrer');
  }
  await page.locator('#cfu-all-toggle').click();
  assert.equal(await page.locator('#table [data-cfu-match]').count(),84);
  await page.locator('#cfu-all-toggle').click();
  assert.equal(await page.locator('#table [data-cfu-match]').count(),3);
  await noOverflow();
  await page.screenshot({path:path.join(shots,'cfu-calendar-390.png'),fullPage:true});

  await page.locator('#cfu-team').selectOption('cfu:team:tavriya');
  assert.equal(await page.locator('#table [data-cfu-match]').count(),1);
  await page.locator('#table [data-cfu-match] a[data-team="cfu:team:tavriya"]').click();
  await page.locator('#team.on').waitFor();
  assert.equal((await page.locator('#team-title').innerText()).includes('Таврия'),true);
  assert((await page.locator('#team').innerText()).includes('Симферополь'));
  assert((await page.locator('#team').innerText()).includes('Состав · сезон 2026'));
  assert((await page.locator('#team .cfu-deregistered').count())>0);
  assert.equal(await page.locator('#team [data-cfu-match]').count(),24);
  assert.equal(await page.locator('#team a.cfu-source[href*="/teams/tavriya/"]').count(),2);
  assert((await page.locator('#team').innerText()).includes('Опубликованные результаты'));
  await noOverflow();
  await page.screenshot({path:path.join(shots,'cfu-club-390.png'),fullPage:true});

  await page.locator('#cfu-team-back').click();
  await page.locator('#table.on').waitFor();
  assert.equal(await page.locator('[data-competition="cfu"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#cfu-round').inputValue(),'28');
  assert.equal(await page.locator('#cfu-team').inputValue(),'cfu:team:tavriya');

  await page.locator('#table [data-cfu-match] a[data-team="cfu:team:tavriya"]').click();
  await page.locator('#team.on').waitFor();
  await page.goBack();
  await page.locator('#table.on').waitFor();
  assert.equal(await page.locator('[data-competition="cfu"]').getAttribute('aria-pressed'),'true');

  await page.goto(base+'#team=cfu%3Ateam%3Atavriya');await ready();
  await page.locator('#team-title').waitFor();
  assert((await page.locator('#team-title').innerText()).includes('Таврия'));

  await page.goto(base+'#table');await ready();await openCfu();
  await page.reload();await ready();
  assert.equal(await page.locator('[data-competition="cfu"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-cfu-standing]').count(),7);

  await page.setViewportSize({width:320,height:844});
  await page.evaluate(()=>{localStorage.setItem('sudak-theme','dark');document.documentElement.dataset.theme='dark'});
  await page.locator('[data-cfu-view="calendar"]').click();
  await page.locator('#cfu-round').selectOption('28');
  await noOverflow();
  await page.screenshot({path:path.join(shots,'cfu-calendar-320.png'),fullPage:true});
  await page.locator('#table [data-cfu-match] a[data-team="cfu:team:tavriya"]').click();
  await page.locator('#team.on').waitFor();
  await noOverflow();
  await page.screenshot({path:path.join(shots,'cfu-club-320.png'),fullPage:true});

  assert.deepEqual(errors,[]);
  console.log('PASS CFU table, calendar (rounds 26/28, all 84), Tavriya club/back/direct reload, RFK switch, 320/390 no overflow, no JS errors');
 }finally{await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());
