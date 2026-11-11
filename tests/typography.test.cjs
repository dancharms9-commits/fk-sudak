const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),read=name=>fs.readFileSync(path.join(root,name));
test('the offline sheet and reviewed visual baseline match the canonical typography source',()=>{
 const normalized=s=>s.toString().replace(/\r\n/g,'\n').trim();
 const css=normalized(read('typography.css')),html=read('index.html').toString();
 assert.equal(normalized(html.match(/<style data-typography-refresh>\s*([\s\S]*?)<\/style>/)[1]),css);
 assert.equal(normalized(read('tests/fixtures/typography-refresh.css')),css);
 assert.equal((css.match(/@font-face/g)||[]).length,3);
 assert(!/https?:|Roboto Condensed|fonts\.googleapis|fonts\.gstatic/.test(css));
 assert(!/Roboto Condensed|fonts\.googleapis|fonts\.gstatic/.test(html));
});
test('only the three licensed, complete IBM WOFF2 weights ship as application fonts',()=>{
 const manifest=JSON.parse(read('docs/typography-refresh/fonts.json'));
 assert.deepEqual(manifest.map(f=>f.weight).sort(),[400,600,700]);
 assert.equal(manifest.reduce((sum,f)=>sum+f.bytes,0),193092);
 for(const font of manifest){const bytes=read(font.file);assert.equal(bytes.subarray(0,4).toString(),'wOF2');assert.equal(bytes.length,font.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),font.sha256)}
 assert(read('assets/fonts/ibm-plex-sans/OFL.txt').toString().includes('SIL OPEN FONT LICENSE'));
 assert.deepEqual(fs.readdirSync(path.join(root,'assets/fonts/ibm-plex-sans')).sort(),['IBMPlexSans-Bold.woff2','IBMPlexSans-Regular.woff2','IBMPlexSans-SemiBold.woff2','OFL.txt']);
});
