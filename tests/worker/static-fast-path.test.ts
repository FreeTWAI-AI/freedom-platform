import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {createWorkerHandler,workerRuntime,type WorkerEnv} from '../../apps/platform-api/src/worker.js';
import {createPlatformApp} from '../../apps/platform-api/src/platform-app.js';

const origin='http://127.0.0.1:8787',file='/assets/app-abcdefgh.js';
function harness({full=false,fail=false,missing=false}:{full?:boolean;fail?:boolean;missing?:boolean}={}){
  let runtimes=0,apps=0,ended=0;const seen:string[]=[],pending:Promise<unknown>[]=[];
  const pool={async query(){throw new Error('database unavailable');},async end(){ended++;}} as unknown as Pool;
  const env:WorkerEnv={FREEDOM_ENV:fail?'staging':'local',APP_ORIGIN:fail?'https://staging-next.freetwai.com':origin,FREEDOM_RELEASE_SHA:'a'.repeat(40),FREEDOM_DATABASE_NAME:'fixture',HYPERDRIVE:{connectionString:'unused'},FREEDOM_PRIVATE_AI_ENABLED:full?'true':undefined,
    ASSETS:{async fetch(request){const path=new URL(request.url).pathname;seen.push(path);
      if(missing&&path!=='/')return new Response('missing',{status:404});
      return new Response(request.method==='HEAD'?null:new Uint8Array([0,1,127,255]),{headers:{'Content-Type':path.endsWith('.ico')?'image/x-icon':'text/javascript','Cache-Control':'public, max-age=3600','Content-Security-Policy':'unsafe','Referrer-Policy':'unsafe','X-Content-Type-Options':'unsafe','Set-Cookie':'bad=1','ETag':'"fixture"','Content-Length':'4','X-Asset-Metadata':'kept'}});
    }}};
  const handler=createWorkerHandler({createPool:()=>pool,createRuntime:(...args)=>{runtimes++;return workerRuntime(...args);},createApp:(...args)=>{apps++;return createPlatformApp(...args);}});
  return {env,seen,counts:()=>({runtimes,apps,ended}),async call(path:string,init?:RequestInit){const response=await handler.fetch(new Request(env.APP_ORIGIN+path,init),env,{waitUntil:p=>pending.push(p)});await Promise.all(pending);return response;}};
}

test('GET/HEAD build files and favicon exactly match full-app bytes, status and headers without runtime/app construction',async()=>{
  for(const path of [file,'/assets/theme-12345678.css','/assets/font-abcdefgh.woff2','/favicon.ico'])for(const method of ['GET','HEAD']){
    const fast=harness(),full=harness({full:true});const a=await fast.call(path,{method}),b=await full.call(path,{method});
    assert.equal(a.status,b.status);assert.deepEqual([...a.headers],[...b.headers]);assert.deepEqual(new Uint8Array(await a.arrayBuffer()),new Uint8Array(await b.arrayBuffer()));
    assert.deepEqual(fast.counts(),{runtimes:0,apps:0,ended:1});assert.deepEqual(full.counts(),{runtimes:1,apps:1,ended:1});
    assert.equal(a.headers.get('set-cookie'),null);assert.equal(a.headers.get('cache-control'),path==='/favicon.ico'?'no-store':'public, max-age=31536000, immutable');assert.equal(a.headers.get('x-asset-metadata'),'kept');
  }
});
test('reserved routes, navigation, unknown paths and non-GET methods retain full-app precedence even with shadow files',async()=>{
  for(const path of ['/api/v1/health','/api/unknown','/guilds','/unknown','/public/guide-packs/test/file.webp','/admin','/development/skills/example','/services','/highlights','/events/example','/member-cards/'+'a'.repeat(43),'/assets/app.js','/assets/a%2fb-abcdefgh.js']){
    const fast=harness(),full=harness({full:true});const a=await fast.call(path),b=await full.call(path);
    assert.equal(a.status,b.status,path);assert.deepEqual([...a.headers],[...b.headers],path);assert.equal(await a.text(),await b.text(),path);assert.equal(fast.counts().apps,1,path);
  }
  for(const method of ['POST','OPTIONS']){const h=harness();await h.call(file,{method});assert.equal(h.counts().apps,1);assert.deepEqual(h.seen,[]);}
});
test('404 file probes preserve shell fallback and ambiguous cookies preserve middleware rejection',async()=>{
  const fast=harness({missing:true}),full=harness({full:true,missing:true});const a=await fast.call(file),b=await full.call(file);
  assert.equal(a.status,b.status);assert.deepEqual([...a.headers],[...b.headers]);assert.equal(await a.text(),await b.text());assert.equal(fast.counts().apps,1);
  assert.equal(a.headers.get('cache-control'),'no-store','a missing hashed filename must not cache its shell fallback');
  const h=harness();const denied=await h.call(file,{headers:{Cookie:'freedom_local_session=a; freedom_local_session=b'}});assert.equal(denied.status,403);assert.deepEqual(h.seen,[]);assert.equal(h.counts().apps,1);
});
test('readiness and host failures still block file delivery before assets/runtime/app',async()=>{
  const h=harness({fail:true});const response=await h.call(file);assert.equal(response.status,503);assert.deepEqual(h.seen,[]);assert.deepEqual(h.counts(),{runtimes:0,apps:0,ended:1});
  const fast=harness();fast.env.APP_ORIGIN='http://localhost:8787';const handler=createWorkerHandler({createPool:()=>{throw new Error('must not open');}});const rejected=await handler.fetch(new Request(origin+file),fast.env,{waitUntil(){}});assert.equal(rejected.status,403);assert.deepEqual(fast.seen,[]);
});
