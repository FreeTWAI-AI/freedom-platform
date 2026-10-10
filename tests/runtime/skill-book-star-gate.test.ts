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
const config:GitHubSocialConfig={clientId:'Iv1.star-gate-test',clientSecret:'synthetic-client-secret',tokenKey:randomBytes(32).toString('base64'),redirectUri:origin+'/github/callback'};
const guild='guild_marketing',secondGuild='guild_security';
type Call={url:string;method:string;headers:Headers};
class GitHubMock {
  calls:Call[]=[];userId=12345;starred=false;status=200;failure=false;expiresIn=28800;refreshes=0;
  unstarred=new Set<string>();
  fetch:typeof fetch=async(input,init={})=>{
    const url=String(input),method=init.method??'GET',headers=new Headers(init.headers);
    this.calls.push({url,method,headers});
    assert.equal(init.redirect,'manual');assert.ok(init.signal);
    assert.equal(headers.get('x-github-api-version'),'2026-03-10');
    if(url==='https://github.com/login/oauth/access_token'){const refresh=new URLSearchParams(String(init.body)).get('grant_type')==='refresh_token';if(refresh)this.refreshes++;return Response.json({access_token:'ghu_star_gate_synthetic'+this.refreshes,refresh_token:'ghr_star_gate_synthetic'+this.refreshes,token_type:'bearer',scope:'',expires_in:refresh?28800:this.expiresIn,refresh_token_expires_in:15897600});}
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
const cmd=(who:Actor,operation:string,body:unknown={},expected?:string,key=randomUUID()):Command=>({actor:who,operation,key,body,...(expected===undefined?{}:{expected})});
const adm=(operation:string,userId=actor.user_id):AdminCommand=>({admin,operation,key:randomUUID(),body:{user_id:userId,reason:'Synthetic star gate appointment'}});
const code=(name:string)=>(error:unknown)=>{assert.ok(error instanceof Problem);assert.equal(error.code,name);return true;};
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await Promise.all([pool.end(),offPool.end()]);await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
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
async function rejectsUnchanged(run:()=>Promise<unknown>,name:string){
  const previous=await state();await assert.rejects(run,code(name));const after=await state();
  if(name==='github_reconnect_required'){
    assert.equal((await pool.query('SELECT count(*)::int n FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0].n,0);
    delete previous.github_social_connections;delete after.github_social_connections;
  }
  assert.deepEqual(after,previous);
}
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
  assert.throws(()=>configureBookStarGate(offPool,async()=>async()=>{}),/skill_book_star_gate_pool_policy_conflict/);
  let replacementCalled=false;
  configureBookStarGate(pool,async()=>{replacementCalled=true;return async()=>{};});
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
  });
}
test('a GitHub network failure fails closed without grants or persisted command effects',async()=>{
  await connect();mock.starred=true;mock.failure=true;
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'provider-network'),guild,'join'),'github_unavailable');
});

test('the current token identity must match the linked GitHub identity before checking Stars',async()=>{
  await connect();mock.userId=99999;mock.starred=true;
  await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'identity-mismatch'),guild,'join'),'github_reconnect_required');
  assert.equal(starCalls().length,0);
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


test('rejected live Star checks retain their consumed attempt budget',async()=>{
  await connect();
  for(let i=0;i<2;i++)await assert.rejects(changeGuildMembership(pool,cmd(actor,'budget-rejected-'+i),guild,'join'),code('skill_book_star_required'));
  const row=(await pool.query("SELECT attempts FROM github_social_rate_limits WHERE user_id=$1 AND operation='skill-book-star-check'",[actor.user_id])).rows[0];
  assert.equal(row?.attempts,2);
  await pool.query("UPDATE github_social_rate_limits SET attempts=30 WHERE user_id=$1 AND operation='skill-book-star-check'",[actor.user_id]);mock.calls=[];
  await assert.rejects(changeGuildMembership(pool,cmd(actor,'budget-exhausted'),guild,'join'),code('github_rate_limited'));
  assert.equal(mock.calls.length,0);
  assert.equal((await pool.query("SELECT attempts FROM github_social_rate_limits WHERE user_id=$1 AND operation='skill-book-star-check'",[actor.user_id])).rows[0].attempts,31);
});

test('a refreshed credential survives an unstarred business rollback',async()=>{
  mock.expiresIn=30;await connect();
  const before=(await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0].encrypted_tokens;
  await assert.rejects(changeGuildMembership(pool,cmd(actor,'refresh-denied'),guild,'join'),code('skill_book_star_required'));
  assert.equal(mock.refreshes,1);
  const rotated=(await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0].encrypted_tokens;assert.notEqual(rotated,before);
  assert.equal((await pool.query('SELECT count(*) FROM member_skill_book_grants WHERE user_id=$1',[actor.user_id])).rows[0].count,'0');
  mock.starred=true;await changeGuildMembership(pool,cmd(actor,'refresh-accepted'),guild,'join');await assertGranted();
  assert.equal(mock.refreshes,1,'the already-rotated refresh token must not be reused');
  assert.equal((await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0].encrypted_tokens,rotated);
});

test('invalid credentials remain disconnected after a rejected grant',async()=>{
  await connect();mock.status=401;
  await assert.rejects(changeGuildMembership(pool,cmd(actor,'invalid-credential'),guild,'join'),code('github_reconnect_required'));
  assert.equal((await pool.query('SELECT count(*) FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0].count,'0');
});

test('a one-connection host loads stored configuration without waiting for its own transaction',async()=>{
  const one=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1,connectionTimeoutMillis:300});
  try{
    createApp(one,origin,'local',{skillBookStarGateEnabled:true,githubSocial:{tokenKey:config.tokenKey,fetcher}});
    await assert.rejects(changeGuildMembership(one,cmd(actor,'single-config'),guild,'join'),code('github_not_configured'));
  }finally{await one.end();}
});

async function afterPrepared(change:()=>Promise<void>,run:()=>Promise<void>){
  const original=GitHubSocial.prototype.prepareBookStars;
  GitHubSocial.prototype.prepareBookStars=async function(...args){const check=await original.apply(this,args);await change();return check;};
  try{await run();}finally{GitHubSocial.prototype.prepareBookStars=original;}
}
test('final grant rechecks the session after provider preparation and leaves no business effects',async()=>{
  await connect();mock.starred=true;
  await afterPrepared(async()=>{await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[actor.session_hash]);},async()=>{
    await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'revoked-after-provider'),guild,'join'),'session_expired');
  });
});
test('final grant rejects a connection disconnected after the provider check',async()=>{
  await connect();mock.starred=true;
  await afterPrepared(()=>social.disconnect(actor).then(()=>{}),async()=>{
    await assert.rejects(changeGuildMembership(pool,cmd(actor,'disconnect-after-provider'),guild,'join'),code('skill_book_star_check_changed'));
  });
  assert.equal(await membership(),undefined);
  assert.equal((await pool.query('SELECT count(*) FROM member_skill_book_grants WHERE user_id=$1',[actor.user_id])).rows[0].count,'0');
});
test('final grant rejects a later platform Star write even with the same credential',async()=>{
  await connect();mock.starred=true;
  await afterPrepared(async()=>{await pool.query("INSERT INTO github_social_rate_limits(user_id,operation,window_start,attempts) VALUES($1,'star-write',now(),1)",[actor.user_id]);},async()=>{
    await rejectsUnchanged(()=>changeGuildMembership(pool,cmd(actor,'changed-star-write'),guild,'join'),'skill_book_star_check_changed');
  });
});
test('a one-connection configured host rejects then grants multiple guilds and replays without provider I/O',async()=>{
  const one=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1,connectionTimeoutMillis:300});
  try{
    createApp(one,origin,'local',{skillBookStarGateEnabled:true,githubSocial:{config,fetcher}});
    mock.expiresIn=30;await connect();const input=cmd(actor,'single-success',{guild_keys:[guild,secondGuild],primary_guild_key:guild,confirmed:true,guild_answers:sampleGuildAnswers(guild)});
    await assert.rejects(quickStartOnboarding(one,input),code('skill_book_star_required'));assert.equal(mock.refreshes,1);assert.equal(await membership(),undefined);
    mock.starred=true;const first=await quickStartOnboarding(one,input);await assertGranted();assert.equal(first.completed,true);assert.equal(mock.refreshes,1);
    mock.failure=true;mock.calls=[];
    assert.deepEqual(await quickStartOnboarding(one,input),JSON.parse(JSON.stringify(first)));
    assert.equal(mock.calls.length,0);
  }finally{await one.end();}
});

// Preserve the confirmed-support regression from upstream review 9f7e3119.
test('a rejected live check reconciles an existing confirmed Star without changing business state',async()=>{
  await connect();const books=await listGuildSkillBooks(pool,actor.community_id,guild);
  const repository=new URL(books[0].upstream_url??books[0].repository_url).pathname.slice(1).toLowerCase();
  await pool.query('INSERT INTO skill_star_support(github_user_id,repository_key,active) VALUES($1,$2,true)',[String(mock.userId),repository]);
  const before=await state();delete before.skill_star_support;
  await assert.rejects(changeGuildMembership(pool,cmd(actor,'support-reject'),guild,'join'),code('skill_book_star_required'));
  assert.equal((await pool.query('SELECT active FROM skill_star_support WHERE repository_key=$1',[repository])).rows[0].active,false);
  const after=await state();delete after.skill_star_support;assert.deepEqual(after,before);
});
