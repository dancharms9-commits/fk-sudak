/* The optional data extension must be invisible to the existing UI. Compare
 * actual PNG pixels for old/new JSON in the same browser, not mock renderers. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
const extended=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
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
          shots[tab]=await page.screenshot({animations:'disabled'});
        }
        screenshots.push(shots);await context.close();
      }
      for(const tab of Object.keys(screenshots[0]))assert(screenshots[0][tab].equals(screenshots[1][tab]),`${tab} ${theme} ${width}: platform changed rendered pixels`);
      console.log(`PASS pixel-identical legacy/platform JSON: 5 tabs, ${theme}, ${width}px`);
    }
    assert.deepEqual(errors,[]);console.log('PASS zero JavaScript errors; no UI changes from platform');
  }finally{await browser.close();server.close()}
})().catch(err=>{console.error(err);process.exitCode=1;server.close()});
