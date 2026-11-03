// Production selectors and HTML: no parallel source of football statistics.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const nodes=new Map();
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){},querySelector(){return null}});return nodes.get(id)};
const context=vm.createContext({URL,URLSearchParams,console,location:{hash:''},history:{state:{}},
  document:{getElementById:node},window:{addEventListener(){}},localStorage:{getItem(){return null}}});
vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
const run=expression=>JSON.parse(JSON.stringify(vm.runInContext(expression,context)));
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const now=Date.parse('2026-11-04T12:00:00Z');
const select=(next=data.next,res=data.res,at=now)=>run(`homeMatches(${JSON.stringify(next)},${JSON.stringify(res)},${at})`);

test('real calendar: nearest future and last completed result are selected without mutating data',()=>{
  const before=JSON.stringify(data);
  const selected=select([...data.next].reverse(),[...data.res].reverse());
  assert.deepEqual(selected.next,data.next[0]);assert.deepEqual(selected.latest,data.res[0]);
  assert.equal(JSON.stringify(data),before);
});
test('past fixtures, unknown dates, another season and unconfirmed scores are not promoted',()=>{
  const next=[['3 ноября','Вчера','','дома'],['31 февраля','Неверно','','дома'],['5 ноября 2025','Прошлый сезон','','дома'],['дата уточняется','Без даты','','дома']];
  const results=[['3 ноября','Без счёта',null,null,'','дома'],['2 ноября','Ничья',0,0,'','дома'],['5 ноября','Завтра',3,1,'','дома']];
  const selected=select(next,results);
  assert.equal(selected.next,null);assert.equal(selected.latest[1],'Ничья');assert.equal(select([],[]).latest,null);
});
test('a fixture without a kickoff stays upcoming throughout its club-local day',()=>{
  const next=[['4 ноября','Сегодня','','дома'],['5 ноября','Завтра','','в гостях']];
  assert.equal(select(next,[] ,Date.parse('2026-11-04T20:59:00Z')).next[1],'Сегодня');
  assert.equal(select(next,[] ,Date.parse('2026-11-04T21:00:00Z')).next[1],'Завтра');
});
test('no future games: latest result is the single featured match, missing calendar is safe',()=>{
  const result=select([],data.res);assert.equal(result.next,null);assert.deepEqual(result.latest,data.res[0]);
  assert.equal(select([],[]).completed.length,0);
});
test('real standing and goal difference come only from the existing table',()=>{
  assert.deepEqual(run(`homeStanding(${JSON.stringify(data.table)})`),{place:2,games:16,points:40,difference:33});
  assert.equal(run('homeStanding([])'),null);
  assert.equal(run('homeStanding([["Судак-2",16,"1–0",40]])'),null);
  assert.deepEqual(run('homeStanding([["ФК «Судак»",null,null,null]])'),{place:1,games:null,points:null,difference:null});
  assert.equal(run('homeStanding([["ФК «Судак»",0,"0:2",0]])').difference,-2);
});
test('leaders use season goals, appearances and minutes, keeping every tied player',()=>{
  const players=data.player_stats_2026.players;
  const leaders=run(`homeLeaders(${JSON.stringify(players)})`);
  for(const leader of leaders){
    const known=players.filter(p=>Number.isInteger(p[leader.field])&&p[leader.field]>=0);
    const maximum=Math.max(...known.map(p=>p[leader.field]));
    assert.equal(leader.value,maximum);
    assert.deepEqual(leader.players.map(p=>p.name).sort(),known.filter(p=>p[leader.field]===maximum).map(p=>p.name).sort());
    assert.equal(leader.partial,known.length<players.length);
  }
  assert.equal(leaders[0].value,10);
  const tie=run('homeLeaders([{name:"Б",league_games:7},{name:"А",league_games:7}])')[1];
  assert.equal(tie.players.length,2);assert.deepEqual(tie.players.map(p=>p.name),['А','Б']);
});
test('unknown, zero and federation totals never create a false leader',()=>{
  for(const players of [[],[{name:'А',federation_games:100}],[{name:'А',league_goals:0,league_games:null,league_minutes:-1}]]){
    assert(run(`homeLeaders(${JSON.stringify(players)})`).every(l=>l.players.length===0));
  }
});
test('news sorts actual publications, validates source links and never fabricates dates',()=>{
  const rows=[['','Без даты','','https://rffk-roo.ru/news/4/'],['1 ноября','Раньше','','https://rffk-roo.ru/news/2/'],['3 ноября','Позже','','https://rffk-roo.ru/news/3/'],['4 ноября','Чужой источник','','https://evil.test/news/1/']];
  assert.deepEqual(run(`homeNews(${JSON.stringify(rows)})`).map(n=>n[1]),['Позже','Раньше','Без даты']);
  assert.equal(run(`homeNews(${JSON.stringify(data.news)})`).length,3);
  assert.deepEqual(run('homeNews([])'),[]);
});
test('upcoming card uses existing match identity; missing time/stadium are not invented',()=>{
  const card=run('homeMatchCard(["14 ноября","УОР","","в гостях"],true)');
  assert(card.includes('data-match="2026|14 ноября|УОР|в гостях"'));
  assert(card.includes('&amp;from=home'));assert(card.includes('Время уточняется'));
  assert(!card.includes('00:00'));assert(!card.includes('Стадион'));assert(!card.includes('0 : 0'));
  assert(card.indexOf('<span>УОР</span>')<card.indexOf('<span>ФК «Судак»</span>'));
  assert(!run('homeMatchCard(["14 ноября","УОР","","в гостях"],true,false)').includes('<a '));
});
test('completed match shows home/away score correctly and escapes untrusted fields',()=>{
  const card=run('homeMatchCard(["3 ноября","<Соперник>",3,2,"","в гостях"])');
  assert(card.includes('2 : 3'));assert(card.includes('Завершён · Победа'));
  assert(card.includes('&lt;Соперник&gt;'));assert(!card.includes('<Соперник>'));
});
test('leader cards use confirmed photos and route existing profiles back to home',()=>{
  const p=data.player_stats_2026.players.find(p=>p.photo_url);
  const before=JSON.stringify(p);
  const card=run(`homeLeaderCard({field:'league_goals',label:'Бомбардиры',unit:'гол.',value:10,partial:false,players:[${JSON.stringify(p)}]})`);
  assert(card.includes('data-player="rffk-'));assert(card.includes('&amp;from=home'));
  assert(card.includes(p.photo_url));assert.equal(JSON.stringify(p),before);
  const invalid={...p,photo_source_url:'https://rffk-roo.ru/players/999999/'};
  assert(!run(`homeLeaderCard({label:'Лидер',unit:'гол.',value:10,players:[${JSON.stringify(invalid)}]})`).includes('<img '));
});
test('direct home profile route has a home parent, preserving squad route semantics',()=>{
  context.location.hash='#player=rffk-202&from=home';
  assert.equal(run('routeParent(currentRoute())'),'#home');
  context.location.hash='#player=rffk-202&role=all';
  assert.equal(run('routeParent(currentRoute())'),'#squad&role=all');
});

test('result outcome distinguishes draws and defeats, including away games',()=>{
  assert.equal(run('homeOutcome(["3 ноября","А",0,0,"","дома"])'),'Ничья');
  assert.equal(run('homeOutcome(["3 ноября","А",1,2,"","в гостях"])'),'Поражение');
});
