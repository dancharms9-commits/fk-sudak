/* Targeted CFU Premier League match-centre checks; no browser or network. */
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
const details=JSON.parse(fs.readFileSync(path.join(root,'cfu-premier-match-details-2026.json'),'utf8'));
const committed=JSON.parse(fs.readFileSync(path.join(root,'docs/cfu-premier-2026/match-details.json'),'utf8'));

function setup(stored={}){
  const nodes=new Map(),writes={};
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){},querySelector(){return null},querySelectorAll(){return []}});
    return nodes.get(id);
  };
  const context=vm.createContext({
    URL,URLSearchParams,Intl,console,
    location:{hash:''},
    history:{state:{},scrollRestoration:'auto'},
    document:{baseURI:'https://example.test/fk-sudak/',title:'',getElementById:node},
    window:{addEventListener(){},scrollY:0,scrollTo(){}},
    localStorage:{getItem(key){return Object.hasOwn(stored,key)?stored[key]:null},setItem(key,value){writes[key]=value}},
  });
  vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
  const run=expression=>JSON.parse(JSON.stringify(vm.runInContext(expression,context)));
  return {run,node,writes,context};
}
const clone=value=>JSON.parse(JSON.stringify(value));
const ui=setup();
ui.run(`CFU_PREMIER=${JSON.stringify(premier)};CFU_ROSTERS=${JSON.stringify(rosters)};CFU_MATCH_DETAILS=${JSON.stringify(details)};true`);

test('published protocol copy is the committed snapshot and stays CFU-only',()=>{
  assert.deepEqual(details,committed);
  assert.equal(details.provider,'cfu');
  assert.equal(details.competitionKey,'cfu-premier-2026');
  assert.equal(details.season,2026);
  assert.equal(Object.keys(details.matchesById).length,5);
  assert(!JSON.stringify(details).toLowerCase().includes('rffk'));
});

test('client validator accepts verified partial protocols and rejects unsafe contracts',()=>{
  assert.equal(ui.run('validCfuMatchDetails(CFU_MATCH_DETAILS)'),true);
  for(const mutate of [
    value=>{value.schemaVersion=2},
    value=>{value.provider='rffk'},
    value=>{value.season=2025},
    value=>{value.competitionKey='cfu-cup-2026'},
    value=>{value.matchesById['cfu:match:18763'].sourceMatchId='18764'},
    value=>{value.matchesById['cfu:match:18763'].homeTeamId='cfu:team:fc-okean'},
    value=>{value.matchesById['cfu:match:18763'].homeScore=1},
    value=>{value.matchesById['cfu:match:18763'].events[0].playerId='rffk-280'},
    value=>{value.matchesById['cfu:match:18763'].events[0].minute='45+99'},
    value=>{value.matchesById['cfu:match:18763'].goals=[]},
  ]){
    const value=clone(details);mutate(value);
    assert.equal(ui.run(`validCfuMatchDetails(${JSON.stringify(value)})`),false);
  }
  assert.equal(ui.run('validCfuMatchDetails(null)'),false);
});

test('finished match centre shows confirmed goals, minutes and player links',()=>{
  const {run,node}=ui;
  run("location.hash='#match=cfu%3Amatch%3A18763&from=table';renderCfuMatch(currentRoute());true");
  const markup=node('match').innerHTML;
  assert(markup.includes('ГФК &quot;Ялта&quot;'));
  assert(markup.includes('ФК &quot;Таврия&quot;'));
  assert(markup.includes('0:2'));
  assert(markup.includes('Матч завершен'));
  assert(markup.includes('Роман Климентовский'));
  assert(markup.includes('Владимир Клепча'));
  assert(markup.includes('44′'));
  assert(markup.includes('48′'));
  assert(markup.includes('data-player="cfu:player:280"'));
  assert(markup.includes('href="https://www.cfu2015.com/matches/premier-leagueCFU/match_18763/"'));
  assert(!markup.includes('rffk'));
});

test('future match does not show a result or finished status',()=>{
  const {run,node}=ui;
  run("location.hash='#match=cfu%3Amatch%3A18769&from=table';renderCfuMatch(currentRoute());true");
  const markup=node('match').innerHTML;
  assert(markup.includes('Счёт не опубликован'));
  assert(!markup.includes('Итоговый счёт'));
  assert(!markup.includes('Завершён'));
  assert(!markup.includes('0:0'));
  assert(markup.includes('Официальный протокол импортирован, но результат и события'));
});

test('match without an imported protocol says so and keeps the official link',()=>{
  const {run,node}=ui;
  run("location.hash='#match=cfu%3Amatch%3A17745&from=table';renderCfuMatch(currentRoute());true");
  const markup=node('match').innerHTML;
  assert(markup.includes('Подробный протокол этого матча пока не импортирован'));
  assert(markup.includes('3:1'));
  assert(!markup.includes('Завершён'));
  assert(markup.includes('https://www.cfu2015.com/matches/premier-leagueCFU/match_17745/'));
});

test('calendar cards expose one internal match link without nesting anchors',()=>{
  const markup=ui.run(`CFU_STATE.round=24;CFU_STATE.team='all';CFU_STATE.all=false;cfuCalendarHTML()`);
  assert.equal((markup.match(/data-cfu-match=/g)||[]).length,3);
  assert.equal((markup.match(/class="cfu-center-link"/g)||[]).length,3);
  assert(markup.includes('href="#match=cfu%3Amatch%3A18763&amp;from=table"'));
  assert(!/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/.test(markup),'nested anchors');
});

test('saved protocol snapshot restores offline; invalid storage is ignored',()=>{
  const saved=setup({'sudak-cfu-premier-match-details-v1':JSON.stringify(details)});
  saved.run('restoreCfuMatchDetails();true');
  assert.equal(saved.run('validCfuMatchDetails(CFU_MATCH_DETAILS)'),true);
  assert.equal(saved.run('CFU_MATCH_DETAILS_SAVED'),true);
  const broken=setup({'sudak-cfu-premier-match-details-v1':'{"schemaVersion":1}'});
  broken.run('restoreCfuMatchDetails();true');
  assert.equal(broken.run('CFU_MATCH_DETAILS'),null);
});

test('match centre and Back parents keep CFU club and calendar context',()=>{
  const {run}=ui;
  run("location.hash='#team=cfu%3Ateam%3Atavriya';true");
  assert.equal(run("cfuMatchCenterHref(cfuMatch('cfu:match:18763'))"),
    '#match=cfu%3Amatch%3A18763&from=team&team=cfu%3Ateam%3Atavriya');
  run("location.hash='#match=cfu%3Amatch%3A18763';true");
  assert.equal(run('routeParent(currentRoute())'),'#table');
  run("location.hash='#match=cfu%3Amatch%3A18763&from=team&team=cfu%3Ateam%3Atavriya';true");
  assert.equal(run('routeParent(currentRoute())'),'#team=cfu%3Ateam%3Atavriya');
});
