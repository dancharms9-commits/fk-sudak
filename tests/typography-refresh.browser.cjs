/* Real A/B/C captures and typography checks; football data is always read-only. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),phase=process.env.TYPOGRAPHY_PHASE||'B';
const out=path.resolve(process.env.TYPOGRAPHY_DIR||path.join(root,'docs/typography-refresh'));
const baseline=process.env.MULTI_CLUB_BASELINE_HTML?fs.readFileSync(process.env.MULTI_CLUB_BASELINE_HTML):execFileSync('git',['show','main:index.html'],{cwd:root});
const numeric='.num,.center-score-numbers,.home-score,.home-result-score b,.home-standing-top>b,.home-metrics dd,.sc,.champ-score,.club-score,.stats-value b,.club-metrics dd,.club-record dd';
const comparisonCSS=`@font-face{font-family:"Roboto Condensed Trial";font-style:normal;font-weight:700;font-display:swap;src:url("docs/typography-refresh/trial/roboto-condensed-latin-700-normal.woff2") format("woff2")} ${numeric}{font-family:"Roboto Condensed Trial","IBM Plex Sans",sans-serif!important;font-weight:700!important} .home-standing-top small{font-family:"IBM Plex Sans",sans-serif}`;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 if(pathname==='/'&&phase==='A'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(baseline)}
 const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
const metrics=()=>{
 const active=document.querySelector('main>section.on'),visible=e=>!!e.getClientRects().length;
 const box=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {text:e.textContent.trim().slice(0,100),x:r.x,y:r.y,w:r.width,h:r.height,font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,line:s.lineHeight,numeric:s.fontVariantNumeric}};
 const text=[...active.querySelectorAll('h2,h3,.club-link,.club-roster-player b,.home-score,.champ-score,.num,.profile-values b')].filter(visible);
 const controls=[...document.querySelectorAll('header button,#nav button,main>section.on a,main>section.on button,main>section.on summary,main>section.on select,main>section.on input')].filter(visible);
 return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollY,header:box(document.querySelector('header')),nav:box(document.querySelector('#nav')),text:text.map(box),controls:controls.map(box),clipped:controls.filter(e=>{const r=e.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5}).map(box)};
};
async function settle(p){await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('header img,main>section.on img')].filter(i=>{const r=i.getBoundingClientRect();return r.width&&r.top<innerHeight}).map(i=>i.decode().catch(()=>{})));await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});}
async function route(p,hash){await p.evaluate(hash=>{history.replaceState({},'',hash);applyRoute();document.activeElement?.blur();scrollTo(0,0)},hash);}
const screens=[['home','#home'],['calendar','#table'],['kashtan','#team=936'],['roster','#team=936'],['popov','#player=rffk-146&team=936&competition=4&season=22&from=team'],['match','#match=rffk-38771&from=table']];
(async()=>{
 fs.mkdirSync(path.join(out,phase),{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/fk-sudak/`,browser=await chromium.launch({...process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{},args:['--disable-partial-raster']});
 const results=[],errors=[];
 try{
  for(const theme of ['dark','light'])for(const width of [320,390,768,1440]){
   const c=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width,height:844},deviceScaleFactor:1});
   await c.addInitScript(theme=>{localStorage.setItem('sudak-theme',theme);Date.now=()=>Date.parse('2026-11-11T09:00:00Z')},theme);
   await c.route('https://rffk-roo.ru/**',r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
   await p.goto(base);await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
   if(phase==='C')await p.addStyleTag({content:comparisonCSS});
   for(const [name,hash] of screens){
    await route(p,hash);
    if(name==='calendar')await p.evaluate(()=>{CHAMP_STATE.view='calendar';CHAMP_STATE.round='18';CHAMP_STATE.team='all';CHAMP_STATE.status='all';renderChampionship()});
    if(name==='roster')await p.locator('#team .club-roster-role').first().evaluate(e=>scrollTo(0,scrollY+e.getBoundingClientRect().top-24));
    await settle(p);const m=await p.evaluate(metrics);results.push({name,theme,...m});
    assert.equal(m.scrollWidth,width,`${phase} ${name}: horizontal overflow`);assert.deepEqual(m.clipped,[],`${phase} ${name}: clipped controls`);
    await p.screenshot({path:path.join(out,phase,`${name}-${theme}-${width}.png`),animations:'disabled'});
   }
   await c.close();console.log(`PASS ${phase}: six screens, ${theme}, ${width}px`);
  }
  fs.writeFileSync(path.join(out,phase,'metrics.json'),JSON.stringify({browser:browser.version(),platform:process.platform,phase,results})+'\n');assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
