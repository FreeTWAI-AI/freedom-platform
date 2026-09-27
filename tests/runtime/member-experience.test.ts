import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_experience_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:number,key=randomUUID()) {
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function signIn(email=DEMO_USERS[0].email):Promise<Session>{
  const result=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(result.status,200,JSON.stringify(result.data));
  return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token,user:result.data.user};
}
const draft=()=>({title:'一起練習社群提案',description:'交流並做出一份可分享的提案。',starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+90000000).toISOString(),mode:'online',location:'https://example.org/meeting',capacity:1});
async function guildMaster(userId:string){await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_security','active')`,[randomUUID(),DEMO_COMMUNITY,userId]);await pool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,'guild_security',$2)`,[DEMO_COMMUNITY,userId]);}

test('new member can preview safe events and submit one for review, while RSVP stays gated',async()=>{
  const member=await signIn(),host=await signIn(DEMO_USERS[1].email);
  assert.equal((await request('/events',host,draft())).status,201);
  await pool.query('UPDATE users SET onboarding_required=true WHERE user_id=$1',[member.user.user_id]);
  const tasks=await request('/task-board/preview',member);assert.equal(tasks.status,200);assert.ok(Array.isArray(tasks.data.items));
  assert.ok(tasks.data.items.every((item:any)=>!('owner_ref' in item)&&!('participation_terms' in item)&&!('my_claim' in item)));
  const events=await request('/events',member);assert.equal(events.status,200);assert.equal(events.data.items.length,0);
  const submitted=await request('/events',member,draft());assert.equal(submitted.status,201);assert.equal(submitted.data.state,'pending');
  const own=(await request('/events',member)).data.items[0];assert.equal(own.event_id,submitted.data.event_id);
  assert.equal(own.location,undefined);assert.equal(own.organizer_name,undefined);
  assert.equal((await request(`/events/${submitted.data.event_id}/rsvp`,member,{going:true})).status,403);
  assert.equal((await request('/me/contribution-records',member)).status,403);
  assert.equal((await request('/work-items',member)).status,403);
});

test('member event publishing, editing, RSVP capacity, cancellation and idempotency are scoped',async()=>{
  const owner=await signIn(),first=await signIn(DEMO_USERS[1].email),second=await signIn(DEMO_USERS[2].email);
  await guildMaster(first.user.user_id);
  const body={...draft(),guild_key:'guild_security'},key=randomUUID();
  const created=await request('/events',owner,body,undefined,key);assert.equal(created.status,201,JSON.stringify(created.data));
  assert.equal(created.data.state,'pending');
  assert.deepEqual((await request('/events',owner,body,undefined,key)).data,created.data);
  const id=created.data.event_id;
  assert.equal((await request(`/events/${id}/update`,first,{...body,title:'冒名修改'},1)).status,403);
  assert.equal((await request(`/events/${id}/update`,owner,{...body,title:'更新活動'},1)).status,200);
  assert.equal((await request(`/events/${id}/update`,owner,body,1)).status,412);
  assert.equal((await request(`/events/${id}/rsvp`,first,{going:true})).status,409);
  assert.equal((await request(`/events/${id}/review`,owner,{decision:'approve',reason:'自審'},2)).status,403);
  const approved=await request(`/events/${id}/review`,first,{decision:'approve',reason:'符合公會活動安排。'},2);assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal(approved.data.state,'published');
  assert.equal((await request(`/events/${id}/rsvp`,first,{going:true})).status,200);
  assert.equal((await request(`/events/${id}/rsvp`,second,{going:true})).status,409);
  assert.equal((await request(`/events/${id}/rsvp`,first,{going:false})).status,200);
  assert.equal((await request(`/events/${id}/rsvp`,second,{going:true})).status,200);
  assert.equal((await request('/me/contribution-records',second)).data.accepted_count,0);
  assert.equal((await pool.query('SELECT count(*) FROM contributions')).rows[0].count,'0');
  assert.equal((await request(`/events/${id}/cancel`,first,{},3)).status,403);
  assert.equal((await request(`/events/${id}/cancel`,owner,{},3)).status,200);
  assert.equal((await request(`/events/${id}/rsvp`,first,{going:true})).status,409);
  const list=await request('/events',owner);assert.equal(list.data.items.find((item:any)=>item.event_id===id).state,'cancelled');
  const announcements=await request('/events/bulletins',second);assert.deepEqual(announcements.data.items.map((item:any)=>item.kind).sort(),['approved','submitted']);
  assert.match(announcements.data.items.find((item:any)=>item.kind==='approved').message,/核准了/);
  const ownerNotices=await request('/me/notifications',owner);assert.ok(ownerNotices.data.items.some((item:any)=>item.kind==='event_approved'));
});

test('contribution records do not assign an unapproved score',async()=>{
  const member=await signIn();
  const records=await request('/me/contribution-records',member);assert.equal(records.status,200);assert.equal(records.data.accepted_count,0);
  assert.equal(records.data.policy,'accepted_work_facts_v1');
  assert.equal(records.data.total,undefined);assert.deepEqual(records.data.entries,[]);
});

test('simultaneous requests for the last event seat admit only one member',async()=>{
  const owner=await signIn(),first=await signIn(DEMO_USERS[1].email),second=await signIn(DEMO_USERS[2].email);
  await guildMaster(first.user.user_id);
  const created=await request('/events',owner,{...draft(),guild_key:'guild_security'});assert.equal(created.status,201);
  assert.equal((await request(`/events/${created.data.event_id}/review`,first,{decision:'approve',reason:'可公開報名。'},1)).status,200);
  const path=`/events/${created.data.event_id}/rsvp`;
  const results=await Promise.all([request(path,first,{going:true}),request(path,second,{going:true})]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  assert.equal((await request('/events',owner)).data.items.find((item:any)=>item.event_id===created.data.event_id).attending_count,1);
});
