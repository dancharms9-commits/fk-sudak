/* Targeted CFU Premier League UI adapter checks; no browser or network access. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const published=JSON.parse(fs.readFileSync(path.join(root,'cfu-premier-2026.json'),'utf8'));
const committed=JSON.parse(fs.readFileSync(path.join(root,'docs/cfu-premier-2026/snapshot.json'),'utf8'));

function setup(stored={}){
  const nodes=new Map(),writes={};
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){},querySelector(){return null},querySelectorAll(){return []}});
    return nodes.get(id);
  };
  const localStorage={
    getItem(key){return Object.hasOwn(stored,key)?stored[key]:null},
    setItem(key,value){writes[key]=value},
  };
  const context=vm.createContext({
    URL,URLSearchParams,Intl,console,
    location:{hash:''},
    history:{state:{},scrollRestoration:'auto'},
    document:{baseURI:'https://example.test/fk-sudak/',title:'',getElementById:node},
    window:{addEventListener(){},scrollY:0,scrollTo(){}},
    localStorage,
  });
  vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
  const run=expression=>JSON.parse(JSON.stringify(vm.runInContext(expression,context)));
  return {run,node,writes};
}
const snapshot={
  ...committed,
  teamsById:published.teamsById,
  matchesById:published.matchesById,
  standings:published.standings,
  sourceMetadata:published.sourceMetadata,
  unresolvedRecords:published.unresolvedRecords,
};
const clone=value=>JSON.parse(JSON.stringify(value));
const ui=setup();
ui.run(`CFU_PREMIER=${JSON.stringify(snapshot)};true`);

test('published JSON is the certified snapshot with the full calendar contract',()=>{
  assert.deepEqual(published,committed);
  assert.equal(Object.keys(published.teamsById).length,7);
  assert.equal(Object.keys(published.matchesById).length,84);
  assert.equal(new Set(Object.values(published.matchesById).map(m=>m.round)).size,28);
  assert.equal(new Set(Object.values(published.matchesById).map(m=>m.circle)).size,4);
  assert.equal(published.standings.asOfRound,24);
});

test('client validation accepts the snapshot and rejects unsafe contracts',()=>{
  assert.equal(ui.run('validCfuSnapshot(CFU_PREMIER)'),true);
  for(const mutate of [
    value=>{value.schemaVersion=2},
    value=>{value.provider='rffk'},
    value=>{value.matchesById['cfu:match:17745'].homeTeamId='cfu:team:unknown'},
    value=>{value.matchesById['cfu:match:17745'].awayScore=null},
    value=>{
      const match=value.matchesById['cfu:match:17745'];
      delete value.matchesById['cfu:match:17745'];
      match.matchId='4:22';
      value.matchesById['4:22']=match;
    },
  ]){
    const value=clone(snapshot);mutate(value);
    assert.equal(ui.run(`validCfuSnapshot(${JSON.stringify(value)})`),false);
  }
  assert.equal(ui.run('validCfuSnapshot(null)'),false);
});

test('default round is the nearest round without a published score',()=>{
  assert.equal(ui.run('cfuDefaultRound()'),26);
  const complete=clone(snapshot);
  for(const match of Object.values(complete.matchesById)){
    if(!Number.isInteger(match.homeScore)){match.homeScore=0;match.awayScore=0}
  }
  assert.equal(ui.run(`cfuDefaultRound(${JSON.stringify(complete)})`),28);
});

test('standings keep official order and expose all seven clubs',()=>{
  const markup=ui.run('cfuStandingsHTML()');
  assert(markup.includes('Официальная таблица после 24-го тура'));
  assert(markup.includes('Проверено: 11.11.2026'));
  assert(markup.indexOf('ФК &quot;Таврия&quot;')<markup.indexOf('ГФК &quot;Ялта&quot;'));
  assert.equal((markup.match(/data-cfu-standing=/g)||[]).length,7);
  assert(markup.includes('https://www.cfu2015.com/matches/premier-leagueCFU/table/?season=2026'));
});

test('calendar renders three scoreless matches in round 28 without inventing status',()=>{
  const markup=ui.run(`CFU_STATE.round=28;CFU_STATE.team='all';CFU_STATE.all=false;cfuCalendarHTML()`);
  assert.equal((markup.match(/data-cfu-match=/g)||[]).length,3);
  assert.equal((markup.match(/Счёт не опубликован/g)||[]).length,3);
  assert(!markup.includes('0:0'));
  assert(!markup.includes('Завершён'));
  assert(!markup.includes('Отменён'));
  assert(!markup.includes('Перенесён'));
  assert.equal((markup.match(/Матч на сайте КФС/g)||[]).length,3);
});

test('a published score is shown without an invented finished status',()=>{
  const match=published.matchesById['cfu:match:17745'];
  const markup=ui.run(`cfuMatchHTML(${JSON.stringify(match)})`);
  assert(markup.includes('3:1'));
  assert(!markup.includes('Завершён'));
  assert(!markup.includes('Счёт не опубликован'));
  assert(markup.includes('Матч на сайте КФС'));
});

test('unsafe external URLs are not rendered',()=>{
  assert.equal(ui.run(`cfuOfficialURL('javascript:alert(1)')`),'');
  assert.equal(ui.run(`cfuOfficialURL('https://evil.test/teams/x/')`),'');
  const match={...published.matchesById['cfu:match:17745'],sourceUrl:'https://evil.test/match/1/'};
  const markup=ui.run(`cfuMatchHTML(${JSON.stringify(match)})`);
  assert(!markup.includes('evil.test'));
  assert(!markup.includes('Матч на сайте КФС'));
});

test('club page lists every published result plus the remaining fixtures',()=>{
  const {run,node}=ui;
  run(`renderCfuClub({section:'team',teamId:'cfu:team:tavriya'});true`);
  const markup=node('team').innerHTML;
  assert(markup.includes('ФК &quot;Таврия&quot;'));
  assert(markup.includes('Симферополь'));
  assert(markup.includes('Опубликованные результаты'));
  assert(markup.includes('Остальные матчи календаря'));
  assert(markup.includes('Состав и статистика футболистов будут добавлены после проверки официальных данных КФС.'));
  assert(markup.includes('https://www.cfu2015.com/teams/tavriya/'));
  const expected=run(`cfuTeamMatches('cfu:team:tavriya').length`);
  assert.equal((markup.match(/data-cfu-match=/g)||[]).length,expected);
  assert(expected>12);
});

test('CFU club hash routes are decoded and remain separate from RFFK ids',()=>{
  assert.equal(ui.run(`location.hash='#team=cfu%3Ateam%3Atavriya';currentRoute().teamId`),'cfu:team:tavriya');
  assert.equal(ui.run(`location.hash='#team=cfu%3Ateam%3Atavriya';currentRoute().section`),'team');
  assert.equal(ui.run(`isCfuTeamId('cfu:team:tavriya')`),true);
  assert.equal(ui.run(`isCfuTeamId('141')`),false);
});

test('competition choice uses a new storage key and defaults to RFFK',()=>{
  assert.equal(ui.run('COMPETITION'),'rfk');
  ui.run(`COMPETITION='cfu';saveCompetition();true`);
  assert.equal(ui.writes['sudak-competition-v1'],'cfu');
  assert.equal(Object.hasOwn(ui.writes,'sudak-championship-v1'),false);
  assert.equal(setup({'sudak-competition-v1':'cfu'}).run('COMPETITION'),'cfu');
  assert.equal(setup({'sudak-competition-v1':'unexpected'}).run('COMPETITION'),'rfk');
});

test('switching to CFU and back leaves the RFFK view, round and filters untouched',()=>{
  const {run,node}=setup();
  run(`CHAMP_STATE.view='calendar';CHAMP_STATE.round='18';CHAMP_STATE.team='141';CHAMP_STATE.status='played';CHAMPIONSHIP={calendar:{rounds:[{id:'18',name:'18-й тур'}],teams:[],matches:[]},scorers:null};CFU_PREMIER=${JSON.stringify(snapshot)};COMPETITION='cfu';renderChampionship();true`);
  assert(node('table').innerHTML.includes('data-competition-switch="true"'));
  assert(node('table').innerHTML.includes('Премьер-лига КФС'));
  assert.equal(run('CHAMP_STATE.view'),'calendar');
  assert.equal(run('CHAMP_STATE.round'),'18');
  assert.equal(run('CHAMP_STATE.team'),'141');
  assert.equal(run('CHAMP_STATE.status'),'played');
  run(`COMPETITION='rfk';renderChampionship();true`);
  assert.equal(run('CHAMP_STATE.round'),'18');
  assert(node('table').innerHTML.includes('id="champ-panel"'));
});

test('unavailable CFU data shows a message and keeps the return to RFFK',()=>{
  const {run,node}=setup();
  run(`CFU_PREMIER=null;CFU_ERROR='Данные Премьер-лиги КФС недоступны.';COMPETITION='cfu';renderChampionship();true`);
  const markup=node('table').innerHTML;
  assert(markup.includes('Данные Премьер-лиги КФС недоступны.'));
  assert(markup.includes('data-competition-switch="true"'));
  assert(markup.includes('data-competition="rfk"'));
  assert(!markup.includes('cfu-table'));
  run(`COMPETITION='rfk';renderChampionship();true`);
  assert(node('table').innerHTML.includes('id="champ-panel"'));
});

test('a saved valid snapshot restores for offline use; invalid storage is ignored',()=>{
  const stored={['sudak-cfu-premier-v1']:JSON.stringify(published)};
  const saved=setup(stored);
  saved.run('restoreCfuPremier();true');
  assert.equal(saved.run('validCfuSnapshot(CFU_PREMIER)'),true);
  assert.equal(saved.run('CFU_SAVED'),true);
  const broken=setup({['sudak-cfu-premier-v1']:'{"schemaVersion":1}'});
  broken.run('restoreCfuPremier();true');
  assert.equal(broken.run('CFU_PREMIER'),null);
});
