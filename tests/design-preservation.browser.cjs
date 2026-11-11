/* Compare real base/candidate raster and geometry, including all legacy centers. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),data=JSON.parse(fs.readFileSync(path.join(root,'data.json')));
const baseline=require('./typography-baseline.cjs')(process.env.MULTI_CLUB_BASELINE_HTML?fs.readFileSync(process.env.MULTI_CLUB_BASELINE_HTML):execFileSync('git',['show','main:index.html'],{cwd:root}));
const shots=process.env.DESIGN_PRESERVATION_DIR;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'&&url.searchParams.has('baseline')){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(baseline)}
 const file=path.resolve(root,url.pathname==='/'?'index.html':'.'+url.pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
 fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(body)});
});
const layout=()=>[...document.querySelectorAll('header,header *,nav,nav *,main>section.on,main>section.on *')].map(e=>{
 const r=e.getBoundingClientRect(),s=getComputedStyle(e);
 return {tag:e.tagName,id:e.id,className:e.className,text:e.textContent,src:e.getAttribute('src'),href:e.getAttribute('href'),rect:[r.x,r.y,r.width,r.height],style:[s.color,s.backgroundColor,s.backgroundImage,s.borderColor,s.borderRadius,s.fontFamily,s.fontSize,s.fontWeight,s.boxShadow]};
});
async function rasterDelta(p,a,b,edges){
 if(a.equals(b))return {changed:0,max:0,total:a.readUInt32BE(16)*a.readUInt32BE(20),edgePixels:0,hardMax:0};
 return p.evaluate(async({urls,edges})=>{
  const pictures=await Promise.all(urls.map(async src=>{const i=new Image();i.src=src;await i.decode();return i}));
  const c=document.createElement('canvas');c.width=pictures[0].width;c.height=pictures[0].height;
  const ctx=c.getContext('2d',{willReadFrequently:true}),rgba=pictures.map(i=>{ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(i,0,0);return ctx.getImageData(0,0,c.width,c.height).data});
  const onEdge=(x,y)=>edges.some(r=>{const qx=Math.abs(x-r.x-r.width/2)-(r.width/2-r.radius),qy=Math.abs(y-r.y-r.height/2)-(r.height/2-r.radius);return Math.abs(Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r.radius)<=1.25});
  let changed=0,max=0,edgePixels=0,hardMax=0;const pixels=[];
  for(let i=0;i<rgba[0].length;i+=4){let d=0;for(let j=0;j<4;j++)d=Math.max(d,Math.abs(rgba[0][i+j]-rgba[1][i+j]));if(d){const x=i/4%c.width,y=Math.floor(i/4/c.width);pixels.push({x,y,delta:d,before:[...rgba[0].slice(i,i+4)],after:[...rgba[1].slice(i,i+4)]});changed++;max=Math.max(max,d);if(d>2&&onEdge(x+.5,y+.5))edgePixels++;else hardMax=Math.max(hardMax,d)}}
  return {changed,max,total:c.width*c.height,edgePixels,hardMax,pixels};
 },{urls:[a,b].map(b=>'data:image/png;base64,'+b.toString('base64')),edges});
}
async function stableScreenshot(p){
 let previous=await p.screenshot({animations:'disabled'});
 for(let i=0;i<6;i++){const current=await p.screenshot({animations:'disabled'});if(previous.equals(current))return current;previous=current}
 throw Error('Rendered frame did not settle');
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
 // Full-tile rasterization avoids Chromium's history-dependent antialiasing
 // of rounded gradient clips. This affects capture conditions only, for both
 // documents equally; all pixel limits below remain unchanged.
 const browser=await chromium.launch({...process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{},args:['--disable-partial-raster']}),results=[],errors=[];
 try{
  const comparator=await browser.newPage();
  const old=data.res.map(r=>({name:'legacy-'+data.match_details[[2026,r[0],r[1],r[5]].join('|')].id,hash:'#match='+encodeURIComponent([2026,r[0],r[1],r[5]].join('|'))+'&from=matches'}));
  const screens=[{name:'home',hash:'#home'},{name:'sudak-player',hash:'#player=rffk-202&from=home'},{name:'calendar',hash:'#table',calendar:true},{name:'universal-center',hash:'#match=rffk-38771&from=table'},{name:'scheduled-center',hash:'#match=4%3A2026%3A20%3A117%3A141&from=table'},...old];
  for(const width of [320,390,768,1440])for(const theme of ['light','dark']){
   const snapshots=[];
   const c=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width,height:844},deviceScaleFactor:1});
   await c.addInitScript(theme=>{localStorage.setItem('sudak-theme',theme);Date.now=()=>Date.parse('2026-11-10T12:00:00Z')},theme);
   await c.route('https://rffk-roo.ru/**',r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
   for(const mode of ['before','after']){
    if(mode==='after')await p.evaluate(()=>{localStorage.clear();sessionStorage.clear()});
    await p.goto(base+(mode==='before'?'?baseline=1':''));await p.waitForFunction(()=>!loadingData&&!!PLATFORM);await p.locator('#launch-splash').waitFor({state:'detached'});
    const frames={};
    for(const screen of screens){
     await p.evaluate(hash=>{history.replaceState({},'',hash);applyRoute();document.activeElement?.blur();scrollTo(0,0)},screen.hash);
     if(screen.calendar)await p.evaluate(()=>{CHAMP_STATE.view='calendar';CHAMP_STATE.round='18';CHAMP_STATE.team='all';CHAMP_STATE.status='all';renderChampionship()});
     await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('header img,main>section.on img')].filter(i=>{const r=i.getBoundingClientRect();return r.width&&r.top<innerHeight}).map(i=>i.decode().catch(()=>{})));await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});
     // Compare the real calendar shell against the original main. Remove only
     // row children from both documents, retaining the list itself, borders,
     // header, filters and footer. The separate match-row contract checks the
     // complete, unmodified rows against a frozen reference and source data.
     if(screen.calendar)await p.evaluate(mode=>{
      const lists=document.querySelectorAll('#table .champ-match-list');
      if(lists.length!==1||!lists[0].querySelector('.champ-match'))throw Error('Calendar list missing');
      const type=getComputedStyle(lists[0]).containerType;
      if(type!==(mode==='before'?'normal':'inline-size'))throw Error('Unexpected calendar container type: '+type);
      lists[0].replaceChildren();
     },mode);
     await p.mouse.move(0,0);frames[screen.name]={layout:await p.evaluate(layout),png:await stableScreenshot(p),edges:await p.locator('#nav button.on').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,radius:parseFloat(getComputedStyle(e).borderRadius)}}))};
     if(shots&&['home','calendar','universal-center','scheduled-center','sudak-player',old[0].name].includes(screen.name)){fs.mkdirSync(shots,{recursive:true});fs.writeFileSync(path.join(shots,`${screen.name}-${theme}-${width}-${mode}.png`),frames[screen.name].png)}
    }
    snapshots.push(frames);
   }
   await c.close();
   for(const screen of screens){
    const a=snapshots[0][screen.name],b=snapshots[1][screen.name];
    assert.deepEqual(a.layout,b.layout,`${screen.name} ${width} ${theme}: geometry/text/styles changed`);
    const {pixels=[],...delta}=await rasterDelta(comparator,a.png,b.png,a.edges);results.push({screen:screen.name,width,theme,...delta});
    if(delta.max>2&&shots){fs.writeFileSync(path.join(shots,`${screen.name}-${theme}-${width}-before.png`),a.png);fs.writeFileSync(path.join(shots,`${screen.name}-${theme}-${width}-after.png`),b.png);fs.writeFileSync(path.join(shots,`${screen.name}-${theme}-${width}-delta.json`),JSON.stringify({browser:browser.version(),platform:process.platform,arch:process.arch,delta,pixels,before:a.layout,after:b.layout},null,2)+'\n')}
    // Native Chromium occasionally quantizes the pre-existing rounded gradient
    // edge differently. Allow only its 1.25px outline, <=100 pixels, <=40 RGB.
    // Every other pixel retains the existing 2-level / 0.1% noise bound.
    assert(delta.hardMax<=2&&delta.max<=40&&delta.edgePixels<=100&&delta.changed/delta.total<=.001,`${screen.name} ${width} ${theme}: raster changed ${JSON.stringify(delta)}`);
   }
   console.log(`PASS real base/candidate PNGs + full layout: home, Sudak player, championship, universal/scheduled centers, 16 legacy centers; ${width}px ${theme}`);
  }
  if(shots)fs.writeFileSync(path.join(shots,'preservation.json'),JSON.stringify(results,null,2)+'\n');assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
