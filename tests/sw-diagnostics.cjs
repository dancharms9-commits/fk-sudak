/* Observe the real SW/navigation without changing fetch handlers or timeouts. */
const fs=require('node:fs'),path=require('node:path');
const bounded=promise=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Diagnostic evaluation unavailable')),2000);promise.then(v=>{clearTimeout(timer);resolve(v)},e=>{clearTimeout(timer);reject(e)})});
module.exports=async function swDiagnostics(context,page,directory){
 const out=path.resolve(directory||'_state/sw-diagnostics');fs.mkdirSync(out,{recursive:true});
 const start=Date.now(),events=[],record=(type,detail)=>events.push({ms:Date.now()-start,type,...detail});
 const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Page.enable');await cdp.send('Page.setLifecycleEventsEnabled',{enabled:true});
 context.on('serviceworker',w=>{record('worker-created',{url:w.url()});w.on('close',()=>record('worker-closed',{url:w.url()}))});
 context.on('request',r=>record('request',{url:r.url(),navigation:r.isNavigationRequest()}));
 context.on('requestfailed',r=>record('request-failed',{url:r.url(),failure:r.failure()}));
 context.on('response',r=>record('response',{url:r.url(),status:r.status(),fromServiceWorker:r.fromServiceWorker()}));
 page.on('pageerror',e=>record('page-error',{message:e.message}));page.on('console',m=>{if(m.type()==='error')record('console-error',{message:m.text()})});
 page.on('domcontentloaded',()=>record('domcontentloaded',{url:page.url()}));
 cdp.on('Network.requestWillBeSent',e=>{if(e.type==='Document')record('document-request',e)});cdp.on('Network.loadingFailed',e=>record('network-failed',e));cdp.on('Page.lifecycleEvent',e=>record('lifecycle',e));
 await context.tracing.start({screenshots:true,snapshots:true,sources:true});
 return {record,async snapshot(label){
  const workers=[];for(const w of context.serviceWorkers())try{workers.push(await bounded(w.evaluate(()=>({url:location.href,cache:typeof CACHE==='string'?CACHE:null})))) }catch(e){workers.push({error:e.message})}
  const state=await bounded(page.evaluate(async()=>({url:location.href,readyState:document.readyState,online:navigator.onLine,controller:navigator.serviceWorker.controller?{url:navigator.serviceWorker.controller.scriptURL,state:navigator.serviceWorker.controller.state}:null,registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>({scope:r.scope,active:r.active?.state,installing:r.installing?.state,waiting:r.waiting?.state})),caches:await Promise.all((await caches.keys()).map(async key=>({key,urls:(await (await caches.open(key)).keys()).map(r=>r.url)})))})));record('snapshot',{label,workers,...state});
  console.log('SW DIAGNOSTIC',label,JSON.stringify({workers,controller:state.controller,registrations:state.registrations,caches:state.caches.map(c=>({key:c.key,entries:c.urls.length})),online:state.online}));
 },async finish(error){
  if(error){record('failure',{message:error.message});try{record('frame-tree',await bounded(cdp.send('Page.getFrameTree')));await bounded(cdp.send('Page.stopLoading'));await this.snapshot('after-stop-loading')}catch(e){record('diagnostic-error',{message:e.message})}}
  fs.writeFileSync(path.join(out,'sw-navigation.json'),JSON.stringify({platform:process.platform,node:process.version,experimentalNetworkEvents:process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS||null,events},null,2)+'\n');
  await context.tracing.stop({path:path.join(out,'sw-navigation.zip')});
 }};
};
