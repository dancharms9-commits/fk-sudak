/* Run every existing browser entrypoint, preserving diagnostics outside docs. */
const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.env.TYPOGRAPHY_CHECK_DIR||path.join(root,'_state/typography-refresh/checks'));fs.mkdirSync(out,{recursive:true});
const baseHTML=process.env.MULTI_CLUB_BASELINE_HTML||path.join(root,'_state/typography-refresh/base.html');
if(!fs.existsSync(baseHTML)){
 if(process.env.MULTI_CLUB_BASELINE_HTML)throw Error('Baseline HTML does not exist');
 fs.mkdirSync(path.dirname(baseHTML),{recursive:true});fs.writeFileSync(baseHTML,execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'show','main:index.html'],{cwd:root}));
}
const site=process.env.PAGES_SITE_ROOT||path.join(root,'_state/typography-refresh/site-final');
if(!fs.existsSync(site)){
 if(process.env.PAGES_SITE_ROOT)throw Error('Pages artifact does not exist');
 execFileSync(process.env.PYTHON_EXECUTABLE||'python',['-c',"from scripts.build_pages import ROOT,decode_json,stage_site; stage_site(ROOT,ROOT/'_state/typography-refresh/site-final',decode_json((ROOT/'data.json').read_bytes()))"],{cwd:root});
}
const available=fs.readdirSync(path.join(root,'tests')).filter(n=>(n.endsWith('.browser.cjs')||n==='browser.cjs')&&!n.startsWith('typography-')).sort();
const files=process.argv.length>2?process.argv.slice(2):available;
if(files.some(f=>!available.includes(f)))throw Error('Unknown browser entrypoint');
const results=[];
async function run(file){
 const dir=path.join(out,file);fs.mkdirSync(dir,{recursive:true});const log=fs.openSync(path.join(dir,'output.log'),'w');
 const env={...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'safe.directory',GIT_CONFIG_VALUE_0:root.replaceAll('\\','/'),MULTI_CLUB_BASELINE_HTML:baseHTML,ROSTER_BASELINE_DATA:path.join(root,'data.json'),PAGES_SITE_ROOT:site};
 for(const key of ['VISUAL_SCREENSHOT_DIR','DESIGN_SCREENSHOT_DIR','DESIGN_PRESERVATION_DIR','CLUBS_SCREENSHOT_DIR','CLUB_SCREENSHOT_DIR','ROSTER_SCREENSHOT_DIR','MATCH_SCREENSHOT_DIR'])env[key]=dir;
 const start=Date.now(),child=spawn(process.execPath,['tests/'+file],{cwd:root,env,stdio:['ignore',log,log]});
 const code=await new Promise(resolve=>child.once('exit',resolve));fs.closeSync(log);results.push({file,code,seconds:Math.round((Date.now()-start)/1000)});console.log(`${code===0?'PASS':'FAIL'} ${file} (${results.at(-1).seconds}s)`);
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
}
(async()=>{const queue=[...files];await Promise.all([1,2].map(async()=>{while(queue.length)await run(queue.shift())}));if(results.some(r=>r.code!==0))process.exitCode=1;console.log(`${results.filter(r=>r.code===0).length}/${files.length} browser entrypoints passed`);})();
