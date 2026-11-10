const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
function setup(input=data){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',addEventListener(){},querySelectorAll(){return []},querySelector(){return null}});return nodes.get(id)};
 const context=vm.createContext({URL,URLSearchParams,Intl,console,location:{hash:''},history:{state:{}},
  document:{getElementById:node},window:{addEventListener(){}},localStorage:{getItem(){return null},setItem(){}}});
 vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
 const run=expression=>JSON.parse(JSON.stringify(vm.runInContext(expression,context)));
 run(`adoptData(${JSON.stringify(input)});true`);return {run,node};
}
function missingClubData(){
 const d=structuredClone(data);d.platform.rosters['4:22:936']={teamId:'936',competitionId:'4',seasonId:'22',playerIds:[],quality:{status:'not_checked',coverage:'unknown'}};
 d.platform.playerSeasonStats=Object.fromEntries(Object.entries(d.platform.playerSeasonStats).filter(([,s])=>s.teamId!=='936'));return d;
}
test('all eleven confirmed string IDs resolve in the pinned season, unknown IDs do not',()=>{
 const {run}=setup();assert.equal(run('CLUB_IDS.length'),11);
 for(const id of data.platform.competitionSeasons['4:22'].participantTeamIds)assert.equal(run(`clubContext('${id}').team.teamId`),id);
 for(const id of ['0','258','1029','__proto__','9999',936])assert.equal(run(`clubContext(${JSON.stringify(id)})`),null);
});
test('Kashtan uses full official standings and only ID-linked season matches',()=>{
 const {run}=setup();const m=run("clubContext('936',PLATFORM,Date.parse('2026-11-10T12:00:00Z'))");
 assert.equal(m.team.city,'Каштановое');assert.equal(m.standing.points,51);assert.equal(m.standing.played,17);
 assert.equal(m.results.length,5);assert(m.upcoming.length>0);
 for(const match of [...m.results,...m.upcoming]){assert([match.homeTeamId,match.awayTeamId].includes('936'));assert.equal(match.seasonId,'22')}
 assert.deepEqual(m.players.map(p=>p.playerId).sort(),[...data.platform.rosters['4:22:936'].playerIds].sort());assert(m.stats.every(s=>s.teamId==='936'));
});
test('same names, unresolved teams and other seasons cannot create club relationships',()=>{
 const d=structuredClone(data),matches=d.platform.matchesById;
 const template=structuredClone(Object.values(matches)[0]);
 matches.fake={...template,matchId:'fake',homeTeamId:'936',awayTeamId:'1029',date:'2026-11-09'};
 matches.other={...template,matchId:'other',homeTeamId:'936',seasonId:'99',date:'2026-11-09'};
 d.platform.teamsById['146'].name=d.platform.teamsById['936'].name;
 const {run}=setup(d);const ids=run("clubContext('936').results.map(m=>m.matchId)");assert(!ids.includes('fake'));assert(!ids.includes('other'));
});
test('scheduled unknown scores stay unknown and past, cancelled or postponed matches are not future fixtures',()=>{
 const d=structuredClone(data),m=Object.values(d.platform.matchesById).find(m=>m.homeTeamId==='936');
 d.platform.matchesById={};for(const [id,status,date] of [['future','scheduled','2026-11-28'],['past','scheduled','2026-10-01'],['later','postponed','2026-11-28'],['cancel','cancelled','2026-11-28']])d.platform.matchesById[id]={...m,matchId:id,status,date,homeScore:null,awayScore:null};
 const {run}=setup(d);assert.deepEqual(run("clubContext('936',PLATFORM,Date.parse('2026-11-10')).upcoming.map(m=>m.matchId)"),['future']);
 assert(!run("clubMatchHTML(PLATFORM.matchesById.future)").includes('0:0'));
});
test('empty roster copy describes import state, unavailable and unpublished are distinct',()=>{
 const {run,node}=setup(missingClubData());run("location.hash='#team=936';renderClub();true");const markup=node('team').innerHTML;
 assert(markup.includes('Загрузка этого раздела ещё не выполнена'));assert(!markup.includes('Источник не публикует'));
 assert(!markup.includes('Донской'));assert(!markup.includes('0 голов'));
 for(const status of ['stale','temporarily_unavailable','not_published','not_checked'])assert(run(`clubQuality({status:'${status}'},true)`).length>30);
 assert(run("clubQuality({status:'temporarily_unavailable'},true)").includes('временно недоступен'));
});
test('available roster and statistics require explicit team, season and player IDs; null stays a dash',()=>{
 const d=missingClubData(),player=d.platform.playersById['202'];
 d.platform.rosters['4:22:936']={...d.platform.rosters['4:22:141'],teamId:'936',playerIds:['202']};
 const s=d.platform.playerSeasonStats['202:141:4:22'];
 d.platform.playerSeasonStats['202:936:4:22']={...s,teamId:'936',games:null,goals:0,minutes:null};
 const {run,node}=setup(d);assert.equal(run("clubContext('936').players[0].playerId"),player.playerId);
 run("location.hash='#team=936';renderClub();true");assert(node('team').innerHTML.includes('Матчи: — · Голы: 0 · Минуты: —'));
 assert.equal(run("clubContext('936').stats.length"),1);
});
test('legacy, unsupported and invalid platform snapshots do not break Sudak or promote unknown participants',()=>{
 const {platform,...legacy}=data;const {run,node}=setup(legacy);assert.equal(run('PLATFORM'),null);
 run("CHAMP_STATE.view='standings';renderChampionship();true");assert(node('table').innerHTML.includes('90–21'));assert(!node('table').innerHTML.includes('data-team='));
 for(const patch of [{schemaVersion:2},{provider:'other'},{standings:{'4:22':{rows:{}}}},{teamsById:{...platform.teamsById,'936':{teamId:'936',name:5}}},{competitionSeasons:{'4:22':{...platform.competitionSeasons['4:22'],participantTeamIds:[...platform.competitionSeasons['4:22'].participantTeamIds,'1029']}}}]){
  assert.equal(run(`clubPlatform(${JSON.stringify({...platform,...patch})})`),null);
 }
});
test('bad optional refresh keeps last good platform while accepting legacy updates',()=>{
 const {run}=setup();run(`adoptData(${JSON.stringify({...data,platform:{schemaVersion:2},coach:'Updated'})});true`);
 assert.equal(run("platformTeam('936').teamId"),'936');assert.equal(run('COACH'),'Updated');
});
test('Sudak alias uses existing home, unknown team uses safe club screen, direct routes are stable',()=>{
 const {run}=setup();for(const [hash,section] of [['#team=141','home'],['#team=936','team'],['#team=1029','team'],['#home','home']]){run(`location.hash='${hash}';true`);assert.equal(run('currentRoute().section'),section)}
});
test('registry fields and unsafe URLs cannot inject markup or create external club redirects',()=>{
 const d=structuredClone(data);d.platform.teamsById['936'].name='<img src=x onerror=alert(1)>';
 d.platform.teamsById['936'].sourceUrl='https://evil.test/teams/936/';
 const {run,node}=setup(d);run("location.hash='#team=936';renderClub();true");assert(node('team').innerHTML.includes('&lt;img'));
 assert(!node('team').innerHTML.includes('href="https://evil'));assert(!run("clubLink('1029','Unknown',true)").includes('<a'));
 assert.equal(run("clubOfficialURL('https://rffk-roo.ru/teams/936/?x=1','teams','936')"),'');
});
test('local official badges have exact source hashes and no Sudak assets are substituted',()=>{
 const crypto=require('node:crypto'),manifest=JSON.parse(fs.readFileSync(path.join(root,'assets/clubs/sources.json'),'utf8'));
 assert.equal(manifest.logos.length,10);const {run}=setup();
 for(const logo of manifest.logos){assert.equal(logo.registryLogoUrl,data.platform.teamsById[logo.teamId].branding.officialLogoUrl);assert.equal(logo.sourceUrl,logo.registryLogoUrl.replace('/small/','/medium/'));const raw=fs.readFileSync(path.join(root,'assets/clubs',logo.teamId+'.png'));assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),logo.sha256);assert.equal(run(`clubLogo('${logo.teamId}')`),'assets/clubs/'+logo.teamId+'.png')}
 assert.equal(run("clubLogo('141')"),'icon-192.png?v=final-crest-v7');
});

test('match-center club links require the exact protocol ID, date and score, keeping stale aliases harmless',()=>{
 const {run,node}=setup(),key=Object.keys(data.platform.legacyLinks.matches)[0];
 run(`location.hash='#match='+encodeURIComponent(${JSON.stringify(key)})+'&from=matches';renderMatch();true`);
 assert(node('match').innerHTML.includes('data-team='));
 run(`PLATFORM.matchesById[PLATFORM.legacyLinks.matches[${JSON.stringify(key)}]].homeScore=999;renderMatch();true`);
 assert(!node('match').innerHTML.includes('data-team='));
});
