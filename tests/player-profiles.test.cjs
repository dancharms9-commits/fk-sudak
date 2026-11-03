// Exercise the production inline functions without copying matching logic.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const nodes=new Map();
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){},querySelector(){return null}});return nodes.get(id)};
const context=vm.createContext({URL,URLSearchParams,console,location:{hash:''},history:{state:{},scrollRestoration:'auto'},
  document:{getElementById:node},window:{addEventListener(){}},localStorage:{getItem(){return null}}});
vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
const run=expression=>JSON.parse(JSON.stringify(vm.runInContext(expression,context)));
const player=(name,id)=>({name,position:'Полузащитники',federation_games:39,
  league_games:7,league_goals:2,league_minutes:420,league_starts:4,league_substitutions:3,
  league_penalty_goals:1,profile_url:`https://rffk-roo.ru/players/${id}/`});
function resolve(author,players,type='goal'){
  return run(`resolveScorer(${JSON.stringify({player:author,type})},${JSON.stringify(players)})`);
}

test('exact name and unique surname/initial; no surname-only, fuzzy or wrong initial attribution',()=>{
  const players=[player('Донской Илья',202),player('Семенов Владимир',1151)];
  for(const name of ['Донской Илья','Донской И.','  ДОНСКОЙ   И.  '])assert.equal(resolve(name,players).name,'Донской Илья');
  for(const name of ['Донской','Донской В.','Донскои И.','Илья Донской','Несуществующий Н.'])assert.equal(resolve(name,players),null);
});
test('homonyms and duplicate full names require unique identity',()=>{
  const players=[player('Иванов Иван',1),player('Иванов Игорь',2),player('Иванов Алексей',3)];
  assert.equal(resolve('Иванов И.',players),null);
  assert.equal(resolve('Иванов Иван',players).profile_url,players[0].profile_url);
  assert.equal(resolve('Иванов А.',players).name,'Иванов Алексей');
  assert.equal(resolve('Иванов Иван',[players[0],player('Иванов Иван',4)]),null);
  assert.equal(resolve('Семёнов В.',[player('Семенов Владимир',5),player('Семёнов Владислав',6)]),null);
});
test('hyphenated surname, е/ё and patronymic initials use exact normalized tokens',()=>{
  assert.equal(resolve('Семёнов В.',[player('Семенов Владимир',1)]).name,'Семенов Владимир');
  assert.equal(resolve('Иванов-Петров А.',[player('Иванов-Петров Андрей',2)]).name,'Иванов-Петров Андрей');
  assert.equal(resolve('Иванов И. П.',[player('Иванов Иван Петрович',3)]).name,'Иванов Иван Петрович');
  assert.equal(resolve('Иванов И. П.',[player('Иванов Иван',3)]),null);
});
test('penalties are personal goals; own goals, missed penalties and unknown event types are excluded',()=>{
  const players=[player('Храмов Олег',1270)];
  assert.equal(resolve('Храмов О.',players,'penalty').name,'Храмов Олег');
  for(const type of ['own_goal','missed_penalty','yellow','unknown'])assert.equal(resolve('Храмов О.',players,type),null);
});
test('only Sudak goals count at home and away; unavailable protocols never replace official totals',()=>{
  const p=player('Донской Илья',202),players=[p];
  const rows=[['1 мая','Соперник',2,1,'','дома'],['2 мая','Соперник',1,0,'','в гостях'],['3 мая','Соперник',1,0,'','дома']];
  const goal=(side,type='goal')=>({side,type,player:'Донской И.',minute:'45+2'});
  const details={};
  rows.forEach((r,i)=>{details[[2026,r[0],r[1],r[5]].join('|')]={status:i===2?'unavailable':'available',date:'2026-05-0'+(i+1),
    home:i===1?'Соперник':'ФК «Судак»',away:i===1?'ФК «Судак»':'Соперник',home_score:i===1?0:2,away_score:1,
    goals:i===1?[goal('away','penalty'),goal('away','own_goal')]:[goal('home'),goal('away'),goal('home','own_goal')]};});
  const before=JSON.stringify(p);
  const out=run(`playerGoalMatches(${JSON.stringify(p)},${JSON.stringify(players)},${JSON.stringify(rows)},${JSON.stringify(details)})`);
  assert.equal(out.entries.length,2);
  assert.equal(out.entries[1].goal.type,'penalty');
  assert.equal(out.unavailable,1);
  assert.equal(JSON.stringify(p),before);
});
test('wrong season, score and team identity are rejected even if status says available',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
  const p=data.player_stats_2026.players.find(p=>p.name==='Донской Илья');
  const row=data.res[0],key=[2026,row[0],row[1],row[5]].join('|');
  for(const fields of [{date:'2025-10-25'},{home:'Другая команда'},{home_score:999},{status:'unavailable'}]){
    const details={[key]:{...data.match_details[key],...fields}};
    const out=run(`playerGoalMatches(${JSON.stringify(p)},${JSON.stringify([p])},${JSON.stringify([row])},${JSON.stringify(details)})`);
    assert.equal(out.entries.length,0);assert.equal(out.unavailable,1);
  }
});
test('published protocols link to the right players without exceeding official league totals',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
  const players=data.player_stats_2026.players;
  const copy=JSON.stringify(players);
  const totals={};
  for(const p of players){
    const out=run(`playerGoalMatches(${JSON.stringify(p)},${JSON.stringify(players)},${JSON.stringify(data.res)},${JSON.stringify(data.match_details)})`);
    totals[p.name]=out.entries.length;
    if(Number.isInteger(p.league_goals))assert(out.entries.length<=p.league_goals,p.name);
    for(const e of out.entries)assert.notEqual(e.goal.type,'own_goal');
  }
  assert.equal(totals['Донской Илья'],5);assert.equal(totals['Семенов Владимир'],10);
  assert.equal(totals['Глушков Никита'],2);assert.equal(totals['Храмов Олег'],1);
  assert.equal(JSON.stringify(players),copy);
});
test('official photo needs a matching player source and a real portrait path',()=>{
  const p={...player('Донской Илья',202),photo_url:'https://rffk-roo.ru/uploads/people/large/DGIaYmPn.jpg',photo_source_url:'https://rffk-roo.ru/players/202/'};
  assert.equal(run(`officialPhoto(${JSON.stringify(p)})`),p.photo_url);
  for(const fields of [{photo_source_url:'https://rffk-roo.ru/players/999/'},{photo_source_url:null},
    {photo_url:'https://evil.example/uploads/people/large/photo.jpg'},
    {photo_url:'https://rffk-roo.ru/assets/images/logo.png'},
    {photo_url:'https://rffk-roo.ru/uploads/people/large/no_photo.png'},
    {photo_url:'http://rffk-roo.ru/uploads/people/large/photo.jpg'}])assert.equal(run(`officialPhoto(${JSON.stringify({...p,...fields})})`),'');
});
test('stable profile ID and conservative fallback when partial stats omit the URL',()=>{
  const p=player('Донской Илья',202);
  assert.equal(run(`playerKey(${JSON.stringify(p)})`),'rffk-202');
  const route={player:'rffk-202',playerName:'Донской Илья'};
  const partial={...p,profile_url:null};
  assert.equal(run(`findPlayer(${JSON.stringify(route)},${JSON.stringify([partial])})`).name,p.name);
  assert.equal(run(`findPlayer(${JSON.stringify(route)},${JSON.stringify([{...p,profile_url:'https://rffk-roo.ru/players/999/'}])})`),null);
});
test('unknown season metrics show dashes and missing protocols never claim zero goals',()=>{
  const p={...player('Донской Илья',202),league_games:null,league_goals:null,league_minutes:null,league_starts:null,league_substitutions:null,league_penalty_goals:null};
  vm.runInContext(`PLAYER_STATS_2026={season:2026,players:[${JSON.stringify(p)}]};RES=[['25 октября','ФК «Саки»',3,2,'','в гостях']];MATCH_DETAILS={};location.hash='#player=rffk-202';renderPlayer()`,context);
  const view=node('player').innerHTML;
  assert(view.includes('Это не означает, что футболист не забивал'));
  assert(view.includes('Список может быть неполным'));
  assert(!view.includes('голов: 0'));
  for(const field of ['league_games','league_goals','league_minutes','league_starts','league_substitutions','league_penalty_goals'])assert(view.includes(`data-stat="${field}"><b>—</b>`));
  assert(view.includes(`Всего игр в карточке РФФК: ${p.federation_games} · общий показатель федерации, не показатель сезона 2026.`));
});
test('missing and corrupted saved data do not break startup or invent profiles',()=>{
  for(const raw of [null,'broken json','{}','{"updated":"invalid"}']){
    context.localStorage={getItem(){return raw}};
    assert.doesNotThrow(()=>vm.runInContext('restoreSavedData()',context));
  }
  context.localStorage={getItem(){throw Error('Storage denied')}};
  assert.doesNotThrow(()=>vm.runInContext('restoreSavedData()',context));
});
test('saved dataset restores actual league stats and protocols without changing their timestamp',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
  context.localStorage={getItem(){return JSON.stringify(data)}};
  vm.runInContext('restoreSavedData()',context);
  assert.equal(run('lastDataTimestamp'),Date.parse(data.updated));
  assert.equal(run('hasSavedData'),true);
  assert.equal(run('playerRows().find(p=>p.name==="Донской Илья").league_goals'),5);
  assert.deepEqual(run('MATCH_DETAILS'),data.match_details);
});

test('squad keeps all 41 profile identities and only confirmed 2026 games/goals on cards',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
  const players=data.player_stats_2026.players;
  const before=JSON.stringify(data);
  vm.runInContext(`PLAYER_STATS_2026=${JSON.stringify(data.player_stats_2026)};PLAYER_ROLE='all';renderSquad()`,context);
  const view=node('squad').innerHTML;
  const cards=[...view.matchAll(/<a class="stats-player player-link"[\s\S]*?<\/a>/g)].map(m=>m[0]);
  assert.equal(cards.length,41);
  for(const p of players){
    const id=run(`playerKey(${JSON.stringify(p)})`);
    const card=cards.find(card=>card.includes(`data-player="${id}"`));
    assert(card,p.name);
    assert(card.includes(run(`esc(playerHref(${JSON.stringify(p)}))`)));
    assert(card.includes(`<div class="stats-name">${p.name}</div>`));
    assert(card.includes(`<div class="stats-role">${p.position}</div>`));
    for(const field of ['league_games','league_goals']){
      assert(card.includes(`data-stat="${field}"><b>${run(`statValue(${JSON.stringify(p[field])})`)}</b>`),p.name+' '+field);
    }
    for(const detail of ['league_minutes','league_penalty_goals','federation_games','Минуты','пенальти'])assert(!card.includes(detail));
    const photo=run(`officialPhoto(${JSON.stringify(p)})`);
    assert.equal(card.includes('<img '),!!photo,p.name);
    if(photo)assert(card.includes(`src="${photo}"`));
  }
  assert.equal(JSON.stringify(data),before);
  assert.deepEqual(run('PLAYER_STATS_2026.players'),players);
});

test('all position filters retain their exact players and profile role links',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
  for(const role of ['all','Вратари','Защитники','Полузащитники','Нападающие']){
    vm.runInContext(`PLAYER_STATS_2026=${JSON.stringify(data.player_stats_2026)};PLAYER_ROLE=${JSON.stringify(role)};renderSquad()`,context);
    const view=node('squad').innerHTML;
    const expected=data.player_stats_2026.players.filter(p=>role==='all'||p.position===role);
    assert.equal((view.match(/data-player=/g)||[]).length,expected.length);
    assert(view.includes(`data-role="${role}" aria-pressed="true"`));
    for(const p of expected)assert(view.includes(run(`esc(playerHref(${JSON.stringify(p)}))`)));
  }
});

test('squad rejects unverified portraits, escapes names and keeps unknown season totals as dashes',()=>{
  const p={...player('Иванов <Иван>',1),league_games:null,league_goals:null,
    photo_url:'https://rffk-roo.ru/uploads/people/large/unverified.jpg',photo_source_url:'https://rffk-roo.ru/players/2/'};
  vm.runInContext(`PLAYER_STATS_2026={season:2026,players:[${JSON.stringify(p)}]};PLAYER_ROLE='all';renderSquad()`,context);
  const view=node('squad').innerHTML;
  assert(!view.includes('<img '));
  assert(view.includes('Иванов &lt;Иван&gt;'));
  assert(!view.includes('Иванов <Иван>'));
  for(const field of ['league_games','league_goals'])assert(view.includes(`data-stat="${field}"><b>—</b>`));
  vm.runInContext('PLAYER_ROLE="Вратари";renderSquad()',context);
  assert(node('squad').innerHTML.includes('Игроки не найдены.'));
});

test('legacy offline squad data keeps every profile without borrowing federation games for 2026',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
  vm.runInContext(`PLAYER_STATS_2026=null;SQUAD=${JSON.stringify(data.squad)};PLAYER_ROLE='all';renderSquad()`,context);
  const view=node('squad').innerHTML;
  assert.equal((view.match(/data-player=/g)||[]).length,41);
  assert.equal((view.match(/data-stat="league_games"><b>—<\/b>/g)||[]).length,41);
  assert.equal((view.match(/data-stat="league_goals"><b>—<\/b>/g)||[]).length,41);
  assert(!view.includes('<img '));
});
