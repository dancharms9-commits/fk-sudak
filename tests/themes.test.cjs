const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const policy=html.match(/<script data-theme-policy>([\s\S]*?)<\/script>/)[1];
const toggle=html.match(/<script data-theme-toggle>([\s\S]*?)<\/script>/)[1];
function app(saved,{denied=false}={}){
  const writes=[],attributes={},handlers={},root={dataset:{}},button={
    setAttribute(name,value){attributes[name]=value},
    addEventListener(name,handler){handlers[name]=handler}
  };
  const context=vm.createContext({document:{documentElement:root,getElementById(id){assert.equal(id,'theme-toggle');return button}},
    get localStorage(){if(denied)throw Error('Storage denied');return {
      getItem(key){assert.equal(key,'sudak-theme');return saved},
      setItem(key,value){writes.push([key,value])}
    }}});
  vm.runInContext(policy,context);vm.runInContext(toggle,context);
  return {root,button,writes,attributes,click:()=>handlers.click()};
}
test('fresh users start dark without relying on the operating system',()=>{
  const state=app(null);assert.equal(state.root.dataset.theme,'dark');
  assert.equal(state.attributes['aria-pressed'],'false');assert.deepEqual(state.writes,[]);
});
test('stored light and dark preferences are restored with the matching accessible state',()=>{
  for(const theme of ['light','dark']){
    const state=app(theme);assert.equal(state.root.dataset.theme,theme);
    assert.equal(state.attributes['aria-pressed'],String(theme==='light'));
  }
});
test('unsupported storage values fall back to dark',()=>{
  for(const value of ['',null,'system','LIGHT','undefined','__proto__'])assert.equal(app(value).root.dataset.theme,'dark');
});
test('the same control switches both ways and persists only the theme preference',()=>{
  const state=app('dark');state.click();assert.equal(state.root.dataset.theme,'light');
  assert.equal(state.attributes['aria-pressed'],'true');assert.match(state.button.title,/тёмную/);
  state.click();assert.equal(state.root.dataset.theme,'dark');assert.equal(state.attributes['aria-pressed'],'false');
  assert.deepEqual(state.writes,[['sudak-theme','light'],['sudak-theme','dark']]);
});
test('unavailable storage leaves the theme control usable',()=>{
  const state=app(null,{denied:true});assert.equal(state.root.dataset.theme,'dark');
  state.click();assert.equal(state.root.dataset.theme,'light');state.click();assert.equal(state.root.dataset.theme,'dark');
});
test('a reload resolves the last saved choice before application styles',()=>{
  const state=app(null);state.click();const rebooted=app(state.writes[0][1]);
  assert.equal(rebooted.root.dataset.theme,'light');
  assert(html.indexOf('<script data-theme-policy>')<html.indexOf('<style'));
});
