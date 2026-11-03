const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){},querySelector(){return null}});return nodes.get(id)};
const context=vm.createContext({URL,URLSearchParams,console,location:{hash:''},history:{state:{}},document:{getElementById:node},window:{addEventListener(){}},localStorage:{getItem(){return null}}});
vm.runInContext(source.slice(0,source.lastIndexOf('\nrestoreSavedData();')),context);
const run=expression=>JSON.parse(JSON.stringify(vm.runInContext(expression,context)));
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
const key=r=>[2026,r[0],r[1],r[5]].join('|');
const first=data.res[0],firstKey=key(first);
const model=(rows=data.res,next=data.next,details=data.match_details,id=firstKey)=>run(`matchCenter(${JSON.stringify(id)},${JSON.stringify(rows)},${JSON.stringify(next)},${JSON.stringify(details)})`);

test('all real protocols retain correct home/away scores and official source identity',()=>{
  const before=JSON.stringify(data);
  for(const row of data.res){
    const m=model(data.res,data.next,data.match_details,key(row));
    assert(m.finished);assert.equal(m.status,'Завершён');assert.equal(m.source,data.match_details[key(row)].source_url);
    assert.deepEqual(m.scores,row[5]==='дома'?[row[2],row[3]]:[row[3],row[2]]);
    assert.equal(m.goals.length,row[2]+row[3]);
  }
  assert.equal(JSON.stringify(data),before);
});
test('future match without time or stadium has no artificial score or extra blocks',()=>{
  const next=[['14 ноября','УОР','','в гостях']],id=key(['14 ноября','УОР',null,null,'','в гостях']);
  const m=model([],next,{},id);assert.equal(m.finished,false);assert.equal(m.scores,null);assert.equal(m.time,'');assert.equal(m.venue,'');
  assert.deepEqual(m.events.items,[]);assert.deepEqual(m.lineups,{});
  for(const fn of ['matchGoalsHTML','matchEventsHTML','matchLineupsHTML'])assert.equal(run(`${fn}(${JSON.stringify(m)})`),'');
});
test('unavailable or mismatched protocol never supplies scorers, venue, time or foreign source',()=>{
  for(const fields of [{home:'Другой клуб'},{date:'2025-10-25'},{home_score:99},{id:'999999'}]){
    const details={[firstKey]:{...data.match_details[firstKey],...fields}};
    const m=model(data.res,data.next,details);assert.equal(m.detail,null);assert.equal(m.source,'');assert.equal(m.goals,null);assert.equal(m.time,'');
  }
  const m=model(data.res,data.next,{[firstKey]:{...data.match_details[firstKey],status:'unavailable'}});
  assert.equal(m.goals,null);assert(m.source);
});
test('goals retain repeat authors and penalty/own-goal types; invalid progression is rejected',()=>{
  const d=structuredClone(data.match_details[firstKey]);
  assert.equal(run(`confirmedMatchGoals(${JSON.stringify(d)},[2,3])`).filter(g=>g.player==='Донской И.').length,2);
  d.goals[0].type='own_goal';delete d.events;
  const goals=run(`confirmedMatchGoals(${JSON.stringify(d)},[2,3])`);assert.equal(goals[0].type,'own_goal');
  assert.equal(run(`eventActorSide(${JSON.stringify(goals[0])})`),'away');
  d.goals[1].score=[99,0];assert.equal(run(`confirmedMatchGoals(${JSON.stringify(d)},[2,3])`),null);
});
test('missing event minutes stay unknown; no invented timing or full chronology',()=>{
  const d=structuredClone(data.match_details[firstKey]);delete d.events;delete d.goals[0].minute;
  const m=model(data.res,data.next,{[firstKey]:d});assert.equal(m.goals[0].minute,null);
  assert.equal(m.events.complete,false);
  const view=run(`matchEventsHTML(${JSON.stringify(m)})`);assert(view.includes('Подтверждённые события'));assert(!view.includes('class="center-timeline is-timed"'));
  for(const value of ['0','121','45+99','неизвестно'])assert.equal(run(`matchMinute(${JSON.stringify(value)})`),null);
  assert.equal(run('matchMinute("45+2")'),'45+2');
});
test('unknown or inconsistent extended events fall back to actual confirmed goals',()=>{
  const d=structuredClone(data.match_details[firstKey]);d.events[0].type='invented';
  const m=model(data.res,data.next,{[firstKey]:d});assert.equal(m.events.complete,false);assert(!m.events.items.some(e=>e.type==='invented'));
  d.events=d.events.filter(e=>e.type!=='goal');assert.equal(model(data.res,data.next,{[firstKey]:d}).events.items.length,d.goals.length);
});
test('homonymous initials do not create profile links; official lineup IDs disambiguate exact identities',()=>{
  const players=[{name:'Иванов Иван',profile_url:'https://rffk-roo.ru/players/1/'},{name:'Иванов Игорь',profile_url:'https://rffk-roo.ru/players/2/'}];
  const base={clubSide:'home',lineups:{}};
  const resolve=(name,side,m=base)=>run(`matchPlayer(${JSON.stringify(name)},${JSON.stringify(side)},${JSON.stringify(m)},${JSON.stringify(players)})`);
  assert.equal(resolve('Иванов И.','home'),null);assert.equal(resolve('Иванов','home'),null);assert.equal(resolve('Иванов Иван','away'),null);
  assert.equal(resolve('Иванов Иван','home').profile_url,players[0].profile_url);
  const m={...base,lineups:{home:{starters:[players[1]]}}};assert.equal(resolve('Иванов И.','home',m).profile_url,players[1].profile_url);
  m.lineups.home.starters.push(players[0]);assert.equal(resolve('Иванов И.','home',m),null);
  m.lineups.home.starters=[{...players[1],profile_url:'https://rffk-roo.ru/players/99/'}];assert.equal(resolve('Иванов И.','home',m),null);
});
test('missing optional lineup URLs cannot recurse or invent profiles',()=>{
  const m={clubSide:'home',lineups:{home:{starters:[{name:'Иванов Иван',profile_url:''}]}}};
  assert.equal(run(`matchPlayer('Иванов И.','home',${JSON.stringify(m)},[{name:'Иванов Иван'}])`).name,'Иванов Иван');
  assert.equal(run(`matchPlayer('Иванов И.','home',${JSON.stringify(m)},[])`),null);
});
test('empty goals and missing optional data produce no empty timeline/lineup/statistics',()=>{
  const d={...data.match_details[firstKey],goals:[],events:[],lineups:{}};
  const rows=[['25 октября',first[1],0,0,'',first[5]]];d.home_score=0;d.away_score=0;
  const m=model(rows,[],{[firstKey]:d});
  assert(run(`matchGoalsHTML(${JSON.stringify(m)})`).includes('В этом матче голов не было'));
  assert.equal(run(`matchEventsHTML(${JSON.stringify(m)})`),'');assert.equal(run(`matchLineupsHTML(${JSON.stringify(m)})`),'');
  const noProtocol=model(data.res,[],{});assert.equal(noProtocol.goals,null);assert.equal(noProtocol.events.items.length,0);
});
test('cancelled and postponed states require explicit matching data',()=>{
  const n=['14 ноября','УОР','','в гостях'],r=[n[0],n[1],null,null,n[2],n[3]],id=key(r);
  for(const [status,label] of [['cancelled','Отменён'],['postponed','Перенесён']]){
    const m=model([],[n],{[id]:{date:'2026-11-14',home:'УОР',away:'ФК «Судак»',match_status:status}},id);
    assert.equal(m.status,label);assert.equal(m.scores,null);
  }
});
test('match-to-player parent survives a direct route and player goal deep links',()=>{
  const parent='#match='+encodeURIComponent(firstKey)+'&from=home';
  context.location.hash='#player=rffk-202&from=match&back='+encodeURIComponent(parent);
  assert.equal(run('routeParent(currentRoute())'),parent);
  context.location.hash='#match='+encodeURIComponent(firstKey)+'&from=player&player=rffk-202&name='+encodeURIComponent('Донской Илья')+'&role=all&profileFrom=match&profileBack='+encodeURIComponent(parent);
  const profile=run('routeParent(currentRoute())');assert(profile.includes('&from=match&back='));
  assert.equal(run('matchParentHash("javascript:alert(1)")'),'');
});
test('names are escaped and only approved club art is rendered',()=>{
  const m=model();m.goals[0].player='<script>alert(1)</script>';
  const view=run(`matchGoalsHTML(${JSON.stringify(m)})`);
  assert(!view.includes('<script>'));assert(view.includes('&lt;script&gt;'));
});

test('unknown fixture date is omitted rather than turned into an invented date',()=>{
  const n=['дата уточняется','УОР','','дома'],id=key([n[0],n[1],null,null,n[2],n[3]]);
  assert.equal(model([],[n],{},id).date,'');
});
