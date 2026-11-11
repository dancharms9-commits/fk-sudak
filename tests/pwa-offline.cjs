/* Playwright 1.48 only emulates SW fetch offline with its network manager on.
   Set this before requiring Playwright; it changes the test driver, not the PWA. */
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS='1';
const assert=require('node:assert/strict');
// Closing the local origin also covers a cold SW restart: 1.48 can retain a
// target whose protocol offline state was reset by Chromium restarting it.
exports.disconnectServer=async function disconnectServer(server){
 const address=server.address();
 await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});
 return ()=>new Promise(resolve=>server.listen(address.port,address.address,resolve));
};
exports.currentWorker=async function currentWorker(page,cacheName){
 await page.evaluate(async()=>{window.__testRegistration=await navigator.serviceWorker.getRegistration();await window.__testRegistration.update()});
 try{
  // 1.48's waitForFunction treats an async predicate's Promise as truthy even
  // when it resolves false. Poll native registration/controller state directly.
  await page.waitForFunction(()=>{
   const r=window.__testRegistration;
   return r?.active?.state==='activated'&&!r.installing&&!r.waiting&&navigator.serviceWorker.controller===r.active;
  });
  const cache=await page.evaluate(async name=>{
   const r=window.__testRegistration,c=await caches.open(name);
   return {keys:await caches.keys(),scope:r.scope,urls:(await c.keys()).map(r=>r.url)};
  },cacheName);
  assert.deepEqual(cache.keys.filter(k=>k.startsWith('sudak-')),[cacheName],'Only the activated shell cache remains');
  for(const file of ['', 'index.html',...['Regular','SemiBold','Bold'].map(w=>`assets/fonts/ibm-plex-sans/IBMPlexSans-${w}.woff2`)])assert(cache.urls.includes(new URL(file,cache.scope).href),'Precached '+file);
  return cache;
 }finally{await page.evaluate(()=>delete window.__testRegistration)}
};
