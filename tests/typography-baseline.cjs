/* Reviewed visual baseline migration: apply ONLY the frozen typography sheet
   to the old HTML, then retain every existing geometry/pixel assertion. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const normalized=s=>s.replace(/\r\n/g,'\n').trim();
const approved=normalized(fs.readFileSync(path.join(__dirname,'fixtures/typography-refresh.css'),'utf8'));
module.exports=function typographyBaseline(html){
 const current=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 const block=current.match(/<style data-typography-refresh>\s*([\s\S]*?)<\/style>/);
 assert(block,'Typography must remain in the offline HTML');
 assert.equal(normalized(block[1]),approved,'Typography differs from the explicitly reviewed visual baseline');
 const source=html.toString();
 const previous=source.match(/<style data-typography-refresh>\s*([\s\S]*?)<\/style>/);
 if(previous){assert.equal(normalized(previous[1]),approved,'Review a changed typography baseline explicitly');return source}
 return source.replace('</head>',`<style data-typography-refresh>\n${approved}\n</style>\n</head>`);
};
