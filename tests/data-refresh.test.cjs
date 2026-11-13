/* Count actual production serialization, storage and DOM replacement calls. */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {setup,data,bundle,keys,clone,rfkUpdate,provisional}=require('./data-refresh-harness.cjs');
const cfuKey='cfu:match:18767';
const savedRfk=()=>({stored:{[keys.data]:JSON.stringify(data())}});
const savedCfu=value=>({hash:'#table',competition:'cfu',stored:{[keys.cfu]:JSON.stringify(value||bundle())}});
const noWork=ui=>assert.deepEqual(ui.counts,{stringify:0,snapshotStringify:0,writes:0,render:0,cfuTableRender:0});

test('first launch renders fallback, then adopts and renders the first RFK response',async()=>{
  const ui=setup();ui.run('restoreSavedData();render()');
  assert.match(ui.node('matches').innerHTML,/Результаты/);assert.equal(ui.counts.render,1);
  ui.reset();ui.respond(data());await ui.run('refreshData(true)');
  assert.equal(ui.counts.stringify,1);assert.equal(ui.counts.writes,1);assert.equal(ui.counts.render,1);
  assert.deepEqual(JSON.parse(ui.values[keys.data]),data());
  assert.match(ui.node('squad').innerHTML,/Донской Илья/);
  assert.equal(ui.run('hasNetworkData'),true);
});

test('restored RFK is rendered initially; repeated equal revisions do no JSON/storage/render work',async()=>{
  const ui=setup(savedRfk());ui.run('restoreSavedData();render()');
  assert.equal(ui.run('hasSavedData'),true);assert.match(ui.node('squad').innerHTML,/Донской Илья/);
  ui.reset();ui.respond(data());
  for(let i=0;i<4;i++)await ui.run('refreshData(true)');
  noWork(ui);assert.equal(ui.requests.length,4);assert.equal(ui.node('retry-data').hidden,true);
  assert(!ui.node('upd').textContent.includes('проверяем'));
});

test('repeated RFK replies after a first network load also do no work',async()=>{
  const ui=setup();ui.respond(data());await ui.run('refreshData(true)');ui.reset();
  for(let i=0;i<3;i++)await ui.run('refreshData(true)');noWork(ui);
});

test('new RFK results render and persist once, stale CDN cannot roll them back',async()=>{
  const ui=setup(savedRfk()),next=rfkUpdate();ui.run('restoreSavedData();render()');ui.reset();
  ui.respond(next);await ui.run('refreshData(true)');
  assert.equal(ui.counts.stringify,1);assert.equal(ui.counts.writes,1);assert.equal(ui.counts.render,1);
  assert.equal(ui.run('RES[0][2]'),next.res[0][2]);
  ui.reset();ui.respond(data());await ui.run('refreshData(true)');noWork(ui);
  assert.deepEqual(JSON.parse(ui.values[keys.data]),next);
});

for(const [label,mutate,expression,expected] of [
  ['squad',d=>{d.squad.Вратари[0].name+=' updated'},'SQUAD.Вратари[0].name',d=>d.squad.Вратари[0].name],
  ['table',d=>{d.table[0][3]++},'TABLE[0][3]',d=>d.table[0][3]],
  ['events',d=>{Object.values(d.match_details)[0].events.push({type:'yellow',player:'Test',side:'home',minute:'1'})},'Object.values(MATCH_DETAILS)[0].events.length',d=>Object.values(d.match_details)[0].events.length],
  ['platform roster',d=>{Object.values(d.platform.rosters)[0].checkedAt='2026-11-13T12:00:00Z'},'Object.values(PLATFORM.rosters)[0].checkedAt',()=> '2026-11-13T12:00:00Z'],
])test(`new RFK revision adopts ${label}`,async()=>{
  const ui=setup(savedRfk()),next=rfkUpdate();mutate(next);ui.run('restoreSavedData()');ui.reset();
  ui.respond(next);await ui.run('refreshData(true)');assert.equal(ui.counts.render,1);assert.equal(ui.run(expression),expected(next));
});

test('RFK refresh preserves search focus, caret and scroll for a real update',async()=>{
  const ui=setup(savedRfk()),calls=[],active={id:'champ-search',selectionStart:3};
  ui.run('restoreSavedData()');ui.context.document.activeElement=active;
  Object.assign(ui.node(active.id),{type:'search',focus:options=>calls.push(options),setSelectionRange:(a,b)=>calls.push([a,b])});
  ui.context.window.scrollTo=(...args)=>calls.push(args);ui.respond(rfkUpdate());await ui.run('refreshData(true)');
  assert.equal(calls[0].preventScroll,true);assert.deepEqual(calls.slice(1),[[3,3],[0,123]]);
});

test('restoring a CFU bundle never serializes or writes it back; equal replies keep table nodes',async()=>{
  const ui=setup(savedCfu());assert.equal(ui.counts.snapshotStringify,0);assert.equal(ui.counts.writes,0);
  ui.run('renderChampionship()');const note=ui.node('table').querySelector('[data-cfu-status]');ui.reset();
  ui.respond(null,bundle());for(let i=0;i<4;i++)await ui.run('loadCfuPremier()');noWork(ui);
  assert.equal(ui.node('table').querySelector('[data-cfu-status]'),note);
  assert.equal(ui.run('CFU_SAVED'),false);assert.equal(ui.run('CFU_MATCH_DETAILS_SAVED'),false);
});

test('first CFU bundle loads atomically and renders the table once',async()=>{
  const ui=setup({hash:'#table',competition:'cfu'});ui.respond(null,bundle());await ui.run('loadCfuPremier()');
  assert.equal(ui.counts.snapshotStringify,1);assert.equal(ui.counts.writes,1);assert.equal(ui.counts.cfuTableRender,1);
  assert.equal(ui.run(`cfuMatch('${cfuKey}').homeScore`),2);assert.equal(ui.run(`cfuMatchDetail('${cfuKey}').goals.length`),2);
});

test('CFU new score/protocol/table replaces football view once and persists atomically',async()=>{
  const ui=setup(savedCfu(provisional())),next=bundle();next.calendar.standings.asOfRound++;
  ui.run('renderChampionship()');ui.reset();ui.respond(null,next);await ui.run('loadCfuPremier()');
  assert.equal(ui.counts.snapshotStringify,1);assert.equal(ui.counts.writes,1);assert.equal(ui.counts.cfuTableRender,1);
  assert.equal(ui.run(`cfuMatch('${cfuKey}').homeScore`),2);assert.equal(ui.run(`cfuMatchDetail('${cfuKey}').status`),'finished');
  assert.equal(ui.run('CFU_PREMIER.standings.asOfRound'),next.calendar.standings.asOfRound);
  assert.deepEqual(JSON.parse(ui.values[keys.cfu]),next);
});

for(const [label,mutate,warning] of [
  ['lastSuccessAt',v=>{v.sync.lastSuccessAt='2026-11-11T21:00:00Z'},null],
  ['lastAttemptAt',v=>{v.sync.lastAttemptAt='2026-11-12T01:00:00Z'},null],
  ['lastSlot',v=>{v.sync.lastSlot='2026-11-12T00:00:00+03:00'},null],
  ['error',v=>{v.sync.error='Score conflict'},/конфликт/],
  ['pending',v=>{v.sync.pending=[cfuKey]},/Ожидается официальное подтверждение/],
  ['source timestamps and freshness',v=>{
    v.calendar.sourceMetadata.retrievedAt='2026-11-12T02:00:00Z';
    Object.assign(v.calendar.sourceMetadata.sections.table,{checkedAt:'2026-11-12T02:00:00Z',status:'stale'});
    v.details.sourceMetadata.retrievedAt='2026-11-12T02:00:00Z';
    v.details.matchesById[cfuKey].checkedAt='2026-11-12T02:00:00Z';
  },null],
])test(`CFU only ${label}: persist metadata, update small notes, retain table`,async()=>{
  const ui=setup(savedCfu()),next=bundle();ui.run('renderChampionship()');
  const note=ui.node('table').querySelector('[data-cfu-status]');ui.reset();mutate(next);ui.respond(null,next);
  await ui.run('loadCfuPremier()');
  assert.equal(ui.counts.snapshotStringify,1);assert.equal(ui.counts.writes,1);
  assert.equal(ui.counts.render,0);assert.equal(ui.counts.cfuTableRender,0);
  assert.equal(ui.node('table').querySelector('[data-cfu-status]'),note);
  assert.equal(note.innerHTML,ui.run('cfuStatusNote()'));if(warning)assert.match(note.innerHTML,warning);
  assert.deepEqual(JSON.parse(ui.values[keys.cfu]),next);
  if(label==='source timestamps and freshness')assert.equal(ui.node('table').querySelector('[data-cfu-table-checked]').textContent,'12.11.2026');
  ui.reset();await ui.run('loadCfuPremier()');noWork(ui);
});

test('pending and error disappearance remove warnings without table replacement',async()=>{
  for(const field of ['pending','error']){
    const initial=bundle();initial.sync[field]=field==='pending'?[cfuKey]:'Conflict';
    const ui=setup(savedCfu(initial));ui.run('renderChampionship()');ui.reset();ui.respond(null,bundle());
    await ui.run('loadCfuPremier()');assert.equal(ui.counts.writes,1);assert.equal(ui.counts.cfuTableRender,0);
    assert(!ui.node('table').querySelector('[data-cfu-status]').innerHTML.includes('cfu-warning'));
  }
});

test('source metadata updates club and protocol check dates without rebuilding their pages',async()=>{
  for(const hash of ['#team=cfu%3Ateam%3Atavriya','#match=cfu%3Amatch%3A18767']){
    const ui=setup({...savedCfu(),hash});ui.run('renderClub();renderMatch()');
    const root=ui.node(hash.startsWith('#team')?'team':'match'),markup=root.innerHTML,next=bundle();
    next.calendar.sourceMetadata.sections.table.checkedAt='2026-11-12T02:00:00Z';
    next.details.matchesById[cfuKey].checkedAt='2026-11-12T02:00:00Z';ui.reset();ui.respond(null,next);await ui.run('loadCfuPremier()');
    assert.equal(root.innerHTML,markup);assert.equal(ui.counts.writes,1);
    assert.equal(root.querySelector(hash.startsWith('#team')?'[data-cfu-table-checked]':'[data-cfu-protocol-checked]').textContent,'12.11.2026');
  }
});

for(const [label,mutate] of [
  ['calendar',v=>{v.calendar.matchesById['cfu:match:18773'].venue+=' updated'}],
  ['protocol events',v=>{v.details.matchesById[cfuKey].events[0].minute='1';v.details.matchesById[cfuKey].goals[0].minute='1'}],
  ['table',v=>{v.calendar.standings.rows[0].points++}],
  ['status',v=>{v.calendar.matchesById['cfu:match:18773'].statusLabel='Матч назначен'}],
])test(`CFU ${label} changes with equal timestamps still update football UI`,async()=>{
  const ui=setup(savedCfu()),next=bundle();mutate(next);ui.run('renderChampionship()');ui.reset();ui.respond(null,next);
  await ui.run('loadCfuPremier()');assert.equal(ui.counts.cfuTableRender,1);assert.equal(ui.counts.writes,1);
  assert.deepEqual(JSON.parse(ui.values[keys.cfu]),next);
});

test('CFU stale CDN, mixed revisions and lost confirmed results never replace accepted snapshot',async()=>{
  for(const mutate of [
    v=>{v.sync.lastAttemptAt='2026-11-11T19:00:00Z'},
    v=>{v.calendar.matchesById[cfuKey].homeScore++},
    v=>{delete v.details.matchesById[cfuKey]},
    v=>{delete v.calendar.matchesById[cfuKey]},
  ]){
    const ui=setup(savedCfu()),stale=bundle();ui.run('renderChampionship()');ui.reset();mutate(stale);ui.respond(null,stale);
    await ui.run('loadCfuPremier()');assert.equal(ui.counts.writes,0);assert.equal(ui.counts.cfuTableRender,0);
    assert.deepEqual(JSON.parse(ui.values[keys.cfu]),bundle());assert.match(ui.run('CFU_ERROR'),/Не удалось получить свежие/);
    assert.match(ui.node('table').querySelector('[data-cfu-status]').innerHTML,/Не удалось получить свежие/);
  }
});

test('offline -> actual online handler: equal data clears error without large work, new revisions are adopted',async()=>{
  const ui=setup({...savedRfk(),...savedCfu(),stored:{...savedRfk().stored,...savedCfu().stored}});
  ui.run('restoreSavedData();render()');ui.respond(Error('offline'),Error('offline'));
  await ui.run('refreshFootball(true)');await ui.settle();assert.equal(ui.node('retry-data').hidden,false);
  assert.match(ui.node('table').querySelector('[data-cfu-status]').innerHTML,/Не удалось получить свежие/);
  ui.reset();ui.respond(data(),bundle());ui.listeners.window.online();await ui.settle();noWork(ui);
  assert.equal(ui.node('retry-data').hidden,true);assert.equal(ui.run('CFU_ERROR'),'');
  const later=bundle();later.sync.lastAttemptAt='2026-11-12T02:00:00Z';
  ui.respond(rfkUpdate(),later);ui.listeners.window.online();await ui.settle();
  assert.equal(ui.counts.render,1);assert.equal(ui.counts.writes,2);
  assert.equal(ui.run('CFU_BUNDLE.sync.lastAttemptAt'),later.sync.lastAttemptAt);
  for(const {url,options} of ui.requests){assert.match(url,/\?v=/);assert.equal(options.cache,'no-store')}
});

test('foreground and polling handlers retain the 15s gap, five-minute interval and hidden-tab policy',async()=>{
  const ui=setup({...savedRfk(),stored:{...savedRfk().stored,...savedCfu().stored}});ui.run('restoreSavedData()');
  ui.respond(data(),bundle());await ui.run('refreshFootball(true)');await ui.settle();ui.reset();
  ui.listeners.window.focus();ui.listeners.document.visibilitychange();await ui.settle();assert.equal(ui.requests.length,2);
  ui.run('lastAttemptAt-=16000;CFU_LAST_POLL-=16000');ui.context.document.hidden=true;
  const poll=ui.intervals.find(item=>item.ms===5*60*1000);assert(poll);poll.fn();await ui.settle();assert.equal(ui.requests.length,2);
  ui.context.document.hidden=false;await poll.fn();await ui.settle();assert.equal(ui.requests.length,4);noWork(ui);
});

test('CFU JSON equality is independent of object key order but preserves array order and new fields',async()=>{
  const ui=setup(savedCfu()),next=bundle();next.sync=Object.fromEntries(Object.entries(next.sync).reverse());
  ui.reset();ui.respond(null,next);await ui.run('loadCfuPremier()');noWork(ui);
  assert.equal(ui.run('sameJson([1,2],[2,1])'),false);assert.equal(ui.run('sameJson({a:1},{a:1,b:2})'),false);
  assert.equal(ui.run('sameJson([], {})'),false);
});
