/* Chromium checks the published roster and the official JPEGs served from the repository. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'), shots=process.env.CFU_PHOTOS_SCREENSHOTS||path.join(root,'_state/cfu-player-photos/screenshots');
const rosterFile='cfu-premier-rosters-2026.json';
const asset='/assets/cfu-player-photos/';
const enriched=JSON.parse(fs.readFileSync(path.join(root,rosterFile),'utf8'));
const clubs=[
  {slug:'tavriya', entriesCount:32, deregisteredCount:9, sampleId:'cfu:player:258'},
  {slug:'fc-okean', entriesCount:45, deregisteredCount:21}
];
const portraits=new Map();
for(const {slug} of clubs){
  for(const {playerId} of enriched.rostersByTeamId[`cfu:team:${slug}`].entries){
    const {photo,sourcePlayerId,sourceUrl}=enriched.playersById[playerId];
    if(!photo||portraits.has(playerId))continue;
    assert.equal(photo.sourceUrl,sourceUrl);
    const url=`${asset}${sourcePlayerId}/${photo.sha256}.jpg`;
    const bytes=fs.readFileSync(path.join(root,url.slice(1)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),photo.sha256);
    portraits.set(playerId,url);
  }
}
const mime={'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json',
  '.css':'text/css','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
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
    if(broken){res.writeHead(404);return res.end()}
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

const large='#player .player-hero .player-avatar';

async function ready(page){
  await page.waitForFunction(()=>!loadingData&&!!CFU_PREMIER&&!!CFU_ROSTERS&&!CFU_ROSTERS_LOADING&&!CFU_MATCH_DETAILS_LOADING);
  await page.locator('#launch-splash').waitFor({state:'detached'});
}
async function loaded(avatar,playerId){
  const img=avatar.locator('img:not(.cfu-photo-pending)');
  await img.waitFor();
  assert.equal(new URL(await img.evaluate(node=>node.currentSrc)).pathname,'/fk-sudak'+portraits.get(playerId));
  assert(await img.evaluate(node=>node.naturalWidth>0&&node.naturalHeight>0));
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

async function checkClub({slug,entriesCount,deregisteredCount,sampleId},base,contextFor){
  const teamId=`cfu:team:${slug}`;
  const entries=enriched.rostersByTeamId[teamId].entries;
  const published=entries.filter(({playerId})=>portraits.has(playerId));
  if(slug==='tavriya')assert.equal(published.length,32);
  const sample=sampleId?published.find(({playerId})=>playerId===sampleId):
    published.find(({shirtNumber})=>Number.isInteger(shirtNumber));
  assert(sample,`An official portrait for ${slug} is published`);
  const {playerId,position,shirtNumber}=sample;
  const {name,sourceUrl}=enriched.playersById[playerId];
  const initials=name.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('');
  const club='#team='+encodeURIComponent(teamId);
  const player='#player='+encodeURIComponent(playerId)+'&team='+encodeURIComponent(teamId)+'&from=team';
  const row=`#team [data-player="${playerId}"]`;
  const small=row+' .cfu-roster-avatar';
  const original=structuredClone(enriched);
  for(const entry of published)delete original.playersById[entry.playerId].photo;
  const shotDir=slug==='tavriya'?shots:path.join(shots,slug);
  fs.mkdirSync(shotDir,{recursive:true});
  const rosterShot=(locator,file)=>locator.screenshot({path:path.join(shotDir,file),
    style:'#nav { visibility: hidden }'});

  for(const theme of ['light','dark']){
    const {context,page}=await contextFor(320,theme);
    const group=page.locator('#team .cfu-roster-group').filter({has:page.locator(`[data-player="${playerId}"]`)});
    try{
      for(const width of [320,390,768]){
        await page.setViewportSize({width,height:844});
        if(slug==='tavriya'){
          snapshot=original;
          await page.goto(base+'?before'+club);await ready(page);
          await page.locator(row).waitFor();
          await layout(page);
          await rosterShot(group,`before-roster-${width}-${theme}.png`);
          await page.goto(base+'?before'+player);await ready(page);
          await page.locator('#player .player-hero').screenshot({path:path.join(shotDir,`before-profile-${width}-${theme}.png`)});
        }

        snapshot=enriched;
        await page.goto(base+club);await ready(page);
        await page.locator(row).scrollIntoViewIfNeeded();
        const thumb=await loaded(page.locator(small),playerId);
        assert.equal(await thumb.getAttribute('loading'),'lazy');
        assert.equal(await thumb.getAttribute('decoding'),'async');
        assert.deepEqual(await page.locator(small).evaluate(node=>{
          const {width,height,borderTopLeftRadius}=getComputedStyle(node);
          return [width,height,borderTopLeftRadius];
        }),['30px','30px','50%']);
        assert.equal(await page.locator(row+' .cfu-shirt').textContent(),String(shirtNumber));
        assert.equal(await page.locator(row+' .cfu-roster-body small').textContent(),position);
        assert.equal(await page.locator('#team .cfu-roster-player').count(),entriesCount);
        assert.equal(await page.locator('#team .cfu-roster-player .cfu-deregistered').count(),deregisteredCount);
        assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
        await layout(page);
        await rosterShot(group,`after-roster-${width}-${theme}.png`);
        if(width===390&&theme==='light'){
          for(const {playerId,deregisteredAt} of entries){
            const entry=page.locator(`#team [data-player="${playerId}"]`);
            const avatar=entry.locator('.cfu-roster-avatar');
            assert.equal(await entry.locator('.cfu-deregistered').count(),Number(Boolean(deregisteredAt)));
            if(portraits.has(playerId)){
              await entry.scrollIntoViewIfNeeded();
              await loaded(avatar,playerId);
            }else{
              assert.equal(await avatar.locator('img').count(),0);
              assert.match(await avatar.textContent(),/^\p{L}{1,2}$/u);
            }
          }
          await rosterShot(page.locator('#team .cfu-roster'),'after-full-roster-390-light.png');
        }

        await page.locator(row).click();
        await page.locator('#player.on').waitFor();
        await loaded(page.locator(large),playerId);
        assert(await page.locator(large).evaluate(node=>node.clientWidth>30&&node.clientHeight>30));
        assert.equal(await page.locator('#player-title').textContent(),name);
        assert((await page.locator('#player .stats-role').textContent()).includes(`${position} · № ${shirtNumber}`));
        assert.equal(await page.locator('#player .profile-club [data-team]').getAttribute('data-team'),teamId);
        assert.equal(await page.locator('#player a.club-source').getAttribute('href'),sourceUrl);
        assert.match(await page.locator('#player a.club-source').textContent(),/Источник фото/);
        await layout(page);
        await page.locator('#player .player-hero').screenshot({path:path.join(shotDir,`after-profile-${width}-${theme}.png`)});
      }
    }finally{await context.close()}
  }

  const {context,page}=await contextFor(390,'dark');
  try{
    snapshot=original;
    await page.goto(base+player);await ready(page);
    assert.equal(await page.locator(large).textContent(),initials);
    assert.equal(await page.locator(large+' img').count(),0);
    snapshot=enriched;
    await page.evaluate(()=>loadCfuRosters());
    await loaded(page.locator(large),playerId);
    assert.equal(await page.evaluate(()=>location.hash),player);
    await page.reload();await ready(page);
    await loaded(page.locator(large),playerId);

    if(slug==='tavriya'){
      await page.goto(base+'#match=cfu%3Amatch%3A18763');await ready(page);
      await page.locator('#match a[data-player="cfu:player:280"]').first().click();
      if(portraits.has('cfu:player:280'))await loaded(page.locator(large),'cfu:player:280');
      else assert.equal(await page.locator(large).textContent(),'РК');
      assert.match(await page.locator('#player-back').textContent(),/К матчу/);
      await page.locator('#player-back').click();
      await page.locator('#match.on').waitFor();
    }

    broken=true;
    const rejected=page.waitForResponse(response=>response.url().includes(asset)&&response.status()===404);
    await page.goto(base+'?broken'+player);await ready(page);
    await rejected;
    await page.locator(large+' img').waitFor({state:'detached'});
    assert.equal(await page.locator(large).textContent(),initials);
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
    assert.equal(await offline.page.locator(large).textContent(),initials);
    assert.equal(await offline.page.locator('#player-title').textContent(),name);
  }finally{networkDown=false;await offline.context.close()}

  console.log(`PASS ${slug}: ${published.length}/${entriesCount} CFU photos, 320/390/768, light/dark, routes, refresh, failure, offline and deferred Home`);
}

(async()=>{
  fs.mkdirSync(shots,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const base=origin+'/fk-sudak/';
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?
    {executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
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
    for(const club of clubs)await checkClub(club,base,contextFor);
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.close());
