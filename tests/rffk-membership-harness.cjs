const {setup,data}=require('./data-refresh-harness.cjs');

const pages=[
  {hash:'#team=936',section:'team'},
  {hash:'#team=146',section:'team'},
  {hash:'#player=rffk-146&team=936&competition=4&season=22&from=team',section:'player'},
  {hash:'#player=rffk-1698&team=117&competition=4&season=22&from=team',section:'player'},
  {hash:'#player=rffk-1698',section:'player'},
  {hash:'#match=rffk-38771&from=table',section:'match'},
];

function openPage(ui,hash){
  ui.context.location.hash=hash;
  ui.run('applyRoute()');
}

function measurePages(html){
  const snapshot=data();
  const registrations=Object.keys(snapshot.platform.registrations).length;
  const rows=pages.map(({hash,section})=>{
    let scans=0;
    const registrationsProxy=new Proxy(snapshot.platform.registrations,{
      ownKeys(target){scans++;return Reflect.ownKeys(target)}
    });
    const ui=setup({html});
    ui.context.document.querySelector=()=>null;
    ui.context.document.querySelectorAll=()=>[];
    const node=ui.node(section);
    ui.node(section+'-title').focus=()=>{};
    ui.node('home-title').focus=()=>{};
    ui.context.snapshot={...snapshot,platform:{...snapshot.platform,registrations:registrationsProxy}};
    ui.run('adoptData(snapshot)');
    const adoption=scans;
    openPage(ui,hash);
    const firstOpen=scans-adoption;
    openPage(ui,'#home');
    openPage(ui,hash);
    return {hash,adoption,firstOpen,reopen:scans-adoption-firstOpen,markup:node.innerHTML};
  });
  return {registrations,rows};
}

module.exports={measurePages};
if(require.main===module){
  const assert=require('node:assert/strict');
  const current=measurePages();
  console.log(`Registrations in data.json: ${current.registrations}`);
  const baseline=process.env.RFFK_BASE_HTML?measurePages(process.env.RFFK_BASE_HTML):null;
  console.table(current.rows.map(({markup,...row},i)=>{
    if(!baseline)return row;
    const before=baseline.rows[i];
    assert.equal(markup,before.markup,`Markup for ${row.hash}`);
    return {hash:row.hash,adoption:`${before.adoption} → ${row.adoption}`,
      firstOpen:`${before.firstOpen} → ${row.firstOpen}`,reopen:`${before.reopen} → ${row.reopen}`};
  }));
  if(baseline)console.log('Rendered markup matches the baseline for every route.');
}
