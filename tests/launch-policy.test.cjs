const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const policy=html.match(/<script data-launch-policy>([\s\S]*?)<\/script>/)[1];
function decide(performance){
  let removed=false;
  const document={documentElement:{dataset:{}},getElementById(id){assert.equal(id,'launch-canvas');return {remove(){removed=true}}}};
  vm.runInNewContext(policy,{performance,document,
    get sessionStorage(){throw Error('Storage unavailable')},get localStorage(){throw Error('Storage unavailable')}});
  return [document.documentElement.dataset.launch,removed];
}
test('fresh navigation shows splash even when storage is unavailable',()=>{
  assert.deepEqual(decide({getEntriesByType:()=>[{type:'navigate'}]}),['show',false]);
});
test('reload and history traversal remove launch canvas before body is parsed',()=>{
  for(const type of ['reload','back_forward'])assert.deepEqual(decide({getEntriesByType:()=>[{type}]}),['skip',true]);
});
test('Navigation Timing entry takes precedence over deprecated navigation type',()=>{
  assert.deepEqual(decide({getEntriesByType:()=>[{type:'reload'}],navigation:{type:0}}),['skip',true]);
});
test('legacy browser navigation type remains usable; unknown timing skips safely',()=>{
  for(const [type,expected] of [[0,'show'],[1,'skip'],[2,'skip'],[255,'skip']]){
    assert.equal(decide({navigation:{type}})[0],expected);
  }
  assert.deepEqual(decide({}),['skip',true]);
  assert.deepEqual(decide({getEntriesByType:()=>[]}),['skip',true]);
});
