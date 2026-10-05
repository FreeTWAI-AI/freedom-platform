import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {brokerBundleModules} from './broker-fixtures/bundle-modules.js';
let mf:Miniflare,directory:string;
before(async()=>{
  directory=await mkdtemp(resolve('.wrangler/broker-native-'));
  await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config','wrangler.broker.example.jsonc','--env','staging-next','--outdir',join(directory,'bundle')],{maxBuffer:1024*1024});
  await build({entryPoints:[resolve('tests/worker/broker-fixtures/provider-client.ts')],outfile:join(directory,'provider-client.mjs'),bundle:true,format:'esm',platform:'neutral',conditions:['workerd','worker','browser']});
  const provider=`let posts=0,gets=0;export default {async fetch(request){const url=new URL(request.url);if(url.pathname==='/counts')return Response.json({posts,gets});if(request.headers.get('Authorization')!=='Bearer SYNTHETIC_NATIVE_PROVIDER_ONLY')return new Response('',{status:401});if(url.pathname==='/redirect')return new Response('',{status:302,headers:{Location:'https://foreign.test/'}});if(url.pathname==='/oversize')return new Response('x'.repeat(32769),{headers:{'Content-Type':'application/json'}});if(request.method==='POST'){posts++;const body=await request.json();if(body.tools.length!==0)return new Response('',{status:400});return Response.json({output:'synthetic result'});}gets++;return Response.json({id:'synthetic',object:'model'});}};`;
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'provider-client',modules:true,scriptPath:join(directory,'provider-client.mjs'),compatibilityDate:'2026-09-21',outboundService:'synthetic-provider'},
    {name:'synthetic-provider',modules:true,script:provider,compatibilityDate:'2026-09-21'},
    {name:'broker',modules:brokerBundleModules(join(directory,'bundle')),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat']}]}));await mf.ready;
});
after(async()=>{await mf?.dispose();if(directory)await rm(directory,{recursive:true,force:true});});
async function provider(path:string,method:'GET'|'POST'='GET'){return (await mf.getWorker('provider-client')).fetch('https://fixture.test/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,method})});}
test('actual broker Wrangler bundle loads workerd and stays unavailable without explicit installation',async()=>{
  const bundle=await readFile(join(directory,'bundle/worker.js'),'utf8');assert(!/from ["']node:(?:http|https)["']/.test(bundle));assert(!bundle.includes('model-step-node-transport.ts'));
  const response=await(await mf.getWorker('broker')).fetch('https://freedom-private-ai.internal/internal/model-execution',{method:'POST'});assert.equal(response.status,503);
});
test('native Worker HTTPS provider GET and POST reach only the synthetic provider with bounded bytes',async()=>{
  assert.equal((await provider('/v1/models/synthetic')).status,200);const response=await provider('/v1/responses','POST');assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:200,body:'{"output":"synthetic result"}'});
  assert.deepEqual(await(await(await mf.getWorker('synthetic-provider')).fetch('https://api.openai.com/counts')).json(),{posts:1,gets:1});
});
test('native provider rejects redirect and oversized output without following or publishing',async()=>{
  for(const path of ['/redirect','/oversize'])assert.equal((await provider(path)).status,503);
});
