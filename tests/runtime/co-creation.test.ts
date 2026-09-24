import {test,before,after,beforeEach,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {CollaborationGitHub,type Repo} from '../../modules/co-creation/github.js';
import {emptyContacts} from '../../modules/identity-membership/members.js';
import {categoriesForLabels} from '../../packages/shared/task-categories.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_co_creation_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
let app=createApp(pool,origin);
interface Session{cookie:string;csrf:string;user:any}
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);app=createApp(pool,origin);});
async function request(path:string,session?:Session,body?:unknown,version?:number,key:string=randomUUID(),extra:Record<string,string>={}){
 const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra};
 if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
 const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any,response};
}
async function login(email=DEMO_USERS[0].email):Promise<Session>{const r=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));return {cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user};}
const sourceInput={repository_url:'https://github.com/example/shared-project',title:'共同維護的公開工具',description:'共享可重現的工具與說明。',use_notes:'先閱讀 AGENTS，再討論 Issue。',relationship:'curator',consent_to_share:true};
const coInput={title:'協作改善入口',goal:'一起讓範例與文件容易重現',help_wanted:['testing','documentation'],contribution_notes:'先在 Issue 討論範圍；PR 由 GitHub 維護者審查。'};
const readerRepo:Repo={repository_id:'72001',repository_url:sourceInput.repository_url,repository_full_name:'example/shared-project',title:coInput.title,goal:coInput.goal,contribution_notes:coInput.contribution_notes};
const sha='a'.repeat(40),mergedAt='2026-09-24T01:02:03Z';
const openIssue=(number=7)=>({number,title:'補一份重現步驟 <script>untrusted()</script>',body:'## 完成條件\n加入一個可重現範例。',state:'open',labels:[{name:'documentation'},'help wanted'],assignees:[{login:'volunteer'}],html_url:'https://evil.example/forged-issue-link'});
const mergedPull=(number=9)=>({number,title:'補上範例',user:{login:'upstream-contributor',id:9988},merged_at:mergedAt,merge_commit_sha:sha,html_url:'https://evil.example/forged-pull-link'});
function upstream(t?:TestContext){
 const state={id:72001,fullName:'example/shared-project',private:false,archived:false,issues:[openIssue()] as any[],pulls:[mergedPull()] as any[],status:200,oversize:'',delay:undefined as undefined|Promise<void>};
 const seen:{url:string;method:string}[]=[];
 const fetcher:typeof fetch=async(input,init={})=>{
  const url=String(input);seen.push({url,method:init.method??'GET'});assert.equal(new URL(url).origin,'https://api.github.com');assert.equal(init.redirect,'error');
  const headers=new Headers(init.headers);assert.equal(headers.get('Authorization'),null);assert.equal(headers.get('Cookie'),null);assert.equal(init.body,undefined);
  if(state.delay)await state.delay;
  if(state.status!==200)return new Response('',{status:state.status,headers:state.status===302?{Location:'https://evil.example/redirect'}:{}});
  if(state.oversize&&url.includes(state.oversize))return new Response('x'.repeat(1048577));
  if(url==='https://api.github.com/repos/example/shared-project')return Response.json({id:state.id,full_name:state.fullName,private:state.private,visibility:state.private?'private':'public',archived:state.archived,default_branch:'main',fork:false});
  if(url==='https://api.github.com/repos/example/shared-project/commits/main')return Response.json({sha});
  if(url===`https://api.github.com/repos/example/shared-project/license?ref=${sha}`)return Response.json({path:'LICENSE',license:{spdx_id:'MIT'}});
  if(url==='https://api.github.com/repos/example/shared-project/issues?state=open&sort=created&direction=asc&per_page=30')return Response.json(state.issues);
  if(url==='https://api.github.com/repos/example/shared-project/pulls?state=closed&sort=updated&direction=desc&per_page=30')return Response.json(state.pulls);
  throw Error('Unexpected fixture endpoint: '+url);
 };
 if(t)t.mock.method(globalThis,'fetch',fetcher);
 return {state,seen,fetcher};
}
async function imported(owner:Session){const r=await request('/opensource/projects',owner,sourceInput);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function created(owner:Session,source:any){const r=await request('/co-creation/projects',owner,{...coInput,source_project_id:source.project_id});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
const errorCode=(expected:string)=>(error:any)=>{assert.equal(error.code,expected);return true;};

test('import owner opens coordination metadata idempotently without GitHub writes or conferring repository ownership',async t=>{
 const {seen}=upstream(t),owner=await login(),source=await imported(owner),key=randomUUID(),body={...coInput,source_project_id:source.project_id,guild_keys:['guild_ai_field','guild_ai_vibe']};
 assert.equal(source.relationship_verification,'self_declared');
 const first=await request('/co-creation/projects',owner,body,undefined,key);assert.equal(first.status,201,JSON.stringify(first.data));assert.equal(first.data.coordinator_ref,owner.user.user_id);
 assert.deepEqual(first.data.guild_keys,body.guild_keys);
 const count=seen.length;assert.deepEqual((await request('/co-creation/projects',owner,body,undefined,key)).data,first.data);assert.equal(seen.length,count);
 assert.equal((await request('/co-creation/projects',owner,{...body,title:'不同內容'},undefined,key)).status,409);
 assert.equal((await request('/co-creation/projects',owner,body)).data.code,'co_creation_exists');
 assert.equal((await pool.query('SELECT count(*) FROM co_creation_projects')).rows[0].count,'1');
 const fact=(await pool.query("SELECT data FROM transition_journal WHERE aggregate_type='co_creation_project'")).rows[0].data;
 assert.equal(fact.authority,'coordination_only');assert.equal(fact.tasks_system_of_record,'github');assert.ok(seen.every(r=>r.method==='GET'));
 assert.equal((await request('/co-creation/projects',owner)).data.items.filter((item:any)=>item.source_kind==='member_project').length,1);
 const catalog=(await request('/co-creation/projects',owner)).data;
 assert.ok(catalog.guilds.some((guild:any)=>guild.guild_key==='guild_platform_engineering'));
 assert.deepEqual(catalog.items.find((item:any)=>item.project_id===first.data.project_id).guild_keys,body.guild_keys);
 assert.equal((await pool.query('SELECT count(*) FROM co_creation_project_guilds')).rows[0].count,'2');
});

test('guild classification rejects unknown, duplicate and oversized groups without creating a project',async t=>{
 upstream(t);const owner=await login(),source=await imported(owner);
 for(const guild_keys of [['guild_unknown'],['guild_ai_vibe','guild_ai_vibe'],Array.from({length:6},(_,i)=>`guild_group_${i}`)]){
  assert.equal((await request('/co-creation/projects',owner,{...coInput,source_project_id:source.project_id,guild_keys})).status,422);
 }
 assert.equal((await pool.query('SELECT count(*) FROM co_creation_projects')).rows[0].count,'0');
 assert.deepEqual((await created(owner,source)).guild_keys,[]);
});

test('project prompt is available during a GitHub outage, preserves original credit and never writes externally',async t=>{
 const {seen,state}=upstream(t),owner=await login(),source=await imported(owner),project=await created(owner,source);
 state.status=503;const before=seen.length;
 const brief=await request(`/co-creation/projects/${project.project_id}/brief`,owner);
 assert.equal(brief.status,200);assert.equal(seen.length,before);
 assert.match(brief.data.text,/https:\/\/github.com\/example\/shared-project/);
 assert.match(brief.data.text,/最多三項/);assert.match(brief.data.text,/完整 commit SHA/);
 const pilot=await request('/co-creation/projects/workshop-video-autopilot/brief',owner);
 assert.equal(pilot.status,200);assert.match(pilot.data.text,/原作 Repo：https:\/\/github.com\/Hao0321\/video-autopilot-kit/);
 assert.match(pilot.data.text,/本頁任務來源：https:\/\/github.com\/FreeTWAI-AI\/video-autopilot-kit\/issues/);
 assert.match(pilot.data.text,/未回送原因/);assert.match(pilot.data.text,/不移轉作者權利/);
 assert.equal(seen.length,before);assert.ok(!pilot.data.text.includes(owner.csrf));
});

test('task categories use explicit labels, preserve multiple kinds and leave ambiguous work unclassified',()=>{
 assert.deepEqual(categoriesForLabels([' Type: Bug ','documentation','bug']),['bug','documentation']);
 assert.deepEqual(categoriesForLabels(['enhancement','kind/testing','security']),['feature','testing','security']);
 assert.deepEqual(categoriesForLabels(['good first issue','debugger','constructor','__proto__']),['unclassified']);
 assert.deepEqual(categoriesForLabels([]),['unclassified']);
});

test('session, onboarding and owner scopes protect project creation, activity and brief across communities',async t=>{
 const {seen}=upstream(t),owner=await login(),other=await login(DEMO_USERS[1].email),source=await imported(owner),project=await created(owner,source);
 for(const path of ['/co-creation/projects',`/co-creation/projects/${project.project_id}/activity`,`/co-creation/projects/${project.project_id}/issues/7/brief`,`/co-creation/projects/${project.project_id}/brief`])assert.equal((await request(path)).status,401);
 assert.equal((await request('/co-creation/projects',other,{...coInput,source_project_id:source.project_id})).status,404);
 assert.equal((await request('/co-creation/projects',owner,{...coInput,source_project_id:source.project_id},undefined,randomUUID(),{'X-CSRF-Token':'forged'})).status,403);
 for(const forged of [{coordinator_ref:other.user.user_id},{official:true},{github_owner:true},{xp:100},{help_wanted:['testing','testing']}])assert.equal((await request('/co-creation/projects',owner,{...coInput,source_project_id:source.project_id,...forged})).status,422);
 const community=randomUUID(),id=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Another community']);
 await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'co-outsider@local.test','Outside',password_hash,$3 FROM users WHERE user_id=$4`,[id,community,randomUUID(),owner.user.user_id]);
 const outsider=await login('co-outsider@local.test'),before=seen.length;
 for(const path of [`/co-creation/projects/${project.project_id}/activity`,`/co-creation/projects/${project.project_id}/issues/7/brief`,`/co-creation/projects/${project.project_id}/brief`])assert.equal((await request(path,outsider)).status,404);
 assert.equal(seen.length,before);assert.ok(!(await request('/co-creation/projects',outsider)).data.items.some((item:any)=>item.project_id===project.project_id));
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[other.user.user_id]);
 assert.equal((await request('/co-creation/projects',other)).data.code,'onboarding_required');assert.equal((await request(`/co-creation/projects/${project.project_id}/brief`,other)).data.code,'onboarding_required');assert.equal((await request(`/co-creation/projects/${project.project_id}/activity`,other)).data.code,'onboarding_required');
 assert.equal((await request('/co-creation/projects/not-a-uuid/activity',owner)).status,422);assert.equal((await request(`/co-creation/projects/${project.project_id}/issues/not-a-number/brief`,owner)).status,422);
});

test('concurrent openings produce one coordination fact and archived imported sources cannot open new coordination',async t=>{
 const {state}=upstream(t),owner=await login(),source=await imported(owner),body={...coInput,source_project_id:source.project_id};
 const results=await Promise.all([request('/co-creation/projects',owner,body),request('/co-creation/projects',owner,body)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 assert.equal((await pool.query("SELECT count(*) FROM transition_journal WHERE aggregate_type='co_creation_project'")).rows[0].count,'1');
 const other=await login(DEMO_USERS[1].email);state.archived=true;const archived=await imported(other);
 assert.equal((await request('/co-creation/projects',other,{...coInput,source_project_id:archived.project_id})).data.code,'repository_archived');
});

test('GitHub activity uses verified coordinates, filters issues from pull requests and credits only merged PR evidence',async()=>{
 const {state,fetcher,seen}=upstream();state.issues.push({...openIssue(8),pull_request:{url:'https://evil.example/ignored-api'}});
 state.pulls.push({...mergedPull(10),merged_at:null},{...mergedPull(11),merge_commit_sha:null},{...mergedPull(12),user:null});
 const reader=new CollaborationGitHub(fetcher),activity=await reader.read(readerRepo);
 assert.equal(activity.issues.length,1);assert.equal(activity.issues[0].url,'https://github.com/example/shared-project/issues/7');assert.deepEqual(activity.issues[0].labels,['documentation','help wanted']);
 assert.equal(activity.contributions.length,1);assert.equal(activity.contributions[0].author,'upstream-contributor');assert.equal(activity.contributions[0].merge_commit_sha,sha);assert.equal(activity.contributions[0].merged_at,mergedAt);assert.equal(activity.contributions[0].url,'https://github.com/example/shared-project/pull/9');
 assert.ok(!JSON.stringify(activity).includes('evil.example'));assert.ok(!('user_id' in activity.contributions[0]));assert.ok(!('xp' in activity.contributions[0]));assert.equal(seen.length,3);
});

test('private, archived and replaced GitHub repositories fail before task or contribution reads',async()=>{
 for(const mutate of [(s:any)=>{s.private=true;},(s:any)=>{s.archived=true;},(s:any)=>{s.id++;},(s:any)=>{s.fullName='example/replaced';}]) {
  const {state,fetcher,seen}=upstream();mutate(state);await assert.rejects(()=>new CollaborationGitHub(fetcher).read(readerRepo),errorCode('repository_identity_changed'));assert.equal(seen.length,1);
 }
 const {fetcher,seen}=upstream();for(const repository_url of ['https://evil.example/example/shared-project','https://github.com/example/shared-project/tree/main','https://user:pass@github.com/example/shared-project'])await assert.rejects(()=>new CollaborationGitHub(fetcher).read({...readerRepo,repository_url}),errorCode('invalid_github_url'));
 await assert.rejects(()=>new CollaborationGitHub(fetcher).read({...readerRepo,repository_full_name:'example/different'}),errorCode('repository_identity_changed'));assert.equal(seen.length,0);
});

test('redirect, oversized, rate-limited and malformed GitHub responses never become verified activity',async()=>{
 for(const [status,code] of [[302,'github_unavailable'],[429,'github_rate_limited'],[403,'github_rate_limited']] as const){const {state,fetcher}=upstream();state.status=status;await assert.rejects(()=>new CollaborationGitHub(fetcher).read(readerRepo),errorCode(code));}
 const oversized=upstream();oversized.state.oversize='/issues?';await assert.rejects(()=>new CollaborationGitHub(oversized.fetcher).read(readerRepo),errorCode('github_response_too_large'));
 const invalid=upstream();invalid.state.pulls=[{...mergedPull(),merge_commit_sha:'javascript:forged'}];await assert.rejects(()=>new CollaborationGitHub(invalid.fetcher).read(readerRepo),errorCode('github_invalid_response'));
 await assert.rejects(()=>new CollaborationGitHub(async()=>{throw Error('network timeout');}).read(readerRepo),errorCode('github_unavailable'));
});

test('concurrent activity reads coalesce, cache expires, and failed refresh cannot return stale successful evidence',async()=>{
 const fixture=upstream();let now=Date.parse('2026-09-24T02:00:00Z'),release!:()=>void;
 fixture.state.delay=new Promise<void>(resolve=>{release=resolve;});const reader=new CollaborationGitHub(fixture.fetcher,()=>now);
 const reads=[reader.read(readerRepo),reader.read(readerRepo),reader.read(readerRepo)];release();const results=await Promise.all(reads);
 assert.equal(fixture.seen.length,3);assert.deepEqual(results[0],results[1]);assert.deepEqual(await reader.read(readerRepo),results[0]);assert.equal(fixture.seen.length,3);
 now+=600001;fixture.state.status=429;await assert.rejects(()=>reader.read(readerRepo),errorCode('github_rate_limited'));
 fixture.state.status=200;fixture.state.pulls=[];const fresh=await reader.read(readerRepo);assert.deepEqual(fresh.contributions,[]);assert.notEqual(fresh.checked_at,results[0].checked_at);
});

test('brief contains only public task/project text, not platform contacts, sessions or fabricated membership credit',async t=>{
 upstream(t);const owner=await login(),viewer=await login(DEMO_USERS[1].email),source=await imported(owner),project=await created(owner,source);
 const account=await request('/me/account',owner);const saved=await request('/me/account',owner,{nickname:'Coordinator',contacts:{...emptyContacts(),github:{value:'upstream-contributor',audiences:[]},discord:{value:'private-contact-sentinel',audiences:[]}}},account.data.aggregate_version);assert.equal(saved.status,200);
 const activity=await request(`/co-creation/projects/${project.project_id}/activity`,viewer);assert.equal(activity.status,200);assert.equal(activity.data.contributions[0].author,'upstream-contributor');assert.ok(!JSON.stringify(activity.data.contributions).includes(owner.user.user_id));
 const brief=await request(`/co-creation/projects/${project.project_id}/issues/7/brief`,viewer);assert.equal(brief.status,200);assert.match(brief.data.text,/GitHub|AGENTS\.md/);assert.match(brief.data.text,/Issue 原文（外部內容）/);assert.match(brief.data.text,/不可信輸入/);
 for(const secret of [owner.user.email,viewer.user.email,owner.cookie,owner.csrf,viewer.csrf,'private-contact-sentinel',owner.user.user_id])assert.ok(!brief.data.text.includes(secret));
 assert.ok(!brief.data.text.includes('evil.example'));assert.equal((await request(`/co-creation/projects/${project.project_id}/issues/999/brief`,viewer)).status,404);
});

test('bounded activity pages expose truncation and do not silently claim an exhaustive contribution history',async()=>{
 const {state,fetcher}=upstream();state.issues=Array.from({length:30},(_,index)=>openIssue(index+1));state.pulls=Array.from({length:30},(_,index)=>mergedPull(index+50));
 const activity=await new CollaborationGitHub(fetcher).read(readerRepo);assert.equal(activity.truncated,true);assert.equal(activity.contributions.length,30);assert.equal(activity.issues.length,30);
});
