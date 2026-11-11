/* Targeted CFU Premier League roster/player UI checks; no browser or network. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const premier=JSON.parse(fs.readFileSync(path.join(root,'cfu-premier-2026.json'),'utf8'));
const rosters=JSON.parse(fs.readFileSync(path.join(root,'cfu-premier-rosters-2026.json'),'utf8'));
const committed=JSON.parse(fs.readFileSync(path.join(root,'docs/cfu-premier-rosters-2026/rosters.json'),'utf8'));

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
  return {run,node,writes,context};
}
const clone=value=>JSON.parse(JSON.stringify(value));
const ui=setup();
ui.run(`CFU_PREMIER=${JSON.stringify(premier)};CFU_ROSTERS=${JSON.stringify(rosters)};true`);

test('published roster copy is the validated committed snapshot',()=>{
  assert.deepEqual(rosters,committed);
  assert.equal(rosters.schemaVersion,1);
  assert.equal(rosters.provider,'cfu');
  assert.equal(rosters.competitionKey,'cfu-premier-2026');
  assert.equal(rosters.season,2026);
  assert.equal(Object.keys(rosters.rostersByTeamId).length,7);
  assert.equal(Object.keys(rosters.playersById).length,238);
  assert.equal(rosters.sourceMetadata.rosters.records,253);
  assert.equal(rosters.sourceMetadata.rosters.deregisteredRecords,90);
});

test('client validation accepts the roster snapshot and rejects unsafe contracts',()=>{
  assert.equal(ui.run('validCfuRosters(CFU_ROSTERS)'),true);
  for(const mutate of [
    value=>{value.schemaVersion=2},
    value=>{value.provider='rffk'},
    value=>{value.season=2025},
    value=>{const player=value.playersById['cfu:player:258'];delete value.playersById['cfu:player:258'];player.playerId='rffk-258';value.playersById['rffk-258']=player},
    value=>{value.playersById['cfu:player:258'].sourceUrl='https://evil.test/players/258/'},
    value=>{value.rostersByTeamId['cfu:team:tavriya'].entries.push(
      clone(value.rostersByTeamId['cfu:team:tavriya'].entries[0]))},
    value=>{value.rostersByTeamId['cfu:team:tavriya'].entries[0].positionGroup='Нападающие'},
    value=>{delete value.rostersByTeamId['cfu:team:tavriya']},
    value=>{value.sourceMetadata.rosters.teams=6},
  ]){
    const value=clone(rosters);mutate(value);
    assert.equal(ui.run(`validCfuRosters(${JSON.stringify(value)})`),false);
  }
  assert.equal(ui.run('validCfuRosters(null)'),false);
});

test('club roster groups published positions and keeps deregistered players',()=>{
  const markup=ui.run(`renderCfuClub({section:'team',teamId:'cfu:team:tavriya'});true`)&&
    ui.node('team').innerHTML;
  assert(markup.includes('Состав · сезон 2026'));
  for(const group of ['Вратари','Защитники','Полузащитники','Нападающие']){
    assert(markup.includes(group),group);
  }
  assert(markup.includes('Валентин Манякин'));
  assert(markup.includes('Артем Булгаков'));
  assert(markup.includes('Отзаявлен'));
  assert(markup.includes('data-player="cfu:player:258"'));
  assert(markup.includes('href="#player=cfu%3Aplayer%3A258&amp;team=cfu%3Ateam%3Atavriya&amp;from=team"'));
  assert(markup.includes('Проверено: '));
  assert(markup.includes('https://www.cfu2015.com/teams/tavriya/'));
  assert.equal((markup.match(/class="cfu-roster-player"/g)||[]).length,32);
  assert(markup.includes('cfu:player:2111'));
});

test('player page is isolated from RFFK and shows only confirmed roster data',()=>{
  const {run,node}=ui;
  assert.equal(run(`findPlayer({player:'cfu:player:258',teamId:'cfu:team:tavriya'})`),null);
  run(`renderCfuPlayer({section:'player',player:'cfu:player:258',teamId:'cfu:team:tavriya',origin:'team'});true`);
  const markup=node('player').innerHTML;
  assert(markup.includes('Валентин Манякин'));
  assert(markup.includes('ФК &quot;Таврия&quot;'));
  assert(markup.includes('Вратарь'));
  assert(markup.includes('№ 1'));
  assert(markup.includes('26.06.1997'));
  assert(markup.includes('Профиль на сайте КФС'));
  assert(markup.includes('https://www.cfu2015.com/players/258/'));
  assert(!markup.includes('Матчи'));
  assert(!markup.includes('Голы'));
  assert(!markup.includes('rffk'));
  assert.equal(run(`isCfuPlayerId('cfu:player:258')`),true);
  assert.equal(run(`isCfuPlayerId('rffk-258')`),false);
});

test('a transfer player keeps separate club records on the profile',()=>{
  const {run,node}=ui;
  run(`renderCfuPlayer({section:'player',player:'cfu:player:2111',teamId:'cfu:team:tavriya',origin:'team'});true`);
  const markup=node('player').innerHTML;
  assert(markup.includes('Артем Булгаков'));
  assert(markup.includes('Отзаявлен: 08.09.2026'));
  assert(markup.includes('Другие клубы в сезоне 2026'));
  assert(markup.includes('ФК &quot;МАК&quot;'));
  assert(markup.includes('№ 12'));
});

test('direct CFU player route and parent are decoded without RFFK fallback',()=>{
  const {run}=ui;
  run(`location.hash='#player=cfu%3Aplayer%3A258&team=cfu%3Ateam%3Atavriya&from=team';true`);
  assert.equal(run('currentRoute().player'),'cfu:player:258');
  assert.equal(run('currentRoute().teamId'),'cfu:team:tavriya');
  assert.equal(run('currentRoute().origin'),'team');
  assert.equal(run('routeParent(currentRoute())'),'#team=cfu%3Ateam%3Atavriya');
  run(`location.hash='#player=cfu%3Aplayer%3A258';true`);
  assert.equal(run('routeParent(currentRoute())'),'#table');
});

test('unavailable roster data is honest and never says the squad is empty',()=>{
  const {run,node}=setup();
  run(`CFU_PREMIER=${JSON.stringify(premier)};CFU_ROSTERS=null;CFU_ROSTERS_ERROR='Официальный состав КФС недоступен.';renderCfuClub({section:'team',teamId:'cfu:team:tavriya'});true`);
  const club=node('team').innerHTML;
  assert(club.includes('Официальный состав КФС недоступен.'));
  assert(!club.includes('футболистов нет'));
  run(`renderCfuPlayer({section:'player',player:'cfu:player:258',teamId:'cfu:team:tavriya',origin:'team'});true`);
  const player=node('player').innerHTML;
  assert(player.includes('Официальный состав КФС недоступен.'));
  assert(!player.includes('Футболист недоступен'));
});

test('a saved valid roster snapshot restores offline; invalid storage is ignored',()=>{
  const stored={['sudak-cfu-premier-rosters-v1']:JSON.stringify(rosters)};
  const saved=setup(stored);
  saved.run('restoreCfuRosters();true');
  assert.equal(saved.run('validCfuRosters(CFU_ROSTERS)'),true);
  assert.equal(saved.run('CFU_ROSTERS_SAVED'),true);
  const broken=setup({['sudak-cfu-premier-rosters-v1']:'{"schemaVersion":1}'});
  broken.run('restoreCfuRosters();true');
  assert.equal(broken.run('CFU_ROSTERS'),null);
});
