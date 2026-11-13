/* Exercise the actual Python importer and production client against official HTML. */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {setup,keys,bundle}=require('./data-refresh-harness.cjs');
const snapshots=require('./rffk-refresh-fixtures.cjs'),match='4:2026:19:930:117';
const saved=()=>({hash:'#table',stored:{[keys.data]:JSON.stringify(snapshots.old),[keys.cfu]:JSON.stringify(bundle())}});

test('official refresh adopts a new revision and renders 1:4 in the existing round',async()=>{
  const ui=setup(saved());ui.run("restoreSavedData();CHAMP_STATE.view='calendar';CHAMP_STATE.round='19';CHAMP_STATE.team='all';render()");
  assert.match(ui.node('table').innerHTML,/data-champ-match="4:2026:19:930:117"/);
  ui.reset();ui.respond(snapshots.new);await ui.run('refreshData(true)');
  assert.equal(ui.counts.render,1);assert.equal(ui.counts.writes,1);
  assert.equal(ui.run(`PLATFORM.matchesById['${match}'].sourceMatchId`),'38768');
  assert.equal(ui.run(`PLATFORM.matchesById['${match}'].awayScore`),4);
  assert.match(ui.node('table').innerHTML,/aria-label="ФК «НКСТРОЙ-Керчь» — УОР, 1:4,/);
  assert.equal(ui.run('CHAMP_STATE.round'),'19');
  assert.deepEqual(JSON.parse(ui.values[keys.data]),snapshots.new);
});

test('official match center shows the same result, date and protocol URL',async()=>{
  const ui=setup({...saved(),hash:'#match=rffk-38768&from=table'});
  ui.run('restoreSavedData()');ui.respond(snapshots.new);await ui.run('refreshData(true)');
  const html=ui.node('match').innerHTML;
  assert.match(html,/НКСТРОЙ-Керчь/);assert.match(html,/УОР/);
  assert.match(html,/<span class="num">1<\/span><span aria-hidden="true">:<\/span><span class="num">4<\/span>/);
  assert.match(html,/11\.11\.2026/);assert.match(html,/https:\/\/rffk-roo.ru\/matches\/38768\//);
});

test('next hourly stale response and offline reload preserve 1:4 and the CFU bundle',async()=>{
  const ui=setup(saved());ui.run('restoreSavedData()');ui.respond(snapshots.new);await ui.run('refreshData(true)');
  const accepted=ui.values[keys.data],cfu=ui.values[keys.cfu];
  ui.reset();ui.respond(snapshots.old);await ui.run('refreshData(true)');
  assert.equal(ui.values[keys.data],accepted);assert.equal(ui.values[keys.cfu],cfu);
  assert.equal(ui.counts.writes,0);assert.equal(ui.counts.render,0);
  const restored=setup({stored:ui.values});restored.run('restoreSavedData();render()');
  assert.equal(restored.run(`PLATFORM.matchesById['${match}'].awayScore`),4);
  assert.equal(restored.run(`CHAMPIONSHIP.calendar.matches.find(m=>m.id==='${match}').away_score`),4);
  assert.equal(restored.values[keys.cfu],cfu);
});
