/* Production functions in a small DOM/storage harness; no network or dependencies.
 * Reproduce operation counts: node tests/data-refresh-harness.cjs
 * Compare another revision: PERF_HTML=/path/to/base.html node tests/data-refresh-harness.cjs
 */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const clone=value=>structuredClone(value);
const data=()=>read('data.json');
const bundle=()=>({schemaVersion:1,calendar:read('cfu-premier-2026.json'),details:read('cfu-premier-match-details-2026.json'),
  sync:{lastAttemptAt:'2026-11-11T21:00:00Z',lastSlot:'2026-11-11T23:00:00+03:00',lastSuccessAt:read('cfu-premier-2026.json').sourceMetadata.retrievedAt,pending:[],error:null}});
const keys={data:'sudak-data-v1',cfu:'sudak-cfu-sync-v1'};
function setup({stored={},hash='',competition='rfk',html=process.env.PERF_HTML||path.join(root,'index.html')}={}){
  const source=fs.readFileSync(html,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const values={...stored},nodes=new Map(),requests=[],listeners={window:{},document:{}},intervals=[];
  const counts={stringify:0,snapshotStringify:0,writes:0,render:0,cfuTableRender:0};
  function element(id=''){
    let markup='',parts=new Map();
    return {id,dataset:{},children:[],textContent:'',hidden:false,
      get innerHTML(){return markup},
      set innerHTML(value){
        markup=value;parts=new Map();
        if(id==='table'&&value.includes('cfu-table'))counts.cfuTableRender++;
        // Only the three small note targets need querying in these tests.
        for(const attr of ['data-cfu-status','data-cfu-table-checked','data-cfu-protocol-checked']){
          const match=value.match(new RegExp('<(div|span) '+attr+'>([\\s\\S]*?)</\\1>'));
          if(match){const part=element();part.innerHTML=match[2];part.textContent=match[2];parts.set('['+attr+']',part)}
        }
      },
      addEventListener(){},append(child){this.children.push(child)},
      querySelector(selector){
        const home=selector.match(/^\[data-home-block="(.*)"\]$/);
        return home?this.children.find(child=>child.dataset.homeBlock===home[1])||null:parts.get(selector)||null;
      },
      querySelectorAll(selector){const found=this.querySelector(selector);return found?[found]:[]},
    };
  }
  const node=id=>{if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id)};
  const context=vm.createContext({URL,URLSearchParams,Intl,console,AbortController,setTimeout,clearTimeout,counts,
    setInterval:(fn,ms)=>{intervals.push({fn,ms})},
    location:{hash},history:{state:{},scrollRestoration:'auto'},
    document:{baseURI:'https://example.test/fk-sudak/',title:'',readyState:'loading',hidden:false,
      getElementById:node,createElement:()=>element(),addEventListener:(name,fn)=>{listeners.document[name]=fn}},
    window:{addEventListener:(name,fn)=>{listeners.window[name]=fn},scrollY:123,scrollTo(){}},
    localStorage:{getItem:key=>key==='sudak-competition-v1'?competition:values[key]??null,
      setItem:(key,value)=>{counts.writes++;values[key]=value}},
    fetch:async()=>{throw Error('offline')},
  });
  const run=code=>vm.runInContext(code,context);
  run(`const nativeStringify=JSON.stringify;JSON.stringify=function(value,...args){
    counts.stringify++;if(value&&(value.updated&&value.table||value.calendar&&value.details))counts.snapshotStringify++;
    return nativeStringify(value,...args);
  }`);
  run(source.slice(0,source.lastIndexOf('\nrestoreSavedData();')));
  run('const originalRender=render;render=function(){counts.render++;return originalRender()}');
  // Install exactly the production polling/foreground/reconnection handlers.
  run(source.slice(source.indexOf('function refreshFootball('),source.indexOf('if("serviceWorker" in navigator)')));
  const reset=()=>{for(const key of Object.keys(counts))counts[key]=0};
  const respond=(rffk,cfu)=>{context.fetch=async(url,options)=>{
    requests.push({url,options});
    const value=new URL(url).pathname.endsWith('/data.json')?rffk:cfu;
    if(value instanceof Error||!value)throw value||Error('offline');
    return {ok:true,json:async()=>clone(value)};
  }};
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));
    if(run('loadingData||CFU_LOADING'))throw Error('request did not settle')};
  return {context,run,node,values,counts,reset,respond,requests,listeners,intervals,settle};
}
function rfkUpdate(){const next=data();next.updated=new Date(Date.parse(next.updated)+60000).toISOString();next.res[0][2]++;return next}
function provisional(){const value=bundle(),key='cfu:match:18767';
  Object.assign(value.calendar.matchesById[key],{homeScore:0,awayScore:0,status:null,statusLabel:null});
  delete value.details.matchesById[key];delete value.details.sourceMetadata.sources[key];value.sync.pending=[key];return value;
}
async function report(){
  const rows=[];
  async function measure(scenario,options,prepare,action){const ui=setup(options);await prepare(ui);ui.reset();await action(ui);rows.push({scenario,...ui.counts})}
  await measure('RFK first launch + 3 equal replies',{},()=>{},async ui=>{ui.run('restoreSavedData();render()');ui.respond(data());for(let i=0;i<3;i++)await ui.run('refreshData(true)')});
  await measure('RFK restored + 3 equal replies',{stored:{[keys.data]:JSON.stringify(data())}},ui=>ui.run('restoreSavedData();render()'),async ui=>{ui.respond(data());for(let i=0;i<3;i++)await ui.run('refreshData(true)')});
  await measure('RFK new score',{stored:{[keys.data]:JSON.stringify(data())}},ui=>ui.run('restoreSavedData();render()'),async ui=>{ui.respond(rfkUpdate());await ui.run('refreshData(true)')});
  const cfuOptions={hash:'#table',competition:'cfu',stored:{[keys.cfu]:JSON.stringify(bundle())}};
  rows.push({scenario:'CFU restore only',...setup(cfuOptions).counts});
  await measure('CFU 3 equal replies',cfuOptions,ui=>ui.run('renderChampionship()'),async ui=>{ui.respond(null,bundle());for(let i=0;i<3;i++)await ui.run('loadCfuPremier()')});
  await measure('CFU only lastSuccessAt',cfuOptions,ui=>ui.run('renderChampionship()'),async ui=>{const value=bundle();value.sync.lastSuccessAt='2026-11-11T21:00:00Z';ui.respond(null,value);await ui.run('loadCfuPremier()')});
  await measure('CFU new score',{...cfuOptions,stored:{[keys.cfu]:JSON.stringify(provisional())}},ui=>ui.run('renderChampionship()'),async ui=>{ui.respond(null,bundle());await ui.run('loadCfuPremier()')});
  return rows;
}
module.exports={setup,data,bundle,keys,clone,rfkUpdate,provisional,report};
if(require.main===module)report().then(rows=>console.log(JSON.stringify(rows,null,2))).catch(error=>{console.error(error);process.exitCode=1});
