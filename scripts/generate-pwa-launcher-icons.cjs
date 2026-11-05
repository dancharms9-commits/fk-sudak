/* Launcher only. The source is byte-identical to sudak_B_font2_old_rus.png.
 * Preserve the in-app crest, favicon, installation identity and service worker.
 * Run with the same Playwright/Chromium options as tests/browser.cjs.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'assets/home-crest-original.png'));
assert.equal(createHash('sha256').update(source).digest('hex'),'a423ec7fa499ae42bbf6b85e00213bb5034e871e6ae845256e8774b43104673c','Use the exact user-approved original');
(async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  try{
    const page=await browser.newPage();
    const icons=await page.evaluate(async base64=>{
      const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
      return [[192,'any',.94],[512,'any',.94],[512,'maskable',.78]].map(([size,purpose,fit])=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#001329';ctx.fillRect(0,0,size,size);
        const ratio=Math.min(size/image.width,size/image.height)*fit;
        const width=Math.round(image.width*ratio),height=Math.round(image.height*ratio);
        ctx.imageSmoothingQuality='high';
        ctx.drawImage(image,Math.round((size-width)/2),Math.round((size-height)/2),width,height);
        return {size,purpose,png:canvas.toDataURL('image/png').split(',')[1]};
      });
    },source.toString('base64'));
    const directory=path.join(root,'assets/pwa-launcher');fs.mkdirSync(directory,{recursive:true});
    const manifestPath=path.join(root,'manifest.json');
    const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    manifest.icons=icons.map(({size,purpose,png})=>{
      const bytes=Buffer.from(png,'base64');
      const digest=createHash('sha256').update(bytes).digest('hex').slice(0,12);
      const name=`crest-${purpose}-${size}-${digest}.png`;
      fs.writeFileSync(path.join(directory,name),bytes);
      return {src:'assets/pwa-launcher/'+name,sizes:`${size}x${size}`,type:'image/png',purpose};
    });
    fs.writeFileSync(manifestPath,JSON.stringify(manifest)+'\n');
    console.log('Created full-crest 192/512 any and safe-circle 512 maskable icons. Only manifest.icons updated.');
    for(const icon of manifest.icons)console.log(icon.src);
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
