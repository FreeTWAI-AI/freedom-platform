import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_events_past_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown){
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function signIn(email=DEMO_USERS[0].email):Promise<Session>{
  const result=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});
  assert.equal(result.status,200,JSON.stringify(result.data));
  return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token,user:result.data.user};
}
async function addUser(email:string,name:string){
  const id=randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    SELECT $1,community_id,$2,$3,password_hash,$4 FROM users WHERE user_id=$5`,[id,email,name,randomUUID(),DEMO_USERS[0].user_id]);
  return id;
}
function insertEvent(id:string,organizer:string,title:string,startSql:string,visibility='open'){
  return pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind,guild_key)
    VALUES($1,$2,$3,$4,'仍可閱讀的活動說明',${startSql},${startSql}+interval '2 hours','online','線上教室','published',$5,${visibility==='guild'?"'guild_skill_exchange'":"'other'"},${visibility==='guild'?"'guild_security'":'NULL'})`,
  [id,DEMO_COMMUNITY,organizer,title,visibility]);
}

test('a published event that started 45 days ago stays readable and cannot be joined',async()=>{
  const viewer=await signIn(),host=await signIn(DEMO_USERS[1].email);
  const id=randomUUID(),title='四十五天前的公開活動';
  await insertEvent(id,host.user.user_id,title,"now()-interval '45 days'");
  const list=await request('/events',viewer);
  assert.equal(list.status,200);
  const item=list.data.items.find((row:any)=>row.event_id===id);
  assert.equal(item.title,title);assert.equal(item.state,'published');assert.equal(item.visibility,'open');
  assert.equal('list_rank' in item,false);
  const read=await request(`/events/${id}`,viewer);
  assert.equal(read.status,200);assert.equal(read.data.description,'仍可閱讀的活動說明');assert.equal(read.data.state,'published');
  const page=await request(`/public/events/${id}`);
  assert.equal(page.status,200);assert.equal(page.data.title,title);assert.equal(page.data.description,'仍可閱讀的活動說明');
  const rsvp=await request(`/events/${id}/rsvp`,viewer,{going:true});
  assert.equal(rsvp.status,409);assert.equal(rsvp.data.code,'event_closed');
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[viewer.user.user_id]);
  const preview=await request('/events',viewer);
  assert.equal(preview.data.items.find((row:any)=>row.event_id===id).title,title);
  assert.equal(preview.data.items[0].location,undefined);assert.equal(preview.data.items[0].organizer_name,undefined);
});

test('a guild-only past event stays inside the guild, and a test-account host stays hidden',async()=>{
  const member=await signIn(),outsider=await signIn(DEMO_USERS[1].email),host=await signIn(DEMO_USERS[2].email);
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_security','active')`,[randomUUID(),DEMO_COMMUNITY,member.user.user_id]);
  const guildId=randomUUID();
  await insertEvent(guildId,host.user.user_id,'公會裡的舊交流',"now()-interval '50 days'",'guild');
  assert.equal((await request('/events',outsider)).data.items.some((row:any)=>row.event_id===guildId),false);
  assert.equal((await request(`/events/${guildId}`,outsider)).status,404);
  assert.equal((await request('/events',member)).data.items.find((row:any)=>row.event_id===guildId).title,'公會裡的舊交流');
  const tester=await addUser(`past-host-${randomUUID()}@example.invalid`,'合成舊活動主辦');
  const hiddenId=randomUUID();
  await insertEvent(hiddenId,tester,'驗收帳號的舊活動',"now()-interval '70 days'");
  assert.equal((await request('/events',member)).data.items.some((row:any)=>row.event_id===hiddenId),false);
  assert.equal((await request(`/events/${hiddenId}`,member)).status,404);
  assert.equal((await request(`/public/events/${hiddenId}`)).status,404);
  const self=await signIn((await pool.query('SELECT email FROM users WHERE user_id=$1',[tester])).rows[0].email);
  assert.equal((await request('/events',self)).data.items.some((row:any)=>row.event_id===hiddenId),true);
});

test('upcoming and own pending events survive a large past-event list',async()=>{
  const viewer=await signIn(),host=DEMO_USERS[1].user_id;
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    SELECT gen_random_uuid(),$1,$2,'大量過去 '||g::text,'已結束的活動',now()-make_interval(days=>g),now()-make_interval(days=>g)+interval '1 hour','online','線上','published','open','other'
    FROM generate_series(31,150) g`,[DEMO_COMMUNITY,host]);
  const upcoming=randomUUID(),pending=randomUUID();
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    VALUES($1,$2,$3,'即將的大量活動','還沒開始',now()+interval '2 days',now()+interval '3 days','online','線上','published','workshop','other'),
    ($4,$2,$5,'我的待審活動','還在審核',now()+interval '4 days',now()+interval '5 days','online','線上','pending','workshop','other')`,
  [upcoming,DEMO_COMMUNITY,host,pending,viewer.user.user_id]);
  const list=await request('/events',viewer);
  const items=list.data.items as any[];
  assert.equal(items.find(row=>row.event_id===upcoming).state,'published');
  assert.equal(items.find(row=>row.event_id===pending).state,'pending');
  const past=items.filter(row=>String(row.title).startsWith('大量過去'));
  assert.equal(past.length,100);
  assert.equal(past.some(row=>row.title==='大量過去 31'),true);
  assert.equal(past.some(row=>row.title==='大量過去 150'),false);
  assert.equal(items.some(row=>'list_rank' in row),false);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[viewer.user.user_id]);
  const preview=(await request('/events',viewer)).data.items as any[];
  assert.equal(preview.some(row=>row.event_id===upcoming),true);
  assert.equal(preview.some(row=>row.event_id===pending),true);
  assert.equal(preview.some(row=>row.title==='大量過去 31'),true);
  assert.equal(preview[0].location,undefined);
});
