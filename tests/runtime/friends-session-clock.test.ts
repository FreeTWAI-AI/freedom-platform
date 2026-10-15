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
import {friendDirectory} from '../../modules/identity-membership/member-connections.js';
import {readWithMemberSession} from '../../packages/db/member-session.js';
import {Problem} from '../../packages/shared/problem.js';

const database=z.string().min(1).parse(process.env.TEST_DATABASE_URL);
const schema=`fp_friends_clock_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:database});
const pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,application_name:schema,max:12});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin);
type Session={cookie:string;csrf:string;id:string};
let viewer:Session,empty:Session,peer:Session,actor:Actor;
async function request(path:string,session?:Session,body?:unknown){
  const headers:Record<string,string>={Origin:origin};
  if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrf;}
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:z.record(z.string(),z.unknown()).parse(await response.json()),cookie:response.headers.get('set-cookie')};
}
function raw(session:Session){const value=readSessionCookie(session.cookie,origin);assert.ok(value);return value;}
async function member(nickname:string):Promise<Session>{
  const result=await request('/auth/register',undefined,{email:`${randomUUID()}@example.test`,nickname,password:'freedom-friends-clock-password'});
  assert.equal(result.status,201);const parsed=z.object({csrf_token:z.string(),user:z.object({user_id:z.uuid()})}).parse(result.data);assert.ok(result.cookie);
  const session={cookie:result.cookie.split(';')[0],csrf:parsed.csrf_token,id:parsed.user.user_id};
  assert.equal((await request('/me/onboarding/quick-start',session,{guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true,guild_answers:sampleGuildAnswers('guild_ai_vibe')})).status,200);
  return session;
}
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);
  viewer=await member('friend-clock-viewer');empty=await member('friend-clock-empty');peer=await member('friend-clock-private-peer');
  assert.equal((await request(`/friends/${peer.id}/request`,viewer,{})).status,200);
  actor=await authenticate(pool,raw(viewer));
});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function expiry(session:Session,seconds:number){
  assert.equal((await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1',[tokenHash(raw(session)),seconds])).rowCount,1);
}
async function blockedRead(session:Session,expired:boolean){
  const gate=await admin.connect();let pending:ReturnType<typeof request>|undefined;
  try{
    await expiry(session,expired?2:300);
    await gate.query('BEGIN');await gate.query(`LOCK TABLE ${schema}.member_friendships IN ACCESS EXCLUSIVE MODE`);
    const holder=z.object({pid:z.number()}).parse((await gate.query('SELECT pg_backend_pid() AS pid')).rows[0]).pid;
    pending=request('/friends/directory?scope=outgoing',session);
    const deadline=Date.now()+8000;
    for(;;){
      const waiting=z.object({waiting:z.boolean()}).parse((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting',[schema,holder])).rows[0]).waiting;
      if(waiting)break;assert.ok(Date.now()<deadline,'friend projection must actually wait in PostgreSQL');await setImmediate();
    }
    const hash=tokenHash(raw(session));
    assert.equal((await pool.query('SELECT expires_at>clock_timestamp() AS active FROM sessions WHERE token_hash=$1',[hash])).rows[0].active,true);
    if(expired){
      await pool.query('SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp())::double precision)+0.04) FROM sessions WHERE token_hash=$1',[hash]);
      assert.equal((await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE token_hash=$1',[hash])).rows[0].expired,true);
    }
    await gate.query('ROLLBACK');return await pending;
  }finally{await gate.query('ROLLBACK');gate.release();if(pending)await pending;}
}
for(const populated of [true,false])test(`friends directory ${populated?'populated':'empty'} projection rejects expiry after a real SQL wait`,async()=>{
  const result=await blockedRead(populated?viewer:empty,true);
  assert.equal(result.status,401);assert.equal(result.data.code,'session_expired');assert.equal('items' in result.data,false);
  assert.equal(JSON.stringify(result.data).includes('friend-clock-private-peer'),false);
  assert.equal(JSON.stringify(result.data).includes(peer.id),false);
});
test('valid session preserves the pending friendship card after the same SQL wait',async()=>{
  const result=await blockedRead(viewer,false);assert.equal(result.status,200);
  const saved=(await pool.query('SELECT aggregate_version FROM member_friendships WHERE requester_ref=$1',[viewer.id])).rows[0];
  const page=z.object({items:z.array(z.object({user_id:z.uuid(),nickname:z.string(),friendship:z.object({state:z.string(),requester_ref:z.uuid(),aggregate_version:z.number()})}).passthrough()),total:z.number(),next_offset:z.number().nullable()}).parse(result.data);
  assert.equal(page.total,1);assert.equal(page.next_offset,null);
  assert.deepEqual(page.items.map(item=>({user_id:item.user_id,nickname:item.nickname,...item.friendship})),[{user_id:peer.id,nickname:'friend-clock-private-peer',state:'pending',requester_ref:viewer.id,aggregate_version:Number(saved.aggregate_version)}]);
  await expiry(empty,300);assert.deepEqual((await request('/friends/directory?scope=outgoing',empty)).data,{items:[],total:0,next_offset:null});
});
for(const state of ['expired','revoked','inactive'] as const)test(`captured Actor cannot read friends after ${state}`,async()=>{
  await expiry(viewer,300);
  try{
    if(state==='expired')await expiry(viewer,-1);
    if(state==='revoked')await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[actor.session_hash]);
    if(state==='inactive')await pool.query('UPDATE users SET active=false WHERE user_id=$1',[viewer.id]);
    await assert.rejects(readWithMemberSession(pool,actor,q=>friendDirectory(q,actor,{scope:'outgoing'})),(error:unknown)=>error instanceof Problem&&error.status===401&&error.code==='session_expired');
  }finally{
    await pool.query('UPDATE users SET active=true WHERE user_id=$1',[viewer.id]);
    await pool.query('UPDATE sessions SET revoked_at=NULL WHERE token_hash=$1',[actor.session_hash]);await expiry(viewer,300);
  }
});
