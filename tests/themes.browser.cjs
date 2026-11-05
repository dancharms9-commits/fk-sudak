/* Theme persistence, actual first frames, unchanged screen state and local SVGs. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const root=path.resolve(__dirname,'..'),screenshots=process.env.VISUAL_SCREENSHOT_DIR;
const server=http.createServer((req,res)=>{
  const relative=new URL(req.url,'http://localhost').pathname.replace(/^\/fk-sudak(?=\/)/,'');
  const file=path.join(root,relative==='/'?'index.html':relative);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);res.end();return}
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.json':'application/json','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream');res.end(data);
  });
});
const launch=process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{};
const settle=page=>page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame)});
const ready=async page=>{await page.waitForFunction(()=>document.querySelector('#upd').textContent.startsWith('Данные обновлены'));await page.locator('#launch-splash').waitFor({state:'detached'});await settle(page)};
const theme=page=>page.getAttribute('html','data-theme');
const choose=async(page,value)=>{if(await theme(page)!==value)await page.locator('#theme-toggle').click();await settle(page);assert.equal(await theme(page),value)};
function contrast(a,b){
  const luminance=color=>{const rgb=color.trim().slice(1).match(/../g).slice(0,3).map(hex=>parseInt(hex,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
  const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
async function checkThemes(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/fk-sudak/';
  let browser,profileContext;
  const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'sudak-themes-'));
  const errors=[];
  try{
    browser=await chromium.launch(launch);
    const context=await browser.newContext({serviceWorkers:'block',colorScheme:'light',viewport:{width:390,height:844}});
    await context.route('https://rffk-roo.ru/uploads/people/**',route=>route.abort());
    await context.addInitScript(()=>{
      window.themeFrames=[];
      const sample=()=>{if(document.querySelector('main'))window.themeFrames.push(document.documentElement.dataset.theme);if(window.themeFrames.length<12)requestAnimationFrame(sample)};
      requestAnimationFrame(sample);
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await ready(page);assert.equal(await theme(page),'dark');
    assert((await page.evaluate(()=>window.themeFrames)).every(value=>value==='dark'));
    assert.deepEqual(await page.locator('#nav button').allTextContents(),['Главная','Матчи','Чемпионат','Состав','Новости']);
    assert.equal(await page.locator('#nav button svg').count(),5);
    const capture=async(name,width,value)=>{
      await settle(page);
      const layout=await page.evaluate(()=>{
        const toggle=document.querySelector('#theme-toggle').getBoundingClientRect();
        const overlap=[...document.querySelectorAll('header .crest,header h1,header p')].some(el=>{
          const r=el.getBoundingClientRect();return Math.min(r.right,toggle.right)>Math.max(r.left,toggle.left)&&Math.min(r.bottom,toggle.bottom)>Math.max(r.top,toggle.top);
        });
        const css=getComputedStyle(document.documentElement),token=name=>css.getPropertyValue(name).trim();
        return {width:innerWidth,scroll:document.documentElement.scrollWidth,overlap,ink:token('--ink'),mute:token('--mute'),card:token('--card'),link:token('--sea'),navInk:token('--nav-ink'),navTop:token('--nav-top'),active:token('--nav-active'),selected:token('--nav-selected')};
      });
      assert.equal(layout.width,layout.scroll,name);assert(!layout.overlap,'Theme control overlaps branding: '+name);
      for(const [foreground,background] of [['ink','card'],['mute','card'],['link','card'],['navInk','navTop'],['active','selected']])assert(contrast(layout[foreground],layout[background])>=4.5,`Low contrast: ${name} ${foreground}`);
      if(screenshots){fs.mkdirSync(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,`${name}-${width}-${value}.png`)});}
    };
    for(const width of [320,390,768,1440])for(const value of ['dark','light']){
      await page.setViewportSize({width,height:844});await choose(page,value);
      for(const tab of ['home','matches','table','squad','news']){
        await page.locator(`#nav [data-t="${tab}"] svg`).click();await page.locator(`#${tab}.on`).waitFor();await settle(page);
        assert.equal(await theme(page),value);await page.evaluate(()=>scrollTo(0,0));await capture(tab,width,value);
        if(tab==='home'){
          const crest=await page.locator('header .crest').boundingBox(),before=Math.min(221,Math.max(130,width*.406));
          assert(Math.abs(crest.width-before*.8)<.1);assert(Math.abs(crest.width/crest.height-.75)<.001);
        }
        if(tab==='matches'){
          await page.locator('#matches .result-link').first().click();await page.locator('#match.on').waitFor();
          const hash=await page.evaluate(()=>location.hash);await choose(page,value==='dark'?'light':'dark');
          assert.equal(await page.evaluate(()=>location.hash),hash);await choose(page,value);await page.evaluate(()=>scrollTo(0,0));await capture('match-detail',width,value);
        }
        if(tab==='table'){
          for(const view of ['standings','calendar','scorers']){
            await page.locator(`[data-champ-view="${view}"]`).click();await capture('championship-'+view,width,value);
          }
          await page.locator('#champ-search').fill('Донской');
          const row=page.locator('.champ-scorer').first(),text=await row.textContent();
          await choose(page,value==='dark'?'light':'dark');assert.equal(await page.locator('#champ-search').inputValue(),'Донской');assert.equal(await row.textContent(),text);
          await choose(page,value);await page.locator('#champ-search').fill('');
        }
        if(tab==='squad'){
          await page.locator('#squad a[data-player]').first().click();await page.locator('#player.on').waitFor();
          const hash=await page.evaluate(()=>location.hash),name=await page.locator('#player-title').innerText();
          await choose(page,value==='dark'?'light':'dark');assert.equal(await page.evaluate(()=>location.hash),hash);assert.equal(await page.locator('#player-title').innerText(),name);
          await choose(page,value);await page.evaluate(()=>scrollTo(0,0));await capture('player-profile',width,value);
        }
      }
      console.log(`PASS ${width}px ${value}: five tabs, SVG hits, all championship panels, profile/protocol, contrast, crest at 80%, no overflow/overlap`);
    }
    await choose(page,'light');await page.reload();await ready(page);assert.equal(await theme(page),'light');
    assert((await page.evaluate(()=>window.themeFrames)).every(value=>value==='light'));
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'),'true');
    await page.close();const reopened=await context.newPage();await reopened.goto(base+'#squad');await ready(reopened);assert.equal(await theme(reopened),'light');
    await context.close();await browser.close();browser=null;
    // A real browser-process restart with the same profile must retain the choice.
    profileContext=await chromium.launchPersistentContext(profileDir,{...launch,viewport:{width:390,height:844},colorScheme:'dark'});
    let persistent=profileContext.pages()[0];persistent.on('pageerror',error=>errors.push(error.message));
    await persistent.goto(base);await ready(persistent);await choose(persistent,'light');
    await persistent.evaluate(async()=>{await navigator.serviceWorker.ready});await persistent.reload();await ready(persistent);
    await persistent.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await profileContext.close();profileContext=null;
    profileContext=await chromium.launchPersistentContext(profileDir,{...launch,viewport:{width:390,height:844},colorScheme:'dark'});
    await profileContext.setOffline(true);persistent=profileContext.pages()[0];persistent.on('pageerror',error=>errors.push(error.message));
    await persistent.goto(base);await persistent.locator('#launch-splash').waitFor({state:'detached'});assert.equal(await theme(persistent),'light');
    assert.equal(await persistent.locator('#nav svg').count(),5);
    for(const tab of ['home','matches','table','squad','news']){await persistent.locator(`#nav [data-t="${tab}"]`).click();await persistent.locator(`#${tab}.on`).waitFor();assert.equal(await theme(persistent),'light');}
    await choose(persistent,'dark');await persistent.reload();assert.equal(await theme(persistent),'dark');
    await persistent.locator('#launch-splash').waitFor({state:'detached'});assert.deepEqual(errors,[]);
    console.log('PASS theme before first frame, reload/new window/browser restart, real SW offline tabs/icons/theme switching; zero JavaScript errors');
  }finally{
    if(profileContext)await profileContext.close();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(path.resolve(profileDir)),path.resolve(os.tmpdir()));fs.rmSync(profileDir,{recursive:true,force:true});
  }
}
module.exports=checkThemes;
if(require.main===module)checkThemes().catch(error=>{console.error(error);process.exitCode=1});
