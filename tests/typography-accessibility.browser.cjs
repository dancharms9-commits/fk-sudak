/* All interface text enlarged atomically, including fixed-px labels and nav. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.env.TYPOGRAPHY_DIR||path.join(root,'docs/typography-refresh'));
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
 const file=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
(async()=>{
 fs.mkdirSync(path.join(out,'text150'),{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{}),results=[],issues=[],errors=[];
 try{
  for(const theme of (process.env.TYPOGRAPHY_THEMES||'dark,light').split(','))for(const width of (process.env.TYPOGRAPHY_WIDTHS||'320,390,768,1440').split(',').map(Number)){
   const c=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width,height:844}});
   await c.addInitScript(theme=>{localStorage.setItem('sudak-theme',theme);Date.now=()=>Date.parse('2026-11-11T09:00:00Z')},theme);await c.route('https://rffk-roo.ru/**',r=>r.abort());
   const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
   const screens=[['home','#home'],['calendar','#table'],['standings','#table'],['kashtan','#team=936'],['roster','#team=936'],['long-name','#team=930'],['popov','#player=rffk-146&team=936&competition=4&season=22&from=team'],['match','#match=rffk-38771&from=table'],['legacy-match','#match=rffk-38762&from=matches'],['squad','#squad'],['news','#news'],['matches','#matches'],['scorers','#table'],['sudak-player','#player=rffk-202&from=home']].filter(([name])=>!process.env.TYPOGRAPHY_SCREENS||process.env.TYPOGRAPHY_SCREENS.split(',').includes(name));
   for(const [name,hash]of screens){
    // Fresh document: inline text sizes from the previous route cannot leak.
    await p.goto(`http://127.0.0.1:${server.address().port}/fk-sudak/?text150=${name}${hash}`);await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
    if(['calendar','standings','scorers'].includes(name))await p.evaluate(name=>{CHAMP_STATE.view=name;CHAMP_STATE.round='18';renderChampionship()},name);
    await p.evaluate(async()=>{
     await document.fonts.ready;
     const es=[...document.querySelectorAll('body,header,header *,#nav,#nav *,main>section.on,main>section.on *')].filter(e=>!(e instanceof SVGElement)&&!e.closest('.club-name'));
     const sizes=es.map(e=>parseFloat(getComputedStyle(e).fontSize));es.forEach((e,i)=>e.style.fontSize=sizes[i]*1.5+'px');
     await document.fonts.ready;
    });
    await p.evaluate(()=>scrollTo(0,0));
    if(name==='roster')await p.locator('#team .club-roster-role').first().evaluate(e=>scrollTo(0,scrollY+e.getBoundingClientRect().top-24));
    const m=await p.evaluate(()=>{
     const visible=e=>e.getClientRects().length&&!e.closest('details:not([open])')||e.tagName==='SUMMARY'&&e.getClientRects().length;
     const box=e=>{const r=e.getBoundingClientRect();return {text:(e.getAttribute('aria-label')||e.textContent).trim().slice(0,70),tag:e.tagName,cls:e.className,w:r.width,h:r.height,x:r.x,right:r.right}};
     const controls=[...document.querySelectorAll('header button,#nav button,main>section.on :is(a,button,input,select,summary)')].filter(visible);
     const clipped=controls.filter(e=>{const r=e.getBoundingClientRect();if(r.x<-.5||r.right>innerWidth+.5||e.clientWidth&&e.scrollWidth>e.clientWidth+1)return true;if(e.tagName==='SELECT'){const s=getComputedStyle(e),ctx=document.createElement('canvas').getContext('2d');ctx.font=`${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;return ctx.measureText(e.selectedOptions[0]?.label||'').width>e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-24}return false}).map(box);
     return {scrollWidth:document.documentElement.scrollWidth,clipped,smallTargets:controls.filter(e=>{const r=e.getBoundingClientRect();return r.width<44||r.height<44}).map(box),navHeight:document.querySelector('#nav').getBoundingClientRect().height};
    });
    results.push({name,theme,width,...m});if(m.scrollWidth!==width||m.clipped.length||m.smallTargets.length)issues.push({name,theme,width,...m});
    if(['home','calendar','kashtan','roster','popov','match'].includes(name))await p.screenshot({path:path.join(out,'text150',`${name}-${theme}-${width}.png`),animations:'disabled'});
   }
   await c.close();console.log(`CHECK 150% all text: ${theme} ${width}`);
  }
  fs.writeFileSync(path.join(out,'accessibility.json'),JSON.stringify({results,issues,errors},null,2)+'\n');assert.deepEqual(errors,[]);assert.deepEqual(issues,[],'Text 150% must retain all controls and fit horizontally');
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
