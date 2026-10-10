import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {ASSESSMENT_VERSION,ASSESSMENT_SHA256} from '../../modules/positioning/assessment.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
import {refreshGuildDiscoveryReports,guildDiscoveryReport,validateAiGuildReport,ruleGuildReport,type GuildEvidence} from '../../modules/community/guild-discovery.js';
import {guildReviewerFromBindings} from '../../apps/platform-api/src/guild-review.js';
import {createWorkerHandler} from '../../apps/platform-api/src/worker.js';
import {memberCards,memberCard} from '../../modules/identity-membership/members.js';
import {friendDirectory} from '../../modules/identity-membership/member-connections.js';
import {memberPositioningSummary} from '../../modules/positioning/onboarding.js';
import type {Actor} from '../../modules/identity-membership/service.js';
const database=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_connections_${process.pid}_${Date.now()}`,admin=createPool(database),pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,max:12});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin);
type Session={cookie:string;csrf:string;id:string};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:number,key=randomUUID()){
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version!==undefined)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function member(name='共創夥伴',ready=true,email=`${randomUUID()}@example.test`):Promise<Session>{
  const result=await request('/auth/register',undefined,{email,nickname:name,password:'freedom-connections-password'});assert.equal(result.status,201,JSON.stringify(result.data));
  const session={cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token,id:result.data.user.user_id};
  if(ready)assert.equal((await request('/me/onboarding/quick-start',session,{guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true,guild_answers:sampleGuildAnswers('guild_ai_vibe')})).status,200);
  return session;
}
test('quick entry explicitly joins a real guild, preserves private draft and grants books atomically without fabricating an assessment',async()=>{
  const session=await member('快速加入',false);
  assert.equal((await request('/members',session)).status,403);
  const draft=await request('/me/onboarding/answers',session,{assessment_version:ASSESSMENT_VERSION,assessment_sha256:ASSESSMENT_SHA256,answers:{},occupation:'私人工作',founding_interest:false,capabilities:['python'],equipment:[]});assert.equal(draft.status,200);
  const body={guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true,guild_answers:sampleGuildAnswers('guild_ai_vibe')},key=randomUUID();
  assert.equal((await request('/me/onboarding/quick-start',session,{...body,guild_keys:['guild_fake'],primary_guild_key:'guild_fake'})).status,422);
  const result=await request('/me/onboarding/quick-start',session,body,undefined,key);assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.completed,true);assert.equal(result.data.entry_mode,'quick');assert.equal(result.data.assessment_completed,false);assert.equal(result.data.state,'draft');assert.equal(result.data.draft.occupation,'私人工作');assert.equal(result.data.result,null);
  assert.deepEqual((await request('/me/onboarding/quick-start',session,body,undefined,key)).data,result.data);
  assert.equal((await request('/me/onboarding/quick-start',session,body)).status,409);
  const card=await request('/members/'+session.id,session);assert.deepEqual(card.data.capabilities,[]);assert.equal(card.data.primary_guild.guild_key,'guild_ai_vibe');assert.ok(result.data.skill_books.length>0);
  assert.equal((await request('/members',session)).status,200);assert.equal((await request('/work-items',session)).status,200);
  const guilds=(await request('/guilds/directory',session)).data.items;assert.equal(guilds.length,18);assert.ok(guilds.every((guild:any)=>Array.isArray(guild.tags)));
  assert.equal((await request('/admin',session)).status,404);
});
test('quick entry races cannot create conflicting primary guilds or double grants',async()=>{
  const session=await member('同時加入',false);
  const results=await Promise.all(['guild_ai_vibe','guild_music_mv'].map(key=>request('/me/onboarding/quick-start',session,{guild_keys:[key],primary_guild_key:key,confirmed:true,guild_answers:sampleGuildAnswers(key)})));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  assert.equal((await pool.query('SELECT count(*) FROM guild_member_preferences WHERE user_id=$1',[session.id])).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM positioning_profession_memberships WHERE user_id=$1',[session.id])).rows[0].count,'1');
});
test('share cards are opt-in, bounded, revocable and never expose IDs, contacts, raw answers or equipment',async()=>{
  const owner=await member('我的公開名片');
  await pool.query(`INSERT INTO onboarding_assessments(assessment_id,community_id,user_id,assessment_version,assessment_sha256,state,published_profile,occupation,answers)
    VALUES($1,$2,$3,'fixture',$4,'completed',$5,'不公開職業','{"secret":"私密答案"}')`,[randomUUID(),DEMO_COMMUNITY,owner.id,'0'.repeat(64),JSON.stringify({capabilities:['python','react'],equipment:['private_tool'],featured_capabilities:['python']})]);
  await pool.query('UPDATE member_accounts SET contacts=$2 WHERE user_id=$1',[owner.id,JSON.stringify({email:{audiences:['public']},line:{value:'私人LINE',audiences:['public']}})]);
  const defaults=await request('/me/member-card-share',owner);assert.equal(defaults.data.enabled,false);assert.equal(defaults.data.include_avatar,false);
  assert.equal((await request('/me/member-card-share',undefined,{enabled:true,include_avatar:true})).status,401);
  const enabled=await request('/me/member-card-share',owner,{enabled:true,include_avatar:true});assert.equal(enabled.status,200,JSON.stringify(enabled.data));
  const token=enabled.data.share_path.split('/').at(-1),shared=await request('/public/member-cards/'+token);assert.equal(shared.status,200);assert.equal(shared.response.headers.get('cache-control'),'no-store');
  assert.deepEqual(Object.keys(shared.data).sort(),['avatar_url','capabilities','design','headline','links','nickname','primary_guild','profile_links']);assert.deepEqual(shared.data.capabilities,['Python']);
  assert.equal(shared.data.design,'editorial');assert.equal(shared.data.headline,null);assert.deepEqual(shared.data.links,[]);
  assert.deepEqual(shared.data.profile_links,[{platform:'line',label:'LINE',handle:'私人LINE',url:null}]);
  for(const forbidden of [owner.id,'@','不公開職業','私密答案','private_tool'])assert.equal(JSON.stringify(shared.data).includes(forbidden),false);
  assert.equal((await request('/me/member-card-share',owner,{enabled:false,include_avatar:false},1)).status,200);
  assert.equal((await request('/public/member-cards/'+token)).status,404);
  const restarted=await request('/me/member-card-share',owner,{enabled:true,include_avatar:false},2);assert.equal(restarted.status,200);assert.notEqual(restarted.data.share_path,enabled.data.share_path);
  assert.equal((await request('/public/member-cards/'+token)).status,404);
  const current=restarted.data.share_path.split('/').at(-1),rotated=await request('/me/member-card-share',owner,{enabled:true,include_avatar:false,rotate:true},3);assert.equal(rotated.status,200);assert.equal((await request('/public/member-cards/'+current)).status,404);
  assert.equal((await request('/me/member-card-share',owner,{enabled:true,include_avatar:false},3)).status,412);
});
test('public avatar and authenticated share resolution recheck current sharing, active state and viewer community',async()=>{
  const owner=await member('分享頭像'),viewer=await member('觀看者');
  await pool.query('INSERT INTO member_avatars(user_id,community_id,image_bytes) VALUES($1,$2,$3)',[owner.id,DEMO_COMMUNITY,Buffer.from('synthetic-image')]);
  const share=(await request('/me/member-card-share',owner,{enabled:true,include_avatar:true})).data,token=share.share_path.split('/').at(-1);
  const avatar=await app.request(origin+'/api/v1/public/member-cards/'+token+'/avatar');assert.equal(avatar.status,200);assert.equal(avatar.headers.get('content-type'),'image/webp');assert.equal(avatar.headers.get('cache-control'),'no-store');
  assert.equal((await request('/member-cards/'+token+'/member',viewer)).data.user_id,owner.id);
  assert.equal((await request('/member-cards/'+token+'/member')).status,401);
  await request('/me/member-card-share',owner,{enabled:true,include_avatar:false},1);
  assert.equal((await app.request(origin+'/api/v1/public/member-cards/'+token+'/avatar')).status,404);
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[owner.id]);assert.equal((await request('/public/member-cards/'+token)).status,404);
});
test('an existing share row keeps its avatar choice and the card page is noindex only for a token',async()=>{
  const saved=await member('已保存分享'),fresh=await member('尚未分享'),token=randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO member_card_shares(user_id,community_id,share_token,enabled,include_avatar) VALUES($1,$2,$3,true,true)',[saved.id,DEMO_COMMUNITY,token]);
  assert.equal((await request('/me/member-card-share',saved)).data.include_avatar,true);assert.equal((await request('/me/member-card-share',fresh)).data.include_avatar,false);
  assert.equal((await request('/public/member-cards/'+token)).data.avatar_url,null);
  const pageToken='a'.repeat(43);
  assert.equal((await app.request(origin+'/member-cards/'+pageToken)).headers.get('x-robots-tag'),'noindex, nofollow');
  assert.equal((await app.request(origin+'/member-cards/'+pageToken+'/')).headers.get('x-robots-tag'),'noindex, nofollow');
  for(const path of ['/','/guilds','/api/v1/health','/member-cards/short','/member-cards/'+pageToken+'/extra'])assert.equal((await app.request(origin+path)).headers.get('x-robots-tag'),null,path);
});
test('verification accounts and unfinished members cannot publish public cards',async()=>{
  const testAccount=await member('合成驗證帳',true,`${randomUUID()}@example.invalid`),unfinished=await member('尚未選公會',false);
  const blockedTest=await request('/me/member-card-share',testAccount,{enabled:true,include_avatar:true}),blockedJoin=await request('/me/member-card-share',unfinished,{enabled:true,include_avatar:true});
  assert.equal(blockedTest.status,403);assert.equal(blockedTest.data.code,'member_share_unavailable');assert.equal(blockedTest.data.detail,'完成加入流程的會員才能分享名片。');
  assert.equal(blockedJoin.status,403);assert.equal(blockedJoin.data.code,'onboarding_required');assert.equal(blockedJoin.data.detail,'請先選擇主要公會，完成加入後即可使用會員功能。');
});
test('friends directory handles both invitation directions and current accepted contact visibility',async()=>{
  const a=await member('好友甲'),b=await member('好友乙');
  await pool.query('UPDATE member_accounts SET contacts=$2 WHERE user_id=$1',[b.id,JSON.stringify({email:{audiences:['friends']}})]);
  await request('/friends/'+b.id+'/request',a,{});
  const outgoing=(await request('/friends/directory?scope=outgoing',a)).data,incoming=(await request('/friends/directory?scope=incoming',b)).data;
  assert.equal(outgoing.total,1);assert.equal(incoming.total,1);assert.deepEqual(outgoing.items[0].contacts,{});
  assert.equal((await request('/friends/directory?scope=accepted',a)).data.total,0);
  await request('/friends/'+a.id+'/accept',b,{},incoming.items[0].friendship.aggregate_version);
  const accepted=(await request('/friends/directory?scope=accepted&search=好友乙',a)).data;assert.equal(accepted.total,1);assert.ok(accepted.items[0].contacts.email);assert.equal(accepted.next_offset,null);
  const version=accepted.items[0].friendship.aggregate_version;await request('/friends/'+b.id+'/remove',a,{},version);
  assert.equal((await request('/friends/directory',a)).data.total,0);assert.deepEqual((await request('/members/'+b.id,a)).data.contacts,{});
});
test('recommendations exclude self, pending friends, accepted friends, inactive, unfinished and test members',async()=>{
  const viewer=await member('推薦觀看者'),candidate=await member('同公會夥伴'),unfinished=await member('未完成夥伴',false),hidden=await member('驗證夥伴',true,`${randomUUID()}@example.invalid`);
  let result=await request('/members/recommendations?limit=3',viewer);assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(result.data.items.some((item:any)=>item.member.user_id===candidate.id));assert.ok(result.data.items.find((item:any)=>item.member.user_id===candidate.id).reason.includes('AI 開發公會'));
  for(const id of [viewer.id,unfinished.id,hidden.id])assert.ok(!result.data.items.some((item:any)=>item.member.user_id===id));
  await request('/friends/'+candidate.id+'/request',viewer,{});result=await request('/members/recommendations?limit=3',viewer);assert.ok(!result.data.items.some((item:any)=>item.member.user_id===candidate.id));
  const friendship=(await request('/friends/directory?scope=incoming',candidate)).data.items.find((item:any)=>item.user_id===viewer.id).friendship;
  assert.equal((await request('/friends/'+viewer.id+'/accept',candidate,{},friendship.aggregate_version)).status,200);
  result=await request('/members/recommendations?limit=3',viewer);assert.ok(!result.data.items.some((item:any)=>item.member.user_id===candidate.id));
  const inactive=await member('停用夥伴');await pool.query('UPDATE users SET active=false WHERE user_id=$1',[inactive.id]);
  result=await request('/members/recommendations?limit=3',viewer);assert.ok(!result.data.items.some((item:any)=>item.member.user_id===inactive.id));
  assert.equal((await request('/members/recommendations?limit=4',viewer)).status,422);assert.equal((await request('/members/recommendations')).status,401);
});
test('batch cards preserve single-card DTOs and privacy while skipping unavailable members',async()=>{
  const viewer=await member('批次觀看者'),friend=await member('好友'),stranger=await member('非好友'),unfinished=await member('未完成',false),inactive=await member('停用'),hidden=await member('驗證',true,`${randomUUID()}@example.invalid`);
  const actor=(await pool.query('SELECT * FROM users WHERE user_id=$1',[viewer.id])).rows[0] as Actor;
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[inactive.id]);
  await pool.query(`INSERT INTO member_friendships(community_id,low_ref,high_ref,requester_ref,state) VALUES($1,least($2::uuid,$3::uuid),greatest($2::uuid,$3::uuid),$2,'accepted')`,[DEMO_COMMUNITY,viewer.id,friend.id]);
  const contacts={email:{audiences:['friends']},discord:{value:'公會Discord',audiences:['guild']},github:{value:'public-handle',audiences:['public']},line:{value:'私人LINE',audiences:[]}};
  await pool.query('UPDATE member_accounts SET contacts=$2 WHERE user_id=ANY($1::uuid[])',[[friend.id,stranger.id],JSON.stringify(contacts)]);
  for(const switched of [false,true]){
    if(switched)await pool.query("INSERT INTO guild_preference_switch(community_id,state,aggregate_version) VALUES($1,'switched',1)",[DEMO_COMMUNITY]);
    const ids=[stranger.id,unfinished.id,friend.id,inactive.id,viewer.id,hidden.id];
    const cards=await memberCards(pool,actor,ids);
    assert.deepEqual(cards.map(card=>card.user_id),[stranger.id,friend.id,viewer.id]);
    assert.deepEqual(cards,await Promise.all([stranger.id,friend.id,viewer.id].map(id=>memberCard(pool,actor,id))));
    assert.deepEqual(cards[0].contacts,{discord:'公會Discord',github:'public-handle'});
    assert.deepEqual(cards[1].contacts,{discord:'公會Discord',github:'public-handle',email:(await pool.query('SELECT email FROM users WHERE user_id=$1',[friend.id])).rows[0].email});
    for(const card of cards){
      const summary=await memberPositioningSummary(pool,DEMO_COMMUNITY,card.user_id);
      for(const key of Object.keys(summary))assert.deepEqual(card[key as keyof typeof card],summary[key as keyof typeof summary]);
    }
    for(const id of [unfinished.id,inactive.id,hidden.id])await assert.rejects(memberCard(pool,actor,id),{status:404});
  }
});
test('friend card query count stays constant from one to fifty cards',async()=>{
  const viewer=await member('查詢觀看者'),actor=(await pool.query('SELECT * FROM users WHERE user_id=$1',[viewer.id])).rows[0] as Actor;
  const ids=Array.from({length:50},()=>randomUUID());
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,profession_membership_ref,password_hash)
    SELECT id,$1,id::text||'@example.test','批次好友',gen_random_uuid(),'synthetic-unused-hash' FROM unnest($2::uuid[]) AS id`,[DEMO_COMMUNITY,ids]);
  await pool.query(`INSERT INTO member_friendships(community_id,low_ref,high_ref,requester_ref,state)
    SELECT $1,least($2::uuid,id),greatest($2::uuid,id),$2,'accepted' FROM unnest($3::uuid[]) AS id`,[DEMO_COMMUNITY,viewer.id,ids]);
  let queries=0;
  const counted=new Proxy(pool,{get(target,key){if(key==='query')return (text:string,values:unknown[])=>{queries++;return target.query(text,values);};return Reflect.get(target,key);}});
  const one=await friendDirectory(counted,actor,{limit:1}),oneCount=queries;queries=0;
  const fifty=await friendDirectory(counted,actor,{limit:50});
  assert.equal(one.items.length,1);assert.equal(fifty.items.length,50);assert.equal(queries,oneCount);assert.equal(queries,4);
});
test('guild reports run once daily with a lease and use only catalog evidence; provider failure keeps an honest rule report',async()=>{
  let called=0;const reviewer=async(catalog:GuildEvidence[])=>{called++;assert.equal(JSON.stringify(catalog).includes('user_id'),false);return {pairs:[{guild_keys:[catalog[0].guild_key,catalog[1].guild_key],reason:'共同 AI 領域',difference:'目的仍有不同',suggestion:'clarify'}]};};
  const before=(await pool.query('SELECT count(*) FROM positioning_guild_catalog')).rows[0].count;
  const results=await Promise.all([refreshGuildDiscoveryReports(pool,{communityId:DEMO_COMMUNITY,reviewer}),refreshGuildDiscoveryReports(pool,{communityId:DEMO_COMMUNITY,reviewer})]);assert.equal(called,1);assert.equal(results.reduce((n,r)=>n+r.updated,0),1);
  const report=await guildDiscoveryReport(pool,DEMO_COMMUNITY);assert.equal(report.report.method,'ai');assert.equal(report.report.ai_status,'completed');assert.ok(report.generated_at);assert.match(report.source_sha256,/^[a-f0-9]{64}$/);
  await refreshGuildDiscoveryReports(pool,{communityId:DEMO_COMMUNITY,reviewer});assert.equal(called,1);
  await pool.query("UPDATE guild_discovery_reports SET next_attempt_at=now()-interval '1 minute'");
  await refreshGuildDiscoveryReports(pool,{communityId:DEMO_COMMUNITY,reviewer:async()=>{throw new Error('provider unavailable');}});
  const fallback=(await guildDiscoveryReport(pool,DEMO_COMMUNITY)).report;assert.equal(fallback.method,'rules');assert.equal(fallback.ai_status,'unavailable');assert.equal((await pool.query('SELECT count(*) FROM positioning_guild_catalog')).rows[0].count,before);
  await pool.query("UPDATE guild_discovery_reports SET next_attempt_at=now()-interval '1 minute' WHERE community_id=$1",[DEMO_COMMUNITY]);
  await refreshGuildDiscoveryReports(pool,{communityId:DEMO_COMMUNITY,reviewer:async()=>undefined});
  assert.equal((await guildDiscoveryReport(pool,DEMO_COMMUNITY)).report.ai_status,'invalid_response');
});
test('AI reports reject invented guilds, duplicates, extra commands and unbounded text; inference requires explicit opt-in',async()=>{
  const catalog:GuildEvidence[]=[{guild_key:'a',name:'甲',purpose:'AI 開發',tags:['technology'],books:[]},{guild_key:'b',name:'乙',purpose:'AI 驗證',tags:['technology'],books:[]}],fallback=ruleGuildReport(catalog);
  const pair={guild_keys:['a','b'],reason:'AI',difference:'開發與驗證',suggestion:'collaborate'};
  for(const raw of [{pairs:[{...pair,guild_keys:['a','fake']}]},{pairs:[pair,pair]},{pairs:[pair],command:'delete'},{pairs:[{...pair,reason:'x'.repeat(601)}]}])assert.throws(()=>validateAiGuildReport(raw,catalog,fallback));
  assert.equal(guildReviewerFromBindings({AI:{run:async()=>({})},FREEDOM_GUILD_REVIEW_MODEL:'fixture'}),undefined);
  let called=false;const reviewer=guildReviewerFromBindings({AI:{run:async(model,input)=>{called=true;assert.equal(model,'fixture');assert.ok(input.response_format);return {response:JSON.stringify({pairs:[pair]})};}},FREEDOM_GUILD_REVIEW_ENABLED:'true',FREEDOM_GUILD_REVIEW_MODEL:'fixture'})!;
  assert.equal(validateAiGuildReport(await reviewer(catalog),catalog,fallback).method,'ai');assert.equal(called,true);
});
test('existing scheduled handler runs guild analysis even when GitHub sync fails, and releases its pool',async()=>{
  let analyzed=false,ended=false;const handler=createWorkerHandler({createPool:()=>({end:async()=>{ended=true;}} as unknown as Pool),syncGitHub:async()=>{throw new Error('fixture');},guildDiscovery:async(_pool,options)=>{assert.equal(options?.communityId,DEMO_COMMUNITY);analyzed=true;return {updated:1};},authPrune:async()=>({sessions:0,login_attempts:0,auth_rate_limits:0,password_reset_tokens:0})});
  const pending:Promise<unknown>[]=[];await handler.scheduled({}, {HYPERDRIVE:{connectionString:'unused'},ASSETS:{fetch:async()=>new Response()},FREEDOM_REGISTRATION_COMMUNITY_ID:DEMO_COMMUNITY}, {waitUntil:p=>{pending.push(p);}});
  await Promise.all(pending);assert.equal(analyzed,true);assert.equal(ended,true);
});
