const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1],data=JSON.parse(fs.readFileSync(path.join(root,'data.json')));
function setup(input=data){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',addEventListener(){},querySelectorAll(){return []},querySelector(){return null}});return nodes.get(id)};
 const context=vm.createContext({URL,URLSearchParams,Intl,console,location:{hash:''},history:{state:{}},document:{getElementById:node},window:{addEventListener(){}},localStorage:{getItem(){return null},setItem(){}}});
 vm.runInContext(script.slice(0,script.lastIndexOf('\nrestoreSavedData();')),context);
 const run=s=>JSON.parse(JSON.stringify(vm.runInContext(s,context)));run(`adoptData(${JSON.stringify(input)});true`);return {run,node};
}
test('three primary stats retain source zero and missing data, secondary stats retain all six fields',()=>{
 const d=structuredClone(data);d.platform.playerSeasonStats['146:936:4:22'].minutes=null;
 const {run,node}=setup(d);run("location.hash=platformPlayerHref('146','936');renderPlayer();true");
 const m=node('player').innerHTML,primary=m.split('<div class="profile-values">')[1].split('</div><dl')[0];
 assert.deepEqual([...primary.matchAll(/data-stat="([^"]+)"/g)].map(m=>m[1]),['league_games','league_minutes','league_goals']);
 assert(primary.includes('data-stat="league_minutes"><b>—</b>'));assert(primary.includes('data-stat="league_goals"><b>0</b>'));
 assert.equal([...m.matchAll(/data-stat=/g)].length,9);assert(m.includes('Регистрация и источники РФФК'));
});
test('all published registration periods remain separate with human dates and exact club links',()=>{
 const {run,node}=setup();run("location.hash=platformPlayerHref('1698','117');renderPlayer();true");const m=node('player').innerHTML;
 const regs=Object.values(data.platform.registrations).filter(r=>r.playerId==='1698');
 for(const r of regs)assert(m.includes(`data-registration="${r.registrationId}"`));
 assert(m.includes('24 марта 2026'));assert(m.includes('1 сентября 2026'));assert(!m.includes('2026-09-04</'));
 assert(m.includes('data-team="117"'));assert(m.includes('data-team="146"'));
 assert(m.includes('Последнее подтверждение'));assert(m.includes('Дата отзаявки не опубликована'));
});
test('source success is labelled as a check, missing timestamps never claim a fresh update',()=>{
 const {run}=setup();
 const m=run("footballSources([['Состав',{status:'stale',coverage:'partial',lastSuccessAt:'2026-11-10T12:00:00Z'}]])");
 assert(m.includes('проверено 10 ноября 2026'));assert(m.includes('Последняя успешная проверка'));assert(!m.includes('обновлено'));
 assert(run("footballWarnings([['Состав',{status:'temporarily_unavailable',coverage:'partial'}]])").includes('Данные неполные'));
 assert(run("footballSources([['Состав',{status:'not_checked'}]])").includes('время проверки не указано'));
 assert.equal(run("footballDate(null)"),'дата не опубликована');
 const grouped=run("footballSources([['Профиль',{status:'current',reason:'profile'}],['Регистрации',{status:'current',reason:'registration'}],['Регистрации',{status:'current',reason:'season'}]])");assert.equal((grouped.match(/<li>/g)||[]).length,1);assert(grouped.includes('Профиль / Регистрации'));
 const d=structuredClone(data);delete d.platform.rosters['4:22:936'];const absent=setup(d);absent.run("location.hash='#team=936';renderClub();true");assert(absent.node('team').innerHTML.includes('Состав пока не загружен в приложение'));
});
test('ambiguous registrations warn outside disclosure and never invent disputed periods',()=>{
 const {run,node}=setup();run("location.hash=platformPlayerHref('1928','146');renderPlayer();true");const m=node('player').innerHTML;
 assert(m.indexOf('Сведения о заявках РФФК неоднозначны')<m.indexOf('<details'));
 assert(m.includes('несовместимые сведения о периоде регистрации'));assert(m.includes('строка источника 3'));
 assert.equal([...m.matchAll(/data-registration=/g)].length,Object.values(data.platform.registrations).filter(r=>r.playerId==='1928').length);
});
test('compact confirmed matches use only official lineup identity and preserve center route and parent',()=>{
 const {run}=setup();run("location.hash=platformPlayerHref('146','936');true");
 const matches=run("confirmedPlayerMatches('146')"),markup=run('polishedPlayerMatches(findPlayer(currentRoute()))');
 assert.equal([...markup.matchAll(/class="player-confirmed-match /g)].length,matches.length);
 for(const m of matches)assert(markup.includes('data-match="'+run(`platformMatchKey(${JSON.stringify(m)})`)+'"'));
 assert(markup.includes('profileRoute='));assert(markup.includes('Список может быть неполным'));
});
