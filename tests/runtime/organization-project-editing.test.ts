import {test,before,after,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_org_project_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const config={clientId:'Iv1.org-project-test',clientSecret:'synthetic-secret',tokenKey:randomBytes(32).toString('base64'),redirectUri:origin+'/github/callback'};
const state:{permissions?:{admin:boolean;maintain:boolean;push:boolean};repositoryId:number;private:boolean;archived:boolean;identityId:number;status:number}={permissions:{admin:true,maintain:false,push:true},repositoryId:501,private:false,archived:false,identityId:12345,status:200};
const sha='a'.repeat(40);
const provider:typeof fetch=async(input,init)=>{
  const url=String(input),auth=new Headers(init?.headers).get('Authorization');
  assert.equal(init?.redirect,'manual');
  if(url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'ghu_org_test',token_type:'bearer',scope:''});
  if(url===`https://api.github.com/applications/${config.clientId}/token`&&init?.method==='DELETE')return new Response(null,{status:204});
  if(url==='https://api.github.com/user'){
    assert.equal(auth,'Bearer ghu_org_test');
    return Response.json({id:state.identityId,login:'org-manager'});
  }
  if(url==='https://api.github.com/repos/example-org/project'){
    if(auth){assert.equal(auth,'Bearer ghu_org_test');if(state.status!==200)return new Response(null,{status:state.status});}
    return Response.json({id:state.repositoryId,full_name:'example-org/project',private:state.private,archived:state.archived,visibility:'public',default_branch:'main',fork:false,owner:{id:999,login:'example-org',type:'Organization'},...(auth?{permissions:state.permissions}:{})});
  }
  if(url.endsWith('/commits/main'))return Response.json({sha});
  if(url.endsWith(`/license?ref=${sha}`))return Response.json({path:'LICENSE',license:{spdx_id:'MIT'}});
  throw new Error(`Unexpected synthetic provider URL: ${url}`);
};
const app=createApp(pool,origin,'local',{githubSocial:{config,fetcher:provider}});
type Session={cookie:string;csrf:string;userId:string};
type Data={project_id:string;submission_id:string;aggregate_version:number;code:string;title:string;authorization_url:string;csrf_token:string;user:{user_id:string};owner_ref:string;can_edit:boolean};
async function api(path:string,session?:Session,body?:unknown,version?:number,key=randomUUID()){
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;}
  if(version!==undefined)headers['If-Match']=`"${version}"`;
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as Data,response};
}
async function login(email:string):Promise<Session>{
  const result=await api('/auth/login',undefined,{email,password:DEMO_PASSWORD});
  assert.equal(result.status,200,JSON.stringify(result.data));
  return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token,userId:result.data.user.user_id};
}
async function connect(session:Session){
  const start=await api('/me/github/connect',session,{return_to:'#opensource'});
  const state=new URL(start.data.authorization_url).searchParams.get('state');
  assert.equal((await api('/me/github/complete',session,{state,code:'synthetic-code'})).status,200);
}
const metadata={title:'組織作品修正版',description:'整理團隊共同筆記。',use_notes:'先閱讀組織 Repo 的 README。',demo_url:null};
async function fixture(){
  const owner=await login('submitter@organization-project.invalid'),manager=await login(DEMO_USERS[1].email);
  const saved=await api('/me/skill-submissions/manual',owner,{...metadata,title:'原投稿版本',repository_url:'https://github.com/example-org/project',relationship:'curator'});
  assert.equal(saved.status,201,JSON.stringify(saved.data));
  const published=await api(`/me/skill-submissions/${saved.data.submission_id}/publish`,owner,{consent_to_share:true},saved.data.aggregate_version);
  assert.equal(published.status,200,JSON.stringify(published.data));
  await connect(manager);
  const project=(await pool.query<{project_id:string;aggregate_version:string}>('SELECT project_id,aggregate_version FROM oss_projects WHERE project_id=$1',[published.data.project_id])).rows[0];
  return {owner,manager,projectId:project.project_id,version:Number(project.aggregate_version),submissionId:saved.data.submission_id};
}
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);
  await pool.query("UPDATE users SET email='submitter@organization-project.invalid' WHERE user_id=$1",[DEMO_USERS[0].user_id]);
  Object.assign(state,{permissions:{admin:true,maintain:false,push:true},repositoryId:501,private:false,archived:false,identityId:12345,status:200});
  mock.method(globalThis,'fetch',provider);
});
afterEach(()=>mock.restoreAll());

test('linked organization manager can edit published work and its skill page without taking ownership',async()=>{
  const f=await fixture(),path=`/opensource/projects/${f.projectId}:revise`;
  const updated=await api(path,f.manager,metadata,f.version);
  assert.equal(updated.status,200,JSON.stringify(updated.data));
  assert.equal(updated.data.title,metadata.title);assert.equal(updated.data.owner_ref,f.owner.userId);
  const skill=await api(`/skill-submissions/${f.submissionId}`);
  assert.equal(skill.data.title,metadata.title);
  const persisted=(await pool.query<{owner_ref:string;payload:{title:string;relationship:string}}>('SELECT owner_ref,payload FROM skill_submissions WHERE submission_id=$1',[f.submissionId])).rows[0];
  assert.equal(persisted.owner_ref,f.owner.userId);assert.equal(persisted.payload.relationship,'curator');
  assert.equal(persisted.payload.title,'原投稿版本');
  assert.equal((await api(`/me/skill-submissions/${f.submissionId}`,f.manager)).status,404);
  assert.equal((await api('/marketing/campaigns',f.manager,{title:'行銷',audience:'會員',goal:'試用',draft_text:'介紹組織作品',source_project_id:f.projectId})).status,404);
});

test('maintain is sufficient but push-only, read-only and missing permissions cannot edit',async()=>{
  const f=await fixture(),path=`/opensource/projects/${f.projectId}:revise`;
  state.permissions={admin:false,maintain:true,push:true};
  const updated=await api(path,f.manager,metadata,f.version);assert.equal(updated.status,200,JSON.stringify(updated.data));
  for(const push of [true,false]){
    state.permissions={admin:false,maintain:false,push};
    assert.equal((await api(path,f.manager,{...metadata,title:'不可修改'},updated.data.aggregate_version)).status,404);
  }
  state.permissions=undefined;
  assert.equal((await api(path,f.manager,metadata,updated.data.aggregate_version)).status,404);
});

test('every write and receipt replay rechecks revoked GitHub rights and stable repository identity',async()=>{
  const f=await fixture(),path=`/opensource/projects/${f.projectId}:revise`,key=randomUUID();
  const updated=await api(path,f.manager,metadata,f.version,key);assert.equal(updated.status,200,JSON.stringify(updated.data));
  state.permissions={admin:false,maintain:false,push:false};
  assert.equal((await api(path,f.manager,metadata,f.version,key)).status,404);
  state.permissions={admin:true,maintain:false,push:true};state.repositoryId=502;
  assert.equal((await api(path,f.manager,metadata,updated.data.aggregate_version)).status,404);
  state.repositoryId=501;state.private=true;
  assert.equal((await api(path,f.manager,metadata,updated.data.aggregate_version)).status,404);
  state.private=false;state.archived=true;
  assert.equal((await api(path,f.manager,metadata,updated.data.aggregate_version)).status,404);
  assert.equal((await pool.query('SELECT title FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0].title,metadata.title);
});

test('identity mismatch and provider errors fail closed; original submitter keeps editing without GitHub',async()=>{
  const f=await fixture(),path=`/opensource/projects/${f.projectId}:revise`;
  state.identityId=54321;
  assert.equal((await api(path,f.manager,metadata,f.version)).data.code,'github_reconnect_required');
  state.identityId=12345;
  for(const status of [403,429,500]){
    state.status=status;
    assert.notEqual((await api(path,f.manager,metadata,f.version)).status,200);
  }
  const updated=await api(path,f.owner,metadata,f.version);assert.equal(updated.status,200,JSON.stringify(updated.data));
  assert.equal((await api(path,f.owner,metadata,f.version)).status,412);
});

test('management check and version refresh require current linked rights, community scope and visible ownership',async()=>{
  const f=await fixture(),access=`/opensource/projects/${f.projectId}/edit-access`,refresh=`/opensource/projects/${f.projectId}:refresh`;
  assert.equal((await api(access,undefined,{})).status,401);
  assert.equal((await api(access,f.manager,{})).data.can_edit,true);
  const updated=await api(refresh,f.manager,{},f.version);
  assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.owner_ref,f.owner.userId);
  await api('/me/github/disconnect',f.manager,{});
  assert.equal((await api(access,f.manager,{})).status,404);
  assert.equal((await api(refresh,f.manager,{},updated.data.aggregate_version)).status,404);
  await connect(f.manager);
  await pool.query("UPDATE users SET email='hidden-submitter@example.invalid' WHERE user_id=$1",[f.owner.userId]);
  assert.equal((await api(access,f.manager,{})).status,404);
  await pool.query("UPDATE users SET email='submitter@organization-project.invalid' WHERE user_id=$1",[f.owner.userId]);
  await pool.query('INSERT INTO communities(community_id,name) VALUES($1,$2)',[randomUUID(),'另一個社群']);
  await pool.query('UPDATE oss_projects SET community_id=(SELECT community_id FROM communities WHERE name=$2) WHERE project_id=$1',[f.projectId,'另一個社群']);
  assert.equal((await api(access,f.manager,{})).status,404);
  assert.equal((await api(`/opensource/projects/${f.projectId}:revise`,f.manager,metadata,updated.data.aggregate_version)).status,404);
});
