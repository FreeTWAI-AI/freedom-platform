import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { assessmentQuestions,ASSESSMENT_VERSION,ASSESSMENT_SHA256,evaluateAssessment,guildTitles } from '../../modules/positioning/assessment.js';
import { memberPositioningSummary } from '../../modules/positioning/onboarding.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_onboarding_test_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
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
const answers=Object.fromEntries(assessmentQuestions.map(q=>[q.id,q.options[0].id]));
const body={assessment_version:ASSESSMENT_VERSION,assessment_sha256:ASSESSMENT_SHA256,answers,occupation:'茶農（本人私密職業）',founding_interest:true,capabilities:['getting_started'],equipment:[]};
const chosen=['guild_product_quality_supply','guild_commerce_sales','guild_marketing'];
async function evaluated(member:Session){const saved=await request('/me/onboarding/answers',member,body);assert.equal(saved.status,200,JSON.stringify(saved.data));const evaluated=await request('/me/onboarding/evaluate',member,{},saved.data.draft.aggregate_version);assert.equal(evaluated.status,200,JSON.stringify(evaluated.data));return evaluated.data;}
async function completed(member:Session){const data=await evaluated(member),r=await request('/me/onboarding/complete',member,{guild_keys:chosen,primary_guild_key:chosen[0],confirmed:true},data.draft.aggregate_version);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}

test('original assessment deterministically recommends three of twelve guilds without exposing scores or diagnostic labels',async()=>{
 const result=evaluateAssessment(answers);assert.deepEqual(evaluateAssessment({...answers}),result);assert.equal(result.recommendations.length,3);assert.equal(new Set(result.recommendations.map(r=>r.guild_key)).size,3);
 assert.equal(result.ability_feedback.length,6);assert.ok(result.recommendations.every(r=>r.reason&&r.title));assert.equal('scores' in result,false);
 const member=await signIn(),definition=await request('/assessment-definition',member);assert.equal(definition.status,200);assert.equal(definition.data.assessment_sha256,ASSESSMENT_SHA256);
 assert.equal(definition.data.questions.length,12);assert.ok(definition.data.questions.every((q:any)=>q.options.every((o:any)=>!('weights' in o))));
 assert.ok(definition.data.capability_categories.length>5);assert.ok(definition.data.equipment_categories.length>2);
});

test('every guild can be the first recommendation for at least one preference combination',()=>{
 const preferences=assessmentQuestions.filter(question=>question.kind==='preference');
 const reachable=new Set<string>();
 const combinations=preferences.reduce((n,q)=>n*q.options.length,1);
 for(let index=0;index<combinations;index++){
   let cursor=index;const selected={...answers};
   for(const question of preferences){selected[question.id]=question.options[cursor%question.options.length].id;cursor=Math.floor(cursor/question.options.length);}
   reachable.add(evaluateAssessment(selected).recommendations[0].guild_key);
 }
 assert.deepEqual([...reachable].sort(),Object.keys(guildTitles).sort());
});

test('new members cannot bypass required assessment; draft resumes across sign-in and rejects forged score, unknown answer and old versions',async()=>{
 const member=await signIn();await pool.query('UPDATE users SET onboarding_required=true WHERE user_id=$1',[member.user.user_id]);
 assert.equal((await request('/supplier/products',member)).status,403);assert.equal((await request('/work-items',member)).status,403);
 assert.equal((await request('/me/onboarding/complete',member,{guild_keys:chosen,primary_guild_key:chosen[0],confirmed:true})).status,409);
 const draft={...body,answers:{preferred_result:'product'}},key=randomUUID();
 const saved=await request('/me/onboarding/answers',member,draft,undefined,key);assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.required,true);assert.equal(saved.data.state,'draft');
 assert.deepEqual((await request('/me/onboarding/answers',member,draft,undefined,key)).data,saved.data);
 assert.equal((await request('/me/onboarding/evaluate',member,{},1)).status,422);
 const resumed=await request('/me/onboarding',await signIn());assert.equal(resumed.data.draft.occupation,body.occupation);assert.deepEqual(resumed.data.draft.answers,draft.answers);
 assert.equal((await request('/me/onboarding/answers',member,{...body,scores:{guild_ai_vibe:999}},1)).status,422);
 assert.equal((await request('/me/onboarding/answers',member,{...body,answers:{...answers,unknown:'injected'}},1)).status,422);
 assert.equal((await request('/me/onboarding/answers',member,{...body,assessment_sha256:'0'.repeat(64)},1)).status,422);
 const full=await request('/me/onboarding/answers',member,body,1);assert.equal(full.status,200,JSON.stringify(full.data));
 assert.equal((await request('/me/onboarding/answers',member,body,1)).status,412);assert.equal((await request('/me/onboarding/answers',member,body)).status,428);
 const result=await request('/me/onboarding/evaluate',member,{},2);assert.equal(result.data.state,'evaluated');assert.equal((await request('/work-items',member)).status,403);
});

test('completion atomically creates explicit memberships, exactly one primary and repository grants, then unlocks member',async()=>{
 const member=await signIn();await pool.query('UPDATE users SET onboarding_required=true WHERE user_id=$1',[member.user.user_id]);
 const result=await evaluated(member),key=randomUUID(),complete={guild_keys:chosen,primary_guild_key:chosen[0],confirmed:true};
 assert.equal((await request('/me/onboarding/complete',member,{...complete,primary_guild_key:'guild_ai_vibe'},result.draft.aggregate_version)).status,422);
 assert.equal((await request('/me/onboarding/complete',member,{...complete,guild_keys:[...chosen,'guild_fake']},result.draft.aggregate_version)).status,422);
 assert.equal((await pool.query('SELECT count(*) FROM positioning_profession_memberships')).rows[0].count,'0');
 const completed=await request('/me/onboarding/complete',member,complete,result.draft.aggregate_version,key);assert.equal(completed.status,200,JSON.stringify(completed.data));assert.equal(completed.data.required,false);assert.equal(completed.data.completed,true);assert.equal(completed.data.primary_guild_key,chosen[0]);
 assert.deepEqual((await request('/me/onboarding/complete',member,complete,result.draft.aggregate_version,key)).data,completed.data);
 const guilds=(await request('/guilds/directory',member)).data.items;assert.equal(guilds.filter((g:any)=>g.is_primary).length,1);assert.equal(guilds.filter((g:any)=>g.membership?.state==='active').length,3);assert.ok(guilds.every((g:any)=>g.guild_master===null));
 const books=(await request('/me/skill-books',member)).data.items;assert.ok(books.length>=3);assert.ok(books.every((book:any)=>book.repository_url.startsWith('https://github.com/')&&book.fork_url.startsWith('https://github.com/')));
 assert.equal((await request('/work-items',member)).status,200);
 const events=(await pool.query('SELECT payload FROM outbox')).rows;assert.ok(events.length>0);assert.equal(JSON.stringify(events).includes(body.occupation),false);assert.equal(JSON.stringify(events).includes('preferred_result'),false);
 const projection=await memberPositioningSummary(pool,member.user.community_id??(await pool.query('SELECT community_id FROM users WHERE user_id=$1',[member.user.user_id])).rows[0].community_id,member.user.user_id);
 assert.ok(projection.positioning_title);assert.equal(projection.primary_guild!.guild_key,chosen[0]);assert.equal(projection.secondary_guilds.length,2);assert.deepEqual(projection.capabilities,['getting_started']);assert.equal('answers' in projection,false);assert.equal('occupation' in projection,false);
});

test('stale concurrent primary changes cannot orphan the primary membership; membership grants are idempotent',async()=>{
 const member=await signIn();await completed(member);
 const pref=(await request('/me/guild-preferences',member)).data;
 const results=await Promise.all([request(`/guilds/${chosen[1]}/primary`,member,{},pref.aggregate_version),request(`/guilds/${chosen[2]}/primary`,member,{},pref.aggregate_version)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);
 const current=(await request('/me/guild-preferences',member)).data;
 const directory=(await request('/guilds/directory',member)).data.items;const primary=directory.find((g:any)=>g.guild_key===current.primary_guild_key);
 assert.equal((await request(`/guilds/${primary.guild_key}/leave`,member,{},primary.membership.aggregate_version)).status,409);
 assert.equal((await request('/guilds/guild_ai_vibe/primary',member,{},current.aggregate_version)).status,409);
 const counts=Number((await pool.query('SELECT count(*) FROM member_skill_book_grants')).rows[0].count);
 await request(`/guilds/${chosen[0]}/join`,member,{});await request(`/guilds/${chosen[0]}/join`,member,{});
 assert.equal(Number((await pool.query('SELECT count(*) FROM member_skill_book_grants')).rows[0].count),counts);
});

test('concurrent completion produces one completion fact and one grant per guild-book without deadlocks',async()=>{
 const member=await signIn(),result=await evaluated(member),input={guild_keys:chosen,primary_guild_key:chosen[0],confirmed:true};
 const attempts=await Promise.all([request('/me/onboarding/complete',member,input,result.draft.aggregate_version),request('/me/onboarding/complete',member,input,result.draft.aggregate_version)]);
 assert.deepEqual(attempts.map(r=>r.status).sort(),[200,412]);
 assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE event_type='freedom.membership.onboarding.completed.v1'")).rows[0].count,'1');
 assert.equal((await pool.query('SELECT count(*) FROM guild_member_preferences')).rows[0].count,'1');
});

test('guild applications remain pending, scoped to applicant, and never create guilds or grant officers',async()=>{
 const member=await signIn(),other=await signIn(DEMO_USERS[1].email),input={name:'農業職人公會',profession:'農業',reason:'希望一起整理農業現場的可重用知識與工具。'},key=randomUUID();
 const applied=await request('/guild-applications',member,input,undefined,key);assert.equal(applied.status,201,JSON.stringify(applied.data));assert.equal(applied.data.state,'pending');
 assert.deepEqual((await request('/guild-applications',member,input,undefined,key)).data,applied.data);assert.equal((await request('/guild-applications',member,input)).status,409);
 assert.equal((await request('/guild-applications',member)).data.items.length,1);assert.equal((await request('/guild-applications',other)).data.items.length,0);
 assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_catalog')).rows[0].count,'12');assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_officers')).rows[0].count,'0');
 assert.equal((await request('/me/onboarding',other)).data.draft,null);assert.deepEqual((await request('/me/skill-books',other)).data.items,[]);
});

test('retaking the assessment preserves the last confirmed public capabilities until a new completion',async()=>{
 const member=await signIn(),previous=await completed(member);
 const community=(await pool.query('SELECT community_id FROM users WHERE user_id=$1',[member.user.user_id])).rows[0].community_id;
 const saved=await request('/me/onboarding/answers',member,{...body,answers:{preferred_result:'video'},capabilities:[]},previous.draft.aggregate_version);
 assert.equal(saved.status,200);assert.equal(saved.data.completed,true);assert.equal(saved.data.required,false);
 assert.deepEqual((await memberPositioningSummary(pool,community,member.user.user_id)).capabilities,['getting_started']);
 assert.equal((await request('/work-items',member)).status,200);
});
