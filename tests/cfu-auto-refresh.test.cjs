/* Atomic Pages revisions, stale CDN, validated offline storage and SW policy. */
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const script=fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const bundle=()=>({schemaVersion:1,calendar:read('cfu-premier-2026.json'),details:read('cfu-premier-match-details-2026.json'),
  sync:{lastAttemptAt:'2026-11-11T21:00:00Z',lastSlot:'2026-11-11T23:00:00+03:00',lastSuccessAt:read('cfu-premier-2026.json').sourceMetadata.retrievedAt,pending:[],error:null}});
const clone=value=>JSON.parse(JSON.stringify(value));
function setup(stored={}){
  const values={...stored},nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){},querySelector(){return null},querySelectorAll(){return []}});return nodes.get(id)};
  const context=vm.createContext({URL,URLSearchParams,Intl,console,AbortController,setTimeout,clearTimeout,
    location:{hash:''},history:{state:{},scrollRestoration:'auto'},
    document:{baseURI:'https://example.test/fk-sudak/',title:'',getElementById:node},
    window:{addEventListener(){},scrollY:0,scrollTo(){}},
    localStorage:{getItem:key=>values[key]??null,setItem:(key,value)=>{values[key]=value}},
    fetch:async()=>{throw Error('offline')},
  });
  vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
  return {context,values,run:code=>vm.runInContext(code,context)};
}

test('new atomic publication updates calendar, table, status and events together',async()=>{
  const ui=setup(),value=bundle(),requests=[];
  ui.context.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>clone(value)}};
  await ui.run('loadCfuPremier()');
  assert.equal(ui.run("cfuMatch('cfu:match:18767').homeScore"),2);
  assert.equal(ui.run("cfuMatchDetail('cfu:match:18767').status"),'finished');
  assert.equal(ui.run('CFU_PREMIER.standings.asOfRound'),25);
  assert.equal(ui.run("cfuMatchDetail('cfu:match:18767').goals.length"),2);
  assert.equal(requests.length,1);
  assert.match(requests[0].url,/cfu-sync-2026\.json\?v=/);
  assert.equal(requests[0].options.cache,'no-store');
  assert.deepEqual(JSON.parse(ui.values['sudak-cfu-sync-v1']),value);
  assert.match(ui.run('cfuStatusNote()'),/Данные КФС проверены:/);
});

test('stale CDN or an invalid mixed revision cannot roll back a confirmed result',async()=>{
  const ui=setup(),value=bundle();
  ui.run(`adoptCfuBundle(${JSON.stringify(value)})`);
  for(const mutate of [
    old=>{old.sync.lastAttemptAt='2026-11-11T19:00:00Z'},
    old=>{old.calendar.matchesById['cfu:match:18767'].homeScore=0},
    old=>{old.details.matchesById['cfu:match:18767'].awayTeamId='cfu:team:fc-okean'},
    old=>{delete old.details.matchesById['cfu:match:18767']},
  ]){
    const stale=clone(value);mutate(stale);
    ui.context.fetch=async()=>({ok:true,json:async()=>stale});
    await ui.run('loadCfuPremier()');
    assert.equal(ui.run("cfuMatch('cfu:match:18767').homeScore"),2);
    assert.deepEqual(JSON.parse(ui.values['sudak-cfu-sync-v1']),value);
    assert.match(ui.run('CFU_ERROR'),/Не удалось получить свежие/);
  }
});

test('offline storage survives failed load and reconnection adopts a later revision',async()=>{
  const value=bundle(),ui=setup({'sudak-cfu-sync-v1':JSON.stringify(value)});
  assert.equal(ui.run("cfuMatch('cfu:match:18767').homeScore"),2);
  await ui.run('loadCfuPremier()');
  assert.equal(ui.run("cfuMatchDetail('cfu:match:18767').status"),'finished');
  assert.match(ui.run('cfuStatusNote()'),/Не удалось получить свежие/);
  const newer=clone(value);newer.sync.lastAttemptAt='2026-11-12T06:00:00Z';
  ui.context.fetch=async()=>({ok:true,json:async()=>newer});
  await ui.run('loadCfuPremier()');
  assert.equal(ui.run('CFU_ERROR'),'');
  assert.deepEqual(JSON.parse(ui.values['sudak-cfu-sync-v1']),newer);
});

test('source conflicts and pending confirmation remain visible without invented LIVE',()=>{
  const ui=setup(),value=bundle();value.sync.error='Score differs from calendar';
  ui.run(`adoptCfuBundle(${JSON.stringify(value)})`);
  assert.match(ui.run('cfuStatusNote()'),/конфликт/);
  assert(!ui.run('cfuStatusNote()').includes('LIVE'));
  value.sync.error=null;value.sync.pending=['cfu:match:18767'];
  ui.run(`adoptCfuBundle(${JSON.stringify(value)})`);
  assert.match(ui.run('cfuStatusNote()'),/Ожидается официальное подтверждение/);
});

test('a snapshot captured during the matchday becomes stale after the next morning',()=>{
  const ui=setup(),value=bundle();
  value.calendar.sourceMetadata.retrievedAt='2026-11-11T12:00:00Z';
  value.sync.lastSuccessAt='2026-11-11T12:00:00Z';
  ui.run(`adoptCfuBundle(${JSON.stringify(value)});Date.now=()=>Date.parse('2026-11-12T09:01:00+03:00')`);
  assert.match(ui.run('cfuStatusNote()'),/могли устареть/);
});

test('a postponed fixture can advance to a verified played result',()=>{
  const ui=setup(),postponed=bundle(),key='cfu:match:18767';
  Object.assign(postponed.calendar.matchesById[key],{homeScore:0,awayScore:0,status:'postponed',statusLabel:'Матч перенесен'});
  Object.assign(postponed.details.matchesById[key],{homeScore:0,awayScore:0,status:'postponed',statusLabel:'Матч перенесен',goals:[],events:[],goalsComplete:false});
  ui.run(`adoptCfuBundle(${JSON.stringify(postponed)});adoptCfuBundle(${JSON.stringify(bundle())})`);
  assert.equal(ui.run("cfuMatch('cfu:match:18767').status"),'finished');
  assert.equal(ui.run("cfuMatch('cfu:match:18767').homeScore"),2);
});

test('calendar cards use the already verified protocol status for older fixtures',()=>{
  const ui=setup();ui.run(`adoptCfuBundle(${JSON.stringify(bundle())})`);
  const markup=ui.run("cfuMatchHTML(cfuMatch('cfu:match:18763'))");
  assert.match(markup,/Матч завершен/);
  assert(!markup.includes('Предварительный счёт'));
});

test('service worker always passes dynamic results to the network including versioned URLs',()=>{
  const listeners={};
  const context=vm.createContext({URL,self:{location:{origin:'https://example.test'},addEventListener:(name,fn)=>{listeners[name]=fn}}});
  vm.runInContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'),context);
  for(const name of ['data.json','cfu-sync-2026.json','cfu-premier-2026.json','cfu-premier-match-details-2026.json']){
    let intercepted=false;
    listeners.fetch({request:{method:'GET',url:'https://example.test/fk-sudak/'+name+'?v=123'},respondWith(){intercepted=true}});
    assert.equal(intercepted,false,name);
  }
});
