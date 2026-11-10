const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
function setup(input=data){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',addEventListener(){},querySelectorAll(){return []},querySelector(){return null}});return nodes.get(id)};
 const context=vm.createContext({URL,URLSearchParams,Intl,console,location:{hash:''},history:{state:{}},document:{getElementById:node},window:{addEventListener(){}},localStorage:{getItem(){return null},setItem(){}}});
 vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
 const run=s=>JSON.parse(JSON.stringify(vm.runInContext(s,context)));run(`adoptData(${JSON.stringify(input)});true`);return {run,node};
}
test('eleven rosters keep unique string identities, foreign links stay internal with explicit season context',()=>{
 const {run}=setup();
 for(const [key,r] of Object.entries(data.platform.rosters)){
  assert.equal(new Set(r.playerIds).size,r.playerIds.length);
  if(r.teamId==='141')continue;
  const markup=run(`platformRosterHTML('${r.teamId}')`);assert(markup.includes('data-platform-player='));
  assert(markup.includes('competition=4&amp;season=22'));assert(!markup.includes('target="_blank"'));
  for(const id of [...r.playerIds,...(r.clubPlayerIds||[])])assert.equal(typeof id,'string');
 }
});
test('actual transfer player has independent UOR and Saki numbers and the exact club return route',()=>{
 const {run}=setup();
 for(const [team,goals,minutes] of [['117',1,337],['146',6,445]]){
  run(`location.hash=platformPlayerHref('1698','${team}');true`);const p=run('findPlayer(currentRoute())');
  assert.equal(p.league_games,5);assert.equal(p.league_goals,goals);assert.equal(p.league_minutes,minutes);
  assert.equal(run('routeParent(currentRoute())'),'#team='+team);assert.equal(p._platform.membership.state,'confirmed');
 }
});
test('legacy Sudak routes retain the original enriched player and goal behavior',()=>{
 const {run,node}=setup();run("location.hash='#player=rffk-202&name=x&from=home';renderPlayer();true");
 assert.equal(run('findPlayer(currentRoute()).name'),'Донской Илья');
 assert.equal(run('Boolean(findPlayer(currentRoute())._platform)'),false);
 assert(node('player').innerHTML.includes('Голы в матчах'));assert.equal(run('routeParent(currentRoute())'),'#home');
 assert.equal(run("platformMembership('676','141').state"),'historical','Past Sudak affiliations are not the preserved 41-player roster');
});
test('unknown IDs, unassociated teams and other seasons cannot borrow a known player statistics record',()=>{
 const {run}=setup();
 for(const route of [{player:'rffk-999999',teamId:'936',competitionId:'4',seasonId:'22'},{player:'rffk-1698',teamId:'1029',competitionId:'4',seasonId:'22'},{player:'rffk-1698',teamId:'117',competitionId:'63',seasonId:'22'},{player:'rffk-1698',teamId:'117',competitionId:'4',seasonId:'20'}])assert.equal(run(`platformProfile(${JSON.stringify(route)})`),null);
 const bare=run("platformProfile({player:'rffk-1698'})");assert.equal(bare.league_goals,null);assert.equal(bare._platform.teamId,null);
});
test('missing individual values stay dashes, real zero cards survive the shared renderer',()=>{
 const d=structuredClone(data);d.platform.playerSeasonStats['1698:117:4:22'].minutes=null;
 const {run,node}=setup(d);run("location.hash=platformPlayerHref('1698','117');renderPlayer();true");const m=node('player').innerHTML;
 assert(m.includes('data-stat="league_minutes"><b>—</b>'));assert(m.includes('data-stat="league_yellow_cards"><b>0</b>'));
 assert(!m.includes('Голы в матчах'));assert(!m.includes('общий показатель федерации'));
 assert(m.includes('Карточка футболиста на сайте РФФК'));assert(m.includes('loading="lazy"'));
});
test('published position grouping never infers an unknown role; historical and unverified lists stay distinct',()=>{
 const d=structuredClone(data),r=d.platform.rosters['4:22:936'];
 const ids=r.clubPlayerIds.slice(0,2);r.playerIds=[];r.historicalPlayerIds=[ids[0]];r.unverifiedPlayerIds=[ids[1]];
 for(const id of ids)r.entriesByPlayerId[id].position=null;
 d.platform.registrations=Object.fromEntries(Object.entries(d.platform.registrations).filter(([,r])=>!ids.includes(r.playerId)));
 const {run}=setup(d),m=run("platformRosterHTML('936')");
 assert(m.includes('Исторические регистрации: 1'));assert(m.includes('сезон не подтверждён: 1'));assert(m.includes('Амплуа не указано'));
 assert.equal(run(`platformMembership('${ids[0]}','936').state`),'historical');
});
test('profile HTML escapes names and position and accepts photos only from official identity sources',()=>{
 const d=structuredClone(data);d.platform.playersById['1698'].name='<img src=x onerror=fail()>';
 d.platform.playersById['1698'].photoUrl='https://evil.test/photo.jpg';
 const {run,node}=setup(d);run("location.hash=platformPlayerHref('1698','117');renderPlayer();true");
 assert(node('player').innerHTML.includes('&lt;img'));assert(!node('player').innerHTML.includes('src="https://evil'));
});

test('historical jerseys and staff jobs cannot become player metadata for season 2026',()=>{
 const d=structuredClone(data),r=d.platform.rosters['4:22:117'],id='1698';
 r.playerIds=r.playerIds.filter(pid=>pid!==id);r.historicalPlayerIds=[id];
 r.unverifiedPlayerIds=r.unverifiedPlayerIds.filter(pid=>pid!==id);
 r.entriesByPlayerId[id]={...r.entriesByPlayerId[id],currentlyListed:false,number:7,position:'Нападающий'};
 d.platform.registrations=Object.fromEntries(Object.entries(d.platform.registrations).filter(([,reg])=>reg.playerId!==id||reg.teamId!=='117'));
 d.platform.registrations.fixture={playerId:id,teamId:'117',scope:'club',roleKind:'player',number:99,position:'Нападающий',registeredAt:'2018-01-01',releasedAt:'2018-12-31'};
 d.platform.registrations.staff={playerId:id,teamId:'117',scope:'club',roleKind:'staff',number:1,position:'Тренер',registeredAt:'2026-01-01',releasedAt:null};
 const {run}=setup(d),m=run("platformMembership('1698','117')");
 assert.equal(m.state,'historical');assert.equal(m.number,null);assert.equal(m.position,null);
 assert.equal(m.registrations.some(reg=>reg.roleKind==='staff'),false);
});
