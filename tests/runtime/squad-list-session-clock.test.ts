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
import {listSquads} from '../../modules/identity-membership/members.js';
import {Problem} from '../../packages/shared/problem.js';

const database=z.string().min(1).parse(process.env.TEST_DATABASE_URL);
const schema=`fp_squads_clock_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:database});
const pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,application_name:schema,max:12});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin);
type Session={cookie:string;csrf:string;id:string};
let viewer:Session,empty:Session,actor:Actor;
let expected:Record<string,unknown>;
async function request(path:string,session?:Session,body?:unknown){
  const headers:Record<string,string>={Origin:origin};
  if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrf;}
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:z.record(z.string(),z.unknown()).parse(await response.json()),cookie:response.headers.get('set-cookie')};
}
function raw(session:Session){const value=readSessionCookie(session.cookie,origin);assert.ok(value);return value;}
async function member(nickname:string):Promise<Session>{
  const result=await request('/auth/register',undefined,{email:`${randomUUID()}@example.test`,nickname,password:'freedom-squads-clock-password'});
  assert.equal(result.status,201);const parsed=z.object({csrf_token:z.string(),user:z.object({user_id:z.uuid()})}).parse(result.data);assert.ok(result.cookie);
  const session={cookie:result.cookie.split(';')[0],csrf:parsed.csrf_token,id:parsed.user.user_id};
  assert.equal((await request('/me/onboarding/quick-start',session,{guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true,guild_answers:sampleGuildAnswers('guild_ai_vibe')})).status,200);
  return session;
}
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);
  viewer=await member('squad-clock-viewer');empty=await member('squad-clock-empty');
  assert.equal((await request('/squads',viewer,{name:'squad-clock-private',kind:'project',purpose:'session projection boundary'})).status,201);
  expected=(await request('/squads?limit=50',viewer)).data;
  actor=await authenticate(pool,raw(viewer));
});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function expiry(session:Session,seconds:number){
  assert.equal((await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1',[tokenHash(raw(session)),seconds])).rowCount,1);
}
async function blockedRead(session:Session,expired:boolean,populated=true){
  const gate=await admin.connect();let pending:ReturnType<typeof request>|undefined;
  try{
    await expiry(session,expired?2:300);
    await gate.query('BEGIN');await gate.query(`LOCK TABLE ${schema}.member_squads IN ACCESS EXCLUSIVE MODE`);
    const holder=z.object({pid:z.number()}).parse((await gate.query('SELECT pg_backend_pid() AS pid')).rows[0]).pid;
    pending=request(populated?'/squads?limit=50':'/squads?offset=10000',session);
    const deadline=Date.now()+8000;
    for(;;){
      const waiting=z.object({waiting:z.boolean()}).parse((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting',[schema,holder])).rows[0]).waiting;
      if(waiting)break;assert.ok(Date.now()<deadline,'squad projection must actually wait in PostgreSQL');await setImmediate();
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
for(const populated of [true,false])test(`squads ${populated?'populated':'empty'} projection rejects expiry after a real SQL wait`,async()=>{
  const result=await blockedRead(populated?viewer:empty,true,populated);
  assert.equal(result.status,401);assert.equal(result.data.code,'session_expired');assert.equal('items' in result.data,false);
  assert.equal('kinds' in result.data,false);assert.equal('next_offset' in result.data,false);
  assert.equal(JSON.stringify(result.data).includes('squad-clock-private'),false);
  assert.equal(JSON.stringify(result.data).includes(viewer.id),false);
});
test('valid session preserves squad page and membership DTO after the same SQL wait',async()=>{
  const result=await blockedRead(viewer,false);assert.equal(result.status,200);assert.deepEqual(result.data,expected);
  const listed=z.object({items:z.array(z.object({membership:z.object({state:z.string()}).nullable()}))}).parse(result.data);
  assert.ok(listed.items.some(item=>item.membership?.state==='active'));
  const all=z.array(z.record(z.string(),z.unknown())).parse(expected.items),pages:Record<string,unknown>[]=[];
  for(let offset=0;offset<all.length;offset++){
    const page=await request(`/squads?limit=1&offset=${offset}`,viewer);assert.equal(page.status,200);
    pages.push(...z.array(z.record(z.string(),z.unknown())).parse(page.data.items));
    assert.equal(page.data.next_offset,offset+1<all.length?offset+1:null);assert.deepEqual(page.data.kinds,expected.kinds);
  }
  assert.deepEqual(pages,all);
  const emptyResult=await blockedRead(empty,false,false);assert.equal(emptyResult.status,200);assert.deepEqual(emptyResult.data.items,[]);assert.equal(emptyResult.data.next_offset,null);assert.deepEqual(emptyResult.data.kinds,expected.kinds);
});
for(const state of ['expired','revoked','inactive'] as const)test(`captured Actor cannot read squads after ${state}`,async()=>{
  await expiry(viewer,300);
  try{
    if(state==='expired')await expiry(viewer,-1);
    if(state==='revoked')await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[actor.session_hash]);
    if(state==='inactive')await pool.query('UPDATE users SET active=false WHERE user_id=$1',[viewer.id]);
    await assert.rejects(listSquads(pool,actor,20,0),(error:unknown)=>error instanceof Problem&&error.status===401&&error.code==='session_expired');
  }finally{
    await pool.query('UPDATE users SET active=true WHERE user_id=$1',[viewer.id]);
    await pool.query('UPDATE sessions SET revoked_at=NULL WHERE token_hash=$1',[actor.session_hash]);await expiry(viewer,300);
  }
});
