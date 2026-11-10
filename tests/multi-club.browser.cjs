/* The optional data extension must be invisible to the existing UI. Compare
 * actual PNG pixels for old/new JSON in the same browser, not mock renderers. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
const extended=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
async function stableScreenshot(page){
  // Remove transient pointer hover and wait for two identical compositor
  // frames, as visual comparisons must not sample a tab-click transition.
  await page.mouse.move(0,0);
  await page.evaluate(async()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
  let previous=await page.screenshot({animations:'disabled'});
  for(let attempt=0;attempt<6;attempt++){
    const current=await page.screenshot({animations:'disabled'});
    if(previous.equals(current))return current;
    previous=current;
  }
  throw Error('Rendered frame did not settle');
}
async function pixelDifference(page,a,b){
  if(a.equals(b))return {changed:0,max:0,total:1};
  return page.evaluate(async urls=>{
    const pictures=await Promise.all(urls.map(async src=>{const i=new Image();i.src=src;await i.decode();return i}));
    const assertSize=pictures[0].width===pictures[1].width&&pictures[0].height===pictures[1].height;
    if(!assertSize)throw Error('Screenshot sizes differ');
    const canvas=document.createElement('canvas');canvas.width=pictures[0].width;canvas.height=pictures[0].height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const data=pictures.map(i=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(i,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height).data});
    let changed=0,max=0;
    for(let i=0;i<data[0].length;i+=4){let delta=0;for(let c=0;c<4;c++)delta=Math.max(delta,Math.abs(data[0][i+c]-data[1][i+c]));if(delta){changed++;max=Math.max(max,delta)}}
    return {changed,max,total:canvas.width*canvas.height};
  },[a,b].map(buffer=>'data:image/png;base64,'+buffer.toString('base64')));
}
async function presentation(page){
  return page.evaluate(()=>[...document.querySelectorAll('header,header *,nav,nav *,main section.on,main section.on *')].filter(el=>{
    const r=el.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;
  }).map(el=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return {tag:el.tagName,id:el.id,text:el.textContent,src:el.getAttribute('src'),href:el.getAttribute('href'),
      rect:[r.x,r.y,r.width,r.height],styles:[s.color,s.backgroundColor,s.backgroundImage,s.borderColor,s.borderRadius,s.fontFamily,s.fontSize,s.fontWeight,s.boxShadow,s.opacity]};
  }));
}
const {platform,...legacy}=extended;
assert.equal(platform.schemaVersion,1);
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/data.json'){
    res.setHeader('Content-Type','application/json');
    return res.end(JSON.stringify(url.searchParams.get('format')==='legacy'?legacy:extended));
  }
  const file=path.resolve(root,url.pathname==='/'?'index.html':'.'+url.pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
  fs.readFile(file,(err,body)=>{
    if(err){res.writeHead(404);return res.end()}
    res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'application/javascript',
      '.json':'application/json','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream');
    res.end(body);
  });
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  const errors=[];
  const comparator=await browser.newPage();
  try{
    for(const theme of ['light','dark'])for(const width of [320,390,768,1440]){
      const screenshots=[];
      for(const format of ['legacy','platform']){
        const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width,height:844}});
        await context.route('https://rffk-roo.ru/**',r=>r.abort());
        await context.route('**/data.json?*',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(format==='legacy'?legacy:extended)}));
        await context.addInitScript(theme=>{
          localStorage.setItem('sudak-theme',theme);
          Date.now=()=>Date.parse('2026-11-10T12:00:00Z');
        },theme);
        const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
        await page.goto('http://127.0.0.1:'+server.address().port+'/');
        await page.waitForFunction(()=>!loadingData&&hasNetworkData);
        const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('sudak-data-v1')));
        assert.deepEqual(stored,format==='legacy'?legacy:extended,'Comparison must actually load each JSON format');
        await page.locator('#launch-splash').waitFor({state:'detached'});
        const shots={};
        for(const tab of ['home','matches','table','squad','news']){
          await page.locator(`#nav [data-t="${tab}"]`).click();
          await page.locator(`#${tab}.on`).waitFor();
          await page.evaluate(async()=>{
            scrollTo(0,0);await document.fonts.ready;
            await Promise.all([...document.images].filter(i=>{const r=i.getBoundingClientRect();return r.width&&r.top<innerHeight&&r.bottom>0}).map(i=>i.decode().catch(()=>{})));
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          });
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
          shots[tab]={png:await stableScreenshot(page),presentation:await presentation(page)};
        }
        screenshots.push(shots);await context.close();
      }
      for(const tab of Object.keys(screenshots[0])){
        const a=screenshots[0][tab],b=screenshots[1][tab];
        assert.deepEqual(a.presentation,b.presentation,`${tab} ${theme} ${width}: presentation changed`);
        const delta=await pixelDifference(comparator,a.png,b.png);
        // Ignore only very small edge-antialiasing noise between compositor
        // surfaces. Exact geometry/text/styles above still forbid UI changes.
        const equal=delta.max<=2&&delta.changed/delta.total<=0.001;
        if(!equal&&process.env.VISUAL_SCREENSHOT_DIR){
          fs.mkdirSync(process.env.VISUAL_SCREENSHOT_DIR,{recursive:true});
          fs.writeFileSync(path.join(process.env.VISUAL_SCREENSHOT_DIR,`${tab}-${theme}-${width}-legacy.png`),a.png);
          fs.writeFileSync(path.join(process.env.VISUAL_SCREENSHOT_DIR,`${tab}-${theme}-${width}-platform.png`),b.png);
        }
        assert(equal,`${tab} ${theme} ${width}: pixel difference ${JSON.stringify(delta)}`);
      }
      console.log(`PASS equal presentation and raster (bounded edge antialiasing): 5 tabs, ${theme}, ${width}px`);
    }
    assert.deepEqual(errors,[]);console.log('PASS zero JavaScript errors; no UI changes from platform');
  }finally{await browser.close();server.close()}
})().catch(err=>{console.error(err);process.exitCode=1;server.close()});
