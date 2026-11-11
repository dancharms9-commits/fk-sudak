/* CFU Premier League match centre: 390px light and 320px dark scenarios. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),shots=path.join(root,'_state/cfu-premier-match-center');
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
 const errors=[];
 const newContext=async(viewport,theme)=>{
  const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport,deviceScaleFactor:1});
  await context.addInitScript(theme=>{localStorage.setItem('sudak-theme',theme);Date.now=()=>Date.parse('2026-11-11T12:00:00Z')},theme);
  await context.route('https://rffk-roo.ru/**',r=>r.abort());
  await context.route('https://www.cfu2015.com/**',r=>r.abort());
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  return {context,page};
 };
 const ready=async page=>{
  await page.waitForFunction(()=>!loadingData&&!!CFU_PREMIER&&!!CFU_ROSTERS&&!!CFU_MATCH_DETAILS&&!CFU_MATCH_DETAILS_LOADING);
  await page.locator('#launch-splash').waitFor({state:'detached'});
 };
 const noOverflow=async page=>{
  const result=await page.evaluate(()=>{
   const nested=[...document.querySelectorAll('#match a a,#table [data-cfu-match] a a')].length;
   return {width:innerWidth,scroll:document.documentElement.scrollWidth,nav:document.querySelectorAll('#nav button').length,nested};
  });
  assert.equal(result.scroll,result.width,'Horizontal overflow');
  assert.equal(result.nav,5,'Bottom navigation must keep five tabs');
  assert.equal(result.nested,0,'Nested anchors are forbidden');
 };
 let context,page;
 try{
  ({context,page}=await newContext({width:390,height:844},'light'));
  await page.goto(base+'#table');await ready(page);
  await page.locator('[data-competition="cfu"]').click();
  await page.locator('[data-cfu-view="calendar"]').click();
  await page.locator('#cfu-round').selectOption('24');
  const card=page.locator('#table [data-cfu-match="cfu:match:18763"]');
  await card.locator('.cfu-center-link').click();
  await page.locator('#match.on').waitFor();
  assert.equal(await page.locator('#match-title').innerText(),'Центр матча');
  const matchText=await page.locator('#match').innerText();
  assert(matchText.includes('ГФК "Ялта"'));
  assert(matchText.includes('ФК "Таврия"'));
  assert(matchText.includes('0:2'));
  assert(matchText.includes('Матч завершен'));
  assert(matchText.includes('Роман Климентовский'));
  assert(matchText.includes('Владимир Клепча'));
  assert(matchText.includes('44′')&&matchText.includes('48′'));
  assert.equal(await page.locator('#match a[href="https://www.cfu2015.com/matches/premier-leagueCFU/match_18763/"]').count(),1);
  assert.equal(await page.locator('#match a[data-player="cfu:player:280"]').count(),1);
  assert.equal(await page.locator('#match .cfu-center-status').innerText(),'Матч завершен');
  await noOverflow(page);
  await page.screenshot({path:path.join(shots,'match-18763-390-light.png'),fullPage:true});

  await page.locator('#match-back').click();
  await page.locator('#table.on').waitFor();
  assert.equal(await page.locator('[data-competition="cfu"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#cfu-round').inputValue(),'24');

  await page.goto(base+'#team=cfu%3Ateam%3Atavriya');await ready(page);
  await page.locator('#team-title').waitFor();
  await page.locator('#team [data-cfu-match="cfu:match:18763"] .cfu-center-link').scrollIntoViewIfNeeded();
  await page.locator('#team [data-cfu-match="cfu:match:18763"] .cfu-center-link').click();
  await page.locator('#match.on').waitFor();
  assert((await page.locator('#match').innerText()).includes('0:2'));
  await page.locator('#match-back').click();
  await page.locator('#team.on').waitFor();
  assert((await page.locator('#team-title').innerText()).includes('Таврия'));

  await page.goto(base+'#match=cfu%3Amatch%3A18763');await ready(page);
  assert.equal(await page.locator('#match .cfu-center-score b').innerText(),'0:2');
  const directHash=await page.evaluate(()=>location.hash);
  await page.reload();await ready(page);
  assert.equal(await page.locator('#match .cfu-center-score b').innerText(),'0:2');
  assert.equal(await page.evaluate(()=>location.hash),directHash);
  await page.locator('#match-back').click();
  await page.locator('#table.on').waitFor();
  assert.equal(await page.locator('[data-competition="cfu"]').getAttribute('aria-pressed'),'true');

  await page.goto(base+'#match=cfu%3Amatch%3A17745');await ready(page);
  const missingText=await page.locator('#match').innerText();
  assert(missingText.includes('Подробный протокол этого матча пока не импортирован'));
  assert(missingText.includes('3:1'));
  assert(!missingText.includes('Завершён'));
  assert.equal(await page.locator('#match a[href="https://www.cfu2015.com/matches/premier-leagueCFU/match_17745/"]').count(),1);

  await page.goto(base+'#match=cfu%3Amatch%3A18769');await ready(page);
  const futureText=await page.locator('#match').innerText();
  assert(futureText.includes('Счёт не опубликован'));
  assert(!futureText.includes('Итоговый счёт'));
  assert(!futureText.includes('0:0'));
  assert(futureText.includes('Официальный протокол импортирован, но результат и события'));

  await page.evaluate(()=>localStorage.removeItem('sudak-cfu-premier-match-details-v1'));
  await page.route('**/cfu-premier-match-details-2026.json*',r=>r.abort());
  await page.goto(base+'?late-protocol=1#match=cfu%3Amatch%3A18763');
  await page.waitForFunction(()=>!!CFU_PREMIER&&!!CFU_ROSTERS&&CFU_MATCH_DETAILS_ERROR);
  await page.locator('#match.on').waitFor();
  assert((await page.locator('#match').innerText()).includes('Подробный протокол этого матча пока не импортирован'));
  const lateHash=await page.evaluate(()=>location.hash);
  await page.unroute('**/cfu-premier-match-details-2026.json*');
  await page.evaluate(()=>loadCfuMatchDetails());
  await page.waitForFunction(()=>!!CFU_MATCH_DETAILS&&!CFU_MATCH_DETAILS_LOADING);
  await page.waitForFunction(()=>document.querySelector('#match').innerText.includes('Роман Климентовский'));
  assert.equal(await page.evaluate(()=>location.hash),lateHash);
  assert.equal(await page.locator('#match.on').count(),1);
  await page.screenshot({path:path.join(shots,'match-18763-390-light-late.png'),fullPage:true});

  await context.close();
  ({context,page}=await newContext({width:320,height:844},'dark'));
  await page.goto(base+'#match=cfu%3Amatch%3A18763');await ready(page);
  await page.locator('#match .cfu-center-score b').waitFor();
  await noOverflow(page);
  await page.screenshot({path:path.join(shots,'match-18763-320-dark.png'),fullPage:true});
  await page.goto(base+'#match=cfu%3Amatch%3A18769');await ready(page);
  await noOverflow(page);
  await page.screenshot({path:path.join(shots,'match-18769-320-dark.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.goto(base+'#match=cfu%3Amatch%3A17745');await ready(page);
  await noOverflow(page);
  await page.screenshot({path:path.join(shots,'match-17745-390-dark.png'),fullPage:true});

  assert.deepEqual(errors,[]);
  console.log('PASS CFU match centres: goals/status 18763, no protocol 17745, future 18769, calendar/club/direct Back, reload, late loader, 390 light + 320/390 dark, no overflow/nested anchors/JS errors');
 }finally{await context?.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());
