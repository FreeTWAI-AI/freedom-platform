import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { assessmentQuestions,ASSESSMENT_VERSION,ASSESSMENT_SHA256,evaluateAssessment,guildTitles } from '../../modules/positioning/assessment.js';
import { memberPositioningSummary,listGuildSkillBooks } from '../../modules/positioning/onboarding.js';

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

test('original assessment deterministically recommends three of eighteen guilds without exposing scores or diagnostic labels',async()=>{
 const result=evaluateAssessment(answers);assert.deepEqual(evaluateAssessment({...answers}),result);assert.equal(result.recommendations.length,3);assert.equal(new Set(result.recommendations.map(r=>r.guild_key)).size,3);
 assert.equal(result.ability_feedback.length,9);assert.ok(result.recommendations.every(r=>r.reason&&r.title));assert.equal('scores' in result,false);
 const member=await signIn(),definition=await request('/assessment-definition',member);assert.equal(definition.status,200);assert.equal(definition.data.assessment_sha256,ASSESSMENT_SHA256);
 assert.equal(definition.data.questions.length,15);assert.ok(definition.data.questions.every((q:any)=>q.options.every((o:any)=>!('weights' in o))));
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
 assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_catalog')).rows[0].count,'18');assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_officers')).rows[0].count,'0');
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

for(const [choice,guildKey,bookId] of [['security','guild_security','security-scanner'],['music_mv','guild_music_mv','music-mv'],['commercial_production','guild_commercial_production','commercial-production'],['event_space','guild_event_space','event-space'],['projection_mapping','guild_projection_mapping','projection-mapping'],['human_design','guild_human_design','human-design']] as const)test(`${guildKey} is recommendable as primary and grants its actual repository book with unassigned leader`,async()=>{
 const member=await signIn(),specialistAnswers={...answers,preferred_result:choice,work_material:choice,learning_focus:choice};
 assert.equal(evaluateAssessment(specialistAnswers).recommendations[0].guild_key,guildKey);
 const saved=await request('/me/onboarding/answers',member,{...body,answers:specialistAnswers});assert.equal(saved.status,200);
 const evaluated=await request('/me/onboarding/evaluate',member,{},saved.data.draft.aggregate_version);assert.equal(evaluated.data.result.recommendations[0].guild_key,guildKey);
 const complete=await request('/me/onboarding/complete',member,{guild_keys:[guildKey],primary_guild_key:guildKey,confirmed:true},evaluated.data.draft.aggregate_version);assert.equal(complete.status,200,JSON.stringify(complete.data));assert.equal(complete.data.primary_guild_key,guildKey);
 const books=(await request('/me/skill-books',member)).data.items;assert.equal(books[0].book_id,bookId);assert.match(books[0].repository_url,/^https:\/\/github\.com\/FreeTWAI-AI\//);
 const directory=(await request('/guilds/directory',member)).data.items;assert.equal(directory.length,18);const guild=directory.find((g:any)=>g.guild_key===guildKey);assert.equal(guild.guild_master,null);assert.equal(guild.is_primary,true);
});

const oldVersion='freedom-orientation-v1',oldHash='fa485d9b23a0b7626c85284788297ef4b0425d45f2b7950842646b2a39e844cf';
test('an existing v1 draft requires explicit upgrade and additional answers, never silently re-scores',async()=>{
 const member=await signIn();await evaluated(member);
 const oldAnswers={...answers};for(const id of ['ability_security','ability_music_rights','ability_commercial_brief'])delete oldAnswers[id];
 const priorResult={assessment_version:oldVersion,assessment_sha256:oldHash,recommendations:[{guild_key:chosen[0],title:'原先結果',reason:'舊版已儲存結果'}]};
 await pool.query('UPDATE onboarding_assessments SET assessment_version=$1,assessment_sha256=$2,answers=$3,result=$4 WHERE user_id=$5',[oldVersion,oldHash,JSON.stringify(oldAnswers),JSON.stringify(priorResult),member.user.user_id]);
 const old=await request('/me/onboarding',member);assert.equal(old.data.assessment_update_required,true);assert.equal(old.data.current_assessment_version,ASSESSMENT_VERSION);assert.deepEqual(old.data.result,priorResult);
 assert.equal((await request('/me/onboarding/evaluate',member,{},old.data.draft.aggregate_version)).data.code,'assessment_revision_changed');
 assert.equal((await request('/me/onboarding/complete',member,{guild_keys:chosen,primary_guild_key:chosen[0],confirmed:true},old.data.draft.aggregate_version)).data.code,'assessment_revision_changed');
 assert.equal((await request('/me/onboarding/answers',member,{...body,assessment_version:oldVersion,assessment_sha256:oldHash},old.data.draft.aggregate_version)).status,422);
 const upgraded=await request('/me/onboarding/answers',member,{...body,answers:oldAnswers},old.data.draft.aggregate_version);assert.equal(upgraded.status,200);assert.equal(upgraded.data.assessment_update_required,false);assert.equal(upgraded.data.result,null);
 assert.equal((await request('/me/onboarding/evaluate',member,{},upgraded.data.draft.aggregate_version)).data.code,'assessment_incomplete');
 const full=await request('/me/onboarding/answers',member,body,upgraded.data.draft.aggregate_version);assert.equal(full.status,200);assert.equal((await request('/me/onboarding/evaluate',member,{},full.data.draft.aggregate_version)).status,200);
});
test('completed v1 members retain their primary guild, title, published capabilities and access after new guild rollout',async()=>{
 const member=await signIn();await completed(member);
 const community=(await pool.query('SELECT community_id FROM users WHERE user_id=$1',[member.user.user_id])).rows[0].community_id;
 const oldSummary=await memberPositioningSummary(pool,community,member.user.user_id);
 await pool.query('UPDATE onboarding_assessments SET assessment_version=$1,assessment_sha256=$2 WHERE user_id=$3',[oldVersion,oldHash,member.user.user_id]);
 const view=(await request('/me/onboarding',member)).data;assert.equal(view.assessment_update_required,true);assert.equal(view.completed,true);assert.equal(view.required,false);assert.equal(view.primary_guild_key,chosen[0]);
 assert.deepEqual(await memberPositioningSummary(pool,community,member.user.user_id),oldSummary);assert.equal((await request('/work-items',member)).status,200);
});

test('skill and equipment trees preserve unique flat options with meaningful subcategories and nontechnical paths',async()=>{
 const member=await signIn(),definition=(await request('/assessment-definition',member)).data;
 for(const categories of [definition.capability_categories,definition.equipment_categories]){
   const allIds=categories.flatMap((category:any)=>category.options.map((option:any)=>option.id));assert.equal(new Set(allIds).size,allIds.length);
   for(const category of categories){
     assert.ok(category.subcategories.length>=2);
     const ids=category.subcategories.flatMap((group:any)=>group.options.map((option:any)=>option.id));
     assert.deepEqual([...ids].sort(),category.options.map((option:any)=>option.id).sort());assert.equal(new Set(ids).size,ids.length);
   }
 }
 for(const id of ['sales_support','craft_food','field_operations','education_languages','business_support'])assert.ok(definition.capability_categories.some((category:any)=>category.id===id));
});

test('custom skills, equipment and at most three selected featured skills persist; question notes stay private and never affect scoring',async()=>{
 const member=await signIn(),other=await signIn(DEMO_USERS[1].email),selected=['python','sales','customer_service','composition'];
 const input={...body,capabilities:selected,equipment:['sub_suno'],custom_capabilities:['台語訪談','咖啡拉花'],custom_equipment:['我的錄音服務'],featured_capabilities:['sales','custom:台語訪談','composition'],question_notes:{preferred_result:'這段職涯補充只供本人查看',ability_support:'我想補充個人的實際情境'}};
 const saved=await request('/me/onboarding/answers',member,input);assert.equal(saved.status,200,JSON.stringify(saved.data));
 const resumed=(await request('/me/onboarding',await signIn())).data;assert.deepEqual(resumed.draft.custom_capabilities,input.custom_capabilities);assert.deepEqual(resumed.draft.custom_equipment,input.custom_equipment);assert.deepEqual(resumed.draft.featured_capabilities,input.featured_capabilities);assert.deepEqual(resumed.draft.question_notes,input.question_notes);
 const result=await request('/me/onboarding/evaluate',member,{},resumed.draft.aggregate_version);assert.equal(result.status,200);
 assert.deepEqual(result.data.result.recommendations.map((r:any)=>r.guild_key),evaluateAssessment(answers).recommendations.map(r=>r.guild_key));
 const completed=await request('/me/onboarding/complete',member,{guild_keys:chosen,primary_guild_key:chosen[0],confirmed:true},result.data.draft.aggregate_version);assert.equal(completed.status,200);
 const card=(await request('/members/'+member.user.user_id,other)).data;
 assert.deepEqual(card.capabilities,selected);assert.deepEqual(card.custom_capabilities,input.custom_capabilities);assert.deepEqual(card.custom_equipment,input.custom_equipment);assert.deepEqual(card.featured_capabilities,input.featured_capabilities);assert.equal(card.featured_capabilities.length,3);
 assert.equal('question_notes' in card,false);assert.equal('occupation' in card,false);assert.equal(JSON.stringify(card).includes(input.question_notes.preferred_result),false);
 assert.equal(JSON.stringify((await pool.query('SELECT payload FROM outbox')).rows).includes(input.question_notes.preferred_result),false);
});

test('featured skills must be selected, unique and at most three; bounded freeform fields reject malformed entries',async()=>{
 const member=await signIn(),input={...body,capabilities:['python','sales','composition','customer_service'],custom_capabilities:['台語訪談'],custom_equipment:[],featured_capabilities:['python']};
 for(const changes of [
   {featured_capabilities:['python','sales','composition','customer_service']},
   {featured_capabilities:['python','python']},
   {featured_capabilities:['security_review']},
   {featured_capabilities:['custom:不在清單的能力']},
   {custom_capabilities:Array.from({length:11},(_,i)=>'能力'+i)},
   {custom_capabilities:['長'.repeat(61)]},
   {custom_capabilities:['Coding','coding']},
   {custom_capabilities:['不允許\n多行']},
   {custom_equipment:['服務\u0000名稱']},
   {custom_equipment:['長'.repeat(61)]},
   {question_notes:{unknown_question:'不是目前題目'}},
   {question_notes:{preferred_result:'長'.repeat(501)}},
 ])assert.equal((await request('/me/onboarding/answers',member,{...input,...changes})).status,422,JSON.stringify(changes));
 assert.equal((await pool.query('SELECT count(*) FROM onboarding_assessments')).rows[0].count,'0');
 const valid=await request('/me/onboarding/answers',member,{...input,featured_capabilities:['python','custom:台語訪談']});assert.equal(valid.status,200,JSON.stringify(valid.data));
});

test('a novice with no claimed skills or equipment can finish positioning without invented featured skills',async()=>{
 const member=await signIn();await pool.query('UPDATE users SET onboarding_required=true WHERE user_id=$1',[member.user.user_id]);
 const noviceAnswers=Object.fromEntries(assessmentQuestions.map(question=>[question.id,question.kind==='ability'?'learn':question.options[0].id]));
 const saved=await request('/me/onboarding/answers',member,{...body,answers:noviceAnswers,capabilities:[],equipment:[],custom_capabilities:[],custom_equipment:[],featured_capabilities:[]});assert.equal(saved.status,200);
 const result=await request('/me/onboarding/evaluate',member,{},saved.data.draft.aggregate_version);assert.equal(result.status,200,JSON.stringify(result.data));
 const done=await request('/me/onboarding/complete',member,{guild_keys:chosen,primary_guild_key:chosen[0],confirmed:true},result.data.draft.aggregate_version);assert.equal(done.status,200);assert.equal(done.data.required,false);
 const card=(await request('/members/'+member.user.user_id,member)).data;assert.deepEqual(card.capabilities,[]);assert.deepEqual(card.featured_capabilities,[]);assert.deepEqual(card.custom_capabilities,[]);assert.equal((await request('/work-items',member)).status,200);
});

test('legacy snapshots retain full inventory while compact skills fall back to first three; explicit empty selection stays empty',async()=>{
 const member=await signIn(),done=await completed(member),full=['python','sales','composition','customer_service'];
 await pool.query('UPDATE onboarding_assessments SET published_profile=$1 WHERE user_id=$2',[JSON.stringify({capabilities:full,equipment:['sub_suno']}),member.user.user_id]);
 const old=(await request('/members/'+member.user.user_id,member)).data;assert.deepEqual(old.capabilities,full);assert.deepEqual(old.featured_capabilities,full.slice(0,3));assert.deepEqual(old.custom_capabilities,[]);
 const saved=await request('/me/onboarding/answers',member,{...body,capabilities:full,featured_capabilities:[]},done.draft.aggregate_version);assert.equal(saved.status,200);
 const result=await request('/me/onboarding/evaluate',member,{},saved.data.draft.aggregate_version);assert.equal(result.status,200);
 assert.equal((await request('/me/onboarding/complete',member,{guild_keys:chosen,primary_guild_key:chosen[0],confirmed:true},result.data.draft.aggregate_version)).status,200);
 const current=(await request('/members/'+member.user.user_id,member)).data;assert.deepEqual(current.capabilities,full);assert.deepEqual(current.featured_capabilities,[]);
});

test('older clients omitting new optional fields preserve custom data and remove only featured references no longer selected',async()=>{
 const member=await signIn(),input={...body,capabilities:['python','sales'],custom_capabilities:['台語訪談'],custom_equipment:['自備工具服務'],featured_capabilities:['python','custom:台語訪談'],question_notes:{preferred_result:'本人補充'}};
 const saved=await request('/me/onboarding/answers',member,input);assert.equal(saved.status,200);
 const older=await request('/me/onboarding/answers',member,{...body,capabilities:['sales']},saved.data.draft.aggregate_version);assert.equal(older.status,200,JSON.stringify(older.data));
 assert.deepEqual(older.data.draft.custom_capabilities,input.custom_capabilities);assert.deepEqual(older.data.draft.custom_equipment,input.custom_equipment);assert.deepEqual(older.data.draft.question_notes,input.question_notes);assert.deepEqual(older.data.draft.featured_capabilities,['custom:台語訪談']);
});

test('guild directory puts primary first, active secondary guilds next and all unjoined or left guilds last',async()=>{
 const member=await signIn();
 for(const key of ['guild_security','guild_talent_direction','guild_ai_vibe'])assert.equal((await request(`/guilds/${key}/join`,member,{})).status,200);
 assert.equal((await request('/guilds/guild_security/primary',member,{})).status,200);
 let rows=(await request('/guilds/directory',member)).data.items;
 assert.deepEqual(rows.slice(0,3).map((g:any)=>g.guild_key),['guild_security','guild_ai_vibe','guild_talent_direction']);
 assert.equal(rows[0].is_primary,true);assert.ok(rows.slice(1,3).every((g:any)=>g.membership?.state==='active'));
 assert.deepEqual(rows.slice(3).map((g:any)=>g.guild_key),rows.slice(3).map((g:any)=>g.guild_key).sort());
 assert.equal((await request('/guilds/guild_ai_vibe/leave',member,{},rows[1].membership.aggregate_version)).status,200);
 rows=(await request('/guilds/directory',member)).data.items;
 assert.deepEqual(rows.slice(0,2).map((g:any)=>g.guild_key),['guild_security','guild_talent_direction']);
 assert.deepEqual(rows.slice(2).map((g:any)=>g.guild_key),rows.slice(2).map((g:any)=>g.guild_key).sort());
});


test('a reviewed custom guild exposes its bound canonical skill books and joining grants them once',async()=>{
 const member=await signIn(),guildKey='guild_custom_test_music',community=(await pool.query('SELECT community_id FROM users WHERE user_id=$1',[member.user.user_id])).rows[0].community_id;
 await pool.query('INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key) VALUES($1,$2,$3,$4,$5,$6)',[guildKey,'custom_test_music','地方音樂共作公會','整理地方音樂製作經驗','閱讀音樂技能書並完成一份製作企劃','opensource']);
 await pool.query('INSERT INTO guild_skill_book_bindings(community_id,guild_key,book_id) VALUES($1,$2,$3),($1,$2,$4)',[community,guildKey,'music-mv','project-template']);
 const directory=(await request('/guilds/directory',member)).data.items.find((guild:any)=>guild.guild_key===guildKey);assert.deepEqual(directory.skill_books.map((book:any)=>book.id),['music-mv','project-template']);assert.equal(directory.guild_master,null);
 assert.equal((await request(`/guilds/${guildKey}/join`,member,{})).status,200);assert.equal((await request(`/guilds/${guildKey}/join`,member,{})).status,200);
 const books=(await request('/me/skill-books',member)).data.items;assert.deepEqual(books.map((book:any)=>book.id).sort(),['music-mv','project-template']);assert.ok(books.every((book:any)=>book.guild_keys.includes(guildKey)));
 assert.equal((await pool.query('SELECT count(*) FROM member_skill_book_grants WHERE user_id=$1',[member.user.user_id])).rows[0].count,'2');
});

test('guild book bindings merge defaults without duplicates, stay community scoped and skip unknown book IDs',async()=>{
 const member=await signIn(),community=(await pool.query('SELECT community_id FROM users WHERE user_id=$1',[member.user.user_id])).rows[0].community_id,other=randomUUID();
 await pool.query('INSERT INTO communities VALUES($1,$2)',[other,'另一個社群']);
 await pool.query('INSERT INTO guild_skill_book_bindings(community_id,guild_key,book_id) VALUES($1,$2,$3),($1,$2,$4),($1,$2,$5),($6,$2,$7)',[community,'guild_security','security-scanner','project-template','removed-book-definition',other,'music-mv']);
 const own=await listGuildSkillBooks(pool,community,'guild_security');assert.deepEqual(own.map(book=>book.id),['security-scanner','project-template']);
 const different=await listGuildSkillBooks(pool,other,'guild_security');assert.deepEqual(different.map(book=>book.id),['security-scanner','music-mv']);
 assert.equal((await request('/guilds/guild_security/join',member,{})).status,200);
 await pool.query('INSERT INTO member_skill_book_grants(grant_id,community_id,user_id,guild_key,book_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),community,member.user.user_id,'guild_security','removed-book-definition']);
 const visible=(await request('/me/skill-books',member)).data.items;assert.deepEqual(visible.map((book:any)=>book.id).sort(),['project-template','security-scanner']);
});

test('guild directory shows only active pending nominees in its community and never exposes their email',async()=>{
 const member=await signIn(),community=(await pool.query('SELECT community_id FROM users WHERE user_id=$1',[member.user.user_id])).rows[0].community_id;
 const other=randomUUID(),active=randomUUID(),inactive=randomUUID(),foreign=randomUUID();
 await pool.query('INSERT INTO communities VALUES($1,$2)',[other,'另一個任命社群']);
 await pool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name,active) VALUES
   ($1,$2,'pending-test@example.test','待連結負責人',true),($3,$2,'inactive-test@example.test','停用負責人',false),
   ($4,$5,'foreign-test@example.test','其他社群負責人',true)`,[active,community,inactive,foreign,other]);
 await pool.query(`INSERT INTO guild_leadership_nominations(community_id,guild_key,admin_id,state) VALUES
   ($1,'guild_security',$2,'pending'),($1,'guild_music_mv',$3,'pending'),
   ($1,'guild_commercial_production',$4,'pending'),($1,'guild_marketing',$2,'revoked')`,[community,active,inactive,foreign]);
 let rows=(await request('/guilds/directory',member)).data.items;
 assert.deepEqual(rows.find((g:any)=>g.guild_key==='guild_security').guild_master_nominee,{display_name:'待連結負責人',state:'pending'});
 for(const key of ['guild_music_mv','guild_commercial_production','guild_marketing'])assert.equal(rows.find((g:any)=>g.guild_key===key).guild_master_nominee,null);
 assert.equal(JSON.stringify(rows).includes('@example.test'),false);
 assert.equal((await request('/guilds/guild_security/join',member,{})).status,200);
 await pool.query("INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,'guild_security',$2)",[community,member.user.user_id]);
 rows=(await request('/guilds/directory',member)).data.items;
 const appointed=rows.find((g:any)=>g.guild_key==='guild_security');assert.equal(appointed.guild_master.display_name,member.user.display_name);assert.equal(appointed.guild_master.user_id,member.user.user_id);assert.deepEqual(Object.keys(appointed.guild_master).sort(),['display_name','user_id']);assert.equal(appointed.guild_master_nominee,null);
 await pool.query("UPDATE guild_leadership_nominations SET state='bound',bound_user_id=$2,activated_at=now() WHERE community_id=$1 AND guild_key='guild_security'",[community,member.user.user_id]);
 await pool.query("DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key='guild_security'",[community]);
 rows=(await request('/guilds/directory',member)).data.items;
 assert.equal(rows.find((g:any)=>g.guild_key==='guild_security').guild_master_nominee,null);
});
