/* Use production Python validation/import, without writing production JSON. */
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const generated=spawnSync(process.env.PYTHON||'python',['-c',`
import sys,json,io
from contextlib import redirect_stdout
sys.path.insert(0,'tests')
from test_rffk_refresh import baseline,refresh
with redirect_stdout(io.StringIO()):
    old=baseline()
    new=refresh(old)
print(json.dumps({'old':old,'new':new}))
`],{cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8',maxBuffer:16*1024*1024});
assert.equal(generated.status,0,generated.stderr);
module.exports=JSON.parse(generated.stdout);
