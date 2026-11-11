/* Real rendering against an explicitly frozen PR #37 reference and the data.
   The original main remains the reference for the rest of the calendar. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),data=JSON.parse(fs.readFileSync(path.join(root,'data.json')));
const reference=Buffer.from(fs.readFileSync(path.join(root,'tests/fixtures/match-row-reference.html'),'utf8').replace(/\r\n/g,'\n'));
assert.equal(crypto.createHash('sha256').update(reference).digest('hex'),'5f9ced796ba48479b30a46e0541cf0055a462d8f5ab296107a43c94ba306322c','Review any change to the frozen match-row reference');
const out=path.resolve(process.env.MATCH_ROW_CONTRACT_DIR||path.join(root,'_state/match-row-contract'));
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'&&url.searchParams.has('reference')){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(reference)}
 const file=path.resolve(root,url.pathname==='/'?'index.html':'.'+url.pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.json':'application/json','.png':'image/png','.woff2':'font/woff2','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
const matches=data.championship.calendar.matches.map(raw=>{
 const m=data.platform.matchesById[raw.id];
 if(!m||m.competitionId!=='4'||m.seasonId!=='22'||!['current','stale','temporarily_unavailable'].includes(m.quality?.status))return raw;
 return {...raw,date:m.date,time:m.time,home_score:m.homeScore,away_score:m.awayScore,status:m.status,status_label:m.statusLabel||null};
});
const teams=Object.fromEntries(data.championship.calendar.teams.map(t=>[t.id,t.name||'Название не опубликовано']));
const status=m=>m.status_label||({finished:'Матч завершён',technical:'Технический результат',scheduled:m.date?'Матч запланирован':'Дата уточняется',postponed:'Матч перенесён',cancelled:'Матч отменён',suspended:'Матч приостановлен'})[m.status]||'Статус уточняется';
const shortStatus={'Матч завершён':'Завершён','Завершён':'Завершён','Матч запланирован':'По плану','Запланирован':'По плану','Матч перенесён':'Перенос','Матч перенесен':'Перенос','Перенесён':'Перенос','Перенесен':'Перенос','Матч отменён':'Отмена','Отменён':'Отмена','Технический результат':'Тех. итог','Тех. победа':'Тех. победа'};
async function settle(p){await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('#table.on .champ-match img,#team.on .club-fixture img')].map(i=>i.decode().catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});}
async function scaleText(p){await p.evaluate(()=>{const es=[...document.querySelectorAll('body,header,header *,#nav,#nav *,main>section.on,main>section.on *')].filter(e=>!(e instanceof SVGElement)&&!e.closest('.club-name'));const sizes=es.map(e=>parseFloat(getComputedStyle(e).fontSize));es.forEach((e,i)=>e.style.fontSize=sizes[i]*1.5+'px')});}
const inspect=()=>{
 const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
 const words=e=>{const issues=[],walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const n=walker.currentNode;for(const match of n.data.matchAll(/[\p{L}\p{N}]+/gu)){const r=document.createRange();r.setStart(n,match.index);r.setEnd(n,match.index+match[0].length);const lines=[...r.getClientRects()].filter(x=>x.width>0);if(lines.some(x=>Math.abs(x.top-lines[0].top)>1))issues.push({word:match[0],rects:lines.map(x=>({x:x.x,y:x.y,w:x.width,h:x.height}))});}}return issues};
 return [...document.querySelectorAll('#table .champ-match')].map(row=>{
  const date=row.querySelector('.champ-date'),team=[...row.querySelectorAll('.champ-team')],score=row.querySelector('.champ-score'),st=row.querySelector('.champ-status');
  const texts=[...team,st].filter(Boolean),controls=[...row.querySelectorAll('a'),...(row.matches('details')?[row.querySelector('summary')]:[])];
  return {id:row.dataset.champMatch,score:score?.textContent.trim(),date:date?.innerText.trim(),dateLabel:date?.getAttribute('aria-label'),datetime:date?.querySelector('time')?.getAttribute('datetime')||null,
   names:team.map(e=>e.textContent.trim().replace(/^.*?(?=ФК|СК|АФК|УОР|«|Название)/,'')),teamText:team.map(e=>e.innerText.trim()),
   status:st?.textContent.trim(),statusLabel:st?.getAttribute('aria-label'),openLabel:row.querySelector('.champ-open')?.getAttribute('aria-label'),details:row.matches('details')?row.querySelector('.champ-match-info')?.textContent:null,
   badges:team.map(e=>{const b=e.querySelector('.champ-badge'),i=b?.querySelector('img');return {src:i?.getAttribute('src')||null,fit:i?getComputedStyle(i).objectFit:null,bg:i?getComputedStyle(i).backgroundColor:null,initials:b?.querySelector('span')?.textContent||'',initialsVisible:b?getComputedStyle(b.querySelector('span')).visibility:null}}),
   controls:controls.map(box),row:box(row),dateBox:box(date),teamBoxes:team.map(box),scoreBox:box(score),scoreFont:parseFloat(getComputedStyle(score).fontSize),statusBox:st?box(st):null,debug:[getComputedStyle(row).fontSize,getComputedStyle(row.parentElement).fontSize,getComputedStyle(team[0]).fontSize],
   broken: texts.flatMap(words),clipped:texts.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.trim())};
 });
};
const inspectClub=()=>{
 const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
 const broken=e=>{const issues=[],w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);while(w.nextNode()){const n=w.currentNode;for(const m of n.data.matchAll(/[\p{L}\p{N}]+/gu)){const r=document.createRange();r.setStart(n,m.index);r.setEnd(n,m.index+m[0].length);const rects=[...r.getClientRects()].filter(x=>x.width>0);if(rects.some(x=>Math.abs(x.top-rects[0].top)>1))issues.push(m[0]);}}return issues};
 return [...document.querySelectorAll('#team.on .club-fixture')].map(row=>{
  const meta=row.querySelector('.club-match-meta'),pair=[...row.querySelectorAll('.club-match-pair .club-link')],score=row.querySelector('.club-score'),status=row.querySelector('.club-short-status,.club-match-status');
  return {id:row.dataset.clubMatch,score:score.textContent.trim().replace('›','').trim(),label:score.getAttribute('aria-label'),dateLabel:meta.firstElementChild?.getAttribute('aria-label'),datetime:meta.querySelector('time')?.getAttribute('datetime')||null,
   teams:pair.map(e=>({id:e.dataset.team,text:e.innerText,font:parseFloat(getComputedStyle(e).fontSize),box:box(e),img:e.querySelector('img')?.getAttribute('src')||null})),meta:box(meta),metaFont:parseFloat(getComputedStyle(meta).fontSize),scoreBox:box(score),row:box(row),status:status?.textContent.trim(),statusBox:status?box(status):null,
   broken:[...pair,...(status?[status]:[])].flatMap(broken),clipped:[...pair,...(status?[status]:[])].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.trim())};
 });
};
(async()=>{
 fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({...process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{},args:['--disable-partial-raster']}),errors=[];
 try{
  const base=`http://127.0.0.1:${server.address().port}/`;
  for(const theme of (process.env.CONTRACT_THEMES||'light,dark').split(','))for(const width of (process.env.CONTRACT_WIDTHS||'320,390,768,1440').split(',').map(Number))for(const factor of (process.env.CONTRACT_SCALES||'1,1.5').split(',').map(Number)){
   const c=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width,height:844},deviceScaleFactor:1});
   await c.addInitScript(theme=>{localStorage.setItem('sudak-theme',theme);Date.now=()=>Date.parse('2026-11-10T12:00:00Z')},theme);await c.route('https://rffk-roo.ru/**',r=>r.abort());
   const shots=[],clubShots=[],roundShots={'2':[],'19':[]};
   for(const mode of ['reference','candidate']){
    const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+(mode==='reference'?'?reference=1':'')+'#table');await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
    await p.evaluate(()=>{CHAMP_STATE.view='calendar';CHAMP_STATE.round='18';CHAMP_STATE.team='all';CHAMP_STATE.status='all';renderChampionship()});
    if(factor===1.5)await scaleText(p);await settle(p);await p.mouse.move(0,0);
    // Isolate the list screenshot from the fixed bottom navigation. Navigation
    // itself remains fully compared to main in design-preservation.
    await p.addStyleTag({content:'#nav{visibility:hidden!important}'});
    const png=await p.locator('#table .champ-match-list').screenshot({animations:'disabled'});shots.push(png);
    fs.writeFileSync(path.join(out,`${mode}-${theme}-${width}-${factor}.png`),png);
    for(const round of ['2','19']){
     await p.goto(base+(mode==='reference'?'?reference=1&':'?')+'visual-round='+round+'#table');await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
     await p.evaluate(round=>{CHAMP_STATE.view='calendar';CHAMP_STATE.round=round;CHAMP_STATE.team='all';CHAMP_STATE.status='all';renderChampionship()},round);if(factor===1.5)await scaleText(p);await settle(p);await p.addStyleTag({content:'#nav{visibility:hidden!important}'});
     const roundPng=await p.locator('#table .champ-match-list').screenshot({animations:'disabled'});roundShots[round].push(roundPng);fs.writeFileSync(path.join(out,`round-${round}-${mode}-${theme}-${width}-${factor}.png`),roundPng);
    }
    await p.goto(base+(mode==='reference'?'?reference=1&club=1':'?club=1')+'#team=936');await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
    if(factor===1.5)await scaleText(p);await settle(p);await p.addStyleTag({content:'#nav{visibility:hidden!important}'});
    const clubPng=await p.locator('#team .football-match-list').first().screenshot({animations:'disabled'});clubShots.push(clubPng);fs.writeFileSync(path.join(out,`club-${mode}-${theme}-${width}-${factor}.png`),clubPng);
    if(mode==='candidate'){
     fs.writeFileSync(path.join(out,`calendar-${theme}-${width}-${factor}.png`),png);
     const clean=await c.newPage();await clean.goto(base+'?audit-clean=1#team=936');await clean.waitForFunction(()=>!loadingData&&!!PLATFORM);await clean.locator('#launch-splash').waitFor({state:'detached'});await clean.evaluate(()=>document.fonts.ready);
     for(const id of ['141','936','1030','932','521','930','146','934','757','1028','117']){
      const sizes=await clean.evaluate(id=>{history.replaceState({},'','#team='+id);applyRoute();return [...document.querySelectorAll('#team.on .club-fixture,#team.on .club-fixture *')].filter(e=>!(e instanceof SVGElement)&&e.tagName!=='IMG').map(e=>parseFloat(getComputedStyle(e).fontSize))},id);
      await p.evaluate(({id,sizes,factor})=>{history.replaceState({},'','#team='+id);applyRoute();if(factor===1.5){const es=[...document.querySelectorAll('#team.on .club-fixture,#team.on .club-fixture *')].filter(e=>!(e instanceof SVGElement)&&e.tagName!=='IMG');if(es.length!==sizes.length)throw Error('Club row structure differs from unscaled document');es.forEach((e,i)=>e.style.fontSize=sizes[i]*factor+'px')}},{id,sizes,factor});await settle(p);
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),width,`club ${id} horizontal overflow`);
      const rows=await p.evaluate(inspectClub);
      for(const r of rows){const m=data.platform.matchesById[r.id];assert(m,`unknown club match ${r.id}`);assert([m.homeTeamId,m.awayTeamId].includes(id));
       assert.equal(r.score,Number.isInteger(m.homeScore)&&Number.isInteger(m.awayScore)?`${m.homeScore}:${m.awayScore}`:'—');assert.equal(r.datetime,m.date||null);
       assert.equal(r.dateLabel,(m.date?m.date.split('-').reverse().join('.'):'Дата не указана')+(m.time?' · '+m.time:''));
       const full=m.statusLabel||({finished:'Матч завершён',technical:'Технический результат',scheduled:m.date?'Матч запланирован':'Дата уточняется',postponed:'Матч перенесён',cancelled:'Матч отменён',suspended:'Матч приостановлен'})[m.status]||'Статус уточняется';
       assert(r.label.includes(full));if(m.status==='finished')assert.equal(r.status,undefined);else assert.equal(r.status,shortStatus[full]||full);
       assert.deepEqual(r.teams.map(t=>t.id),[m.homeTeamId,m.awayTeamId]);for(const t of r.teams){assert(t.text.includes(data.platform.teamsById[t.id].name));assert(t.box.width>=43.99&&t.box.height>=43.99);assert.equal(t.img,t.id==='141'?'icon-192.png?v=final-crest-v7':`assets/clubs/${t.id}.png`)}
       assert(r.scoreBox.width>=43.99&&r.scoreBox.height>=43.99);assert.equal(r.broken.length,0,`club word split ${r.id}: ${JSON.stringify(r.broken)}`);assert.deepEqual(r.clipped,[],`club clipped ${r.id}`);
       assert(r.metaFont>=13*factor,'club date readability');assert(r.teams.every(t=>t.font>=15*factor),'club name readability');
       assert(Math.abs((r.scoreBox.top+r.scoreBox.bottom)/2-(r.teams[0].box.top+r.teams[1].box.bottom)/2)<=1,`club score must stay beside the team pair: ${r.id}`);
       const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5;
       for(const t of r.teams){assert(!overlap(r.meta,t.box),`club date/team ${r.id}`);assert(!overlap(r.scoreBox,t.box),`club score/team ${r.id}`)}
       assert(r.row.left>=-.5&&r.row.right<=width+.5,`club row overflow ${r.id}`);
      }
      console.log(`CHECK club ${id}: ${theme} ${width} ${factor}`);
     }
     await p.goto(base+'?audit-calendar=1#table');await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});if(factor===1.5)await scaleText(p);
     // Re-render every real round. Scale each new subtree exactly once.
     for(const round of [...new Set(matches.map(m=>m.round_id))]){
      // Measure on a separate unscaled document so inherited font sizes are
      // multiplied exactly once even when the list is re-rendered.
      const sizes=await clean.evaluate(round=>{history.replaceState({},'','#table');applyRoute();CHAMP_STATE.view='calendar';CHAMP_STATE.team='all';CHAMP_STATE.status='all';CHAMP_STATE.round=round;renderChampionship();return [...document.querySelectorAll('#table .champ-match-list,#table .champ-match-list *')].filter(e=>!(e instanceof SVGElement)&&e.tagName!=='IMG').map(e=>parseFloat(getComputedStyle(e).fontSize))},round);
      await p.evaluate(({round,sizes,factor})=>{CHAMP_STATE.view='calendar';CHAMP_STATE.team='all';CHAMP_STATE.status='all';CHAMP_STATE.round=round;renderChampionship();if(factor===1.5){const es=[...document.querySelectorAll('#table .champ-match-list,#table .champ-match-list *')].filter(e=>!(e instanceof SVGElement)&&e.tagName!=='IMG');if(es.length!==sizes.length)throw Error('Calendar row structure differs from unscaled document');es.forEach((e,i)=>e.style.fontSize=sizes[i]*factor+'px')}},{round,sizes,factor});
      await settle(p);const actual=await p.evaluate(inspect),expected=matches.filter(m=>m.round_id===round);
      assert.equal(await p.locator('#table .champ-match-list > :not(.champ-match)').count(),0,`unexpected calendar list content ${round}`);
      assert.deepEqual(actual.map(x=>x.id),expected.map(x=>x.id),`IDs ${round}`);
      for(let i=0;i<expected.length;i++){
       const m=expected[i],r=actual[i],label=status(m),date=m.date?m.date.split('-').reverse().join('.'):'Дата не указана';
       assert.equal(r.score,Number.isInteger(m.home_score)&&Number.isInteger(m.away_score)?`${m.home_score}:${m.away_score}`:'—',`score ${m.id}`);
       assert.equal(r.datetime,m.date||null,`date ${m.id}`);assert.equal(r.dateLabel,date+(m.time?' · '+m.time:''),`date label ${m.id}`);
       if(m.date)assert(r.date.includes(m.date.split('-').reverse().slice(0,2).join('.')));else assert(r.date.includes('—'));
       if(m.time)assert(r.date.includes(m.time));else assert(!/\d{1,2}:\d{2}/.test(r.date));
       assert((r.openLabel||r.details||'').includes(label),`full status ${m.id}: ${label}`);
       const ordinaryResult=m.status==='finished'&&['Матч завершён','Завершён','Матч завершен','Завершен'].includes(label);
       if(ordinaryResult){assert.equal(r.status,undefined,`redundant finished label ${m.id}`);assert.equal(r.statusBox,null)}
       else {assert.equal(r.status,shortStatus[label]||label,`visible status ${m.id}`);if(Object.hasOwn(shortStatus,label))assert.equal(r.statusLabel,label,`status label ${m.id}`)}
       if(ordinaryResult||(width<=390&&factor===1.5)){
        const teamsCenter=(r.teamBoxes[0].top+r.teamBoxes[1].bottom)/2;
        assert(Math.abs((r.scoreBox.top+r.scoreBox.bottom)/2-teamsCenter)<=1,`score must stay beside the team pair: ${m.id}`);
       }
       if(width===320&&factor===1.5)assert.equal(r.scoreFont,30,'approved score size at 320px / 150%');
       for(const [j,id] of [m.home_id,m.away_id].entries())assert(r.teamText[j].includes(teams[id]||'Название не опубликовано'),`team ${m.id}`);
       for(const [j,b] of r.badges.entries()){
        const id=[m.home_id,m.away_id][j],team=data.platform.teamsById[id];
        assert(b.initials,'missing fallback initials');
        if(team){const expectedSrc=id==='141'?'icon-192.png?v=final-crest-v7':/^https:\/\/rffk-roo\.ru\/uploads\/clubs\/small\/[\w.-]+\.png$/.test(team.branding?.officialLogoUrl||'')?`assets/clubs/${id}.png`:null;assert.equal(b.src,expectedSrc,`crest ${m.id} ${id}`)}
        if(b.src){assert.equal(b.fit,'contain');assert.equal(b.bg,'rgba(0, 0, 0, 0)');assert.equal(b.initialsVisible,'hidden')}else assert.notEqual(b.initialsVisible,'hidden');
       }
       for(const a of r.controls)assert(a.width>=43.99&&a.height>=43.99,`small target ${m.id} ${JSON.stringify(a)}`);
       assert.equal(r.broken.length,0,`word split ${m.id}: ${JSON.stringify({broken:r.broken,debug:r.debug,row:r.row,date:r.dateBox,teams:r.teamBoxes,score:r.scoreBox})}`);assert.deepEqual(r.clipped,[],`clipped ${m.id}`);
       const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5;
       for(const b of r.teamBoxes){assert(!overlap(r.dateBox,b),`date overlaps team ${m.id}`);assert(!overlap(r.scoreBox,b),`score overlaps team ${m.id}`);if(r.statusBox)assert(!overlap(r.statusBox,b),`status overlaps team ${m.id}`)}
       assert(r.row.left>=-.5&&r.row.right<=width+.5,`row overflow ${m.id}`);
      }
      if(Number(round)%5===0)console.log(`CHECK round ${round}: ${theme} ${width} ${factor}`);
     }
     // Unpublished and exceptional cases are synthetic UI inputs only; the
     // source data and real match IDs above remain untouched.
     const cases=[
      {status:'scheduled',date:'2026-11-07',time:'14:00',status_label:null,full:'Матч запланирован'},
      {status:'scheduled',date:'2026-11-07',time:null,status_label:null,full:'Матч запланирован'},
      {status:'scheduled',date:null,time:'14:00',status_label:null,full:'Дата уточняется'},
      {status:'postponed',date:null,time:null,status_label:null,full:'Матч перенесён'},
      {status:'cancelled',date:null,time:null,status_label:null,full:'Матч отменён'},
      {status:'other',date:null,time:null,status_label:'Проверка результата',full:'Проверка результата'}
     ];
     await p.goto(base+'?audit-exceptions=1#table');await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
     await p.evaluate(cases=>{CHAMP_STATE.view='calendar';CHAMP_STATE.round='18';renderChampionship();const sample=champMatches()[0];document.querySelector('#table .champ-match-list').innerHTML=cases.map((item,i)=>champMatchHTML({...sample,...item,id:'audit-'+i,source_id:null,source_url:null,club_match_key:null,home_score:null,away_score:null})).join('')},cases);
     if(factor===1.5)await scaleText(p);await settle(p);
     const synthetic=await p.evaluate(inspect);assert.equal(synthetic.length,cases.length);
     for(const [i,r] of synthetic.entries()){
      const m=cases[i];assert.equal(r.score,'—');assert.equal(r.datetime,m.date);assert.equal(r.status,shortStatus[m.full]||m.full);assert((r.details||'').includes(m.full));
      assert.equal(r.dateLabel,(m.date?m.date.split('-').reverse().join('.'):'Дата не указана')+(m.time?' · '+m.time:''));
      if(m.time)assert(r.date.includes(m.time));else assert(!/\d{1,2}:\d{2}/.test(r.date));
      assert.equal(r.broken.length,0,`synthetic word split: ${JSON.stringify(r.broken)}`);assert.deepEqual(r.clipped,[]);
      for(const a of r.controls)assert(a.width>=43.99&&a.height>=43.99,'synthetic target');
     }
     // Actual failed local crest requests must expose the existing initials.
     await p.route('**/assets/clubs/*.png',r=>r.abort());await p.goto(base+'?audit-crest-failure=1#table');await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
     await p.evaluate(()=>{CHAMP_STATE.view='calendar';CHAMP_STATE.round='18';renderChampionship()});await p.waitForFunction(()=>!document.querySelector('#table .champ-team img[src^="assets/clubs/"]'));
     await settle(p);
     const fallback=await p.locator('#table .champ-team .champ-badge').evaluateAll(es=>es.filter(e=>!e.querySelector('img')).map(e=>({text:e.querySelector('span')?.textContent,visibility:getComputedStyle(e.querySelector('span')).visibility,html:e.outerHTML})));
     assert(fallback.length>0,'no failed-crest fallback');assert(fallback.every(x=>x.text&&x.visibility!=='hidden'),`initials remain visible: ${JSON.stringify(fallback)}`);
     await clean.close();
    }
    await p.close();
   }
   assert(shots[0].equals(shots[1]),`match rows differ from frozen reference: ${theme} ${width} ${factor}`);
   for(const round of ['2','19'])assert(roundShots[round][0].equals(roundShots[round][1]),`round ${round} differs from frozen reference: ${theme} ${width} ${factor}`);
   assert(clubShots[0].equals(clubShots[1]),`club rows differ from frozen reference: ${theme} ${width} ${factor}`);
   await c.close();console.log(`PASS row reference + data/geometry: ${theme} ${width} ${factor}`);
  }
  assert.deepEqual(errors,[]);console.log('Reference sha256:',crypto.createHash('sha256').update(reference).digest('hex'));
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
