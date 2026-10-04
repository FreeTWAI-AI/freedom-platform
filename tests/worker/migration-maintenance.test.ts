import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
// @ts-expect-error Canonical tooling is JavaScript without a declaration file.
import {verificationEnvironment} from '../../packages/contribution-tools/process-env.mjs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const CONFIG='wrangler.migration-maintenance.example.jsonc';
const MESSAGE='自由工坊正在進行資料庫維護，暫停服務與寫入，請稍後再試。\n';
const MARKER='reflect-marker-7f3a';
const directory=await mkdtemp(join(tmpdir(),'fp-migration-maintenance-bundle-'));
let source:string;
try{await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config',CONFIG,'--outdir',directory],{env:{...verificationEnvironment(),WRANGLER_SEND_METRICS:'false',XDG_CONFIG_HOME:join(directory,'config')},timeout:30000,maxBuffer:262144});source=await readFile(join(directory,'worker.js'),'utf8');}finally{await rm(directory,{recursive:true,force:true});}

test('config attaches nothing by default and declares no bindings, secrets or crons',async()=>{
 // Only whole-line comments are used in this config, so stripping them yields strict JSON.
 const config=JSON.parse((await readFile(CONFIG,'utf8')).split('\n').filter(line=>!line.trim().startsWith('//')).join('\n'));
 assert.deepEqual(Object.keys(config).sort(),['compatibility_date','main','name','preview_urls','routes','triggers','workers_dev']);
 assert.equal(config.main,'apps/migration-maintenance/src/worker.ts');
 assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
 assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers,{crons:[]});
 assert.doesNotMatch(source,/^\s*import\s/m);
});

test('source handler itself emits no HEAD body, independent of runtime HEAD stripping',async()=>{
 const worker=(await import('../../apps/migration-maintenance/src/worker.js')).default;
 const head=worker.fetch(new Request('https://freetwai.example/api/x',{method:'HEAD'}));
 assert.equal(head.status,503);assert.equal(head.body,null);
 const get=worker.fetch(new Request('https://freetwai.example/api/x'));
 assert.equal(get.status,503);assert.equal(await get.text(),MESSAGE);
});

test('actual workerd returns the same fixed no-store 503 for every method and path without reflecting input',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:source,compatibilityDate:'2026-09-21'}));
 try{
  const paths=['/','/login','/api/members/me?next=/'+MARKER,'/api/auth/session','/assets/index-'+MARKER+'.js','/favicon.ico',
   '/webhooks/github','/api/webhooks/seller?event='+MARKER,'/%3Cscript%3E'+MARKER,'/.well-known/security.txt'];
  const methods=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','PURGE'];
  for(const path of paths)for(const method of methods){
   const hasBody=!['GET','HEAD'].includes(method);
   const response=await mf.dispatchFetch('https://freetwai.example'+path,{method,body:hasBody?JSON.stringify({marker:MARKER}):undefined,headers:{
    Accept:path.startsWith('/api')?'application/json':'text/html',Cookie:'session='+MARKER,Authorization:'Bearer '+MARKER,
    Origin:'https://'+MARKER+'.example','X-Forwarded-Host':MARKER+'.example','X-Hub-Signature-256':'sha256='+MARKER,
    ...(hasBody?{'Content-Type':'application/json'}:{})}});
   const label=`${method} ${path}`,body=await response.text();
   assert.equal(response.status,503,label);
   assert.equal(response.headers.get('retry-after'),'600',label);
   assert.equal(response.headers.get('cache-control'),'no-store',label);
   assert.equal(response.headers.get('content-type'),'text/plain; charset=utf-8',label);
   assert.equal(response.headers.get('x-content-type-options'),'nosniff',label);
   assert.equal(response.headers.get('set-cookie'),null,label);
   assert.equal(body,method==='HEAD'?'':MESSAGE,label);
   for(const [name,value] of response.headers)assert.equal(value.includes(MARKER),false,`${label} header ${name}`);
  }
 }finally{await mf.dispose();}
});
