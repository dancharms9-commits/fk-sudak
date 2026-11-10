/* Real before/after screens. Source data and the offline shell are never edited. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),phase=process.env.CLUBS_PHASE||'after';
const out=path.resolve(process.env.CLUBS_SCREENSHOT_DIR||path.join(root,'docs/design-polish/clubs-players'),phase);
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json')));
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 if(pathname==='/'&&phase==='before'&&process.env.CLUBS_BASELINE_HTML){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(fs.readFileSync(process.env.CLUBS_BASELINE_HTML))}
 const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
 res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
const metrics=()=>{
 const active=document.querySelector('main>section.on'),nav=document.querySelector('#nav').getBoundingClientRect().top;
 const box=e=>e?{height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top,width:e.getBoundingClientRect().width}:null;
 const visible=e=>!!e.getClientRects().length;
 const players=[...active.querySelectorAll('.club-roster-player')].filter(visible);
 const matches=[...active.querySelectorAll(active.id==='player'?'a[data-match]':'[data-club-match],.champ-match')].filter(visible);
 const inside=e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=nav};
 const controls=[...active.querySelectorAll('a,button,summary,select')].filter(visible);
 const text=active.innerText;
 return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollY,
 hero:box(active.querySelector('.club-hero,.player-hero')),
 stats:box(active.querySelector('.club-summary,.club-metrics')?.closest('.card')||active.querySelector('.profile-values')?.closest('.card')),
  playerRows:players.map(box),playerSlots:players.map(e=>box(e.closest('li'))),matchRows:matches.map(box),visiblePlayers:players.filter(inside).length,visibleMatches:matches.filter(inside).length,
  technicalMessages:[...active.querySelectorAll('p,summary')].filter(e=>visible(e)&&(!e.closest('details:not([open])')||e.tagName==='SUMMARY')&&/Подтверждённые данные РФФК|Последнее подтверждение|Последняя успешная проверка|Данные РФФК ·/.test(e.textContent)).length,
  technicalFragments:(text.match(/Подтверждённые данные РФФК|Последнее подтверждение|Последняя успешная проверка|Данные РФФК ·/g)||[]).length,
 clipped:controls.filter(e=>{const r=e.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5}).map(e=>e.className),
 targets:controls.map(e=>({text:e.textContent.trim().slice(0,50),...box(e)}))};
};
(async()=>{
 fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/fk-sudak/`;
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
 const results=[],errors=[];
 try{
  for(const theme of ['light','dark'])for(const width of [320,390,768,1440]){
   const c=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width,height:844},deviceScaleFactor:1});
   await c.addInitScript(theme=>{localStorage.setItem('sudak-theme',theme);Date.now=()=>Date.parse('2026-11-10T12:00:00Z')},theme);
   await c.route('https://rffk-roo.ru/**',r=>r.abort());
   if(process.env.ROSTER_PORTRAIT_FIXTURE)await c.route(data.platform.playersById['146'].photoUrl,r=>r.fulfill({contentType:'image/jpeg',body:fs.readFileSync(process.env.ROSTER_PORTRAIT_FIXTURE)}));
   const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
   await p.goto(base);await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
   const route=hash=>p.evaluate(hash=>{history.replaceState({},'',hash);document.querySelectorAll('#team [style],#player [style]').forEach(e=>e.style.removeProperty('font-size'));applyRoute();document.activeElement?.blur();scrollTo(0,0)},hash);
   const shot=async name=>{
    await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('main>section.on img,header img')].filter(i=>{const r=i.getBoundingClientRect();return r.width&&r.top<innerHeight}).map(i=>i.decode().catch(()=>{})));await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});
    const m=await p.evaluate(metrics);results.push({screen:name,theme,...m});
    assert.equal(m.scrollWidth,width,name+' overflow');assert.deepEqual(m.clipped,[],name+' clipped controls');
    await p.screenshot({path:path.join(out,`${name}-${theme}-${width}.png`),fullPage:name==='popov-sources',animations:'disabled'});
   };
   await route('#team=936');await shot('kashtan');
   if(phase==='after'){
    await p.locator('[data-club-section="club-roster"]').click();
    assert.equal(await p.evaluate(()=>document.activeElement.id),'club-roster');
    assert((await p.evaluate(metrics)).visiblePlayers>0,'Roster shortcut shows players');
    await route('#team=936');
   }
   await p.locator('#team .club-roster-role').first().evaluate(e=>scrollTo(0,scrollY+e.getBoundingClientRect().top-24));await shot('roster');
   await route('#player=rffk-146&team=936&competition=4&season=22&from=team');await shot('popov');
   if(phase==='after'){
    assert.equal(await p.locator('#player [data-stat="league_minutes"] b').innerText(),'0');
    assert.equal(await p.locator('#player [data-stat="league_goals"] b').innerText(),'0');
    await p.locator('#player .profile-sources>summary').click();await shot('popov-sources');
   }
   await route('#player=rffk-1698&team=117&competition=4&season=22');await shot('multi-registration');
   await route('#player=rffk-3516&team=117&competition=4&season=22');await shot('no-statistics');
   await route('#team=930');await shot('long-name');
   await route('#team=117');await shot('partial-club');
   await route('#home');await shot('home');
   await route('#table');await p.evaluate(()=>{CHAMP_STATE.view='calendar';CHAMP_STATE.round='18';CHAMP_STATE.team='all';CHAMP_STATE.status='all';renderChampionship()});await shot('calendar');
   await route('#match=rffk-38771&from=table');await shot('universal-center');
   await route('#match=rffk-38762&from=matches');await shot('sudak-center');
   if(phase==='after'){
    for(const tid of data.platform.competitionSeasons['4:22'].participantTeamIds){
     await route('#team='+tid);
     assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),width);
     if(tid==='141')continue;
     const roster=data.platform.rosters['4:22:'+tid];
     assert.equal(await p.locator('#team .club-roster-player').count(),roster.playerIds.length+roster.unverifiedPlayerIds.length+roster.historicalPlayerIds.length);
     const boxes=await p.locator('#team .club-roster-player').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({h:e.getBoundingClientRect().height,w:e.getBoundingClientRect().width})));
     assert(boxes.every(b=>b.h>=44&&b.w>=44));
     const controls=await p.evaluate(metrics);
     assert(controls.targets.every(b=>b.height>=44&&b.width>=44),'44px club controls '+tid);
    }
   }
    // Increase every text element from its own computed size in one atomic pass.
    // No enlarged parent compounds an already enlarged child; fixed px also grow.
    for(const hash of ['#team=930','#team=936','#player=rffk-146&team=936&competition=4&season=22','#player=rffk-3516&team=117&competition=4&season=22','#player=rffk-1698&team=117&competition=4&season=22']){
     await route(hash);
     await p.evaluate(()=>{const es=[...document.querySelectorAll('main>section.on,main>section.on *')];const sizes=es.map(e=>parseFloat(getComputedStyle(e).fontSize));es.forEach((e,i)=>e.style.fontSize=sizes[i]*1.5+'px')});
     if(phase==='after'&&hash.includes('146&team=936'))await p.locator('#player .profile-sources>summary').click();
     await p.evaluate(()=>scrollTo(0,0));
     const m=await p.evaluate(metrics);results.push({screen:'text150-'+hash,theme,...m});
     if(phase==='after'){assert.equal(m.scrollWidth,width,'150% text '+hash);assert.deepEqual(m.clipped,[])}
     if(width===320)await p.screenshot({path:path.join(out,`text150-${hash.startsWith('#team')?hash.slice(6):hash.match(/rffk-(\d+)/)[1]}-${theme}.png`),animations:'disabled'});
    }
   await c.close();console.log(`PASS ${phase} audit ${theme} ${width}`);
  }
  if(phase==='after'){
   const c=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width:390,height:844}});
   await c.route('https://rffk-roo.ru/**',r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
   await p.goto(base);await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
   const count=await p.evaluate(()=>{
    let n=0;const fields={league_games:'games',league_minutes:'minutes',league_goals:'goals',league_starts:'starts',league_substitutions:'substitutions',league_penalty_goals:'penaltyGoals',league_yellow_cards:'yellowCards',league_second_yellow_cards:'secondYellowCards',league_red_cards:'redCards'};
    for(const tid of CLUB_IDS.filter(id=>id!=='141')){
     const r=PLATFORM.rosters['4:22:'+tid],ids=[...new Set([...(r.playerIds||[]),...(r.clubPlayerIds||[]),...(r.historicalPlayerIds||[])])];
     for(const id of ids){
      history.replaceState({},'',platformPlayerHref(id,tid));applyRoute();
      if(document.querySelector('#player-title').textContent!==PLATFORM.playersById[id].name)throw Error('Profile identity '+id);
      const s=PLATFORM.playerSeasonStats[`${id}:${tid}:4:22`];
      for(const [field,key] of Object.entries(fields)){
       const actual=document.querySelector(`#player [data-stat="${field}"] b`)?.textContent;
       const expected=Number.isInteger(s?.[key])?String(s[key]):'—';
       if(actual!==expected)throw Error(`${id}:${tid} ${field}: ${actual} != ${expected}`);
      }
      n++;
     }
    }
    return n;
   });
   console.log(`PASS all ${count} club/player contexts × nine statistics in rendered profiles`);
   await p.goto(base+'#player=rffk-1698&team=117&competition=4&season=22');
   await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
   await p.locator('#player .profile-sources>summary').click();
   await p.waitForFunction(()=>history.state.profileSourcesOpen===true);
   await p.locator('#player [data-platform-player="1698:146"]').click();
   assert.equal(await p.locator('#player [data-stat="league_goals"] b').innerText(),'6');
   await p.goBack();await p.locator('#player .profile-sources[open]').waitFor();
   assert.equal(await p.evaluate(()=>document.activeElement.dataset.platformPlayer),'1698:146');
   assert.equal(await p.locator('#player [data-stat="league_goals"] b').innerText(),'1');
   await p.reload();await p.waitForFunction(()=>!loadingData&&!!PLATFORM);
   assert.equal(await p.locator('#player .profile-sources[open]').count(),1);
   console.log('PASS transfer club switch, Back restores disclosure/focus, reload retains disclosure');
   await c.close();
  }
  fs.writeFileSync(path.join(out,'metrics.json'),'[\n'+results.map(r=>JSON.stringify(r)).join(',\n')+'\n]\n');assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
