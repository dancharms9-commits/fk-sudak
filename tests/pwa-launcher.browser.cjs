/* Exact launcher artwork, Android safe zone, old-cache update and real SW offline. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const source=fs.readFileSync(path.join(root,'assets/home-crest-original.png'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const cacheName=fs.readFileSync(path.join(root,'sw.js'),'utf8').match(/const CACHE="([^"]+)"/)[1];
const legacy={...manifest,icons:[
  {src:'icon-192.png?v=final-crest-v7',sizes:'192x192',type:'image/png',purpose:'any'},
  {src:'icon-512.png?v=final-crest-v7',sizes:'512x512',type:'image/png',purpose:'any'},
  {src:'icon-maskable-512.png?v=final-crest-v7',sizes:'512x512',type:'image/png',purpose:'maskable'}
]};
async function checkLauncher(){
  const {icons,...settings}=manifest;
  assert.deepEqual(settings,{name:'ФК «Судак»',short_name:'ФК Судак',start_url:'.',scope:'.',display:'standalone',background_color:'#001329',theme_color:'#001329',lang:'ru',description:'ФК «Судак» — результаты, календарь, состав и новости'});
  assert.equal(digest(source),'a423ec7fa499ae42bbf6b85e00213bb5034e871e6ae845256e8774b43104673c');
  assert.deepEqual(icons.map(icon=>[icon.sizes,icon.purpose,icon.type]),[['192x192','any','image/png'],['512x512','any','image/png'],['512x512','maskable','image/png']]);
  for(const icon of icons){
    const match=icon.src.match(/^assets\/pwa-launcher\/crest-(any|maskable)-(192|512)-([a-f0-9]{12})\.png$/);
    assert(match,'Launcher must have a new content-addressed URL');
    assert.equal(match[1],icon.purpose);assert.equal(match[2],icon.sizes.split('x')[0]);
    assert.equal(match[3],digest(fs.readFileSync(path.join(root,icon.src))).slice(0,12));
  }
  let legacyMode=true,newManifestReads=0;
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
    const send=body=>{res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.json':'application/json','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(body)};
    if(pathname==='/manifest.json'){
      if(!legacyMode)newManifestReads++;
      send(JSON.stringify(legacyMode?legacy:manifest));return;
    }
    fs.readFile(file,(error,bytes)=>{if(error){res.writeHead(404);res.end();return}send(bytes)});
  });
  let browser,context;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port+'/';
    browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
    context=await browser.newContext({serviceWorkers:'allow'});
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'manifest.json');
    await page.evaluate(async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready});
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await page.evaluate(async({cacheName,legacy})=>{
      const cache=await caches.open(cacheName);
      await cache.put(new URL('manifest.json',location.href),new Response(JSON.stringify(legacy),{headers:{'Content-Type':'application/json'}}));
    },{cacheName,legacy});
    legacyMode=false;
    const actual=await page.evaluate(async()=>await (await fetch('manifest.json')).json());
    assert.deepEqual(actual,manifest);assert(newManifestReads>0,'Existing SW must refresh the old cached manifest');
    const checks=await page.evaluate(async icons=>{
      const decode=async src=>{const im=new Image();im.src=src;await im.decode();return im};
      const original=await decode('assets/home-crest-original.png');
      const results=[];
      for(const icon of icons){
        const size=Number(icon.sizes.split('x')[0]),fit=icon.purpose==='maskable'?.78:.94;
        const image=await decode(icon.src),canvas=document.createElement('canvas');canvas.width=canvas.height=size;
        const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
        const actual=ctx.getImageData(0,0,size,size).data;
        let opaque=true,radius=0;
        for(let y=0;y<size;y++)for(let x=0;x<size;x++){
          const i=(y*size+x)*4,r=actual[i],g=actual[i+1],b=actual[i+2];
          if(actual[i+3]!==255)opaque=false;
          if((r>180&&g>140&&b<150)||(r>175&&g>175&&b>175))radius=Math.max(radius,Math.hypot(x-size/2,y-size/2));
        }
        const ratio=Math.min(size/original.width,size/original.height)*fit;
        const width=Math.round(original.width*ratio),height=Math.round(original.height*ratio);
        ctx.fillStyle='#001329';ctx.fillRect(0,0,size,size);ctx.imageSmoothingQuality='high';
        ctx.drawImage(original,Math.round((size-width)/2),Math.round((size-height)/2),width,height);
        const expected=ctx.getImageData(0,0,size,size).data;
        let difference=0;for(let i=0;i<expected.length;i++)difference=Math.max(difference,Math.abs(expected[i]-actual[i]));
        results.push({src:icon.src,purpose:icon.purpose,size,width:image.naturalWidth,height:image.naturalHeight,opaque,radius,difference});
      }
      return results;
    },icons);
    for(const result of checks){
      assert.equal(result.width,result.size);assert.equal(result.height,result.size);assert(result.opaque);
      assert.equal(result.difference,0,'Preserve every pixel of the complete original, fitted proportionally: '+result.src);
      if(result.purpose==='maskable'){
        assert(result.radius<result.size*.4,'Shield, lettering and frog must fit the safe circle');
      }
    }
    console.log('PASS launcher: exact supplied crest, 192/512 PNG, no cropping/redrawing, opaque maskable and 40% safe radius');
    for(const icon of icons){
      const bytes=await page.evaluate(async src=>Array.from(new Uint8Array(await (await fetch(src)).arrayBuffer())),icon.src);
      assert.deepEqual(Buffer.from(bytes),fs.readFileSync(path.join(root,icon.src)));
    }
    await page.waitForFunction(async({cacheName,icons})=>{
      const cache=await caches.open(cacheName);return (await Promise.all(icons.map(icon=>cache.match(new URL(icon.src,location.href))))).every(Boolean);
    },{cacheName,icons});
    await context.setOffline(true);
    assert.deepEqual(await page.evaluate(async()=>await (await fetch('manifest.json')).json()),manifest);
    for(const icon of icons){
      const bytes=await page.evaluate(async src=>Array.from(new Uint8Array(await (await fetch(src)).arrayBuffer())),icon.src);
      assert.deepEqual(Buffer.from(bytes),fs.readFileSync(path.join(root,icon.src)));
    }
    assert.deepEqual(errors,[]);
    console.log('PASS unchanged SW: old cached manifest updates to new icon URLs; all exact PNGs available offline; installation settings unchanged');
  }finally{
    if(context)await context.close();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  }
}
module.exports=checkLauncher;
if(require.main===module)checkLauncher().catch(error=>{console.error(error);process.exitCode=1});
