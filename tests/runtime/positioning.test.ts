import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_positioning_test_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:number|string,key=randomUUID()) {
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function signIn(email=DEMO_USERS[0].email):Promise<Session>{const r=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));return {cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user};}
const profile={real_world_occupations:['茶農','店面經營者'],background:'自家茶園與小量包裝能力',strengths:['產品知識','攝影'],goals:'整理茶葉供貨條件，找到合作銷售者',weekly_minutes:60,desired_roles:['supplier','seller'],selected_tracks:['food_supplier'],confirmed:true};

test('expanded directions remain separate from 15 Guild professions and do not expose private profiles',async()=>{
  const member=await signIn();const view=await request('/me/positioning',member),guilds=await request('/guilds',member);
  assert.equal(view.status,200);assert.equal(view.data.profile,null);assert.ok(view.data.tracks.length>=20);
  assert.equal(guilds.data.items.length,15);assert.equal(new Set(guilds.data.items.map((g:any)=>g.profession_key)).size,15);
  assert.ok(guilds.data.items.every((g:any)=>g.membership===null));assert.deepEqual(view.data.recommendations,[]);
  assert.equal((await request('/me/positioning')).status,401);
});
test('self-declared profile persists with immutable revisions, replay and explainable optional recommendations',async()=>{
  const member=await signIn(),key=randomUUID();
  const first=await request('/me/positioning',member,profile,undefined,key);assert.equal(first.status,201,JSON.stringify(first.data));assert.equal(first.data.source,'self_declared');assert.equal(first.data.aggregate_version,1);
  assert.deepEqual((await request('/me/positioning',member,profile,undefined,key)).data,first.data);
  assert.equal((await request('/me/positioning',member,{...profile,goals:'different'},undefined,key)).status,409);
  assert.equal((await request('/me/positioning',member,profile)).status,428);
  const second=await request('/me/positioning',member,{...profile,weekly_minutes:0,goals:'先探索合作'},1);assert.equal(second.status,201);assert.equal(second.data.aggregate_version,2);assert.equal(second.data.supersedes_id,first.data.profile_id);
  assert.equal((await request('/me/positioning',member,profile,1)).status,412);
  const fresh=createApp(pool,origin);const persisted:any=await (await fresh.request(origin+'/api/v1/me/positioning',{headers:{Cookie:member.cookie}})).json();
  assert.equal(persisted.profile.goals,'先探索合作');assert.equal(persisted.recommendations[0].track_key,'food_supplier');assert.match(persisted.recommendations[0].reason,/你已選擇/);assert.ok(persisted.recommendations[0].time_note);
  assert.equal((await pool.query('SELECT count(*) FROM positioning_profiles')).rows[0].count,'2');
  assert.equal((await pool.query('SELECT goals FROM positioning_profiles WHERE profile_id=$1',[first.data.profile_id])).rows[0].goals,profile.goals);
  assert.equal((await pool.query('SELECT count(*) FROM positioning_profession_memberships')).rows[0].count,'0');
  assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE event_type='freedom.positioning.profile.confirmed.v1'")).rows[0].count,'2');
});
test('profile writes reject forged owner, unconfirmed input and unknown directions',async()=>{
  const member=await signIn();
  for(const body of [{...profile,user_id:DEMO_USERS[1].user_id},{...profile,confirmed:false},{...profile,selected_tracks:['made_up']},{...profile,weekly_minutes:-1},{...profile,selected_tracks:['food_supplier','food_supplier']}])assert.equal((await request('/me/positioning',member,body)).status,422);
  assert.equal((await pool.query('SELECT count(*) FROM positioning_profiles')).rows[0].count,'0');
});
test('profile and Guild membership remain private to member and community',async()=>{
  const member=await signIn(),other=await signIn(DEMO_USERS[1].email);await request('/me/positioning',member,profile);await request('/guilds/guild_product_quality_supply/join',member,{});
  assert.equal((await request('/me/positioning',other)).data.profile,null);assert.ok((await request('/guilds',other)).data.items.every((g:any)=>g.membership===null));
  const community=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Other community']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    SELECT $1,$2,'positioning-outsider@local.test','Other member',password_hash,$3 FROM users WHERE user_id=$4`,[randomUUID(),community,randomUUID(),member.user.user_id]);
  const outsider=await signIn('positioning-outsider@local.test');assert.equal((await request('/me/positioning',outsider)).data.profile,null);
  assert.ok((await request('/guilds',outsider)).data.items.every((g:any)=>g.membership===null));
});
test('members freely join, leave and rejoin multiple Guilds without assessment or legacy acting-ref changes',async()=>{
  const member=await signIn(),path='/guilds/guild_ai_vibe',key=randomUUID();
  const joined=await request(path+'/join',member,{},undefined,key);assert.equal(joined.status,200);assert.equal(joined.data.rank,'runner');
  assert.deepEqual((await request(path+'/join',member,{},undefined,key)).data,joined.data);
  assert.equal((await request('/guilds/guild_commerce_sales/join',member,{})).status,200);
  assert.equal((await request(path+'/leave',member,{})).status,428);
  const left=await request(path+'/leave',member,{},1);assert.equal(left.data.state,'left');assert.equal(left.data.aggregate_version,2);
  assert.equal((await request(path+'/join',member,{},1)).status,412);
  const rejoined=await request(path+'/join',member,{},2);assert.equal(rejoined.data.state,'active');assert.equal(rejoined.data.aggregate_version,3);
  assert.equal((await request('/me/positioning',member)).data.profile,null);
  assert.equal((await request('/session',member)).data.user.profession_membership_ref,member.user.profession_membership_ref);
  assert.equal((await request('/guilds/not_real/join',member,{})).status,404);
});
test('concurrent join requests create one membership and one journal fact',async()=>{
  const member=await signIn();const results=await Promise.all([request('/guilds/guild_ai_field/join',member,{}),request('/guilds/guild_ai_field/join',member,{})]);
  assert.ok(results.every(r=>r.status===200));assert.equal(results[0].data.membership_id,results[1].data.membership_id);
  assert.equal((await pool.query("SELECT count(*) FROM positioning_profession_memberships WHERE guild_key='guild_ai_field'")).rows[0].count,'1');
  assert.equal((await pool.query("SELECT count(*) FROM transition_journal WHERE aggregate_type='profession_membership'")).rows[0].count,'1');
});
