/* Audits the changed lists against the actual main HTML, without altering visual baselines. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),phase=process.env.MATCH_ROW_PHASE||'after';
const out=path.resolve(process.env.MATCH_ROW_DIR||path.join(root,'docs/design-polish/match-row-final'),phase);
const baseline=phase==='before'?execFileSync('git',['-c',`safe.directory=${root.replace(/\\/g,'/')}`,'show','main:index.html'],{cwd:root}):null;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 if(pathname==='/'&&baseline){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(baseline)}
 const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.json':'application/json','.png':'image/png','.woff2':'font/woff2','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
(async()=>{
 fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{}),metrics=[],errors=[];
 try{
  for(const theme of ['light','dark'])for(const width of [320,390,768,1440]){
   const c=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width,height:844},deviceScaleFactor:1});
   await c.addInitScript(theme=>{localStorage.setItem('sudak-theme',theme);Date.now=()=>Date.parse('2026-11-10T12:00:00Z')},theme);
   await c.route('https://rffk-roo.ru/**',r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
   await p.goto(`http://127.0.0.1:${server.address().port}/fk-sudak/`);await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
   for(const screen of ['calendar','kashtan']){
    await p.evaluate(screen=>{history.replaceState({},'',screen==='calendar'?'#table':'#team=936');applyRoute();if(screen==='calendar'){CHAMP_STATE.view='calendar';CHAMP_STATE.round='18';CHAMP_STATE.team='all';CHAMP_STATE.status='all';renderChampionship()}},screen);
    if(screen==='kashtan')await p.locator('#club-results').evaluate(e=>scrollTo(0,scrollY+e.getBoundingClientRect().top-20));else await p.evaluate(()=>scrollTo(0,0));
    await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('main>section.on img')].map(i=>i.decode().catch(()=>{})))});
    const m=await p.evaluate(screen=>({scrollWidth:document.documentElement.scrollWidth,rows:[...document.querySelectorAll(screen==='calendar'?'#table .champ-match':'#team .club-fixture')].map(e=>e.getBoundingClientRect().height)}),screen);
    assert.equal(m.scrollWidth,width,screen+' overflow');metrics.push({screen,theme,width,...m});
    await p.screenshot({path:path.join(out,`${screen}-${theme}-${width}.png`),animations:'disabled'});
   }
   if(phase==='after'){
    for(const id of ['141','936','1030','932','521','930','146','934','757','1028','117']){
     await p.evaluate(id=>{history.replaceState({},'','#team='+id);applyRoute()},id);
     assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),width,'club '+id+' overflow');
     for(const e of await p.locator('#team.on .club-fixture .club-link:visible').all())assert((await e.boundingBox()).height>=44,'club link target');
    }
    const examples=await p.evaluate(()=>({scheduled:compactMatchStatus({status:'scheduled',date:'2026-11-07'}),postponed:compactMatchStatus({status:'postponed',status_label:'Матч перенесен'}),cancelled:compactMatchStatus({status:'cancelled'}),unknown:compactMatchStatus({status:'other',status_label:'Официальный статус'}),date:matchDateHTML({date:'2026-11-07'}),time:matchDateHTML({time:'14:00'}),none:matchDateHTML({})}));
    assert.equal(examples.scheduled.text,'По плану');assert.equal(examples.postponed.text,'Перенос');assert.equal(examples.cancelled.text,'Отмена');assert.equal(examples.unknown.text,'Официальный статус');
    assert.match(examples.date,/07\.11/);assert.doesNotMatch(examples.date,/14:00/);assert.match(examples.time,/14:00/);assert.match(examples.none,/Дата уточняется/);
   }
   await c.close();console.log(`PASS ${phase} ${theme} ${width}`);
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
