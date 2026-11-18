/* Chromium checks use a repository-owned geometric JPEG and a synthetic roster response. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'), shots=process.env.CFU_PHOTOS_SCREENSHOTS||path.join(root,'_state/cfu-player-photos/screenshots');
const rosterFile='cfu-premier-rosters-2026.json';
const original=JSON.parse(fs.readFileSync(path.join(root,rosterFile),'utf8'));
const fixture=fs.readFileSync(path.join(root,'tests/fixtures/cfu-premier-rosters/player-photos/test-portrait.jpg'));
const sha256=createHash('sha256').update(fixture).digest('hex');
const enriched=structuredClone(original);
for(const number of [258,280]){
  const player=enriched.playersById['cfu:player:'+number];
  player.photo={status:'approved',sourceUrl:player.sourceUrl,sha256,
    imageUrl:`https://img.cfu2015.com/i/rectangle/286x380/test-${number}.jpg`};
}
const asset='/assets/cfu-player-photos/';
const mime={'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json',
  '.css':'text/css','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
let snapshot=enriched, broken=false, networkDown=false;
const requests=[];
const server=http.createServer((req,res)=>{
  if(networkDown){req.socket.destroy();return}
  const url=new URL(req.url,'http://localhost');
  const pathname=url.pathname.replace(/^\/fk-sudak(?=\/)/,'');
  if(pathname==='/'+rosterFile){
    res.setHeader('Content-Type',mime['.json']);
    return res.end(JSON.stringify(snapshot));
  }
  if(pathname.startsWith(asset)){
    requests.push(pathname);
    if(broken||!['258','280'].some(id=>pathname===asset+id+'/'+sha256+'.jpg')){
      res.writeHead(404);return res.end();
    }
    res.setHeader('Content-Type','image/jpeg');return res.end(fixture);
  }
  if(pathname==='/'&&url.searchParams.has('before')&&process.env.MULTI_CLUB_BASELINE_HTML){
    res.setHeader('Content-Type',mime['.html']);
    return res.end(fs.readFileSync(process.env.MULTI_CLUB_BASELINE_HTML));
  }
  const file=path.join(root,pathname==='/'?'index.html':pathname.slice(1));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
  fs.readFile(file,(error,body)=>{
    if(error){res.writeHead(404);return res.end()}
    res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(body);
  });
});

const club='#team=cfu%3Ateam%3Atavriya';
const player='#player=cfu%3Aplayer%3A258&team=cfu%3Ateam%3Atavriya&from=team';
const row='#team [data-player="cfu:player:258"]';
const small=row+' .cfu-roster-avatar', large='#player .player-hero .player-avatar';

async function ready(page){
  await page.waitForFunction(()=>!loadingData&&!!CFU_PREMIER&&!!CFU_ROSTERS&&!CFU_ROSTERS_LOADING&&!CFU_MATCH_DETAILS_LOADING);
  await page.locator('#launch-splash').waitFor({state:'detached'});
}
async function loaded(avatar){
  const img=avatar.locator('img:not(.cfu-photo-pending)');
  await img.waitFor();
  assert.equal(await img.evaluate(node=>node.naturalWidth),128);
  assert.equal(await img.evaluate(node=>getComputedStyle(node).objectFit),'cover');
  return img;
}
async function layout(page){
  const result=await page.evaluate(()=>({
    width:innerWidth, scroll:document.documentElement.scrollWidth, tabs:document.querySelectorAll('#nav button').length,
    clipped:[...document.querySelectorAll('.on .cfu-roster-player, .on .cfu-roster-body, .on .player-hero')]
      .some(node=>node.scrollWidth>node.clientWidth+1)
  }));
  assert.equal(result.width,result.scroll,'horizontal overflow');
  assert.equal(result.tabs,5);
  assert.equal(result.clipped,false);
}

(async()=>{
  fs.mkdirSync(shots,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const base=origin+'/fk-sudak/';
  const browser=await chromium.launch();
  const errors=[];
  const contextFor=async(width,theme,serviceWorkers='block')=>{
    const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce',serviceWorkers});
    await context.addInitScript(theme=>{localStorage.setItem('sudak-theme',theme);Date.now=()=>Date.parse('2026-11-11T12:00:00Z')},theme);
    await context.route(url=>url.origin!==origin,route=>route.abort());
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    return {context,page};
  };
  try{
    for(const theme of ['light','dark']){
      for(const width of [320,390,768]){
        const {context,page}=await contextFor(width,theme);
        try{
          snapshot=original;
          await page.goto(base+'?before'+club);await ready(page);
          await page.locator(row).waitFor();
          await layout(page);
          await page.locator('#team .cfu-roster-group').first().screenshot({path:path.join(shots,`before-roster-${width}-${theme}.png`)});
          await page.goto(base+'?before'+player);await ready(page);
          await page.locator('#player .player-hero').screenshot({path:path.join(shots,`before-profile-${width}-${theme}.png`)});

          snapshot=enriched;
          await page.goto(base+club);await ready(page);
          await page.locator(row).scrollIntoViewIfNeeded();
          const thumb=await loaded(page.locator(small));
          assert.equal(await thumb.getAttribute('loading'),'lazy');
          assert.equal(await thumb.getAttribute('decoding'),'async');
          assert.equal(await page.locator(small).evaluate(node=>getComputedStyle(node).width),'30px');
          assert.equal(await page.locator(row+' .cfu-shirt').textContent(),'1');
          assert((await page.locator('#team .cfu-roster-player .cfu-deregistered').count())>0);
          assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
          await layout(page);
          await page.locator('#team .cfu-roster-group').first().screenshot({path:path.join(shots,`after-roster-${width}-${theme}.png`)});

          await page.locator(row).click();
          await page.locator('#player.on').waitFor();
          await loaded(page.locator(large));
          assert.equal(await page.locator('#player-title').textContent(),'Валентин Манякин');
          assert.equal(await page.locator('#player a.club-source').getAttribute('href'),'https://www.cfu2015.com/players/258/');
          assert.match(await page.locator('#player a.club-source').textContent(),/Источник фото/);
          await layout(page);
          await page.locator('#player .player-hero').screenshot({path:path.join(shots,`after-profile-${width}-${theme}.png`)});
        }finally{await context.close()}
      }
    }

    const {context,page}=await contextFor(390,'dark');
    try{
      snapshot=original;
      await page.goto(base+player);await ready(page);
      assert.equal(await page.locator(large).textContent(),'ВМ');
      assert.equal(await page.locator(large+' img').count(),0);
      snapshot=enriched;
      await page.evaluate(()=>loadCfuRosters());
      await loaded(page.locator(large));
      assert.equal(await page.evaluate(()=>location.hash),player);
      await page.reload();await ready(page);
      await loaded(page.locator(large));

      await page.goto(base+'#match=cfu%3Amatch%3A18763');await ready(page);
      await page.locator('#match a[data-player="cfu:player:280"]').first().click();
      await loaded(page.locator(large));
      assert.match(await page.locator('#player-back').textContent(),/К матчу/);
      await page.locator('#player-back').click();
      await page.locator('#match.on').waitFor();

      broken=true;
      const rejected=page.waitForResponse(response=>response.url().includes(asset)&&response.status()===404);
      await page.goto(base+'?broken'+player);await ready(page);
      await rejected;
      await page.locator(large+' img').waitFor({state:'detached'});
      assert.equal(await page.locator(large).textContent(),'ВМ');
    }finally{broken=false;await context.close()}

    const offline=await contextFor(390,'light','allow');
    try{
      const initialRequests=requests.length;
      await offline.page.goto(base);await ready(offline.page);
      await offline.page.waitForFunction(()=>!!navigator.serviceWorker.controller);
      assert.equal(requests.length,initialRequests,'Home requests no CFU portraits');
      assert.equal(await offline.page.locator('img[data-cfu-photo]').count(),0);
      assert.equal(await offline.page.locator('#table').evaluate(node=>node.childElementCount),0);
      // Chromium can still fetch through the service worker under page-level emulation.
      networkDown=true;
      await offline.context.setOffline(true);
      await offline.page.goto(base+player);
      await offline.page.reload();await ready(offline.page);
      await offline.page.locator(large+' img').waitFor({state:'detached'});
      assert.equal(await offline.page.locator(large).textContent(),'ВМ');
      assert.equal(await offline.page.locator('#player-title').textContent(),'Валентин Манякин');
    }finally{networkDown=false;await offline.context.close()}

    assert.deepEqual(errors,[]);
    console.log('PASS CFU photos: 320/390/768, light/dark, source, club and match routes, refresh, failure, offline and deferred Home');
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());
