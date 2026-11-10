const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1],data=JSON.parse(fs.readFileSync('data.json','utf8'));
function setup(input=data){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',addEventListener(){},querySelectorAll(){return []},querySelector(){return null}});return nodes.get(id)};
 const context=vm.createContext({URL,URLSearchParams,Intl,console,location:{hash:''},history:{state:{}},document:{getElementById:node},window:{addEventListener(){}},localStorage:{getItem(){return null},setItem(){}}});
 vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
 const run=s=>JSON.parse(JSON.stringify(vm.runInContext(s,context)));run(`adoptData(${JSON.stringify(input)});true`);return {run,node};
}
const known=Object.values(data.platform.matchesById),withProtocol=Object.values(data.platform.protocolsByMatchId)[0],match=data.platform.matchesById[withProtocol.matchId],key='rffk-'+match.sourceMatchId;
test('one adapter resolves all 11 clubs, official IDs and ID-less scheduled fixtures',()=>{
 const {run}=setup();const seen=new Set();
 for(const m of known){const model=run(`matchCenter(${JSON.stringify(m.sourceMatchId?'rffk-'+m.sourceMatchId:m.matchId)})`);assert(model);assert.equal(model.platformMatch.matchId,m.matchId);assert.deepEqual(model.scores,['finished','technical'].includes(m.status)?[m.homeScore,m.awayScore]:null);seen.add(m.homeTeamId);seen.add(m.awayTeamId)}
 assert.equal(seen.size,11);
});
test('unknown match IDs and unresolved clubs do not create invented match centers',()=>{
 const {run}=setup();for(const key of ['rffk-99999999','4:2026:1:0:141','1029','<script>'])assert.equal(run(`matchCenter(${JSON.stringify(key)})`),null);
});
test('future fixtures ignore any accidentally attached lineups or events',()=>{
 const d=structuredClone(data),m=Object.values(d.platform.matchesById).find(m=>m.status==='scheduled');d.platform.protocolsByMatchId[m.matchId]={...withProtocol,...m};
 const {run}=setup(d),model=run(`matchCenter(${JSON.stringify(m.matchId)})`);assert.equal(model.goals,null);assert.deepEqual(model.lineups,{});assert.deepEqual(model.events.items,[]);
});
test('incomplete goals do not hide independent cards or team sheets',()=>{
 const d=structuredClone(data),p=d.platform.protocolsByMatchId[match.matchId];p.goalsComplete=false;p.events=p.events.filter(e=>!['goal','penalty','own_goal'].includes(e.type));p.eventsComplete=false;
 const {run}=setup(d),model=run(`matchCenter('${key}')`);assert.equal(model.goals,null);assert(model.events.items.length);assert(Object.keys(model.lineups).length);assert.equal(model.events.complete,false);
});
test('text-only actors never become linked by surname; lineup IDs link both clubs',()=>{
 const {run}=setup();assert(!run(`matchPersonHTML('Колодяжный А.','home',matchCenter('${key}'),'x')`).includes('<a'));
 for(const side of ['home','away']){const entry=Object.values(withProtocol.lineups[side]).flat()[0];const value=run(`matchPersonHTML('Имя','${side}',matchCenter('${key}'),'x','${entry.sourceUrl}')`);assert(value.includes('data-player="rffk-'+entry.playerId+'"'));assert(value.includes('from=match'));}
});
test('player-to-match evidence comes only from the exact official match lineup',()=>{
 const {run}=setup(),pid=Object.values(withProtocol.lineups.home).flat()[0].playerId;
 const matches=run(`confirmedPlayerMatches('${pid}')`);assert(matches.some(m=>m.matchId===match.matchId));assert.deepEqual(run("confirmedPlayerMatches('99999999')"),[]);
 const d=structuredClone(data);for(const p of Object.values(d.platform.protocolsByMatchId))p.lineups={};
 const isolated=setup(d);assert.deepEqual(isolated.run(`confirmedPlayerMatches('${pid}')`),[]);
});
test('cancelled, postponed and technical status are independent of protocol availability',()=>{
 for(const status of ['postponed','cancelled','suspended','technical']){
  const d=structuredClone(data),m=d.platform.matchesById[match.matchId];m.status=status;if(status!=='technical')m.homeScore=m.awayScore=null;
  const {run}=setup(d),model=run(`matchCenter('${key}')`);assert(model.status);assert.equal(model.finished,status==='technical');
 }
});
test('direct links preserve club, player and match parents',()=>{
 const {run}=setup();
 run(`location.hash='#match=${key}&from=team&team=936';true`);assert.equal(run('routeParent(currentRoute())'),'#team=936');
 const parent='#player=rffk-202&team=141&competition=4&season=22&from=team';
 run(`location.hash='#match=${key}&from=player&player=rffk-202&profileRoute='+encodeURIComponent(${JSON.stringify(parent)});true`);assert.equal(run('routeParent(currentRoute())'),parent);
 run(`location.hash='#player=rffk-202&team=141&competition=4&season=22&from=match&back='+encodeURIComponent('#match=${key}');true`);assert.equal(run('routeParent(currentRoute())'),'#match='+key);
});
test('old Sudak routes and protocol contents still resolve',()=>{
 const {run}=setup();for(const row of data.res){const model=run(`matchCenter(${JSON.stringify([2026,row[0],row[1],row[5]].join('|'))})`);assert(model);assert(!model.platformMatch);assert.deepEqual(model.teams,row[5]==='дома'?['ФК «Судак»',row[1]]:[row[1],'ФК «Судак»']);}
});
test('official event categories, credited own goals and substitutions survive the shared adapter',()=>{
 const {run}=setup(),seen=new Set();
 for(const p of Object.values(data.platform.protocolsByMatchId)){
  const m=data.platform.matchesById[p.matchId],model=run(`platformMatchCenter(${JSON.stringify('rffk-'+m.sourceMatchId)})`);
  for(const e of model.events.items){seen.add(e.type);if(e.type==='own_goal'){assert.equal(run(`eventActorSide(${JSON.stringify(e)})`),e.side==='home'?'away':'home');assert.equal(e.playerId,null)}if(['goal','penalty','own_goal'].includes(e.type))assert(Array.isArray(e.score));}
 }
 for(const type of ['goal','penalty','own_goal','yellow','second_yellow','red','substitution_in','substitution_out'])assert(seen.has(type),type);
});
test('untrusted protocol identities cannot attach events or create a player membership',()=>{
 const d=structuredClone(data),p=d.platform.protocolsByMatchId[match.matchId];p.sourceMatchId='999999';
 const {run}=setup(d),model=run(`platformMatchCenter('${key}')`);assert.equal(model.protocol,null);assert.deepEqual(model.lineups,{});assert.deepEqual(model.events.items,[]);
});
