/* Count production DOM writes and compare opened sections on identical data.
 * PERF_BASE_HTML=/path/to/main.html node tests/deferred-tab-rendering-benchmark.cjs
 */
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {setup,data,bundle,keys,rfkUpdate}=require('./data-refresh-harness.cjs');

const tabs=['home','matches','table','squad','news'];
const details={
  player:'#player=rffk-202',
  team:'#team=936',
  match:'#match=rffk-38771&from=table',
};
const fixedTime='2026-11-18T12:00:00+03:00';
const saved=()=>({[keys.data]:JSON.stringify(data()),[keys.cfu]:JSON.stringify(bundle())});
function prepare(options){
  const ui=setup(options);
  ui.run(`Date.now=()=>Date.parse('${fixedTime}')`);
  return ui;
}
function start(options={}){
  const ui=prepare(options);
  ui.boot();
  return ui;
}
function open(ui,hash){
  ui.context.location.hash=hash;
  ui.run('applyRoute()');
}
function markup(ui,section){
  const root=ui.node(section);
  return section==='home'?root.children.map(block=>block.innerHTML).join('\n'):root.innerHTML;
}

async function measure(html){
  const rows=[],screens={},stored=saved();
  const record=(scenario,ui)=>{
    const writes=ui.domWrites;
    rows.push({scenario,sections:[...new Set(writes.map(id=>id.split(':')[0]))].length,
      roots:writes.filter(id=>!id.startsWith('home:')).length,
      homeBlocks:writes.filter(id=>id.startsWith('home:')).length});
    ui.reset();
  };
  record('Cold / no hash',start({html}));
  const app=start({html,stored});
  record('Saved / no hash',app);
  for(const section of [...tabs.slice(1),'home']){
    open(app,'#'+section);screens[section]=markup(app,section);
  }
  record('First tour of five tabs',app);
  for(const section of [...tabs.slice(1),'home'])open(app,'#'+section);
  record('Second tour of five tabs',app);
  app.respond(rfkUpdate());await app.run('refreshData(true)');
  record('New RFK data while on home',app);
  open(app,'#matches');screens.updatedMatches=markup(app,'matches');record('Open matches after update',app);
  app.respond(data());await app.run('refreshData(true)');
  record('Stale RFK reply on matches',app);

  for(const [section,hash] of Object.entries(details)){
    record('Cold / '+section,start({html,hash}));
    const direct=start({html,hash,stored});
    record('Saved / '+section,direct);
    screens[section]=markup(direct,section);
  }
  const cfu=start({html,stored,hash:'#table',competition:'cfu'});
  screens.cfu=markup(cfu,'table');
  return {rows,screens};
}

function timeColdBoot(baseline){
  const files=[['current',undefined],...(baseline?[['base',baseline]]:[])];
  const samples=Object.fromEntries(files.map(([name])=>[name,[]]));
  for(let i=0;i<25;i++){
    for(const [name,html] of i%2?[...files].reverse():files){
      const ui=prepare({html});
      const start=performance.now();
      ui.boot();
      if(i>=5)samples[name].push(performance.now()-start);
    }
  }
  return Object.fromEntries(Object.entries(samples).map(([name,values])=>{
    const sorted=values.sort((a,b)=>a-b),half=sorted.length/2;
    return [name,((sorted[half-1]+sorted[half])/2).toFixed(2)];
  }));
}

module.exports={tabs,details,saved,start,open,markup};
if(require.main===module)(async()=>{
  const current=await measure();
  const baseline=process.env.PERF_BASE_HTML&&await measure(process.env.PERF_BASE_HTML);
  if(baseline)assert.deepEqual(current.screens,baseline.screens);
  console.table(current.rows.map((row,i)=>{
    if(!baseline)return row;
    const before=baseline.rows[i];
    return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,
      key==='scenario'?value:`${before[key]} → ${value}`]));
  }));
  if(baseline)console.log('Rendered HTML matches the baseline for all five tabs, both competitions, the three detail routes and the updated matches.');
  console.log('Cold synchronous boot median in Node VM (ms, 20 samples):',timeColdBoot(process.env.PERF_BASE_HTML));
})().catch(error=>{console.error(error);process.exitCode=1});
