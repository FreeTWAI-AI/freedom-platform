import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {assessmentQuestions,ASSESSMENT_VERSION,ASSESSMENT_SHA256} from '../../modules/positioning/assessment.js';
const origin='http://127.0.0.1:4310',url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_guild_prefs_${process.pid}_${Date.now()}`,admin=createPool(url),pool=new Pool({connectionString:url,options:`-c search_path=${schema} -c application_name=${schema}`,max:12}),app=createApp(pool,origin);
admin.on('error',()=>{});pool.on('error',()=>{});
type Session={cookie:string;csrf:string;user:any};
const guilds=['guild_security','guild_ai_vibe','guild_marketing','guild_music_mv'];
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{
  try{await pool.end();}catch{/* still drop */}
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()',[schema]).catch(()=>{});
  try{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await admin.end();}
});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);});
async function request(path:string,s?:Session,body?:unknown,version?:string,key:string=randomUUID()){
 const headers:Record<string,string>={Origin:origin,...s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{}};
 if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
 const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any,response};
}
async function login(index=0){const r=await request('/auth/login',undefined,{email:DEMO_USERS[index].email,password:DEMO_PASSWORD});assert.equal(r.status,200);return {cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user} as Session;}
async function setup(){const s=await login();for(const key of guilds)assert.equal((await request(`/guilds/${key}/join`,s,{})).status,200);assert.equal((await request(`/guilds/${guilds[0]}/primary`,s,{})).status,200);return s;}
async function pref(s:Session){return (await request('/me/guild-preferences',s)).data;}
async function set(s:Session,keys:string[],version?:string,key?:string){return request('/me/guild-preferences/secondary',s,{secondary_guild_keys:keys},version??(await pref(s)).aggregate_version,key);}
async function memberGuild(s:Session,key:string){return (await request('/guilds/directory',s)).data.items.find((g:any)=>g.guild_key===key);}

test('legacy NULL projects two stable secondaries and all remaining joined guilds without a write',async()=>{
 const s=await setup();await pool.query('UPDATE guild_member_preferences SET secondary_guild_keys=NULL WHERE user_id=$1',[s.user.user_id]);
 const before=(await pool.query('SELECT * FROM guild_member_preferences WHERE user_id=$1',[s.user.user_id])).rows[0];
 assert.equal(before.secondary_guild_keys,null);assert.deepEqual((await pref(s)).secondary_guild_keys,guilds.slice(1).sort().slice(0,2));
 const directory=(await request('/guilds/directory',s)).data.items,secondary=directory.filter((g:any)=>g.is_secondary);
 assert.equal(secondary.length,2);assert.deepEqual(secondary.map((g:any)=>g.secondary_position).sort(),[1,2]);assert.ok(directory.filter((g:any)=>!g.is_secondary).every((g:any)=>g.secondary_position===null));
 const card=(await request(`/members/${s.user.user_id}`,s)).data;assert.equal(card.secondary_guilds.length,2);assert.deepEqual(card.joined_guilds.map((g:any)=>g.guild_key),['guild_music_mv']);
 assert.deepEqual((await pool.query('SELECT * FROM guild_member_preferences WHERE user_id=$1',[s.user.user_id])).rows[0],before);
});
test('ordered explicit selection and clearing persist across login without granting authority or books',async()=>{
 const s=await setup(),counts=(await pool.query('SELECT count(*) FROM member_skill_book_grants')).rows[0].count;
 assert.deepEqual((await set(s,[guilds[3],guilds[1]])).data.secondary_guild_keys,[guilds[3],guilds[1]]);
 const again=await login(),card=(await request(`/members/${s.user.user_id}`,again)).data;assert.deepEqual(card.secondary_guilds.map((g:any)=>g.guild_key),[guilds[3],guilds[1]]);assert.deepEqual(card.joined_guilds.map((g:any)=>g.guild_key),[guilds[2]]);
 assert.deepEqual((await set(again,[])).data.secondary_guild_keys,[]);assert.deepEqual((await pref(await login())).secondary_guild_keys,[]);
 assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_officers')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM member_skill_book_grants')).rows[0].count,counts);
 const other=await login(1);assert.deepEqual((await pref(other)).secondary_guild_keys,[]);assert.equal((await set(other,[guilds[1]],'1')).status,409);
});
test('strict selection rejects more than two, duplicates, primary, unjoined, unknown, and missing/stale versions',async()=>{
 const s=await setup(),version=(await pref(s)).aggregate_version;
 for(const keys of [guilds.slice(1),[guilds[1],guilds[1]],[guilds[0]]])assert.equal((await set(s,keys,version)).status,422);
 for(const key of ['guild_platform_engineering','guild_unknown'])assert.equal((await set(s,[key],version)).status,409);
 assert.equal((await request('/me/guild-preferences/secondary',s,{secondary_guild_keys:[]})).status,428);
 assert.equal((await set(s,[guilds[1]],version)).status,200);assert.equal((await set(s,[guilds[2]],version)).status,412);
 assert.equal((await request('/me/guild-preferences/secondary',s,{secondary_guild_keys:[],user_id:DEMO_USERS[1].user_id},(await pref(s)).aggregate_version)).status,422);
});
test('selection command is replay safe and serializes against another preference update',async()=>{
 const s=await setup(),version=(await pref(s)).aggregate_version,key=randomUUID(),first=await set(s,[guilds[3]],version,key);
 assert.equal(first.status,200);assert.deepEqual((await set(s,[guilds[3]],version,key)).data,first.data);assert.equal((await set(s,[guilds[2]],version,key)).status,409);
 const current=await pref(s),attempts=await Promise.all([set(s,[guilds[1]],current.aggregate_version),set(s,[guilds[2]],current.aggregate_version)]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,412]);
});
test('primary promotion keeps at most two slots, demotes the former primary, and respects explicit empty',async()=>{
 const s=await setup();await set(s,[guilds[1],guilds[2]]);
 const promoted=await request(`/guilds/${guilds[1]}/primary`,s,{},(await pref(s)).aggregate_version);assert.equal(promoted.status,200);assert.deepEqual(promoted.data.secondary_guild_keys,[guilds[2],guilds[0]]);
 await set(s,[]);const clear=await request(`/guilds/${guilds[2]}/primary`,s,{},(await pref(s)).aggregate_version);assert.deepEqual(clear.data.secondary_guild_keys,[]);
});
test('leaving an explicit secondary removes it and rejoining cannot resurrect its slot',async()=>{
 const s=await setup();await set(s,[guilds[1],guilds[2]]);const before=await pref(s),member=await memberGuild(s,guilds[1]);
 const left=await request(`/guilds/${guilds[1]}/leave`,s,{},member.membership.aggregate_version);assert.equal(left.status,200);assert.deepEqual((await pref(s)).secondary_guild_keys,[guilds[2]]);
 assert.equal((await set(s,[guilds[2]],before.aggregate_version)).status,412);
 assert.equal((await request(`/guilds/${guilds[1]}/join`,s,{},left.data.aggregate_version)).status,200);assert.deepEqual((await pref(s)).secondary_guild_keys,[guilds[2]]);
});
test('legacy leave freezes existing effective choices, and primary/secondary races cannot create an invalid preference',async()=>{
 const s=await setup();await pool.query('UPDATE guild_member_preferences SET secondary_guild_keys=NULL WHERE user_id=$1',[s.user.user_id]);const m=await memberGuild(s,guilds[1]);await request(`/guilds/${guilds[1]}/leave`,s,{},m.membership.aggregate_version);
 assert.deepEqual((await pref(s)).secondary_guild_keys,[guilds[2]]);const after=await memberGuild(s,guilds[1]);await request(`/guilds/${guilds[1]}/join`,s,{},after.membership.aggregate_version);assert.deepEqual((await pref(s)).secondary_guild_keys,[guilds[2]]);
 const version=(await pref(s)).aggregate_version,results=await Promise.all([set(s,[guilds[1],guilds[2]],version),request(`/guilds/${guilds[1]}/primary`,s,{},version)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);
 const p=await pref(s);assert.ok(!p.secondary_guild_keys.includes(p.primary_guild_key));assert.ok(p.secondary_guild_keys.length<=2);
});
test('re-exploration preserves explicit secondary order, and changed primary uses the same promotion rule',async()=>{
 const s=await setup();await set(s,[guilds[3],guilds[1]]);
 const body={assessment_version:ASSESSMENT_VERSION,assessment_sha256:ASSESSMENT_SHA256,answers:Object.fromEntries(assessmentQuestions.map(q=>[q.id,q.options[0].id])),occupation:'',founding_interest:false,capabilities:[],equipment:[]};
 const saved=await request('/me/onboarding/answers',s,body),evaluated=await request('/me/onboarding/evaluate',s,{},saved.data.draft.aggregate_version);
 const complete=await request('/me/onboarding/complete',s,{guild_keys:[guilds[0]],primary_guild_key:guilds[0],confirmed:true},evaluated.data.draft.aggregate_version);assert.equal(complete.status,200);assert.deepEqual(complete.data.secondary_guild_keys,[guilds[3],guilds[1]]);
 const saved2=await request('/me/onboarding/answers',s,body,complete.data.draft.aggregate_version),eval2=await request('/me/onboarding/evaluate',s,{},saved2.data.draft.aggregate_version);
 const changed=await request('/me/onboarding/complete',s,{guild_keys:[guilds[3]],primary_guild_key:guilds[3],confirmed:true},eval2.data.draft.aggregate_version);assert.equal(changed.status,200);assert.deepEqual(changed.data.secondary_guild_keys,[guilds[1],guilds[0]]);
 assert.equal((await pool.query('SELECT count(*) FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2',[DEMO_COMMUNITY,s.user.user_id])).rows[0].count,'4');
});

test('concurrent selection and leave serialize without retaining a departed secondary',async()=>{
 const s=await setup();await set(s,[]);const version=(await pref(s)).aggregate_version,member=await memberGuild(s,guilds[1]);
 const [select,left]=await Promise.all([set(s,[guilds[1]],version),request(`/guilds/${guilds[1]}/leave`,s,{},member.membership.aggregate_version)]);
 assert.equal(left.status,200);const final=await pref(s);
 if(select.status===200){
   assert.deepEqual(select.data.secondary_guild_keys,[guilds[1]]);
   assert.equal(BigInt(final.aggregate_version),BigInt(version)+2n);
 }else{
   // Leave-first changes no preferences when the explicit selection was already
   // empty, so the version remains current and membership validation returns 409.
   assert.equal(select.status,409,JSON.stringify(select.data));assert.equal(select.data.code,'active_guild_required');
   assert.equal(final.aggregate_version,version);
 }
 assert.deepEqual(final.secondary_guild_keys,[]);assert.equal((await memberGuild(s,guilds[1])).membership.state,'left');
 const departed=await set(s,[guilds[1]],final.aggregate_version);assert.equal(departed.status,409);assert.equal(departed.data.code,'active_guild_required');assert.deepEqual(await pref(s),final);
 assert.equal((await request(`/guilds/${guilds[1]}/join`,s,{},left.data.aggregate_version)).status,200);assert.deepEqual((await pref(s)).secondary_guild_keys,[]);
});


test('initial primary freezes secondary choices before later member or administrator-style joins',async()=>{
 const s=await setup(),before=await pref(s);
 assert.deepEqual((await pool.query('SELECT secondary_guild_keys FROM guild_member_preferences WHERE user_id=$1',[s.user.user_id])).rows[0].secondary_guild_keys,[guilds[1],guilds[2]]);
 assert.equal((await request('/guilds/guild_ai_field/join',s,{})).status,200);
 // Appointment paths add active memberships directly; no preference write is involved.
 await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_ai_project','active')",[randomUUID(),DEMO_COMMUNITY,s.user.user_id]);
 assert.deepEqual(await pref(s),before);
 const card=(await request(`/members/${s.user.user_id}`,s)).data;
 assert.deepEqual(card.secondary_guilds.map((g:any)=>g.guild_key),[guilds[1],guilds[2]]);
 assert.ok(card.joined_guilds.some((g:any)=>g.guild_key==='guild_ai_field'));assert.ok(card.joined_guilds.some((g:any)=>g.guild_key==='guild_ai_project'));
});

test('upgrade backfills existing preferences once, including empty choices, without later join displacement',async()=>{
 const s=await setup(),other=await login(1);await request(`/guilds/${guilds[0]}/join`,other,{});await request(`/guilds/${guilds[0]}/primary`,other,{});
 // Recreate the pre-027 table shape in this test's isolated schema, then execute
 // the real migration against existing memberships rather than a copied query.
 await pool.query('ALTER TABLE guild_member_preferences DROP COLUMN secondary_guild_keys');
 await pool.query(await readFile(new URL('../../migrations/027_secondary_guild_preferences.sql',import.meta.url),'utf8'));
 const saved=(await pool.query('SELECT user_id,secondary_guild_keys FROM guild_member_preferences')).rows;
 assert.deepEqual(saved.find(r=>r.user_id===s.user.user_id).secondary_guild_keys,[guilds[1],guilds[2]]);
 assert.deepEqual(saved.find(r=>r.user_id===other.user.user_id).secondary_guild_keys,[]);
 await request('/guilds/guild_ai_field/join',s,{});await request('/guilds/guild_ai_field/join',other,{});
 assert.deepEqual((await pref(s)).secondary_guild_keys,[guilds[1],guilds[2]]);assert.deepEqual((await pref(other)).secondary_guild_keys,[]);
});
