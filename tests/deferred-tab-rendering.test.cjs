const {test}=require('node:test');
const assert=require('node:assert/strict');
const {data,bundle,keys,rfkUpdate,provisional}=require('./data-refresh-harness.cjs');
const {tabs,details,saved,start,open,markup}=require('./deferred-tab-rendering-benchmark.cjs');

const homeWrites=['home:intro','home:featured','home:dashboard'];
const tabContent={home:/В центре игры/,matches:/Календарь.*Результаты/,table:/champ-standing/,
  squad:/Донской Илья/,news:/Новости федерации/};
const titles={player:/Донской Илья/,team:/СК «Каштан»/,match:/Центр матча/};

test('real startup without a hash writes only the three home blocks before ready',()=>{
  const ui=start();
  assert.deepEqual(ui.events,[{type:'sudak:ready',section:'home',writes:homeWrites}]);
  assert.match(markup(ui,'home'),tabContent.home);
  for(const tab of tabs.slice(1))assert.equal(markup(ui,tab),'',tab);
});

test('all five tab hashes write only the requested tab before ready',()=>{
  const stored=saved();
  for(const tab of tabs){
    const ui=start({hash:'#'+tab,stored});
    assert.deepEqual(ui.events,[{type:'sudak:ready',section:tab,writes:tab==='home'?homeWrites:[tab]}]);
    assert.match(markup(ui,tab),tabContent[tab]);
  }
});

test('a first tab visit writes once and subsequent visits keep all section contents',()=>{
  const ui=start({stored:saved()});
  ui.reset();
  for(const tab of [...tabs.slice(1),'home']){
    open(ui,'#'+tab);
    assert.match(markup(ui,tab),tabContent[tab]);
  }
  assert.deepEqual(ui.domWrites,tabs.slice(1));
  ui.reset();
  for(const tab of [...tabs.slice(1),'home'])open(ui,'#'+tab);
  assert.deepEqual(ui.domWrites,[]);
});

test('a new RFK revision updates open matches and defers an already visited squad',async()=>{
  const ui=start({hash:'#squad',stored:saved()});
  const previous=markup(ui,'squad');
  open(ui,'#matches');
  const next=rfkUpdate();
  const player=next.player_stats_2026.players.find(p=>p.name==='Донской Илья');
  player.name='Донской Илья (новая запись)';
  ui.reset();ui.respond(next);await ui.run('refreshData(true)');
  assert.deepEqual(ui.domWrites,['matches']);
  assert(markup(ui,'matches').includes(`${next.res[0][2]}:${next.res[0][3]} <span`));
  assert.equal(markup(ui,'squad'),previous);
  assert.equal(markup(ui,'table'),'');
  ui.reset();open(ui,'#squad');
  assert.deepEqual(ui.domWrites,['squad']);
  assert(markup(ui,'squad').includes(player.name));
  ui.reset();ui.respond(data());await ui.run('refreshData(true)');
  assert.deepEqual(ui.domWrites,[]);
  assert(markup(ui,'squad').includes(player.name));
});

test('role from a direct player route does not render squad and is used when returning',()=>{
  const role=encodeURIComponent('Вратари');
  const ui=start({stored:saved(),hash:details.player+'&role='+role});
  assert.deepEqual(ui.domWrites,['player']);
  open(ui,'#squad&role='+role);
  assert.match(markup(ui,'squad'),/data-role="Вратари" aria-pressed="true"/);
  ui.reset();open(ui,'#home');open(ui,'#squad&role='+role);
  assert.deepEqual(ui.domWrites,homeWrites);
  ui.reset();open(ui,'#squad&role=all');
  assert.deepEqual(ui.domWrites,['squad']);
  assert.match(markup(ui,'squad'),/data-role="all" aria-pressed="true"/);
});

test('direct detail routes write only the detail before the first network response',async()=>{
  for(const [section,hash] of Object.entries(details)){
    const ui=start({hash});
    assert.deepEqual(ui.events,[{type:'sudak:ready',section,writes:[section]}]);
    assert.match(markup(ui,section),new RegExp(`id="${section}-back"`));
    ui.reset();ui.respond(data());await ui.run('refreshData(true)');
    assert.deepEqual(ui.domWrites,[section]);
    assert.match(markup(ui,section),titles[section]);
  }
});

test('offline cold routes use saved RFK data and can lazily open a second section',async()=>{
  for(const [section,hash] of Object.entries(details)){
    const ui=start({hash,stored:saved()});
    assert.deepEqual(ui.domWrites,[section]);
    assert.match(markup(ui,section),titles[section]);
    ui.reset();ui.respond(Error('offline'));await ui.run('refreshData(true)');
    assert.match(ui.node('upd').textContent,/Нет связи/);
    assert.deepEqual(ui.domWrites,[]);
    open(ui,'#matches');assert.match(markup(ui,'matches'),tabContent.matches);
    assert.deepEqual(ui.domWrites,['matches']);
  }
});

test('CFU arrives on home and later updates an already visited hidden championship',async()=>{
  const ui=start({competition:'cfu'});
  ui.reset();ui.respond(null,provisional());await ui.run('loadCfuPremier()');
  assert.deepEqual(ui.domWrites,[]);
  assert.equal(markup(ui,'table'),'');
  assert(ui.requests.some(({url})=>new URL(url).pathname.endsWith('cfu-sync-2026.json')));
  open(ui,'#table');assert.deepEqual(ui.domWrites,['table']);
  assert.match(markup(ui,'table'),/cfu-table/);
  ui.run("CFU_STATE.view='calendar';CFU_STATE.round=25;updateCfuControls()");
  assert.match(markup(ui,'table'),/Предварительный счёт/);
  open(ui,'#home');ui.reset();ui.respond(null,bundle());await ui.run('loadCfuPremier()');
  assert.deepEqual(ui.domWrites,[]);
  open(ui,'#table');
  assert.deepEqual(ui.domWrites,['table']);
  assert.match(markup(ui,'table'),/2:0/);
  assert.match(markup(ui,'table'),/option value="25" selected/);
  assert.doesNotMatch(markup(ui,'table'),/Предварительный счёт/);
});

test('hidden CFU table adopts metadata without replacing its rows on return',async()=>{
  const ui=start({competition:'cfu',hash:'#table',stored:saved()});
  const checked=ui.node('table').querySelector('[data-cfu-table-checked]');
  open(ui,'#home');ui.reset();
  const next=bundle();next.calendar.sourceMetadata.sections.table.checkedAt='2026-11-12T02:00:00Z';
  ui.respond(null,next);await ui.run('loadCfuPremier()');
  assert.deepEqual(ui.domWrites,[]);
  open(ui,'#table');
  assert.deepEqual(ui.domWrites,[]);
  assert.equal(ui.node('table').querySelector('[data-cfu-table-checked]'),checked);
  assert.equal(checked.textContent,'12.11.2026');
});

test('a CFU detail invalidates the previously visited RFK table before returning',()=>{
  const ui=start({hash:'#table',stored:saved()});
  assert.match(markup(ui,'table'),/champ-standing/);
  ui.reset();open(ui,'#match=cfu%3Amatch%3A18767');
  assert.deepEqual(ui.domWrites,['match']);
  ui.reset();open(ui,'#table');
  assert.deepEqual(ui.domWrites,['table']);
  assert.match(markup(ui,'table'),/cfu-table/);
  assert.doesNotMatch(markup(ui,'table'),/champ-standing/);
});

test('a Moscow day change updates the previously opened home calendar on return',()=>{
  const ui=start({stored:saved()});
  ui.run("Date.now=()=>Date.parse('2026-10-20T12:00:00+03:00')");
  open(ui,'#home');
  const featured=ui.node('home').querySelector('[data-home-block="featured"]');
  const old=featured.innerHTML;
  open(ui,'#matches');ui.reset();
  ui.run("Date.now=()=>Date.parse('2026-12-01T12:00:00+03:00')");
  open(ui,'#home');
  assert(ui.domWrites.includes('home:featured'));
  assert.notEqual(featured.innerHTML,old);
});

test('separately loaded legacy CFU protocols refresh a visited calendar on return',async()=>{
  const initial=bundle(),next=structuredClone(initial.details);
  next.matchesById['cfu:match:18767'].statusLabel='Подтверждённый результат';
  const ui=start({competition:'cfu',hash:'#table',stored:{
    'sudak-cfu-premier-v1':JSON.stringify(initial.calendar),
    'sudak-cfu-premier-match-details-v1':JSON.stringify(initial.details),
  }});
  ui.run("CFU_STATE.view='calendar';CFU_STATE.round=25;updateCfuControls()");
  assert.doesNotMatch(markup(ui,'table'),/Подтверждённый результат/);
  open(ui,'#home');ui.reset();
  ui.respond(null,next);await ui.run('loadCfuMatchDetails()');
  assert.deepEqual(ui.domWrites,[]);
  open(ui,'#table');
  assert.deepEqual(ui.domWrites,['table']);
  assert.match(markup(ui,'table'),/Подтверждённый результат/);
});
