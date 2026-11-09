const w=require('@prisma/prisma-schema-wasm');const fs=require('fs');
const f=process.argv[2];const s=fs.readFileSync(f,'utf8');
try{ w.validate(JSON.stringify({prismaSchema:s,noColor:true})); console.log('VALID'); }
catch(e){ console.log(String(e.message||e).slice(0,4000)); }
