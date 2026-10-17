import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test,describe,before,beforeEach,after} from 'node:test';
import type {Pool} from 'pg';
import {Hono} from 'hono';
import type {PlatformEnv} from '../../apps/platform-api/src/module-context.js';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {runDueCommerceWork,runAfterResponseWork,detachAfterResponse} from '../../modules/agent-commerce/operations/due-work.js';
import {createFixtureQueryTransport} from '../../modules/agent-commerce/payments/query-transport.js';
import {CommerceCredentialKeyring} from '../../modules/agent-commerce/payments/credentials.js';
import {EcpayKeyPair,encodeForm,signFields} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {createWorkerHandler,type WorkerEnv} from '../../apps/platform-api/src/worker.js';
import {nodeRuntime} from '../../apps/platform-api/src/app.js';

const ring=()=>CommerceCredentialKeyring.parse('test:'+randomBytes(32).toString('base64'))!;
const transport=createFixtureQueryTransport(async()=>({kind:'error',code:'network'}),'local');
test('quarantine skips before claiming and a missing keyring claims only offline expiry',async()=>{
  const blocked={connect:()=>{throw Error('must not connect');}} as unknown as Pool;
  assert.equal((await runDueCommerceWork(blocked,{transport,freedomEnv:'local',quarantine:true,keyring:ring()})).claimed,0);
  let kinds:unknown;
  const pool={connect:async()=>({on(){},removeListener(){},release(){},query:async(sql:string,values:unknown[])=>{
    if(sql.startsWith('SELECT w.')){const filter=sql.match(/\bkind\s*=\s*ANY\(\$(\d+)::text\[\]\)/);kinds=values[Number(filter![1])-1];return {rows:[]};}
    return {rows:[]};
  }}),query:async()=>({rowCount:0})} as unknown as Pool;
  assert.equal((await runDueCommerceWork(pool,{transport,freedomEnv:'local',keyring:null})).claimed,0);
  assert.deepEqual(kinds,['offline_payment_window_end']);
});
test('claim filters exactly the handler kinds and leases only the returned rows',async()=>{
  const rows=[{due_work_id:'a',tenant_id:'b',target_id:'c',kind:'payment_query',token:'2026-10-16 00:00:00+00'},
    {due_work_id:'d',tenant_id:'e',target_id:'f',kind:'payment_window_end',token:'2026-10-16 00:00:00+00'}];
  let claims=0,leases=0;
  const pool={connect:async()=>({on(){},removeListener(){},release(){},query:async(sql:string,values:unknown[])=>{
    if(sql.startsWith('SELECT w.')){
      claims++;assert(sql.includes('FOR UPDATE SKIP LOCKED'));
      const filter=sql.match(/\bkind\s*=\s*ANY\(\$(\d+)::text\[\]\)/);assert(filter,'claim must exclude kinds without a handler');
      assert.deepEqual(values[Number(filter[1])-1],['payment_query','payment_window_end','offline_payment_window_end']);return {rows};
    }
    if(sql.startsWith('UPDATE commerce_due_work SET lease_until=')){
      leases++;assert(sql.includes('WHERE due_work_id=ANY($1::uuid[])'));assert.deepEqual(values[0],['a','d']);return {rows};
    }
    return {rows:[]};
  }}),query:async()=>({rowCount:1})} as unknown as Pool;
  const result=await runDueCommerceWork(pool,{transport,keyring:ring(),freedomEnv:'local'},{maxExternalCalls:0});
  assert.equal(claims,1);assert.equal(leases,1);assert.equal(result.claimed,2);assert.equal(result.released,2);assert.equal(result.unknown,0);
});
test('Node after-response work runs detached and logs only a fixed error',async()=>{
  let release!:()=>void,started=false;const waiting=new Promise<void>(r=>{release=r;}),logs:unknown[][]=[],original=console.error;
  console.error=(...args)=>{logs.push(args);};
  try{assert.equal(detachAfterResponse(async()=>{started=true;await waiting;throw Error('private');}),undefined);assert(started);release();await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(logs,[['commerce_after_response_failed']]);assert.equal(typeof nodeRuntime('local','http://127.0.0.1:4310').afterResponse,'function');}finally{console.error=original;}
});
test('after-response work has a bounded timeout and still handles late rejection',async()=>{
  let reject!:(error:Error)=>void;const pending=new Promise<void>((_r,no)=>{reject=no;});
  await runAfterResponseWork(()=>pending,1);reject(Error('private'));await Promise.resolve();
});
test('Worker keeps the pool open until every collected work item settles',async()=>{
  const calls:string[]=[],pending:Promise<unknown>[]=[];let release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});
  const pool={end:async()=>{calls.push('end');}} as unknown as Pool;
  const handler=createWorkerHandler({createPool:()=>pool,createApp:((_p,_o,_e,runtime)=>{
    const app=new Hono<PlatformEnv>();app.get('/test',c=>{runtime.afterResponse!(async()=>{calls.push('work');await waiting;calls.push('done');});return c.text('ok');});return app;
  }) as NonNullable<Parameters<typeof createWorkerHandler>[0]>['createApp']});
  const response=await handler.fetch(new Request('http://127.0.0.1:8787/test'),{FREEDOM_ENV:'local',APP_ORIGIN:'http://127.0.0.1:8787',HYPERDRIVE:{connectionString:'synthetic'},ASSETS:{fetch:async()=>new Response('missing',{status:404})}} as WorkerEnv,{waitUntil:p=>{pending.push(p);}});
  assert.equal(response.status,200);assert.deepEqual(calls,['work']);release();await Promise.all(pending);assert.deepEqual(calls,['work','done','end']);
});

describe('due-work database executor',()=>{
  let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
  type Placed=Awaited<ReturnType<typeof f.placed>>;
  before(async()=>{f=await hostedPaymentHarness('fp_commerce_due_work');});beforeEach(async()=>f.reset());after(async()=>f?.stop());
  async function due(){const p=await f.placed();await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p.payment.attempt_ref]);await f.x.h.pool.query("UPDATE commerce_due_work SET due_at=clock_timestamp()-interval '1 second' WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref]);return p;}
  async function fixture(ps:Placed[],call?:(p:Placed)=>Promise<void>){
    const entries=await Promise.all(ps.map(async p=>({p,trade:(await f.x.h.pool.query('SELECT merchant_trade_no FROM commerce_payment_attempts WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0].merchant_trade_no})));
    return createFixtureQueryTransport(async req=>{const trade=new URLSearchParams(req.bodyText()).get('MerchantTradeNo'),entry=entries.find(e=>e.trade===trade)!;assert(entry);await call?.(entry.p);return {kind:'response',status:200,body:encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:entry.trade,TradeStatus:'0'},EcpayKeyPair.of(entry.p.provider.material.hash_key,entry.p.provider.material.hash_iv),'sha256'))};},'local');
  }
  test('two concurrent runners claim different rows with SKIP LOCKED',async()=>{
    const ps=[await due(),await due()],seen=new Set<string>();let entered=0,release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});
    const t=await fixture(ps,async p=>{assert(!seen.has(p.payment.attempt_ref));seen.add(p.payment.attempt_ref);if(++entered===2)release();await waiting;});
    const results=await Promise.all([1,2].map(()=>runDueCommerceWork(f.x.runtime,{transport:t,keyring:f.ring,freedomEnv:'local'},{limit:1})));
    assert.equal(results.reduce((n,r)=>n+r.claimed,0),2);assert.equal(results.reduce((n,r)=>n+r.externalCalls,0),2);assert.equal(seen.size,2);
  });
  test('call budget releases remaining claims; targets and row limit bound selection',async()=>{
    const ps=[await due(),await due(),await due()],t=await fixture(ps);
    const result=await runDueCommerceWork(f.x.runtime,{transport:t,keyring:f.ring,freedomEnv:'local'},{limit:2,maxExternalCalls:1,targets:ps.slice(0,2).map(p=>p.payment.attempt_ref)});
    assert.equal(result.claimed,2);assert.equal(result.externalCalls,1);assert.equal(result.released,1);
    const rows=(await f.x.h.pool.query("SELECT * FROM commerce_due_work WHERE kind='payment_query' ORDER BY due_work_id")).rows;
    assert(rows.every(r=>!r.lease_until));assert.equal(rows.reduce((n,r)=>n+r.attempts,0),1);
  });
  test('deadline releases unstarted work without advancing its attempt count',async()=>{
    const ps=[await due(),await due()],original=Date.now;let elapsed=0;
    const t=await fixture(ps,async()=>{elapsed=1001;});Date.now=()=>original()+elapsed;
    try{const result=await runDueCommerceWork(f.x.runtime,{transport:t,keyring:f.ring,freedomEnv:'local'},{deadlineMs:1000});assert.equal(result.externalCalls,1);assert.equal(result.released,1);}finally{Date.now=original;}
  });
  test('each claimed tenant is bound separately under RLS',async()=>{
    const ps=[await due(),await due()],t=await fixture(ps),bindings:string[]=[],connect=f.x.runtime.connect;
    f.x.runtime.connect=(async()=>{const q=await (connect as Function).call(f.x.runtime),query=q.query,release=q.release;let tenant:string|undefined;
      q.query=(async(...args:unknown[])=>{const sql=String(args[0]);if(sql.includes("set_config('freedom.tenant_id', $1")){const id=(args[1] as string[])[0];assert(!tenant||tenant===id);tenant=id;bindings.push(id);}return (query as Function).apply(q,args);}) as typeof q.query;
      q.release=(error?:Error|boolean)=>{q.query=query;q.release=release;release.call(q,error);};return q;}) as typeof f.x.runtime.connect;
    try{const result=await runDueCommerceWork(f.x.runtime,{transport:t,keyring:f.ring,freedomEnv:'local'});assert.equal(result.externalCalls,2);assert(ps.every(p=>bindings.includes(p.s.tenantId)));}finally{f.x.runtime.connect=connect;}
  });
});
