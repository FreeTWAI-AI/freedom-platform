import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {GitHubSocial,type GitHubSocialConfig} from '../../modules/github-social/service.js';
import type {Actor} from '../../modules/identity-membership/service.js';
import {Problem} from '../../packages/shared/problem.js';
import {changeGuildMembership} from '../../modules/positioning/service.js';
import {configureBookStarGate,quickStartOnboarding,saveAssessmentAnswers,evaluateSavedAssessment,completeOnboarding,listGuildSkillBooks} from '../../modules/positioning/onboarding.js';
import {assessmentQuestions,ASSESSMENT_VERSION,ASSESSMENT_SHA256} from '../../modules/positioning/assessment.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
import {setMemberTier,setGuildExpertByMaster} from '../../modules/positioning/member-tier.js';
import {appointGuildMaster,type AdminActor,type AdminCommand} from '../../modules/platform-admin/service.js';
import {setGuildExpert} from '../../modules/platform-admin/guild-experts.js';

const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_book_star_gate_${process.pid}_${Date.now()}`,origin='http://127.0.0.1:4310';
const database=createPool(databaseUrl);
// Host policy is immutable per Pool. Both hosts use the same isolated database, not the same Pool.
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
const offPool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
// A one-connection pool deadlocks if the gate ever needs a second connection.
const onePool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1,connectionTimeoutMillis:5000});
const config:GitHubSocialConfig={clientId:'Iv1.star-gate-test',clientSecret:'synthetic-client-secret',tokenKey:randomBytes(32).toString('base64'),redirectUri:origin+'/github/callback'};
const guild='guild_marketing',secondGuild='guild_security';
type Call={url:string;method:string;headers:Headers};
class GitHubMock {
  calls:Call[]=[];userId=12345;starred=false;status=200;failure=false;
  unstarred=new Set<string>();firstExpiresIn=28800;tokenRequests=0;
  fetch:typeof fetch=async(input,init={})=>{
    const url=String(input),method=init.method??'GET',headers=new Headers(init.headers);
    this.calls.push({url,method,headers});
    assert.equal(init.redirect,'manual');assert.ok(init.signal);
    assert.equal(headers.get('x-github-api-version'),'2026-03-10');
    if(url==='https://github.com/login/oauth/access_token'){const n=++this.tokenRequests;return Response.json({access_token:`ghu_star_gate_synthetic_${n}`,refresh_token:`ghr_star_gate_synthetic_${n}`,token_type:'bearer',scope:'',expires_in:n===1?this.firstExpiresIn:28800,refresh_token_expires_in:15897600});}
    if(url==='https://api.github.com/user')return Response.json({id:this.userId,login:'verified-star-gate-member'});
    if(url.startsWith('https://api.github.com/user/starred/')){
      assert.equal(method,'GET','the prerequisite must never auto-star');
      if(this.failure)throw new Error('synthetic provider unavailable');
      if(this.status!==200)return Response.json({message:'synthetic failure'},{status:this.status});
      return new Response(null,{status:this.starred&&!this.unstarred.has(url.slice('https://api.github.com/user/starred/'.length))?204:404});
    }
    throw new Error(`Unexpected mock endpoint: ${method} ${url}`);
  };
}
let actor:Actor,master:Actor,admin:AdminActor,mock:GitHubMock,social:GitHubSocial;
const fetcher:typeof fetch=(input,init)=>mock.fetch(input,init);
const app=createApp(pool,origin,'local',{skillBookStarGateEnabled:true,githubSocial:{config,fetcher}});
const offApp=createApp(offPool,origin,'local',{githubSocial:{config,fetcher}});
createApp(onePool,origin,'local',{skillBookStarGateEnabled:true,githubSocial:{config,fetcher}});
const cmd=(who:Actor,operation:string,body:unknown={},expected?:string,key=randomUUID()):Command=>({actor:who,operation,key,body,...(expected===undefined?{}:{expected})});
const adm=(operation:string,userId=actor.user_id):AdminCommand=>({admin,operation,key:randomUUID(),body:{user_id:userId,reason:'Synthetic star gate appointment'}});
const code=(name:string)=>(error:unknown)=>{assert.ok(error instanceof Problem);assert.equal(error.code,name);return true;};
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await Promise.all([pool.end(),offPool.end(),onePool.end()]);await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
async function member(community:string):Promise<Actor>{
  const id=randomUUID(),session=randomBytes(32).toString('hex'),csrf=randomBytes(16).toString('hex');
  const user=(await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic star gate member','unused-test-password-hash',$4) RETURNING *`,[id,community,`${id}@example.invalid`,randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '1 hour',NULL)",[session,id,csrf]);
  return {...user,session_hash:session,csrf_token:csrf};
}
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,github_repository_metrics,skill_star_support CASCADE');
  const community=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Star gate runtime tests']);
  actor=await member(community);master=await member(community);
  admin={admin_id:randomUUID(),community_id:community,email:'star-gate-admin@example.invalid',display_name:'Synthetic administrator',role:'super_admin',subject:'verified-star-gate-test-admin'};
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[admin.admin_id,community,admin.email,admin.display_name]);
  mock=new GitHubMock();social=new GitHubSocial(pool,config,fetcher);
});
async function connect(who=actor,id=12345){
  mock.userId=id;
  const start=await social.start(who,'#guilds'),state=new URL(start.authorization_url).searchParams.get('state')!;
  const result=await social.complete(who,state,'synthetic-code');assert.equal(result.connected,true);
  mock.calls=[];
}
async function state(){
  const tables=['users','positioning_profession_memberships','member_skill_book_grants','guild_member_preferences','member_guild_answers','onboarding_assessments','positioning_guild_officers','positioning_guild_experts','transition_journal','outbox','member_notifications','command_receipts','platform_admin_receipts','platform_admin_audit','github_social_connections','skill_star_support'];
  const result:Record<string,unknown>={};
  for(const table of tables)result[table]=(await pool.query(`SELECT COALESCE(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) AS rows FROM (SELECT to_jsonb(t) AS row FROM ${table} t) s`)).rows[0].rows;
  return result;
}
// The Star check commits its budget, credential lifecycle and confirmed Star
// record separately; every business table must still be untouched.
const credentialTables=['github_social_connections','skill_star_support'];
async function business(){return Object.fromEntries(Object.entries(await state()).filter(([table])=>!credentialTables.includes(table)));}
async function rejectsUnchanged(run:()=>Promise<unknown>,name:string){
  const previous=await business();await assert.rejects(run,code(name));assert.deepEqual(await business(),previous);
}
async function linked(who=actor){return (await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[who.user_id])).rows[0]?.encrypted_tokens as string|undefined;}
async function membership(who=actor){return (await pool.query('SELECT member_tier,aggregate_version::text,state FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3',[who.community_id,who.user_id,guild])).rows[0];}
async function establishMaster(){await appointGuildMaster(offPool,adm('setup-master',master.user_id),guild);}
async function joinOff(){await changeGuildMembership(offPool,cmd(actor,'setup-intern'),guild,'join');}
function starCalls(){return mock.calls.filter(call=>call.url.startsWith('https://api.github.com/user/starred/'));}
async function assertGranted(){
  const books=await listGuildSkillBooks(pool,actor.community_id,guild);
  assert.ok(books.length>0);
  const grants=(await pool.query('SELECT book_id FROM member_skill_book_grants WHERE user_id=$1 AND guild_key=$2 ORDER BY book_id',[actor.user_id,guild])).rows.map(row=>row.book_id);
  assert.deepEqual(grants,books.map(book=>book.id).sort());
  assert.equal((await membership()).state,'active');
}

test('site metadata exposes opt-in policy and default-off grants need neither a connection nor GitHub requests',async()=>{
  for(const [host,enabled] of [[app,true],[offApp,false]] as const){
    const response=await host.request(origin+'/api/v1/site');assert.equal(response.status,200);
    assert.equal((await response.json() as {skill_book_star_gate_enabled:boolean}).skill_book_star_gate_enabled,enabled);
  }
  await changeGuildMembership(offPool,cmd(actor,'off-join'),guild,'join');await assertGranted();
  assert.equal(mock.calls.length,0);assert.equal((await membership()).member_tier,'intern');
});

test('enabled pool cannot be downgraded and repeated enabled initialization retains its original enforcing handler',async()=>{
  assert.throws(()=>createApp(pool,origin,'local',{skillBookStarGateEnabled:false}),/skill_book_star_gate_pool_policy_conflict/);
  assert.throws(()=>configureBookStarGate(offPool,async()=>{}),/skill_book_star_gate_pool_policy_conflict/);
  let replacementCalled=false;
  configureBookStarGate(pool,async()=>{replacementCalled=true;});
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'immutable-join'),guild,'join'),'github_connect_required');
  assert.equal(replacementCalled,false);assert.equal(mock.calls.length,0);
});

test('missing verified GitHub link rolls back join membership, grants, journal and receipt',async()=>{
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'missing-link'),guild,'join'),'github_connect_required');
  assert.equal(mock.calls.length,0);
});

test('a false live Star rejects every grant without auto-starring; retrying the same key after starring succeeds',async()=>{
  await connect();const input=cmd(actor,'live-star-join');
  await rejectsUnchanged(()=>changeGuildMembership(pool,input,guild,'join'),'skill_book_star_required');
  assert.ok(starCalls().length>0);assert.ok(mock.calls.every(call=>call.method==='GET'));
  mock.starred=true;mock.calls=[];
  await changeGuildMembership(pool,input,guild,'join');await assertGranted();
  const books=await listGuildSkillBooks(pool,actor.community_id,guild);
  const repositories=new Set(books.map(book=>new URL(book.upstream_url??book.repository_url).pathname.slice(1).toLowerCase()));
  assert.deepEqual(new Set(starCalls().map(call=>call.url.slice('https://api.github.com/user/starred/'.length).toLowerCase())),repositories);
  assert.ok(mock.calls.every(call=>call.method==='GET'));
  assert.equal((await pool.query('SELECT count(*) FROM skill_star_support')).rows[0].count,'0');
});

test('an already-active join cannot reuse a historical grant after the member unstars the upstream repo',async()=>{
  await connect();mock.starred=true;
  await changeGuildMembership(pool,cmd(actor,'initial-starred-join'),guild,'join');await assertGranted();
  mock.starred=false;mock.calls=[];
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'active-unstarred-join'),guild,'join'),'skill_book_star_required');
  assert.ok(starCalls().length>0);
});

for(const [status,name] of [[503,'github_unavailable'],[429,'github_rate_limited'],[403,'github_permission_required'],[401,'github_reconnect_required']] as const){
  test(`GitHub ${status} fails closed and rolls back acquisition`,async()=>{
    await connect();mock.starred=true;mock.status=status;
    await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,`provider-${status}`),guild,'join'),name);
    // An invalid token is removed even though the join rolled back.
    assert.equal(await linked()===undefined,status===401);
  });
}
test('a GitHub network failure fails closed without grants or persisted command effects',async()=>{
  await connect();mock.starred=true;mock.failure=true;
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'provider-network'),guild,'join'),'github_unavailable');
});

test('the current token identity must match the linked GitHub identity before checking Stars',async()=>{
  await connect();mock.userId=99999;mock.starred=true;
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'identity-mismatch'),guild,'join'),'github_reconnect_required');
  assert.equal(starCalls().length,0);assert.equal(await linked(),undefined);
});

test('rejected Star checks consume the attempt budget even though each join rolls back',async()=>{
  await connect();
  for(let attempt=0;attempt<30;attempt++)await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,`budget-${attempt}`),guild,'join'),'skill_book_star_required');
  mock.starred=true;mock.calls=[];
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'budget-over'),guild,'join'),'github_rate_limited');
  assert.equal(mock.calls.length,0);
});

test('a token refreshed during a rejected check stays rotated instead of reverting with the join',async()=>{
  mock.firstExpiresIn=30;await connect();const original=await linked();
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'rotate-reject'),guild,'join'),'skill_book_star_required');
  assert.equal(mock.tokenRequests,2);const rotated=await linked();assert.ok(rotated);assert.notEqual(rotated,original);
  mock.starred=true;
  await changeGuildMembership(pool,cmd(actor,'rotate-accept'),guild,'join');await assertGranted();
  assert.equal(mock.tokenRequests,2,'the superseded refresh token must not be reused');
  assert.equal(await linked(),rotated);
});

test('a live Star result is recorded for an existing confirmed-support row even when the join is rejected',async()=>{
  await connect();
  const books=await listGuildSkillBooks(pool,actor.community_id,guild);
  const repository=new URL(books[0].upstream_url??books[0].repository_url).pathname.slice(1).toLowerCase();
  await pool.query('INSERT INTO skill_star_support(github_user_id,repository_key,active) VALUES($1,$2,true)',[String(mock.userId),repository]);
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'support-reject'),guild,'join'),'skill_book_star_required');
  assert.equal((await pool.query('SELECT active FROM skill_star_support WHERE repository_key=$1',[repository])).rows[0].active,false);
});

test('the gate never needs a second pool connection, for rejected or accepted multi-guild checks',async()=>{
  mock.firstExpiresIn=30;await connect();
  const input=cmd(actor,'one-connection',{guild_keys:[guild,secondGuild],primary_guild_key:guild,confirmed:true,guild_answers:sampleGuildAnswers(guild)});
  await rejectsUnchanged(()=>quickStartOnboarding(onePool,input),'skill_book_star_required');
  assert.equal(mock.tokenRequests,2);
  mock.starred=true;assert.equal((await quickStartOnboarding(onePool,input)).completed,true);await assertGranted();
});

test('quick start rolls back earlier guild joins when a later guild repo is unstarred, then completes atomically',async()=>{
  await connect();mock.starred=true;
  const books=await listGuildSkillBooks(pool,actor.community_id,secondGuild);assert.ok(books.length);
  mock.unstarred.add(new URL(books[0].upstream_url??books[0].repository_url).pathname.slice(1));
  const input=cmd(actor,'quick-gated',{guild_keys:[guild,secondGuild],primary_guild_key:guild,confirmed:true,guild_answers:sampleGuildAnswers(guild)});
  await rejectsUnchanged(()=>quickStartOnboarding(pool,input),'skill_book_star_required');
  assert.ok(starCalls().some(call=>call.url.includes('claude-skill-social-post')));
  mock.unstarred.clear();const completed=await quickStartOnboarding(pool,input);
  assert.equal(completed.completed,true);assert.equal(completed.entry_mode,'quick');await assertGranted();
  assert.equal((await pool.query('SELECT count(*) FROM positioning_profession_memberships WHERE user_id=$1',[actor.user_id])).rows[0].count,'2');
});

test('assessment completion preserves the evaluated assessment on gate rejection and completes after live Stars pass',async()=>{
  const saved=await saveAssessmentAnswers(pool,cmd(actor,'assessment-save',{assessment_version:ASSESSMENT_VERSION,assessment_sha256:ASSESSMENT_SHA256,answers:Object.fromEntries(assessmentQuestions.map(question=>[question.id,question.options[0].id])),occupation:'',founding_interest:false,capabilities:[],equipment:[]}));
  const evaluated=await evaluateSavedAssessment(pool,cmd(actor,'assessment-evaluate',{},String(saved.draft!.aggregate_version)));
  const input=cmd(actor,'assessment-complete',{guild_keys:[guild],primary_guild_key:guild,confirmed:true},String(evaluated.draft!.aggregate_version));
  await rejectsUnchanged(()=>completeOnboarding(pool,input),'github_connect_required');
  await connect();mock.starred=true;
  const completed=await completeOnboarding(pool,input);assert.equal(completed.completed,true);assert.equal(completed.state,'completed');await assertGranted();
});

test('full-tier promotion checks the target member, not the master, and rechecks Stars even for an existing grant',async()=>{
  await establishMaster();await joinOff();await connect(master,54321);mock.starred=true;
  const input=cmd(master,'promote-target',{member_tier:'full'},'1');
  await rejectsUnchanged(()=>setMemberTier(pool,input,guild,actor.user_id),'github_connect_required');
  await connect(actor);mock.starred=false;
  await rejectsUnchanged(()=>setMemberTier(pool,input,guild,actor.user_id),'skill_book_star_required');
  mock.starred=true;const promoted=await setMemberTier(pool,input,guild,actor.user_id);
  assert.equal(promoted.changed,true);assert.equal((await membership()).member_tier,'full');assert.equal(promoted.aggregate_version,2);
  mock.calls=[];assert.deepEqual(await setMemberTier(pool,input,guild,actor.user_id),promoted);assert.equal(mock.calls.length,0);
  mock.starred=false;
  const demoted=await setMemberTier(pool,cmd(master,'demote-target',{member_tier:'intern'},'2'),guild,actor.user_id);
  assert.equal(demoted.changed,true);assert.equal(mock.calls.length,0);
});

test('default-off promotion paths do not require GitHub or change existing grants',async()=>{
  await establishMaster();await joinOff();
  await setMemberTier(offPool,cmd(master,'off-promote',{member_tier:'full'},'1'),guild,actor.user_id);
  assert.equal((await membership()).member_tier,'full');await assertGranted();assert.equal(mock.calls.length,0);
});

for(const path of ['admin-master','admin-expert','master-expert'] as const){
  test(`${path} appointment cannot bypass the target member Star gate and rolls back role, membership, notifications and audit`,async()=>{
    if(path==='master-expert')await establishMaster();
    const input=path==='master-expert'?cmd(master,'master-expert',{user_id:actor.user_id,active:true}):adm(path);
    const run=()=>path==='admin-master'?appointGuildMaster(pool,input as AdminCommand,guild):path==='admin-expert'?setGuildExpert(pool,{...input as AdminCommand,body:{user_id:actor.user_id,active:true,reason:'Synthetic star gate expert'}},guild):setGuildExpertByMaster(pool,input as Command,guild);
    await rejectsUnchanged(run,'github_connect_required');
    await connect();mock.starred=false;await rejectsUnchanged(run,'skill_book_star_required');
    mock.starred=true;await run();assert.equal((await membership()).member_tier,'full');await assertGranted();
    const table=path==='admin-master'?'positioning_guild_officers':'positioning_guild_experts';
    assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE community_id=$1 AND guild_key=$2 AND user_id=$3`,[actor.community_id,guild,actor.user_id])).rowCount,1);
    assert.ok(starCalls().length>0);assert.ok(mock.calls.every(call=>call.method==='GET'));
  });
}
