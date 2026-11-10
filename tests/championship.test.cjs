const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
function setup(saved=null){
  const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){},querySelector(){return null},querySelectorAll(){return []}});return nodes.get(id)};
  const context=vm.createContext({URL,URLSearchParams,Intl,console,location:{hash:''},history:{state:{},scrollRestoration:'auto'},
    document:{getElementById:node},window:{addEventListener(){}},localStorage:{getItem(){return saved},setItem(){}}});
  vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
  const run=expression=>JSON.parse(JSON.stringify(vm.runInContext(expression,context)));
  run(`adoptData(${JSON.stringify(data)});true`);return {run,node};
}
const {run,node}=setup();
test('default uses nearest unambiguous Moscow round and otherwise last published round',()=>{
  assert.equal(run(`defaultChampRound(undefined,undefined,Date.parse('2026-11-04T12:00:00Z'))`),'19');
  assert.equal(run(`defaultChampRound(undefined,undefined,Date.parse('2027-01-01T12:00:00Z'))`),'22');
  assert.equal(run(`defaultChampRound([{id:'1'},{id:'2'}],[{round_id:'1',date:'2026-11-05',status:'scheduled'},{round_id:'2',date:'2026-11-05',status:'scheduled'}],Date.parse('2026-11-04T12:00:00Z'))`),'2');
});
test('round, team and status filters stay independent',()=>{
  assert.equal(run(`selectedChampMatches(undefined,{round:'18',team:'all',status:'all'}).length`),5);
  assert.equal(run(`selectedChampMatches(undefined,{round:'18',team:'141',status:'played'}).length`),1);
  assert.equal(run(`selectedChampMatches(undefined,{round:'18',team:'936',status:'played'}).length`),1);
  assert.equal(run(`selectedChampMatches(undefined,{round:'18',team:'all',status:'upcoming'}).length`),0);
  assert.equal(run(`selectedChampMatches(undefined,{round:'19',team:'all',status:'upcoming'}).length`),2);
  assert.equal(run(`selectedChampMatches(undefined,{round:'19',team:'141',status:'all'}).length`),0);
});
test('search normalizes case, spaces and ё without changing official order',()=>{
  assert.equal(run(`selectedChampScorers(undefined,{search:'СЕМЁНОВ   ВЛАД',scorerTeam:'all'})[0].id`),'1151');
  assert.equal(run(`selectedChampScorers(undefined,{search:'',scorerTeam:'all'}).length`),25);
  assert.equal(run(`selectedChampScorers(undefined,{search:'Илья',scorerTeam:'141'})[0].id`),'202');
  assert.equal(run(`selectedChampScorers(undefined,{search:'несуществующий',scorerTeam:'all'}).length`),0);
});
test('profile match requires team ID, player ID and full name together',()=>{
  const p=data.championship.scorers.players.find(p=>p.id==='202');
  assert.equal(run(`championshipPlayer(${JSON.stringify(p)}).name`),'Донской Илья');
  for(const change of [{id:'9999'},{name:'Донской Игорь'},{team_id:'936'}])assert.equal(run(`championshipPlayer(${JSON.stringify({...p,...change})})`),null);
});
test('only matching available club protocols use the existing match screen',()=>{
  const m=data.championship.calendar.matches.find(m=>m.source_id==='38762');
  assert(m.club_match_key);
  assert.equal(run(`championshipClubMatch(${JSON.stringify(m)})`),m.club_match_key);
  for(const change of [{source_id:'9999'},{date:'2026-10-24'},{away_score:99},{home_id:'146',away_id:'936'}])assert.equal(run(`championshipClubMatch(${JSON.stringify({...m,...change})})`),null);
});
test('unknown scores never become 0:0, technical and postponement labels survive',()=>{
  for(const status of ['scheduled','postponed','cancelled']){
    const m={id:'fixture',round_id:'1',home_id:'146',away_id:'141',home_score:null,away_score:null,date:null,time:null,status,status_label:'Исходный статус'};
    const markup=run(`champMatchHTML(${JSON.stringify(m)})`);
    assert(!markup.includes('0:0'));assert(markup.includes('Исходный статус'));assert(markup.includes('Дата не указана'));
  }
  const technical=data.championship.calendar.matches.find(m=>m.status==='technical');
  const markup=run(`champMatchHTML(${JSON.stringify(technical)})`);
  assert(markup.includes('3:0'));assert(markup.includes('Тех. победа'));
});
test('untrusted links, player names and status labels cannot inject markup',()=>{
  const m={id:'x',home_id:'141',away_id:'146',status:'scheduled',status_label:'<img src=x onerror=alert(1)>',source_url:'https://evil.test/matches/1/'};
  const markup=run(`champMatchHTML(${JSON.stringify(m)})`);
  assert(!markup.includes('href="https://evil'));assert(markup.includes('&lt;img'));
  const p={id:'666',rank:1,team_id:'146',name:'<script>fail</script>',team_name:'A',games:1,goals:1,source_url:'javascript:alert(1)'};
  const scorer=run(`champScorerHTML(${JSON.stringify(p)})`);
  assert(!scorer.includes('<script>'));assert(!scorer.includes('javascript:'));
});
test('hub renders official standings once and all published scorer rows',()=>{
  run(`CHAMP_STATE.view='standings';renderChampionship();true`);
  assert.equal((node('table').innerHTML.match(/<table>/g)||[]).length,1);
  assert(node('table').innerHTML.includes('63–30'));
  run(`CHAMP_STATE.view='scorers';renderChampionship();true`);
  assert.equal((node('table').innerHTML.match(/data-scorer=/g)||[]).length,25);
  assert(node('table').innerHTML.includes('from=table'));
});
test('stored view and round survive adoption of new data and invalid storage is safe',()=>{
  const {run}=setup(JSON.stringify({view:'calendar',round:'3',team:'141',status:'all'}));
  run('renderChampionship();true');assert.equal(run('CHAMP_STATE.round'),'3');
  assert.equal(run('CHAMP_STATE.team'),'141');
  run(`adoptData(${JSON.stringify(data)});renderChampionship();true`);assert.equal(run('CHAMP_STATE.round'),'3');
  assert.equal(setup('broken').run('CHAMP_STATE.view'),'standings');
});
test('championship parent stays active through nested club player and match routes',()=>{
  for(const [hash,section] of [['#match=abc&from=table','match'],['#player=rffk-202&name=x&from=table','player']]){
    run(`location.hash=${JSON.stringify(hash)};true`);assert.equal(run('currentRoute().section'),section);assert.equal(run('routeParent(currentRoute())'),'#table');
  }
  assert.equal(run(`matchParentTab('#match=abc&from=player&profileFrom=table')`),'table');
});

test('an unavailable leaderboard shows missing data rather than an official zero-player list',()=>{
  const {run,node}=setup();run("CHAMPIONSHIP=null;CHAMP_STATE.view='scorers';renderChampionship();true");
  assert(node('table').innerHTML.includes('Рейтинг пока не загружен'));
  assert(!node('table').innerHTML.includes('0 игроков'));
});
