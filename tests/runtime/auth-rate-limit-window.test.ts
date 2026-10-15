import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {migrate} from '../../scripts/database.js';
import {authRateLimit,authRateLimitInTransaction} from '../../modules/identity-membership/members.js';
import {tokenHash} from '../../modules/identity-membership/service.js';
import {Problem} from '../../packages/shared/problem.js';
import {createPlatformApp} from '../../apps/platform-api/src/platform-app.js';
import {workerRuntime,type WorkerEnv} from '../../apps/platform-api/src/worker.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl,'TEST_DATABASE_URL must explicitly select a disposable PostgreSQL database');
const schema=`fp_rate_window_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:databaseUrl});
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:6});
const seconds=2;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
const limited=(error:unknown)=>error instanceof Problem&&error.status===429&&error.code==='auth_rate_limited';

async function charge(q:PoolClient,scope:string):Promise<'accepted'|'limited'>{
  try{
    await authRateLimitInTransaction(q,scope,'synthetic-member',1,seconds);
    await q.query('COMMIT');return 'accepted';
  }catch(error){
    await q.query('ROLLBACK');
    if(!limited(error))throw error;
    return 'limited';
  }
}

test('queued old transactions share one fresh window after the bucket row lock is released',async()=>{
  const scope='queued-window',bucket=tokenHash(`${scope}/synthetic-member`);
  await pool.query("INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES($1,1,clock_timestamp()-interval '1 day')",[bucket]);
  const blocker=await pool.connect(),workers=await Promise.all([pool.connect(),pool.connect()]);
  let pending:Promise<'accepted'|'limited'>[]=[];
  try{
    await blocker.query('BEGIN');
    await blocker.query('SELECT bucket FROM auth_rate_limits WHERE bucket=$1 FOR UPDATE',[bucket]);
    const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const starts=[];
    for(const q of workers){
      await q.query('BEGIN');
      starts.push((await q.query<{pid:number;started:Date}>('SELECT pg_backend_pid() AS pid,now() AS started')).rows[0]);
    }
    assert.ok(Math.abs(starts[1].started.getTime()-starts[0].started.getTime())<seconds*1000);
    pending=workers.map(q=>charge(q,scope));
    for(const job of pending)void job.catch(()=>{});
    const deadline=Date.now()+5000;let blocked=false;
    while(Date.now()<deadline){
      const rows=(await admin.query<{blockers:number[]}>('SELECT pg_blocking_pids(pid) AS blockers FROM unnest($1::int[]) AS pid',[starts.map(row=>row.pid)])).rows;
      if(rows.every(row=>row.blockers.length>0)&&rows.some(row=>row.blockers.includes(blockerPid))){blocked=true;break;}
      await pause(10);
    }
    assert.equal(blocked,true,'both actual UPSERTs must wait on the held bucket');
    await admin.query('SELECT pg_sleep($1)',[seconds+0.2]);
    for(const start of starts)assert.equal((await admin.query<{crossed:boolean}>('SELECT clock_timestamp()>$1::timestamptz+make_interval(secs=>$2) AS crossed',[start.started,seconds])).rows[0].crossed,true);
    await blocker.query('COMMIT');
    assert.deepEqual((await Promise.all(pending)).sort(),['accepted','limited']);
    await assert.rejects(authRateLimit(pool,scope,'synthetic-member',1,seconds),limited);
    await pool.query('SELECT pg_sleep($1)',[seconds+0.2]);
    await authRateLimit(pool,scope,'synthetic-member',1,seconds);
    await assert.rejects(authRateLimit(pool,scope,'synthetic-member',1,seconds),limited);
  }finally{
    await blocker.query('ROLLBACK');blocker.release();
    await Promise.allSettled(pending);
    for(const q of workers){await q.query('ROLLBACK');q.release();}
  }
});

test('a new bucket admitted by an aged transaction does not immediately reopen',async()=>{
  const q=await pool.connect();
  try{
    await q.query('BEGIN');
    await q.query('SELECT pg_sleep($1)',[seconds+0.2]);
    assert.equal((await q.query<{aged:boolean}>('SELECT clock_timestamp()>now()+make_interval(secs=>$1) AS aged',[seconds])).rows[0].aged,true);
    assert.equal(await charge(q,'new-aged-window'),'accepted');
    await assert.rejects(authRateLimit(pool,'new-aged-window','synthetic-member',1,seconds),limited);
  }finally{await q.query('ROLLBACK');q.release();}
});

test('active budgets isolate scope and network and roll back with the domain transaction',async()=>{
  await authRateLimit(pool,'active-window','network-a',2,60);
  const q=await pool.connect();
  try{
    await q.query('BEGIN');
    await authRateLimitInTransaction(q,'active-window','network-a',2,60);
    await q.query('ROLLBACK');
  }finally{await q.query('ROLLBACK');q.release();}
  await authRateLimit(pool,'active-window','network-a',2,60);
  await assert.rejects(authRateLimit(pool,'active-window','network-a',2,60),limited);
  await authRateLimit(pool,'other-active-window','network-a',1,60);
  await authRateLimit(pool,'active-window','network-b',1,60);
  await assert.rejects(authRateLimit(pool,'other-active-window','network-a',1,60),limited);
  await assert.rejects(authRateLimit(pool,'active-window','network-b',1,60),limited);
});

test('real Worker login budgets group IPv6 peers without consuming another prefix',async()=>{
  const origin='https://example.invalid';
  const runtime=workerRuntime({} as WorkerEnv,{freedomEnv:'staging',origin,release:'a'.repeat(40),trustConnectingIp:true});
  const app=createPlatformApp(pool,origin,'staging',runtime);
  async function attempt(address:string){
    const request=new Request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'CF-Connecting-IP':address,'Content-Type':'application/json'},body:'{}'});
    Object.defineProperty(request,'cf',{value:{colo:'TEST'}});
    return app.fetch(request);
  }
  for(let i=0;i<60;i++)assert.equal((await attempt(i%2?'2001:db8::1':'2001:db8::2')).status,422);
  for(const address of ['2001:db8::1','2001:db8::3']){
    const response=await attempt(address);assert.equal(response.status,429);
    assert.equal((await response.json() as {code:string}).code,'auth_rate_limited');
  }
  assert.equal((await attempt('2001:db8:0:1::1')).status,422,'another prefix and the global budget retain capacity');
});
