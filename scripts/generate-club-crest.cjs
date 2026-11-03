/* Rebuild icons from the approved, unmodified PNG; never crop or redraw it.
 * Uses the same Playwright installation as tests/browser.cjs.
 * Run: node scripts/generate-club-crest.cjs
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
(async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{});
  try{
    const page=await browser.newPage();
    const source=fs.readFileSync(path.join(root,'assets/club-crest-final-original.png'));
    const icons=await page.evaluate(async base64=>{
      const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
      return [
        ['192',192,.94],['512',512,.94],['maskable-512',512,.63],
        ['favicon',32,.94],['apple-touch-icon',180,.94],
      ].map(([name,size,scale])=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#001329';ctx.fillRect(0,0,size,size);
        const ratio=Math.min(size/image.width,size/image.height)*scale;
        const width=Math.round(image.width*ratio),height=Math.round(image.height*ratio);
        ctx.imageSmoothingQuality='high';
        ctx.drawImage(image,Math.round((size-width)/2),Math.round((size-height)/2),width,height);
        return {name,png:canvas.toDataURL('image/png').split(',')[1]};
      });
    },source.toString('base64'));
    for(const {name,png} of icons){
      const bytes=Buffer.from(png,'base64');
      const names=['favicon','apple-touch-icon'].includes(name)
        ? [name+'.png'] : ['icon-'+name+'.png','fk-sudak-pwa-'+name+'.png'];
      for(const filename of names)fs.writeFileSync(path.join(root,filename),bytes);
    }
    console.log('Generated 192px, 512px, maskable 512px, favicon 32px and Apple Touch Icon 180px from the complete approved PNG.');
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
