const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,data,keys}=require('./data-refresh-harness.cjs');
const {measurePages}=require('./rffk-membership-harness.cjs');

// The previous full-scan selector, used as a reference for the same snapshot.
function scanMembership(platform,id,teamId){
  const roster=platform.rosters['4:22:'+teamId];
  if(!roster)return null;
  const registrations=Object.values(platform.registrations||{}).filter(
    reg=>reg.playerId===id&&reg.teamId===teamId&&reg.roleKind!=='staff');
  const confirmed=roster.playerIds?.includes(id);
  if(!confirmed&&!roster.clubPlayerIds?.includes(id)&&!registrations.length)return null;
  const stored=roster.entriesByPlayerId?.[id];
  const entry=stored?.currentlyListed===false?null:stored;
  const season=registrations.filter(reg=>reg.scope==='competition_season'&&reg.competitionId==='4'&&reg.seasonId==='22');
  const positions=[...new Set(season.map(reg=>reg.position).filter(Boolean))];
  const numbers=[...new Set(season.map(reg=>reg.number).filter(Number.isInteger))];
  const club=registrations.filter(reg=>reg.scope==='club');
  const historical=roster.historicalPlayerIds?.includes(id)||
    (club.length>0&&club.every(reg=>reg.releasedAt&&reg.releasedAt<'2026-01-01'));
  return {teamId,position:entry?.position||(positions.length===1?positions[0]:null),
    number:entry?.number??(numbers.length===1?numbers[0]:null),registrations,
    state:confirmed?(teamId==='141'&&roster.quality?.reason==='imported_snapshot'?'legacy':'confirmed'):
      historical?'historical':'unverified'};
}

const id='1698';
const profile='#player=rffk-1698&team=117&competition=4&season=22&from=team';
function fixture(registrations){
  const snapshot=data();
  for(const roster of Object.values(snapshot.platform.rosters)){
    for(const key of ['playerIds','clubPlayerIds','historicalPlayerIds','unverifiedPlayerIds']){
      if(roster[key])roster[key]=roster[key].filter(playerId=>playerId!==id);
    }
    delete roster.entriesByPlayerId?.[id];
  }
  snapshot.platform.registrations=registrations;
  return snapshot;
}
function registration(registrationId,teamId,fields={}){
  return {registrationId,playerId:id,teamId,roleKind:'player',scope:'club',
    registeredAt:'2025-02-01',releasedAt:null,...fields};
}
function adopt(ui,snapshot){
  ui.context.snapshot=snapshot;
  ui.run('adoptData(snapshot)');
}
const registrationIds=markup=>[...markup.matchAll(/data-registration="([^"]+)"/g)].map(match=>match[1]);

test('indexed membership matches the full-scan selector for the published players and clubs',()=>{
  const snapshot=data();
  const ui=setup();
  adopt(ui,snapshot);
  const platform=snapshot.platform;
  const all=Object.values(platform.registrations);
  const ids=[...new Set([...Object.keys(platform.playersById),...all.map(reg=>reg.playerId),'999999'])];
  const teams=ui.run('CLUB_IDS');
  for(const playerId of ids){
    ui.context.playerId=playerId;
    const memberships=structuredClone(ui.run('CLUB_IDS.map(teamId=>platformMembership(playerId,teamId))'));
    for(const [i,teamId] of teams.entries())assert.deepEqual(memberships[i],scanMembership(platform,playerId,teamId),`${playerId}:${teamId}`);
    const registrations=ui.run('platformPlayerRegistrations(playerId)?.all||[]');
    assert.deepEqual(structuredClone(registrations),all.filter(reg=>reg.playerId===playerId),playerId);
  }
});

test('club periods and season entries keep their order and staff appears only in the full list',()=>{
  const snapshot=fixture({
    history:registration('history','117',{releasedAt:'2025-10-01',number:99,position:'Нападающий'}),
    staff:registration('staff','936',{roleKind:'staff',number:1,position:'Тренер'}),
    season:registration('season','146',{scope:'competition_season',competitionId:'4',seasonId:'22',number:7,position:'Защитник'}),
    club:registration('club','146',{number:11,position:'Вратарь'}),
  });
  const photoUrl='https://rffk-roo.ru/uploads/people/large/verified.jpg';
  Object.assign(snapshot.platform.playersById[id],{photoUrl,photoSourceUrl:'https://rffk-roo.ru/teams/146/'});
  const ui=setup({hash:profile});
  adopt(ui,snapshot);
  const previous=teamId=>scanMembership(snapshot.platform,id,teamId);
  for(const teamId of ['117','146','936']){
    assert.deepEqual(structuredClone(ui.run(`platformMembership('${id}','${teamId}')`)),previous(teamId));
  }
  assert.equal(ui.run(`platformMembership('${id}','117')`).state,'historical');
  assert.equal(ui.run(`platformMembership('${id}','117')`).number,null);
  const other=ui.run(`platformMembership('${id}','146')`);
  assert.equal(other.state,'unverified');
  assert.equal(other.number,7);
  assert.equal(other.position,'Защитник');
  assert.equal(ui.run(`platformMembership('${id}','936')`),null);
  ui.run('renderPlayer()');
  const markup=ui.node('player').innerHTML;
  assert.deepEqual(registrationIds(markup),['history','staff','season','club']);
  assert.match(markup,/Историческая связь с клубом/);
  assert.match(markup,/Дата отзаявки не опубликована/);
  assert.match(markup,/Сезонная регистрация · чемпионат 2026/);
  assert.match(markup,/Клубная связь · сотрудник/);
  assert.match(markup,/data-platform-player="1698:146"/);
  assert.doesNotMatch(markup,/data-platform-player="1698:936"/);
  assert.equal(ui.run('officialPhoto(findPlayer(currentRoute()))'),photoUrl);
  const staffPhoto=structuredClone(snapshot);
  staffPhoto.platform.playersById[id].photoSourceUrl='https://rffk-roo.ru/teams/936/';
  adopt(ui,staffPhoto);
  assert.equal(ui.run('officialPhoto(findPlayer(currentRoute()))'),'');
});

test('missing or empty registration maps preserve missing data and roster-only membership',()=>{
  const ui=setup({hash:'#player=rffk-1698'});
  for(const registrations of [undefined,{}]){
    const snapshot=data();
    snapshot.platform.registrations=registrations;
    adopt(ui,snapshot);
    assert.equal(ui.run(`platformMembership('${id}','117').state`),'confirmed');
    assert.equal(ui.run("platformMembership('999999','117')"),null);
    assert.equal(ui.run("platformProfile({player:'rffk-999999'})"),null);
    ui.run('renderPlayer()');
    assert.match(ui.node('player').innerHTML,/Подтверждённых регистраций в приложении пока нет/);
    assert.deepEqual(registrationIds(ui.node('player').innerHTML),[]);
  }
});

test('network adoption and saved-data restoration replace registration lookups and rendered periods',async()=>{
  const original=fixture({old:registration('old','117'),removed:registration('removed','146')});
  const ui=setup({hash:profile,stored:{[keys.data]:JSON.stringify(original)}});
  const expectPeriods=ids=>assert.deepEqual(registrationIds(ui.node('player').innerHTML),ids);
  ui.run('restoreSavedData();renderPlayer()');
  expectPeriods(['old','removed']);
  assert.equal(ui.run(`platformMembership('${id}','146').state`),'unverified');

  const revised=fixture({new:registration('new','117',{releasedAt:'2025-12-31'})});
  revised.updated=new Date(Date.parse(original.updated)+1000).toISOString();
  ui.respond(revised);
  await ui.run('refreshData(true)');
  expectPeriods(['new']);
  assert.equal(ui.run(`platformMembership('${id}','117').state`),'historical');
  assert.equal(ui.run(`platformMembership('${id}','146')`),null);
  ui.respond(original);
  await ui.run('refreshData(true)');
  expectPeriods(['new']);

  const recovered=fixture({restored:registration('restored','117')});
  recovered.updated=new Date(Date.parse(revised.updated)+1000).toISOString();
  ui.values[keys.data]=JSON.stringify(recovered);
  ui.run('restoreSavedData();renderPlayer()');
  expectPeriods(['restored']);
  assert.equal(ui.run(`platformMembership('${id}','117').state`),'unverified');
});

test('production routes scan the full registration map once per snapshot',()=>{
  const {registrations,rows}=measurePages();
  assert(registrations>0);
  for(const {hash,adoption,firstOpen,reopen,markup} of rows){
    assert(markup.length>0,hash);
    assert.equal(adoption+firstOpen,1,hash);
    assert.equal(reopen,0,hash);
  }
});
