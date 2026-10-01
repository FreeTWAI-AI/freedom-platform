import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {adminMembers,type AdminActor} from '../../modules/platform-admin/service.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {guildDirectory} from '../../modules/positioning/onboarding.js';
import {BUILTIN_GUILD_QUESTION_KEYS,GUILD_ANSWERS_INVALID,GUILD_ENTRY_QUESTIONS_VERSION,entryQuestionsForGuild,sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';

const database=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_guildq_${process.pid}_${Date.now()}`,adminPool=createPool(database),pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,max:8});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin),marker='vibe_intent_readme';
type Session={cookie:string;csrf:string;id:string};
before(async()=>{await adminPool.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:number,key=randomUUID()){
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version!==undefined)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,etag:response.headers.get('etag'),response};
}
async function register(name:string):Promise<Session>{
  const result=await request('/auth/register',undefined,{email:`${randomUUID()}@example.test`,nickname:name,password:'freedom-guild-questions-password'});
  assert.equal(result.status,201,JSON.stringify(result.data));
  return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token,id:result.data.user.user_id};
}
function quickBody(guildKey:string,answers:Record<string,string>=sampleGuildAnswers(guildKey)){
  return {guild_keys:[guildKey],primary_guild_key:guildKey,confirmed:true as const,guild_answers:answers};
}
async function joinedCount(userId:string){
  const memberships=(await pool.query('SELECT count(*) FROM positioning_profession_memberships WHERE user_id=$1',[userId])).rows[0].count;
  const answers=(await pool.query('SELECT count(*) FROM member_guild_answers WHERE user_id=$1',[userId])).rows[0].count;
  const completed=(await pool.query('SELECT onboarding_completed_at FROM users WHERE user_id=$1',[userId])).rows[0].onboarding_completed_at;
  return {memberships,answers,completed};
}
function lengthOf(value:string){return [...value].length;}
function verifierDirectoryFields(){
  const source=readFileSync(new URL('../../scripts/verify-public.mjs',import.meta.url),'utf8');
  const listed=source.match(/const GUILD_DIRECTORY_FIELDS=Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(listed,'GUILD_DIRECTORY_FIELDS freeze list');
  return [...listed[1].matchAll(/'([a-z0-9_]+)'/g)].map(item=>item[1]);
}

test('every catalog guild has a bounded question set and custom guilds share the fallback',async()=>{
  const catalog=(await pool.query(`SELECT guild_key FROM positioning_guild_catalog WHERE guild_key NOT LIKE 'guild_custom_%' ORDER BY guild_key`)).rows.map(row=>row.guild_key as string);
  assert.deepEqual(catalog,[...BUILTIN_GUILD_QUESTION_KEYS].sort());
  const hashes=new Set<string>();
  for(const key of catalog){
    const set=entryQuestionsForGuild(key);
    assert.equal(set.version,GUILD_ENTRY_QUESTIONS_VERSION);
    assert.match(set.sha256,/^[a-f0-9]{64}$/);
    assert.deepEqual(entryQuestionsForGuild(key).sha256,set.sha256);
    assert.ok(set.questions.length>=3&&set.questions.length<=4,key);
    const ids=new Set<string>(),options=new Set<string>();
    for(const question of set.questions){
      assert.equal(ids.has(question.id),false,question.id);ids.add(question.id);
      assert.ok(question.prompt.length>0&&lengthOf(question.prompt)<=30,question.prompt);
      assert.ok(question.options.length>=3&&question.options.length<=5,question.id);
      for(const option of question.options){
        assert.equal(options.has(option.id),false,option.id);options.add(option.id);
        assert.ok(option.label.length>0&&lengthOf(option.label)<=16,option.label);
      }
    }
    hashes.add(set.sha256);
  }
  assert.equal(hashes.size,catalog.length);
  const customA=`guild_custom_${'a'.repeat(32)}`,customB=`guild_custom_${'b'.repeat(32)}`,named='guild_custom_test_music';
  for(const key of [customA,customB,named])assert.equal(entryQuestionsForGuild(key).questions.length,3);
  assert.notEqual(entryQuestionsForGuild(customA).sha256,entryQuestionsForGuild(customB).sha256);
  const unknown=entryQuestionsForGuild('guild_not_in_catalog');
  assert.equal(unknown.questions.length,3);
  assert.equal(unknown.version,GUILD_ENTRY_QUESTIONS_VERSION);
  assert.match(unknown.sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(unknown.questions.map(question=>question.id),entryQuestionsForGuild(customA).questions.map(question=>question.id));
  assert.notEqual(unknown.sha256,entryQuestionsForGuild(customA).sha256);
});

test('an unexpected catalog guild still appears in the directory with the fallback questions',async()=>{
  const session=await register('意外公會');
  await pool.query(`INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key) VALUES($1,$2,$3,$4,$5,$6)`,['guild_surprise','surprise_probe','意外出現的公會','一個不在題庫裡的主題','先讀說明','opensource']);
  try{
    const actor=await authenticate(pool,session.cookie.split('=')[1]);
    const items=await guildDirectory(pool,actor);
    const surprise=items.find(item=>item.guild_key==='guild_surprise');
    assert.ok(surprise);
    assert.equal(surprise.entry_questions.questions.length,3);
    assert.deepEqual(surprise.entry_questions.questions.map((question:{id:string})=>question.id),['familiarity','intent','weekly_time']);
    assert.equal(surprise.entry_questions.sha256,entryQuestionsForGuild('guild_surprise').sha256);
    const expected=verifierDirectoryFields();
    assert.deepEqual(expected,[...expected].sort());
    assert.ok(expected.includes('entry_questions')&&expected.includes('tags'));
    for(const item of items)assert.deepEqual(Object.keys(item).sort(),expected,item.guild_key);
    const http=await request('/guilds/directory',session);
    assert.equal(http.status,200,JSON.stringify(http.data));
    assert.ok(http.data.items.some((item:any)=>item.guild_key==='guild_surprise'));
    for(const item of http.data.items)assert.deepEqual(Object.keys(item).sort(),expected,item.guild_key);
  }finally{
    await pool.query(`DELETE FROM positioning_guild_catalog WHERE guild_key='guild_surprise'`);
  }
});

test('quick start rejects missing, extra and invalid answers before anything is joined',async()=>{
  const session=await register('答案不完整');
  const valid=sampleGuildAnswers('guild_ai_vibe'),swapped:Record<string,string>={...valid,nope:valid.intent};
  delete swapped.familiarity;
  const cases=[
    {guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true},
    quickBody('guild_ai_vibe',{}),
    quickBody('guild_ai_vibe',{...valid,surplus:'weekly_under_1'}),
    quickBody('guild_ai_vibe',{...valid,familiarity:'not-a-real-option'}),
    quickBody('guild_ai_vibe',swapped),
    {...quickBody('guild_ai_vibe'),guild_answers:null},
    {...quickBody('guild_ai_vibe'),guild_answers:['weekly_under_1']},
  ];
  for(const body of cases){
    const result=await request('/me/onboarding/quick-start',session,body);
    assert.equal(result.status,422,JSON.stringify(result.data));
    assert.equal(result.data.code,'guild_answers_invalid');
    assert.equal(result.data.detail,GUILD_ANSWERS_INVALID);
  }
  const extra=await request('/me/onboarding/quick-start',session,{...quickBody('guild_ai_vibe'),unexpected:true});
  assert.equal(extra.status,422);assert.equal(extra.data.code,'validation_failed');
  const unknown=await request('/me/onboarding/quick-start',session,{guild_keys:['guild_fake'],primary_guild_key:'guild_fake',confirmed:true,guild_answers:valid});
  assert.equal(unknown.status,422);assert.equal(unknown.data.code,'unknown_guild');
  const state=await joinedCount(session.id);
  assert.equal(state.memberships,'0');assert.equal(state.answers,'0');assert.equal(state.completed,null);
});

test('quick start stores the primary guild answers and journals only the question version',async()=>{
  const session=await register('已回答');
  const answers={...sampleGuildAnswers('guild_ai_vibe'),intent:marker};
  const key=randomUUID();
  const result=await request('/me/onboarding/quick-start',session,quickBody('guild_ai_vibe',answers),undefined,key);
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.completed,true);assert.equal(result.data.entry_mode,'quick');
  assert.equal(JSON.stringify(result.data).includes(marker),false);
  assert.deepEqual((await request('/me/onboarding/quick-start',session,quickBody('guild_ai_vibe',answers),undefined,key)).data,result.data);
  const again=await request('/me/onboarding/quick-start',session,{...quickBody('guild_ai_vibe'),guild_answers:{}});
  assert.equal(again.status,409);assert.equal(again.data.code,'onboarding_already_completed');
  const stored=(await pool.query('SELECT question_set_version,question_set_sha256,answers FROM member_guild_answers WHERE user_id=$1',[session.id])).rows;
  assert.equal(stored.length,1);
  assert.equal(stored[0].question_set_version,GUILD_ENTRY_QUESTIONS_VERSION);
  assert.equal(stored[0].question_set_sha256,entryQuestionsForGuild('guild_ai_vibe').sha256);
  assert.deepEqual(stored[0].answers,answers);
  const journal=(await pool.query(`SELECT data FROM transition_journal WHERE actor_ref=$1 AND command='quick_start_onboarding'`,[session.id])).rows;
  assert.equal(journal.length,1);
  assert.deepEqual(journal[0].data,{entry_mode:'quick',primary_guild_key:'guild_ai_vibe',question_set_version:GUILD_ENTRY_QUESTIONS_VERSION});
  const outbox=(await pool.query(`SELECT o.payload FROM outbox o JOIN transition_journal j ON j.transition_id=o.transition_id WHERE j.actor_ref=$1 AND j.command='quick_start_onboarding'`,[session.id])).rows;
  assert.equal(outbox.length,1);assert.deepEqual(outbox[0].payload.data,journal[0].data);
  await pool.query(`INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key) VALUES($1,$2,$3,$4,$5,$6)`,['guild_custom_test_music','custom_question_music','地方音樂共作公會','整理地方音樂','閱讀一本手冊','opensource']);
  const directory=(await request('/guilds/directory',session)).data.items;
  const vibe=directory.find((guild:any)=>guild.guild_key==='guild_ai_vibe'),custom=directory.find((guild:any)=>guild.guild_key==='guild_custom_test_music');
  assert.equal(vibe.entry_questions.version,GUILD_ENTRY_QUESTIONS_VERSION);
  assert.equal(vibe.entry_questions.sha256,entryQuestionsForGuild('guild_ai_vibe').sha256);
  assert.equal(vibe.entry_questions.questions.length,4);
  assert.equal(custom.entry_questions.questions.length,3);
  assert.deepEqual(custom.entry_questions.questions.map((question:any)=>question.id),['familiarity','intent','weekly_time']);
});

test('guild answers belong to the member and require an active membership',async()=>{
  const owner=await register('題目主人'),other=await register('另一位會員');
  const answers={...sampleGuildAnswers('guild_ai_vibe'),intent:marker};
  assert.equal((await request('/me/onboarding/quick-start',owner,quickBody('guild_ai_vibe',answers))).status,200);
  assert.equal((await request('/me/onboarding/quick-start',other,quickBody('guild_ai_vibe'))).status,200);
  assert.equal((await request('/me/guild-answers')).status,401);
  const own=await request('/me/guild-answers',owner);
  assert.equal(own.status,200);
  assert.equal(own.data.items.length,1);
  assert.equal(own.data.items[0].guild_key,'guild_ai_vibe');
  assert.equal(own.data.items[0].answers.find((answer:any)=>answer.question_id==='intent').option_id,marker);
  assert.equal(own.data.items[0].answers.find((answer:any)=>answer.question_id==='intent').label,'寫可重現說明');
  assert.equal(own.data.items[0].outdated,false);
  assert.equal(JSON.stringify((await request('/me/guild-answers',other)).data).includes(marker),false);
  const joined=await request('/guilds/guild_music_mv/join',owner,{});
  assert.equal(joined.status,200,JSON.stringify(joined.data));
  const blocked=await request('/me/guild-answers/guild_music_mv',owner,{answers:sampleGuildAnswers('guild_music_mv')},1);
  assert.equal(blocked.status,412);assert.equal(blocked.data.code,'version_conflict');
  assert.equal((await pool.query(`SELECT count(*) FROM member_guild_answers WHERE user_id=$1 AND guild_key='guild_music_mv'`,[owner.id])).rows[0].count,'0');
  const absent=await request('/me/guild-answers/guild_event_space',owner,{answers:sampleGuildAnswers('guild_event_space')});
  assert.equal(absent.status,409);assert.equal(absent.data.code,'active_guild_required');
  const saved=await request('/me/guild-answers/guild_music_mv',owner,{answers:sampleGuildAnswers('guild_music_mv')});
  assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.aggregate_version,1);assert.equal(saved.etag,'"1"');
  assert.equal((await request(`/guilds/guild_music_mv/leave`,owner,{},joined.data.aggregate_version)).status,200);
  const left=await request('/me/guild-answers/guild_music_mv',owner,{answers:sampleGuildAnswers('guild_music_mv')},1);
  assert.equal(left.status,409);assert.equal(left.data.code,'active_guild_required');
  assert.equal((await pool.query(`SELECT count(*) FROM member_guild_answers WHERE user_id=$1 AND guild_key='guild_music_mv'`,[owner.id])).rows[0].count,'1');
  assert.ok(!(await request('/me/guild-answers',owner)).data.items.some((item:any)=>item.guild_key==='guild_music_mv'));
});

test('saving guild answers checks If-Match and replays the same command',async()=>{
  const session=await register('版本會員');
  assert.equal((await request('/me/onboarding/quick-start',session,quickBody('guild_ai_vibe'))).status,200);
  const joined=await request('/guilds/guild_music_mv/join',session,{});
  assert.equal(joined.status,200,JSON.stringify(joined.data));
  const answers=sampleGuildAnswers('guild_music_mv'),key=randomUUID();
  const created=await request('/me/guild-answers/guild_music_mv',session,{answers},undefined,key);
  assert.equal(created.status,200,JSON.stringify(created.data));assert.equal(created.data.aggregate_version,1);
  const replay=await request('/me/guild-answers/guild_music_mv',session,{answers},undefined,key);
  assert.deepEqual(replay.data,created.data);
  assert.equal((await pool.query(`SELECT aggregate_version FROM member_guild_answers WHERE user_id=$1 AND guild_key='guild_music_mv'`,[session.id])).rows[0].aggregate_version,'1');
  const missing=await request('/me/guild-answers/guild_music_mv',session,{answers});
  assert.equal(missing.status,428);assert.equal(missing.data.code,'version_required');
  const changed={...answers,intent:'music_intent_source'},updateKey=randomUUID();
  const updated=await request('/me/guild-answers/guild_music_mv',session,{answers:changed},1,updateKey);
  assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.aggregate_version,2);
  assert.equal(updated.data.answers.find((answer:any)=>answer.question_id==='intent').option_id,'music_intent_source');
  const stale=await request('/me/guild-answers/guild_music_mv',session,{answers},1);
  assert.equal(stale.status,412);assert.equal(stale.data.code,'version_conflict');
  assert.deepEqual((await request('/me/guild-answers/guild_music_mv',session,{answers:changed},1,updateKey)).data,updated.data);
  assert.equal((await pool.query(`SELECT aggregate_version FROM member_guild_answers WHERE user_id=$1 AND guild_key='guild_music_mv'`,[session.id])).rows[0].aggregate_version,'2');
});

test('a stored question hash that no longer matches is outdated',async()=>{
  const session=await register('舊題目');
  assert.equal((await request('/me/onboarding/quick-start',session,quickBody('guild_ai_vibe'))).status,200);
  const current=await request('/me/guild-answers',session);
  assert.equal(current.data.items[0].outdated,false);assert.equal(current.data.items[0].answers.length,4);
  await pool.query(`UPDATE member_guild_answers SET question_set_sha256=$2 WHERE user_id=$1`,[session.id,'f'.repeat(64)]);
  const stale=await request('/me/guild-answers',session);
  assert.equal(stale.data.items[0].outdated,true);
  assert.equal(stale.data.items[0].question_set_version,GUILD_ENTRY_QUESTIONS_VERSION);
  assert.equal(stale.data.items[0].answers[0].prompt.length>0,true);
});

test('guild answers stay out of cards, recommendations, admin lists, the journal and the outbox',async()=>{
  const owner=await register('不公開答案'),viewer=await register('只看公開');
  const answers={...sampleGuildAnswers('guild_ai_vibe'),intent:marker};
  assert.equal((await request('/me/onboarding/quick-start',owner,quickBody('guild_ai_vibe',answers))).status,200);
  assert.equal((await request('/me/onboarding/quick-start',viewer,quickBody('guild_music_mv'))).status,200);
  assert.equal((await request('/guilds/guild_ai_vibe/join',viewer,{})).status,200);
  const card=await request('/members/'+owner.id,viewer);
  const directory=await request('/members',viewer);
  const share=await request('/me/member-card-share',owner,{enabled:true,include_avatar:false});
  assert.equal(share.status,200,JSON.stringify(share.data));
  const token=share.data.share_path.split('/').at(-1);
  const shared=await request('/public/member-cards/'+token);
  const recommendations=await request('/members/recommendations?limit=3',viewer);
  const community=(await pool.query('SELECT community_id FROM users WHERE user_id=$1',[owner.id])).rows[0].community_id as string;
  const stub:AdminActor={admin_id:randomUUID(),community_id:community,email:'unused@example.test',display_name:'測試管理',role:'super_admin',subject:'guild-questions'};
  const admins=await adminMembers(pool,stub,50,0,'不公開答案',true);
  const journal=(await pool.query('SELECT data FROM transition_journal WHERE actor_ref=$1',[owner.id])).rows;
  const outbox=(await pool.query('SELECT o.payload FROM outbox o JOIN transition_journal j ON j.transition_id=o.transition_id WHERE j.actor_ref=$1',[owner.id])).rows;
  for(const payload of [card.data,directory.data,shared.data,recommendations.data,admins,journal,outbox])assert.equal(JSON.stringify(payload).includes(marker),false);
  assert.ok(admins.items.some((item:any)=>item.user_id===owner.id));
  assert.equal(community.length>0,true);
});
