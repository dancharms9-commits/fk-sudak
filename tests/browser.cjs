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
      if(page.url().startsWith(base))await page.evaluate(()=>localStorage.removeItem('sudak-data-v1'));
      const target=new URL(url);target.searchParams.set("test",String(++navigation));
      await page.goto(target.href);
      await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    };
    const section=async(name)=>{
      await page.locator(`#nav [data-t="${name}"]`).click();
      await page.waitForFunction(name=>document.querySelector('main section.on')?.id===name,name);
    };
    await load();
    const iconBytes=fs.readFileSync(path.join(root,'icon-maskable-512.png'));
    const standardIconBytes=fs.readFileSync(path.join(root,'fk-sudak-pwa-512.png'));
    const assetChecks=await page.evaluate(async ({icon,original})=>{
      async function decode(base64){const img=new Image();img.src='data:image/png;base64,'+base64;await img.decode();return img}
      const [mask,source]=await Promise.all([decode(icon),decode(original)]);
      const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(mask,0,0);
      const pixels=ctx.getImageData(0,0,512,512).data;
      let opaque=true,maxCrestRadius=0,crestPixels=0;
      for(let y=0;y<512;y++)for(let x=0;x<512;x++){
        const i=(y*512+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
        if(pixels[i+3]!==255)opaque=false;
        // Red shield, yellow sun and white ornaments identify essential artwork.
        if((r>130&&g<115&&b<140)||(r>180&&g>140&&b<150)||(r>175&&g>175&&b>175)){
          crestPixels++;maxCrestRadius=Math.max(maxCrestRadius,Math.hypot(x-256,y-256));
        }
      }
      const reference=document.createElement('canvas');reference.width=reference.height=512;
      const rc=reference.getContext('2d',{willReadFrequently:true});rc.imageSmoothingQuality='high';rc.drawImage(source,64,64,384,384);
      const expected=rc.getImageData(0,0,512,512).data;
      let maxChannelDifference=0;
      // Entire source crest box at 75% fits inside the W3C radius-40% safe zone.
      for(let y=108;y<=404;y++)for(let x=135;x<=378;x++){
        const i=(y*512+x)*4;for(let c=0;c<3;c++)maxChannelDifference=Math.max(maxChannelDifference,Math.abs(pixels[i+c]-expected[i+c]));
      }
      const safe=document.createElement('canvas');safe.width=safe.height=512;const sc=safe.getContext('2d');
      sc.beginPath();sc.arc(256,256,204.8,0,Math.PI*2);sc.clip();sc.drawImage(mask,0,0);
      return {width:mask.naturalWidth,height:mask.naturalHeight,opaque,maxCrestRadius,crestPixels,maxChannelDifference,safePreview:safe.toDataURL('image/png')};
    },{icon:iconBytes.toString('base64'),original:standardIconBytes.toString('base64')});
    assert.equal(assetChecks.width,512);assert.equal(assetChecks.height,512);assert(assetChecks.opaque);
    assert(assetChecks.crestPixels>10000);assert(assetChecks.maxCrestRadius<204.8,'Crest must stay inside maskable safe circle');
    assert(assetChecks.maxChannelDifference<=1,'Original crest pixels must be preserved after resize');
    if(process.env.VISUAL_SCREENSHOT_DIR){
      fs.mkdirSync(process.env.VISUAL_SCREENSHOT_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.VISUAL_SCREENSHOT_DIR,'maskable-safe-zone.png'),Buffer.from(assetChecks.safePreview.split(',')[1],'base64'));
    }
    console.log('PASS opaque 512px maskable icon, original crest and Android safe circle (radius '+assetChecks.maxCrestRadius.toFixed(1)+'px)');
    const layout=async()=>{
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),await page.evaluate(()=>innerWidth),'Horizontal overflow');
      const clipped=await page.evaluate(()=>{
        const selector='header .crest,header .brand,header h1,header p,main,nav,nav button,main section.on h2,main section.on .card,main section.on .stats-player,main section.on .vs,main section.on .num,main section.on .tm,main section.on .profile-values,main section.on .goal-timeline,main section.on .match-back';
        return [...document.querySelectorAll(selector)].filter(el=>el.getClientRects().length).filter(el=>{
          const r=el.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5;
        }).map(el=>el.tagName+'.'+el.className);
      });
      assert.deepEqual(clipped,[],'Clipped layout or controls');
      // At the end of the document, fixed bottom navigation must not cover content.
      await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
      const overlap=await page.evaluate(()=>{
        const nav=document.getElementById('nav').getBoundingClientRect();
        const last=document.getElementById('upd').getBoundingClientRect();
        return last.bottom>nav.top+.5;
      });
      assert.equal(overlap,false,'Bottom navigation covers the final content');
      await page.evaluate(()=>scrollTo(0,0));
    };
    for(const colorScheme of ['light','dark'])for(const reducedMotion of ['no-preference','reduce'])for(const width of [320,390,768,1440]){
      await page.emulateMedia({colorScheme,reducedMotion});
      await page.setViewportSize({width,height:844});
      await load();
      await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))});
      await layout();
      assert.equal(await page.locator('header .crest img').evaluate(img=>img.complete&&img.naturalWidth===192),true);
      assert.equal(await page.locator('#home .home-intro').count(),1);
      assert.equal(await page.locator('#home .home-next').count(),data.next.length?1:0);
      assert.equal(await page.locator('#home .home-result').count(),1);
      assert.equal(await page.locator('#home .home-standing').count(),1);
      if(reducedMotion==='reduce'){
        const motion=await page.locator('#home .home-result').evaluate(el=>{
          const s=getComputedStyle(el);return {animation:parseFloat(s.animationDuration),transition:parseFloat(s.transitionDuration),scroll:getComputedStyle(document.documentElement).scrollBehavior};
        });
        assert(motion.animation<=.00001&&motion.transition<=.00001);assert.equal(motion.scroll,'auto');
      }
      if(process.env.VISUAL_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.VISUAL_SCREENSHOT_DIR,`home-${colorScheme}-${reducedMotion}-${width}.png`),fullPage:true});
      for(const name of ['matches','table','squad','news']){await section(name);await layout()}
      // Profile and match screens remain readable under the same theme/motion settings.
      await section('squad');await page.locator('#squad a[data-player]').first().click();await page.locator('#player.on').waitFor();await layout();
      await section('matches');await page.locator('#matches a[data-match]').first().click();await page.locator('#match.on').waitFor();await layout();
      console.log('PASS visual layout, navigation clearance and header icon: '+colorScheme+', '+reducedMotion+', '+width+'px');
    }
    await page.emulateMedia({colorScheme:'light',reducedMotion:'no-preference'});
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
    const footballer=data.player_stats_2026.players.find(p=>p.name==='Донской Илья');
    const playerID='rffk-'+footballer.profile_url.match(/\/players\/(\d+)/)[1];
    const role='Полузащитники';
    const profileURL=base+'/#player='+playerID+'&name='+encodeURIComponent(footballer.name)+'&role='+encodeURIComponent(role);
    const metric=field=>page.locator(`#player [data-stat="${field}"] b`);
    // Photos are tested as trusted URLs here; network is stubbed for repeatability.
    await context.route('https://rffk-roo.ru/uploads/people/**',r=>r.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64')}));
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:844});
      await load(base+'/#squad&role='+encodeURIComponent(role));
      const card=page.locator(`#squad [data-player="${playerID}"]`);
      await card.scrollIntoViewIfNeeded();
      const squadScroll=await page.evaluate(()=>scrollY);
      await card.click();await page.locator('#player.on').waitFor();
      assert.equal(await page.locator('#player-title').innerText(),footballer.name);
      for(const field of ['league_games','league_goals','league_minutes','league_starts','league_substitutions','league_penalty_goals']){
        assert.equal(await metric(field).innerText(),String(footballer[field]??'—'),field);
      }
      assert.equal(await page.locator('#nav [data-t="squad"]').getAttribute('aria-current'),'page');
      assert.equal(await page.locator('#player .player-goal').count(),5);
      if(footballer.photo_url)assert.equal(await page.locator('#player .player-avatar img').getAttribute('src'),footballer.photo_url);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,'Profile overflow at '+width);
      const match=page.locator('#player .player-goal').last();
      const matchHash=await match.getAttribute('href');
      await match.scrollIntoViewIfNeeded();
      const playerScroll=await page.evaluate(()=>scrollY);
      const goalIndex=await match.getAttribute('data-goal');
      await match.click();await page.locator('#match.on').waitFor();
      assert.equal(await page.locator('#match-back').innerText(),'← К футболисту');
      assert.equal(await page.locator('#nav [data-t="squad"]').getAttribute('aria-current'),'page');
      await page.locator('#match-back').click();await page.locator('#player.on').waitFor();
      assert.equal(await page.locator('#player-title').innerText(),footballer.name);
      assert.equal(await page.locator(`#player [data-goal="${goalIndex}"]`).evaluate(el=>el===document.activeElement),true);
      assert(Math.abs(await page.evaluate(()=>scrollY)-playerScroll)<3,'Restore player scroll at '+width);
      await page.locator('#player-back').click();await page.locator('#squad.on').waitFor();
      assert.equal(await page.locator('#squad [aria-pressed="true"]').getAttribute('data-role'),role);
      assert.equal(await card.evaluate(el=>el===document.activeElement),true);
      assert(Math.abs(await page.evaluate(()=>scrollY)-squadScroll)<3,'Restore squad scroll at '+width);
      await page.goForward();await page.locator('#player.on').waitFor();
      await page.goForward();await page.locator('#match.on').waitFor();
      assert.equal(await page.evaluate(()=>location.hash),matchHash);
      await page.goBack();await page.locator('#player.on').waitFor();
      await page.goBack();await page.locator('#squad.on').waitFor();
      console.log('PASS player → match → player → filtered squad, history/focus/scroll at '+width+'px');
    }
    await page.setViewportSize({width:390,height:844});
    await load(base+'/#squad');
    assert.equal(await page.locator('#squad a[data-player]').count(),data.player_stats_2026.players.length);
    for(let i=0;i<data.player_stats_2026.players.length;i++){
      const card=page.locator('#squad a[data-player]').nth(i);
      const name=await card.locator('.stats-name').innerText();
      await card.click();await page.locator('#player.on').waitFor();
      assert.equal(await page.locator('#player-title').innerText(),name);
      await page.goBack();await page.locator('#squad.on').waitFor();
    }
    console.log('PASS all '+data.player_stats_2026.players.length+' footballer cards open their own profiles');
    await load(profileURL);
    assert.equal(await page.locator('#player-title').innerText(),footballer.name);
    // A direct match URL still knows the return chain even after a reload/new tab.
    const directMatch=await page.locator('#player .player-goal').first().getAttribute('href');
    await load(base+'/'+directMatch);await page.reload();
    await page.locator('#match-back').click();await page.locator('#player.on').waitFor();
    await page.locator('#player-back').click();await page.locator('#squad.on').waitFor();
    assert.equal(await page.locator('#squad [aria-pressed="true"]').getAttribute('data-role'),role);
    const keyboardCard=page.locator(`#squad [data-player="${playerID}"]`);
    await keyboardCard.focus();await page.keyboard.press('Enter');
    await page.locator('#player.on').waitFor();
    await page.emulateMedia({colorScheme:'dark'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    await page.emulateMedia({colorScheme:'light'});
    const unknown=base+'/#player=unknown&role='+encodeURIComponent(role);
    await load(unknown);assert((await page.locator('#player').innerText()).includes('Футболист недоступен'));
    await page.locator('#player-back').click();await page.locator('#squad.on').waitFor();
    console.log('PASS player/match deep links, reload, keyboard, unknown profile and dark mode');
    const absent=structuredClone(data);absent.match_details={};
    await page.route('**/data.json?*',r=>r.fulfill({json:absent}));
    await load(profileURL);
    assert.equal(await metric('league_goals').innerText(),String(footballer.league_goals));
    assert.equal(await page.locator('#player .player-goal').count(),0);
    assert((await page.locator('#goal-coverage').innerText()).includes('Список может быть неполным'));
    assert(!(await page.locator('#goal-coverage').innerText()).includes('голов: 0'));
    await page.unroute('**/data.json?*');
    const homonyms=structuredClone(data);
    homonyms.player_stats_2026.players.push({...footballer,name:'Донской Иван',profile_url:'https://rffk-roo.ru/players/999999/'});
    await page.route('**/data.json?*',r=>r.fulfill({json:homonyms}));
    await load(profileURL);
    assert.equal(await page.locator('#player .player-goal').count(),0);
    assert((await page.locator('#goal-coverage').innerText()).includes('неоднозначные сокращённые имена'));
    assert.equal(await metric('league_goals').innerText(),String(footballer.league_goals));
    await page.unroute('**/data.json?*');
    const noMetrics=structuredClone(data);delete noMetrics.player_stats_2026;
    await page.route('**/data.json?*',r=>r.fulfill({json:noMetrics}));
    await load(profileURL);
    assert.equal(await page.locator('#player-title').innerText(),footballer.name);
    for(const field of ['league_games','league_goals','league_minutes','league_starts','league_substitutions','league_penalty_goals'])assert.equal(await metric(field).innerText(),'—');
    assert.equal(await page.locator('#player .player-avatar img').count(),0);
    assert.equal(await page.locator('#player .player-avatar span').innerText(),'ДИ');
    await page.unroute('**/data.json?*');
    // Broken official images fall back to initials without breaking the profile.
    await context.unroute('https://rffk-roo.ru/uploads/people/**');
    await context.route('https://rffk-roo.ru/uploads/people/**',r=>r.abort());
    await load(profileURL);
    await page.waitForFunction(()=>!document.querySelector('#player .player-avatar img'));
    assert.equal(await page.locator('#player .player-avatar span').innerText(),'ДИ');
    await context.unroute('https://rffk-roo.ru/uploads/people/**');
    console.log('PASS missing protocols keep official totals, homonyms are rejected, unknown metrics stay unknown, photo fallback');

    // Separate context permits real service-worker requests (which bypass route mocks).
    await context.close();
    context=await browser.newContext({viewport:{width:390,height:844}});
    page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/manifest.json');
    await page.evaluate(async()=>{
      const old=await caches.open('sudak-v2');await old.put('./obsolete-icon.png',new Response('old icon'));
    });
    await load(base+'/#match='+encodeURIComponent(firstKey)+'&from=matches');
    // New routes use only hash fragments: the existing PWA shell still works offline.
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
    assert(await page.evaluate(async()=>!!(await navigator.serviceWorker.getRegistration())));
    const shell=await page.evaluate(async()=>{
      const keys=await caches.keys(),cache=await caches.open('sudak-ui-v3');
      return {keys,urls:(await cache.keys()).map(request=>new URL(request.url).pathname)};
    });
    assert(!shell.keys.includes('sudak-v2'),'Old shell cache must be removed');
    for(const icon of ['icon-192.png','icon-512.png','icon-maskable-512.png'])assert(shell.urls.includes('/'+icon));
    assert(!shell.urls.some(url=>url.endsWith('/data.json')),'Federation data must still bypass the SW cache');
    const manifest=await page.evaluate(async()=>await (await fetch('manifest.json')).json());
    assert.deepEqual(manifest.icons.map(i=>i.purpose),['any','any','maskable']);
    assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'),'manifest.json');
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    await context.setOffline(true);
    await page.locator('#match-back').click();
    await page.locator('#matches.on').waitFor();
    await page.locator('#matches a[data-match]').first().click();
    assert.equal(await page.locator('#match .goal-timeline li').count(),source.goals.length);
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.includes('Нет связи'));
    assert.equal(await page.locator('#match .goal-timeline li').count(),source.goals.length);
    // A warm offline reload keeps player metrics, goal links, filters and return chain.
    await page.evaluate(hash=>{location.hash=hash},new URL(profileURL).hash);
    await page.locator('#player.on').waitFor();
    assert.equal(await metric('league_goals').innerText(),String(footballer.league_goals));
    await page.locator('#player .player-goal').first().click();await page.locator('#match.on').waitFor();
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.includes('Нет связи'));
    await page.locator('#match-back').click();await page.locator('#player.on').waitFor();
    await page.locator('#player-back').click();await page.locator('#squad.on').waitFor();
    assert.equal(await page.locator('#squad [aria-pressed="true"]').getAttribute('data-role'),role);
    // No saved dataset: the shell still loads with a clear unavailable message.
    await page.evaluate(()=>localStorage.removeItem('sudak-data-v1'));
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.includes('Нет свежих данных'));
    assert.equal(await page.locator('#squad a[data-player]').count(),0);
    await context.setOffline(false);
    await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));
    assert.equal(await page.locator('#squad a[data-player]').count(),data.player_stats_2026.players.filter(p=>p.position===role).length);
    console.log('PASS standings, player stats/filter, news, dark mode, PWA offline shell and reconnect');
    assert.deepEqual(errors,[],'Browser script errors');
    console.log('PASS no browser JavaScript errors');
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server.close());
