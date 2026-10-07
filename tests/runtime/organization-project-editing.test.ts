import {test,before,after,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,transaction} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {CompactSign,exportJWK,generateKeyPair} from 'jose';
import {authenticate} from '../../modules/identity-membership/service.js';
import {createRuntimeRegistrations} from '../../modules/agent-control/runtime-registration.js';
import {createAgentConnections} from '../../modules/agent-control/agent-connections.js';
import {parseRuntimePublicJwk} from '../../modules/agent-control/runtime-proof.js';
import {insertInitialRefreshFamily} from '../../modules/agent-control/bootstrap-session-store.js';
import {createExecutionPrerequisites} from '../../modules/agent-execution/prerequisites.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_org_project_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const config={clientId:'Iv1.org-project-test',clientSecret:'synthetic-secret',tokenKey:randomBytes(32).toString('base64'),redirectUri:origin+'/github/callback'};
const state:{permissions?:{admin:boolean;maintain:boolean;push:boolean};repositoryId:number;private:boolean;archived:boolean;identityId:number;status:number}={permissions:{admin:true,maintain:false,push:true},repositoryId:501,private:false,archived:false,identityId:12345,status:200};
const rotation={expired:false,consumed:false,refreshes:0};
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
let repositoryGate:{entered:ReturnType<typeof barrier>;resume:ReturnType<typeof barrier>}|undefined;
let revokeGate:typeof repositoryGate;
const sha='a'.repeat(40);
const provider:typeof fetch=async(input,init)=>{
  const url=String(input),auth=new Headers(init?.headers).get('Authorization');
  assert.equal(init?.redirect,'manual');
  if(url==='https://github.com/login/oauth/access_token'){
    const fields=new URLSearchParams(String(init?.body));
    if(fields.get('grant_type')==='refresh_token'){
      rotation.refreshes++;
      if(rotation.consumed||fields.get('refresh_token')!=='ghr_org_test')return Response.json({error:'invalid_grant'});
      rotation.consumed=true;
      return Response.json({access_token:'ghu_org_rotated',token_type:'bearer',scope:'',expires_in:3600,refresh_token:'ghr_org_rotated',refresh_token_expires_in:86400});
    }
    return Response.json({access_token:'ghu_org_test',token_type:'bearer',scope:'',...(rotation.expired?{expires_in:1,refresh_token:'ghr_org_test',refresh_token_expires_in:86400}:{})});
  }
  if(url===`https://api.github.com/applications/${config.clientId}/token`&&init?.method==='DELETE'){
    if(revokeGate){revokeGate.entered.release();await revokeGate.resume.promise;}
    return new Response(null,{status:204});
  }
  if(url==='https://api.github.com/user'){
    assert.equal(auth,rotation.consumed?'Bearer ghu_org_rotated':'Bearer ghu_org_test');
    return Response.json({id:state.identityId,login:'org-manager'});
  }
  if(url==='https://api.github.com/repos/example-org/project'){
    if(auth){
      assert.equal(auth,rotation.consumed?'Bearer ghu_org_rotated':'Bearer ghu_org_test');
      if(repositoryGate){repositoryGate.entered.release();await repositoryGate.resume.promise;}
      if(state.status!==200)return new Response(null,{status:state.status});
    }
    return Response.json({id:state.repositoryId,full_name:'example-org/project',private:state.private,archived:state.archived,visibility:'public',default_branch:'main',fork:false,owner:{id:999,login:'example-org',type:'Organization'},...(auth?{permissions:state.permissions}:{})});
  }
  if(url.endsWith('/commits/main'))return Response.json({sha});
  if(url.endsWith(`/license?ref=${sha}`))return Response.json({path:'LICENSE',license:{spdx_id:'MIT'}});
  throw new Error(`Unexpected synthetic provider URL: ${url}`);
};
const app=createApp(pool,origin,'local',{githubSocial:{config,fetcher:provider}});
type Session={cookie:string;csrf:string;userId:string};
type Data={project_id:string;submission_id:string;aggregate_version:number;code:string;title:string;authorization_url:string;csrf_token:string;user:{user_id:string};owner_ref:string;can_edit:boolean;submission:{submission_id:string;aggregate_version:number}};
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
  Object.assign(rotation,{expired:false,consumed:false,refreshes:0});
  mock.method(globalThis,'fetch',provider);
});
afterEach(()=>{repositoryGate?.resume.release();revokeGate?.resume.release();repositoryGate=undefined;revokeGate=undefined;mock.restoreAll();});

test('expired token rotation survives a stale edit and the next management check needs no reconnect',async()=>{
  rotation.expired=true;
  const f=await fixture(),key=randomUUID();
  const before=(await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0];
  const failed=await api(`/opensource/projects/${f.projectId}:revise`,f.manager,metadata,f.version+1,key);
  assert.equal(failed.status,412,JSON.stringify(failed.data));assert.equal(failed.data.code,'version_conflict');
  assert.deepEqual((await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0],before);
  assert.equal((await pool.query('SELECT 1 FROM command_receipts WHERE idempotency_key=$1',[key])).rowCount,0);
  const checked=await api(`/opensource/projects/${f.projectId}/edit-access`,f.manager,{});
  assert.equal(checked.status,200,JSON.stringify(checked.data));assert.equal(checked.data.can_edit,true);
  assert.equal(rotation.refreshes,1);
});

test('expired token rotation persists with a successful edit and is reused by the next check',async()=>{
  rotation.expired=true;
  const f=await fixture();
  const credential=(await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[f.manager.userId])).rows[0].encrypted_tokens;
  const updated=await api(`/opensource/projects/${f.projectId}:revise`,f.manager,metadata,f.version);
  assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.title,metadata.title);
  const rotated=(await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[f.manager.userId])).rows[0].encrypted_tokens;
  assert.notEqual(rotated,credential);
  const checked=await api(`/opensource/projects/${f.projectId}/edit-access`,f.manager,{});
  assert.equal(checked.status,200,JSON.stringify(checked.data));assert.equal(checked.data.can_edit,true);
  assert.equal(rotation.refreshes,1);
  assert.equal((await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[f.manager.userId])).rows[0].encrypted_tokens,rotated);
});

test('permission denial after refresh preserves the credential and rolls back the project receipt',async()=>{
  rotation.expired=true;
  const f=await fixture(),key=randomUUID();
  const before=(await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0];
  state.permissions={admin:false,maintain:false,push:false};
  assert.equal((await api(`/opensource/projects/${f.projectId}:revise`,f.manager,metadata,f.version,key)).status,404);
  assert.deepEqual((await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0],before);
  assert.equal((await pool.query('SELECT 1 FROM command_receipts WHERE idempotency_key=$1',[key])).rowCount,0);
  state.permissions={admin:true,maintain:false,push:true};
  assert.equal((await api(`/opensource/projects/${f.projectId}/edit-access`,f.manager,{})).status,200);
  assert.equal(rotation.refreshes,1);
});

test('receipt INSERT failure rolls back project and journal but retains the completed refresh',async()=>{
  rotation.expired=true;
  const f=await fixture(),key=randomUUID();
  const before=(await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0];
  const journal=(await pool.query('SELECT * FROM transition_journal WHERE aggregate_id=$1',[f.projectId])).rows;
  await pool.query(`CREATE FUNCTION reject_project_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$;
    CREATE TRIGGER reject_project_receipt BEFORE INSERT ON command_receipts
    FOR EACH ROW WHEN (NEW.idempotency_key='${key}') EXECUTE FUNCTION reject_project_receipt()`);
  try{
    assert.equal((await api(`/opensource/projects/${f.projectId}:revise`,f.manager,metadata,f.version,key)).status,500);
    assert.deepEqual((await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0],before);
    assert.deepEqual((await pool.query('SELECT * FROM transition_journal WHERE aggregate_id=$1',[f.projectId])).rows,journal);
    assert.equal((await pool.query('SELECT 1 FROM command_receipts WHERE idempotency_key=$1',[key])).rowCount,0);
    assert.equal((await api(`/opensource/projects/${f.projectId}/edit-access`,f.manager,{})).status,200);
    assert.equal(rotation.refreshes,1);
  }finally{await pool.query('DROP TRIGGER reject_project_receipt ON command_receipts; DROP FUNCTION reject_project_receipt()');}
});

test('disconnect queued during refresh wins the transaction handoff without resurrecting credentials', {timeout:10000},async()=>{
  rotation.expired=true;
  const f=await fixture();
  const before=(await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0];
  repositoryGate={entered:barrier(),resume:barrier()};revokeGate={entered:barrier(),resume:barrier()};
  const edit=api(`/opensource/projects/${f.projectId}:revise`,f.manager,metadata,f.version);
  let disconnect:ReturnType<typeof api>|undefined;
  try{
    await repositoryGate.entered.promise;
    disconnect=api('/me/github/disconnect',f.manager,{});
    let blocked=false;
    for(let i=0;i<200&&!blocked;i++){
      blocked=(await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE 'SELECT pg_advisory_xact_lock%' AND cardinality(pg_blocking_pids(pid))>0`)).rowCount!>0;
      if(!blocked)await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(blocked,true,'disconnect must wait on the credential transaction');
    repositoryGate.resume.release();
    await revokeGate.entered.promise;
    assert.equal(rotation.refreshes,1);
    revokeGate.resume.release();
    assert.equal((await disconnect).status,200);
    assert.equal((await edit).status,404);
    assert.equal((await pool.query('SELECT 1 FROM github_social_connections WHERE user_id=$1',[f.manager.userId])).rowCount,0);
    assert.deepEqual((await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0],before);
  }finally{repositoryGate.resume.release();revokeGate.resume.release();await edit;await disconnect;}
});

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

test('public introduction editing grants no private submission writes, Agent Grant control or model budget access',async()=>{
  const f=await fixture(),path=`/opensource/projects/${f.projectId}:revise`;
  const issued=await api('/me/skill-submissions',f.owner,{});
  assert.equal(issued.status,201,JSON.stringify(issued.data));
  const draft=issued.data.submission;
  const privateBefore=(await pool.query('SELECT * FROM skill_submissions WHERE submission_id=ANY($1::uuid[]) ORDER BY submission_id',[[draft.submission_id,f.submissionId]])).rows;
  assert.ok(privateBefore.find(row=>row.submission_id===draft.submission_id).grant_hash);
  const owner=await authenticate(pool,f.owner.cookie.split('=')[1]),manager=await authenticate(pool,f.manager.cookie.split('=')[1]);
  const options={environment:'local' as const,clientId:'org-project-boundary'},enrollment=createRuntimeRegistrations(pool,{environment:options.environment});
  const pair=await generateKeyPair('ES256',{extractable:true});
  const challenge=await enrollment.begin(owner,{key:randomUUID(),publicJwk:parseRuntimePublicJwk(await exportJWK(pair.publicKey))});
  const proof=await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(pair.privateKey);
  const device=await enrollment.confirm(owner,{key:randomUUID(),challengeId:challenge.challenge_id,proof});
  const connection=await createAgentConnections(pool,options).create(owner,{key:randomUUID(),runtimeDeviceId:device.runtimeDeviceId});
  await transaction(pool,q=>insertInitialRefreshFamily(q,connection.connectionId,new Date(connection.issuedAt),new Date(connection.expiresAt)));
  const prerequisites=createExecutionPrerequisites(pool,options);
  const selection={providerRef:'synthetic-provider',modelRef:'synthetic-model',processingLocation:'claimed-unverified-location',artifactCustody:'runtime_local' as const,credentialCustody:'official_cli' as const,engineLocation:'runtime_local' as const,billingSource:'user_cli' as const};
  const model=await prerequisites.models.create(owner,{key:randomUUID(),connectionId:connection.connectionId,expectedConnectionVersion:'1',selection});
  await pool.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
    SELECT $1,scope_id,owner_principal_id,environment,client_id,selection,1,true,16384,20 FROM model_connections WHERE model_connection_id=$2`,[randomUUID(),model.modelConnectionId]);
  const budgetBefore=(await pool.query('SELECT * FROM model_inference_export_policy')).rows;
  assert.equal((await api(path,f.manager,metadata,f.version)).status,200);
  const privateBody={...metadata,repository_url:'https://github.com/example-org/project',relationship:'author'};
  assert.equal((await api(`/me/skill-submissions/${f.submissionId}/manual`,f.manager,privateBody,1)).status,404);
  for(const operation of ['grant','revoke'])assert.equal((await api(`/me/skill-submissions/${draft.submission_id}/${operation}`,f.manager,{},Number(draft.aggregate_version))).status,404);
  await assert.rejects(prerequisites.models.read(manager,{modelConnectionId:model.modelConnectionId}),{status:404,code:'not_found'});
  await assert.rejects(prerequisites.models.revoke(manager,{key:randomUUID(),modelConnectionId:model.modelConnectionId,expectedVersion:'1'}),{status:404,code:'not_found'});
  await assert.rejects(prerequisites.models.create(manager,{key:randomUUID(),connectionId:connection.connectionId,expectedConnectionVersion:'1',selection}),{status:404,code:'not_found'});
  assert.deepEqual(await prerequisites.models.read(owner,{modelConnectionId:model.modelConnectionId}),model);
  assert.deepEqual((await pool.query('SELECT * FROM model_inference_export_policy')).rows,budgetBefore);
  assert.deepEqual((await pool.query('SELECT * FROM skill_submissions WHERE submission_id=ANY($1::uuid[]) ORDER BY submission_id',[[draft.submission_id,f.submissionId]])).rows,privateBefore);
  assert.equal((await api(path,f.manager,{...metadata,owner_ref:f.manager.userId,relationship:'author',max_output_tokens:1000},f.version+1)).status,422);
  const project=(await pool.query('SELECT owner_ref,relationship FROM oss_projects WHERE project_id=$1',[f.projectId])).rows[0];
  assert.deepEqual(project,{owner_ref:f.owner.userId,relationship:'curator'});
  assert.equal((await api(`/me/skill-submissions/${draft.submission_id}/grant`,f.owner,{},Number(draft.aggregate_version))).status,200);
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
