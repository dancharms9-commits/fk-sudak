const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,data,keys}=require('./data-refresh-harness.cjs');

const sudak='#player=rffk-202';
const contextual=sudak+'&team=141&competition=4&season=22';
const statFields=['league_games','league_goals','league_minutes','league_starts','league_substitutions','league_penalty_goals'];

function profile(snapshot=data()){
  const ui=setup({hash:sudak,stored:{[keys.data]:JSON.stringify(snapshot)}});
  const player=ui.node('player'),descriptor=Object.getOwnPropertyDescriptor(player,'innerHTML');
  const writes=[],imageEvents=new EventTarget();
  let photoRemoved=false;
  Object.defineProperty(player,'innerHTML',{
    ...descriptor,
    set(markup){writes.push(markup);descriptor.set.call(this,markup)},
  });
  player.querySelector=selector=>selector==='.player-avatar img'&&player.innerHTML.includes('<img')?
    {addEventListener:imageEvents.addEventListener.bind(imageEvents),remove(){photoRemoved=true}}:null;
  ui.context.document.querySelector=()=>null;
  ui.context.document.querySelectorAll=()=>[];
  ui.node('player-title').focus=()=>{};
  ui.context.matchesCalls=0;
  ui.run(`restoreSavedData();const originalPlayerMatchesHTML=playerMatchesHTML;
    playerMatchesHTML=function(p){matchesCalls++;return originalPlayerMatchesHTML(p)}`);
  return {ui,player,writes,imageEvents,photoRemoved:()=>photoRemoved};
}

test('opening the Sudak profile writes all statistics, goals, matches and links together',()=>{
  const snapshot=data();
  const playerData=snapshot.player_stats_2026.players.find(p=>p.profile_url==='https://rffk-roo.ru/players/202/');
  const {ui,player,writes}=profile(snapshot);
  ui.run('applyRoute()');
  assert.equal(writes.length,1);
  assert.equal(ui.context.matchesCalls,1);
  const markup=player.innerHTML;
  assert.match(markup,/<h2 id="player-title" tabindex="-1">Донской Илья<\/h2>/);
  assert.ok(markup.includes(`<p class="stats-role">${playerData.position}</p>`));
  assert.match(markup,/class="stats-source" href="https:\/\/rffk-roo\.ru\/players\/202\/"/);
  for(const field of statFields)assert.ok(markup.includes(`data-stat="${field}"><b>${playerData[field]??'—'}</b>`),field);

  assert.match(markup,/id="goal-coverage">По протоколам подтверждено голов:/);
  const goalLinks=[...markup.matchAll(/class="row match-link player-goal" href="([^"]+)"/g)];
  assert.ok(goalLinks.length>0);
  const matchLinks=[...markup.matchAll(/class="row match-link" data-match="(rffk-\d+)" href="([^"]+)"/g)];
  assert.ok(matchLinks.length>0);
  assert.ok(markup.indexOf('Голы в матчах')<markup.indexOf('Подтверждённые матчи'));
  for(const [,id,href] of matchLinks){
    ui.context.location.hash=href.replaceAll('&amp;','&');
    assert.equal(ui.run('currentRoute().key'),id);
    assert.equal(ui.run('routeParent(currentRoute())'),sudak);
  }
  for(const [,href] of goalLinks){
    ui.context.location.hash=href.replaceAll('&amp;','&');
    assert.equal(ui.run('currentRoute().origin'),'player');
    assert.equal(ui.run('new URLSearchParams(routeParent(currentRoute()).slice(1)).get("player")'),'rffk-202');
  }
});

test('the contextual Sudak profile preserves a confirmed number and unknown card statistics',()=>{
  const snapshot=data(),roster=snapshot.platform.rosters['4:22:141'];
  roster.entriesByPlayerId={...roster.entriesByPlayerId,'202':{...roster.entriesByPlayerId?.['202'],number:17}};
  const {ui,player,writes}=profile(snapshot);
  ui.context.location.hash=contextual;
  ui.run('applyRoute()');
  assert.equal(writes.length,1);
  assert.equal(ui.context.matchesCalls,1);
  assert.match(player.innerHTML,/<span class="tag">№ 17<\/span>/);
  for(const field of ['league_yellow_cards','league_second_yellow_cards','league_red_cards']){
    assert.ok(player.innerHTML.includes(`data-stat="${field}"><b>—</b>`),field);
  }
});

test('an absent player shows the back button and message without requesting match markup',()=>{
  const {ui,player,writes}=profile();
  ui.context.location.hash='#player=rffk-999999';
  ui.run('applyRoute()');
  assert.equal(writes.length,1);
  assert.equal(ui.context.matchesCalls,0);
  assert.match(player.innerHTML,/id="player-back">← К составу/);
  assert.match(player.innerHTML,/Футболист недоступен/);
  assert.doesNotMatch(player.innerHTML,/player-avatar|data-stat|data-match/);
});

test('the error handler keeps the portrait initials on the single rendered profile',()=>{
  const {ui,player,writes,imageEvents,photoRemoved}=profile();
  ui.context.location.hash='#player=rffk-1151';
  ui.run('applyRoute()');
  assert.match(player.innerHTML,/<span aria-hidden="true">СВ<\/span><img class="club-photo"/);
  assert.equal(photoRemoved(),false);
  imageEvents.dispatchEvent(new Event('error'));
  assert.equal(photoRemoved(),true);
  assert.equal(writes.length,1);
});

test('a newer data.json updates the open profile in one write and stale data cannot replace it',async()=>{
  const snapshot=data(),next=structuredClone(snapshot);
  next.updated=new Date(Date.parse(snapshot.updated)+60000).toISOString();
  next.player_stats_2026.players.find(p=>p.profile_url==='https://rffk-roo.ru/players/202/').league_minutes=null;
  const {ui,player,writes}=profile(snapshot);
  ui.run('applyRoute()');
  const links=markup=>[...markup.matchAll(/href="([^"]+)"/g)].map(([,href])=>href);
  const originalLinks=links(player.innerHTML);
  writes.length=0;
  ui.context.matchesCalls=0;
  ui.respond(next);await ui.run('refreshData(true)');
  assert.equal(writes.length,1);
  assert.equal(ui.context.matchesCalls,1);
  assert.match(player.innerHTML,/data-stat="league_minutes"><b>—<\/b>/);
  assert.deepEqual(links(player.innerHTML),originalLinks);
  assert.equal(ui.context.location.hash,sudak);

  ui.respond(snapshot);await ui.run('refreshData(true)');
  assert.equal(writes.length,1);
  assert.equal(ui.context.matchesCalls,1);
  assert.equal(JSON.parse(ui.values[keys.data]).updated,next.updated);
});
