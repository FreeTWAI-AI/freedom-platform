import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {eventAttendees} from '../../modules/community/events.js';
import { createApp } from '../../apps/platform-api/src/app.js';

// #401: organizers read who is going. In-process requests, synthetic members and a disposable schema only.
const origin='http://127.0.0.1:4315',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_event_attendees_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
const app=createApp(pool,origin,'local',{eventEmailSender:async()=>{}});
type Session={cookie:string;csrf:string;id:string};
type Attendee={kind:'member';user_id:string;nickname:string;avatar_url:string|null;registered_at:string}|{kind:'guest';registered_at:string};
type Page={items:Attendee[];total:number;next_offset:number|null};
type Problem={code?:string};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});

async function request<T=Problem>(path:string,s?:Session,body?:unknown,version?:number){
  const headers:Record<string,string>={Origin:origin,...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();if(version)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,headers:response.headers,data:await response.json() as T};
}
async function signIn(index:number):Promise<Session>{
  const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_USERS[index].email,password:DEMO_PASSWORD})});
  const data=await response.json() as {csrf_token:string;user:{user_id:string}};
  return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:data.csrf_token,id:data.user.user_id};
}
async function publishedEvent(owner:Session,reviewer:Session,extra:Record<string,unknown>={}){
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_member_operations','active') ON CONFLICT DO NOTHING`,[randomUUID(),DEMO_COMMUNITY,reviewer.id]);
  await pool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,'guild_member_operations',$2) ON CONFLICT DO NOTHING`,[DEMO_COMMUNITY,reviewer.id]);
  const created=await request<{event_id:string}>('/events',owner,{title:'名單測試',description:'合成活動',starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+90000000).toISOString(),mode:'online',location:'https://example.org/meeting',capacity:10,visibility:'open',...extra});
  assert.equal(created.status,201,JSON.stringify(created.data));
  assert.equal((await request(`/events/${created.data.event_id}/review`,reviewer,{decision:'approve',reason:'資料完整'},1)).status,200);
  return created.data.event_id;
}

test('the organizer sees going members and public guests in registration order, matching the attending count, with no contact data',async()=>{
  const owner=await signIn(0),a=await signIn(1),b=await signIn(2);
  const id=await publishedEvent(owner,a);
  assert.equal((await request(`/events/${id}/rsvp`,a,{going:true})).status,200);
  const guest=await app.request(`${origin}/api/v1/public/events/${id}/register`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({name:'合成訪客',email:'guest-attendee@example.org',referral_code:null})});
  assert.equal(guest.status,200,await guest.text());
  assert.equal((await request(`/events/${id}/rsvp`,b,{going:true})).status,200);
  const list=await request<Page>(`/events/${id}/attendees`,owner);
  assert.equal(list.status,200,JSON.stringify(list.data));
  assert.equal(list.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(list.data.items.map(item=>item.kind==='member'?item.user_id:'guest'),[a.id,'guest',b.id]);
  assert.equal(list.data.total,3);assert.equal(list.data.next_offset,null);
  assert.equal((await request<{attending_count:number}>(`/events/${id}`,owner)).data.attending_count,list.data.total);
  const text=JSON.stringify(list.data);
  for(const secret of ['guest-attendee@example.org','合成訪客','@local.test','email'])assert.equal(text.includes(secret),false,secret);
  const member=list.data.items[0];assert.equal(member.kind,'member');
  assert.deepEqual(Object.keys(member).sort(),['avatar_url','kind','nickname','registered_at','user_id']);
  assert.deepEqual(Object.keys(list.data.items[1]).sort(),['kind','registered_at']);
  // A cancellation leaves the list.
  assert.equal((await request(`/events/${id}/rsvp`,a,{going:false})).status,200);
  const after=await request<Page>(`/events/${id}/attendees`,owner);
  assert.equal(after.data.total,2);assert.equal(after.data.items.some(item=>item.kind==='member'&&item.user_id===a.id),false);
});

test('only the organizer may read the list; others, unknown events and bad queries are refused',async()=>{
  const owner=await signIn(0),a=await signIn(1),b=await signIn(2);
  const id=await publishedEvent(owner,a);
  await request(`/events/${id}/rsvp`,b,{going:true});
  for(const viewer of [a,b]){const denied=await request(`/events/${id}/attendees`,viewer);assert.equal(denied.status,403);assert.equal(denied.data.code,'organizer_required');}
  assert.equal((await request(`/events/${randomUUID()}/attendees`,owner)).status,404);
  assert.equal((await request(`/events/${id}/attendees?limit=51`,owner)).status,422);
  assert.equal((await request(`/events/${id}/attendees?sort=name`,owner)).status,422);
  assert.equal((await app.request(`${origin}/api/v1/events/${id}/attendees`,{headers:{Origin:origin}})).status,401);
});

test('pages are stable and verification-only test accounts are excluded like the count',async()=>{
  const owner=await signIn(0),a=await signIn(1);
  const id=await publishedEvent(owner,a,{capacity:null});
  const ids:string[]=[];
  for(let i=0;i<5;i++){
    const user=randomUUID();ids.push(user);
    await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,community_id,$2,$3,password_hash,$4 FROM users WHERE user_id=$5`,[user,`attendee-${i}-${user}@${i===2?'example.invalid':'example.org'}`,`合成報名者${i}`,randomUUID(),owner.id]);
    await pool.query(`INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state,updated_at) VALUES($1,$2,$3,'going',timestamptz '2026-10-01T00:00:00Z'+make_interval(mins=>$4))`,[randomUUID(),id,user,i]);
  }
  // Index 2 uses the verification-only domain and must stay out of both the count and the list.
  const hidden=1;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM community_event_rsvps r WHERE r.event_id=$1 AND is_verification_test_account(r.user_id)',[id])).rows[0].n,hidden);
  const first=await request<Page>(`/events/${id}/attendees?limit=2`,owner);
  assert.equal(first.data.total,5-hidden);
  const all=[...first.data.items];let next=first.data.next_offset;
  while(next!==null){const page=await request<Page>(`/events/${id}/attendees?limit=2&offset=${next}`,owner);all.push(...page.data.items);next=page.data.next_offset;}
  assert.equal(all.length,5-hidden);
  assert.deepEqual(all.map(item=>item.kind==='member'?item.user_id:'guest'),ids.filter((_,index)=>index!==2));
  assert.deepEqual(all.map(item=>item.registered_at),[...all.map(item=>item.registered_at)].sort());
});

test('same-time guest registrations cross page boundaries without exposing their private tie-breaker',async()=>{
  const owner=await signIn(0),reviewer=await signIn(1),id=await publishedEvent(owner,reviewer);
  await pool.query(`INSERT INTO community_event_guest_rsvps(event_id,email,name,email_sent_at,created_at)
    SELECT $1,email,'private guest',clock_timestamp(),timestamptz '2026-10-01T00:00:00Z'
    FROM unnest(ARRAY['c-private@example.org','a-private@example.org','b-private@example.org']) AS email`,[id]);
  const items:Attendee[]=[];
  for(let offset=0;offset<3;offset++){
    const page=await request<Page>(`/events/${id}/attendees?limit=1&offset=${offset}`,owner);
    assert.equal(page.status,200);assert.equal(page.data.total,3);assert.equal(page.data.items.length,1);
    assert.equal(page.data.next_offset,offset===2?null:offset+1);items.push(...page.data.items);
  }
  for(const item of items)assert.deepEqual(Object.keys(item).sort(),['kind','registered_at']);
  assert.doesNotMatch(JSON.stringify(items),/private|email|registration_key/);
});

// Private domain reads must fence the session again after a real database wait.
const sessionExpired=(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='session_expired';
async function waitForAttendeeLock(application:string){
  for(let attempt=0;attempt<200;attempt++){
    const waiting=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",[application])).rows[0].waiting;
    if(waiting)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('attendee read did not reach the database lock barrier');
}
test('attendee domain read rejects a previously authenticated revoked session',async()=>{
  const owner=await signIn(0),reviewer=await signIn(1),id=await publishedEvent(owner,reviewer);
  const actor=await authenticate(pool,owner.cookie.split('=')[1]);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[actor.session_hash]);
  await assert.rejects(eventAttendees(pool,actor,id,{}),sessionExpired);
});
test('attendee read rejects expiry while blocked on its private roster query',async()=>{
  const owner=await signIn(0),reviewer=await signIn(1),id=await publishedEvent(owner,reviewer);
  const actor=await authenticate(pool,owner.cookie.split('=')[1]),application=`attendee-expiry-${randomUUID()}`;
  const reader=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,application_name:application,max:1,statement_timeout:10000}),blocker=await pool.connect();
  let outcome:Promise<{error?:unknown}>|undefined;
  try{
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=$1",[actor.session_hash]);
    await blocker.query('BEGIN');await blocker.query('LOCK TABLE community_event_rsvps IN ACCESS EXCLUSIVE MODE');
    outcome=eventAttendees(reader,actor,id,{}).then(()=>({}),error=>({error}));
    await waitForAttendeeLock(application);
    await blocker.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))+0.1) FROM sessions WHERE token_hash=$1',[actor.session_hash]);
    await blocker.query('COMMIT');
    assert.ok(sessionExpired((await outcome).error));
  }finally{await blocker.query('ROLLBACK');blocker.release();await outcome;await reader.end();}
});
test('attendee read checks current organizer after waiting for the event row lock',async()=>{
  const owner=await signIn(0),reviewer=await signIn(1),id=await publishedEvent(owner,reviewer);
  const actor=await authenticate(pool,owner.cookie.split('=')[1]),application=`attendee-owner-${randomUUID()}`;
  const reader=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,application_name:application,max:1,statement_timeout:10000}),blocker=await pool.connect();
  let outcome:Promise<{error?:unknown}>|undefined;
  try{
    await blocker.query('BEGIN');await blocker.query('UPDATE community_events SET organizer_ref=$2 WHERE event_id=$1',[id,reviewer.id]);
    outcome=eventAttendees(reader,actor,id,{}).then(()=>({}),error=>({error}));
    await waitForAttendeeLock(application);await blocker.query('COMMIT');
    const error=(await outcome).error;
    assert.ok(error&&typeof error==='object'&&'code' in error&&error.code==='organizer_required');
  }finally{await blocker.query('ROLLBACK');blocker.release();await outcome;await reader.end();}
});
