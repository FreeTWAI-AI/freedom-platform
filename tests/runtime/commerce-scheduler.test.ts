import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {createWorkerHandler,type WorkerEnv} from '../../apps/platform-api/src/worker.js';
// These scheduler tests isolate job boundaries; real offline expiry runs in its own PG tests.
const idleDueWork=async()=>({claimed:0,completed:0,failed:0,externalCalls:0,released:0,unknown:0});
for(const settings of [{},{FREEDOM_COMMERCE_CHECKOUT_ENABLED:'false'},{FREEDOM_COMMERCE_CHECKOUT_ENABLED:'true',FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true',FREEDOM_SUPPLIER_CONSOLE_ENABLED:'true'},{FREEDOM_COMMERCE_QUARANTINE:'true'},{FREEDOM_COMMERCE_QUARANTINE:'synthetic-secret'}])test(`scheduler commerce settings ${JSON.stringify(settings)}`,async()=>{
  const calls:string[]=[],logs:string[]=[],pending:Promise<unknown>[]=[];const original=console.error;console.error=(...args)=>logs.push(args.join(' '));
  const pool={connect:async()=>({on(){},removeListener(){},release(){},query:async()=>({rows:[]})}),end:async()=>{calls.push('end');}} as unknown as Pool;
  try {
    const handler=createWorkerHandler({createPool:()=>pool,commerceApplyDeferred:async(given,options)=>{assert.equal(given,pool);assert.deepEqual(options,{limit:200});calls.push('payments');return {applied:0,failed:0,skipped:0};},commerceSweep:async(given,options)=>{assert.equal(given,pool);assert.deepEqual(options,{limit:200});calls.push('commerce');return 0;},syncGitHub:async()=>{calls.push('github');return {requests:0,repositories:0,items_upserted:0,not_modified:0,stop_reason:'completed'};},authPrune:async()=>({sessions:0,login_attempts:0,auth_rate_limits:0,password_reset_tokens:0})});
    await handler.scheduled({},settings as WorkerEnv,{waitUntil:p=>pending.push(p)});await Promise.all(pending);
    const skipped='FREEDOM_COMMERCE_QUARANTINE' in settings;
    assert.deepEqual(calls,skipped?['github','end']:['payments','commerce','github','end']);assert.deepEqual(logs,settings.FREEDOM_COMMERCE_QUARANTINE==='synthetic-secret'?['commerce_settings_invalid']:[]);
  }finally{console.error=original;}
});
test('commerce sweep failure logs a fixed name, continues later jobs and ends the pool',async()=>{
  const calls:string[]=[],logs:string[]=[],pending:Promise<unknown>[]=[];const original=console.error;console.error=(...args)=>logs.push(args.join(' '));
  try {
    const handler=createWorkerHandler({createPool:()=>({end:async()=>{calls.push('end');}} as unknown as Pool),commerceDueWork:idleDueWork,commerceApplyDeferred:async()=>({applied:0,failed:0,skipped:0}),commerceSweep:async()=>{throw Error('synthetic-secret');},commerceEmailSweep:async()=>({expired:0,deleted:0}),syncGitHub:async()=>{calls.push('github');return {requests:0,repositories:0,items_upserted:0,not_modified:0,stop_reason:'completed'};},authPrune:async()=>({sessions:0,login_attempts:0,auth_rate_limits:0,password_reset_tokens:0})});
    await handler.scheduled({},{} as WorkerEnv,{waitUntil:p=>pending.push(p)});await Promise.all(pending);assert.deepEqual(logs,['commerce_sweep_failed']);assert.deepEqual(calls,['github','end']);
  }finally{console.error=original;}
});
test('each commerce backfill has its own failure boundary and quarantine skips all four',async()=>{
  const {randomBytes}=await import('node:crypto');
  for(const quarantine of [false,true]){
    const calls:string[]=[],logs:string[]=[],pending:Promise<unknown>[]=[];const original=console.error;console.error=(...args)=>logs.push(args.join(' '));
    const env={FREEDOM_ENV:'local',FREEDOM_COMMERCE_PROVIDER_PROFILES:'ecpay.aio.credit.v1',COMMERCE_CREDENTIAL_KEYS:'test:'+randomBytes(32).toString('base64'),COMMERCE_JOURNAL:{put:async()=>null,get:async()=>null},FREEDOM_COMMERCE_QUARANTINE:String(quarantine)} as unknown as WorkerEnv;
    const pool={end:async()=>{calls.push('end');}} as unknown as Pool;
    try{
      const handler=createWorkerHandler({createPool:()=>pool,commerceDueWork:async()=>{calls.push('queries');throw Error('synthetic-secret');},commerceSweep:async()=>{calls.push('holds');throw Error('synthetic-secret');},commerceEmailSweep:async()=>({expired:0,deleted:0}),commerceApplyDeferred:async(given,options)=>{assert.equal(given,pool);assert.deepEqual(options,{limit:200});calls.push('payments');throw Error('synthetic-secret');},commerceFlushJournal:async(given,journal,options)=>{assert.equal(given,pool);assert.equal(journal.environment,'local');assert.deepEqual(options,{limit:200});calls.push('journal');throw Error('synthetic-secret');},syncGitHub:async()=>{calls.push('github');return {requests:0,repositories:0,items_upserted:0,not_modified:0,stop_reason:'completed'};},authPrune:async()=>({sessions:0,login_attempts:0,auth_rate_limits:0,password_reset_tokens:0})});
      await handler.scheduled({},env,{waitUntil:p=>pending.push(p)});await Promise.all(pending);
      assert.deepEqual(calls,quarantine?['github','end']:['payments','holds','queries','journal','github','end']);assert.deepEqual(logs,quarantine?[]:['commerce_payment_deferred_failed','commerce_sweep_failed','commerce_due_work_failed','commerce_control_journal_failed']);
    }finally{console.error=original;}
  }
});


test('review 3: quarantine recovery applies verified payments before sweeping holds', async () => {
  const calls: string[] = [], pending: Promise<unknown>[] = [];
  const handler = createWorkerHandler({
    createPool: () => ({ end: async () => {} }) as unknown as Pool,
    commerceDueWork: idleDueWork,
    commerceApplyDeferred: async () => { calls.push('payments'); return { applied: 0, failed: 0, skipped: 0 }; },
    commerceSweep: async () => { calls.push('holds'); return 0; },
    commerceEmailSweep: async () => ({ expired: 0, deleted: 0 }),
    syncGitHub: async () => ({ requests: 0, repositories: 0, items_upserted: 0, not_modified: 0, stop_reason: 'completed' }),
    authPrune: async () => ({ sessions: 0, login_attempts: 0, auth_rate_limits: 0, password_reset_tokens: 0 })
  });
  await handler.scheduled({}, {} as WorkerEnv, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  assert.deepEqual(calls, ['payments', 'holds']);
});


test('review 8: deferred partial failure logs only its fixed name and counts before later jobs', async () => {
  const logs: unknown[][] = [], original = console.error, pending: Promise<unknown>[] = [];
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const handler = createWorkerHandler({
      createPool: () => ({ end: async () => {} }) as unknown as Pool,
      commerceDueWork: idleDueWork,
      commerceApplyDeferred: async () => ({ applied: 1, failed: 1, skipped: 1 }), commerceSweep: async () => 0,
      commerceEmailSweep: async () => ({ expired: 0, deleted: 0 }),
      syncGitHub: async () => ({ requests: 0, repositories: 0, items_upserted: 0, not_modified: 0, stop_reason: 'completed' }),
      authPrune: async () => ({ sessions: 0, login_attempts: 0, auth_rate_limits: 0, password_reset_tokens: 0 })
    });
    await handler.scheduled({}, {} as WorkerEnv, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    assert.deepEqual(logs, [['commerce_payment_deferred_partial', { applied: 1, failed: 1, skipped: 1 }]]);
  } finally { console.error = original; }
});

test('scheduled runs commerceEmailSweep with { limit: 500 } outside quarantine and skips it in quarantine', async () => {
  for (const quarantine of [false, true]) {
    const sweepCalls: { pool: Pool; options: { limit?: number } | undefined }[] = [], pending: Promise<unknown>[] = [];
    const pool = { end: async () => {} } as unknown as Pool;
    const handler = createWorkerHandler({
      createPool: () => pool,
      commerceDueWork: idleDueWork,
      commerceApplyDeferred: async () => ({ applied: 0, failed: 0, skipped: 0 }),
      commerceSweep: async () => 0,
      commerceEmailSweep: async (given, options) => { sweepCalls.push({ pool: given, options }); return { expired: 0, deleted: 0 }; },
      syncGitHub: async () => ({ requests: 0, repositories: 0, items_upserted: 0, not_modified: 0, stop_reason: 'completed' }),
      authPrune: async () => ({ sessions: 0, login_attempts: 0, auth_rate_limits: 0, password_reset_tokens: 0 }),
    });
    await handler.scheduled({}, { FREEDOM_COMMERCE_QUARANTINE: String(quarantine) } as WorkerEnv, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    if (quarantine) {
      assert.equal(sweepCalls.length, 0);
    } else {
      assert.equal(sweepCalls.length, 1);
      assert.equal(sweepCalls[0].pool, pool);
      assert.deepEqual(sweepCalls[0].options, { limit: 500 });
    }
  }
});
