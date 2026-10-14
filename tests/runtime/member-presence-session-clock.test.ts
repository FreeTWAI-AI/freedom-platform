import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {Pool} from 'pg';
import {z} from 'zod';
import {migrate} from '../../scripts/database.js';
import {seedLocal} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
import {readSessionCookie} from '../../apps/platform-api/src/session-cookie.js';
import {authenticate,tokenHash,type Actor} from '../../modules/identity-membership/service.js';
import {memberPresence} from '../../modules/identity-membership/members.js';
import {Problem} from '../../packages/shared/problem.js';

const database=z.string().min(1).parse(process.env.TEST_DATABASE_URL);
const schema=`fp_presence_clock_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:database});
const pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,application_name:schema,max:12});
type Signal={promise:Promise<void>;resolve:()=>void};
function signal():Signal{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve};}
let delivery:{held:Signal;release:Signal;used:boolean}|undefined;
// Delay actual SQL-result delivery; preserve native rows and the transaction client.
// This is a driver-delivery race, not a claim of a native relation-lock wait.
function observed<T extends object>(target:T):T{
  return new Proxy(target,{get(target,key,receiver){
    const value=Reflect.get(target,key,receiver);
    if(key==='connect'&&target===pool){
      assert.ok(typeof value==='function');
      return async(...args:unknown[])=>{const client=await Reflect.apply(value,target,args);assert.ok(client&&typeof client==='object');return observed(client);};
    }
    if(key==='query'){
      assert.ok(typeof value==='function');
      return async(...args:unknown[])=>{
      const result=await Reflect.apply(value,target,args),current=delivery;
      if(current&&!current.used&&typeof args[0]==='string'&&args[0].startsWith('SELECT u.user_id,')&&args[0].includes('AS last_seen_at')){
        current.used=true;current.held.resolve();await current.release.promise;
      }
      return result;
      };
    }
    return typeof value==='function'?value.bind(target):value;
  }});
}
const origin='http://127.0.0.1:4310',app=createApp(observed(pool),origin);
type Session={cookie:string;csrf:string;id:string};
let viewer:Session,peer:Session,actor:Actor;
async function request(path:string,session?:Session,body?:unknown){
  const headers:Record<string,string>={Origin:origin};
  if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrf;}
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:z.record(z.string(),z.unknown()).parse(await response.json()),cookie:response.headers.get('set-cookie')};
}
function raw(session:Session){const value=readSessionCookie(session.cookie,origin);assert.ok(value);return value;}
async function member(nickname:string):Promise<Session>{
  const result=await request('/auth/register',undefined,{email:`${randomUUID()}@example.test`,nickname,password:'freedom-presence-clock-password'});
  assert.equal(result.status,201);const parsed=z.object({csrf_token:z.string(),user:z.object({user_id:z.uuid()})}).parse(result.data);assert.ok(result.cookie);
  const session={cookie:result.cookie.split(';')[0],csrf:parsed.csrf_token,id:parsed.user.user_id};
  assert.equal((await request('/me/onboarding/quick-start',session,{guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true,guild_answers:sampleGuildAnswers('guild_ai_vibe')})).status,200);
  return session;
}
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);
  viewer=await member('presence-clock-viewer');peer=await member('presence-clock-private-peer');

  actor=await authenticate(pool,raw(viewer));
});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function expiry(session:Session,seconds:number){
  assert.equal((await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1',[tokenHash(raw(session)),seconds])).rowCount,1);
}
async function delayedRead(expired:boolean){
  await expiry(viewer,expired?2:300);
  const current={held:signal(),release:signal(),used:false};delivery=current;
  const pending=request(`/members/presence?ids=${peer.id}`,viewer);
  try{
    const deadline=Date.now()+8000;while(!current.used){assert.ok(Date.now()<deadline,'real presence SQL must complete before delivery is held');await setImmediate();}
    const hash=tokenHash(raw(viewer));
    assert.equal((await pool.query('SELECT expires_at>clock_timestamp() AS active FROM sessions WHERE token_hash=$1',[hash])).rows[0].active,true);
    if(expired){
      await pool.query('SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp())::double precision)+0.04) FROM sessions WHERE token_hash=$1',[hash]);
      assert.equal((await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE token_hash=$1',[hash])).rows[0].expired,true);
    }
    current.release.resolve();return await pending;
  }finally{current.release.resolve();delivery=undefined;await pending;}
}
test('presence rejects session expiry after actual projection result delivery is delayed',async()=>{
  const result=await delayedRead(true);assert.equal(result.status,401);assert.equal(result.data.code,'session_expired');assert.equal('items' in result.data,false);assert.equal(JSON.stringify(result.data).includes(peer.id),false);
});
test('valid session preserves presence DTO across the same delivery delay',async()=>{
  const result=await delayedRead(false);assert.equal(result.status,200);
  const row=(await pool.query('SELECT max(coalesce(last_seen_at,created_at)) AS seen FROM sessions WHERE user_id=$1',[peer.id])).rows[0];
  assert.deepEqual(result.data,{items:[{user_id:peer.id,last_seen_at:new Date(row.seen).toISOString(),is_online:true}]});
  assert.deepEqual((await request('/members/presence?ids=',viewer)).data,{items:[]});
});
test('peer online status uses the projection statement clock after a native viewer-session wait',async()=>{
  await expiry(viewer,300);await expiry(peer,2);
  // Keep middleware presence fresh so its conditional UPDATE needs no row lock.
  await pool.query('UPDATE sessions SET last_seen_at=clock_timestamp() WHERE token_hash=$1',[actor.session_hash]);
  const gate=await admin.connect();let pending:ReturnType<typeof request>|undefined;
  try{
    await gate.query('BEGIN');await gate.query(`SELECT token_hash FROM ${schema}.sessions WHERE token_hash=$1 FOR UPDATE`,[actor.session_hash]);
    const holder=(await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=request(`/members/presence?ids=${peer.id}`,viewer);
    const deadline=Date.now()+8000;
    for(;;){
      const waiting=(await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting',[schema,holder])).rows[0].waiting;
      if(waiting)break;assert.ok(Date.now()<deadline,'reader must wait on the native session lock');await setImmediate();
    }
    const hash=tokenHash(raw(peer));
    assert.equal((await pool.query('SELECT expires_at>clock_timestamp() AS active FROM sessions WHERE token_hash=$1',[hash])).rows[0].active,true);
    await pool.query('SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp())::double precision)+0.04) FROM sessions WHERE token_hash=$1',[hash]);
    assert.equal((await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE token_hash=$1',[hash])).rows[0].expired,true);
    await gate.query('ROLLBACK');const result=await pending;assert.equal(result.status,200);
    assert.equal(z.object({items:z.array(z.object({is_online:z.boolean()}))}).parse(result.data).items[0]?.is_online,false);
  }finally{await gate.query('ROLLBACK');gate.release();if(pending)await pending;await expiry(peer,300);}
});
for(const state of ['expired','revoked','inactive'] as const)for(const populated of [true,false])test(`captured Actor cannot read ${populated?'populated':'empty'} presence after ${state}`,async()=>{
  await expiry(viewer,300);
  try{
    if(state==='expired')await expiry(viewer,-1);
    if(state==='revoked')await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[actor.session_hash]);
    if(state==='inactive')await pool.query('UPDATE users SET active=false WHERE user_id=$1',[viewer.id]);
    await assert.rejects(memberPresence(pool,actor,populated?peer.id:''),(error:unknown)=>error instanceof Problem&&error.status===401&&error.code==='session_expired');
  }finally{
    await pool.query('UPDATE users SET active=true WHERE user_id=$1',[viewer.id]);
    await pool.query('UPDATE sessions SET revoked_at=NULL WHERE token_hash=$1',[actor.session_hash]);await expiry(viewer,300);
  }
});
