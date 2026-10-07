import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createMemberModelHttpTransport } from '../../apps/platform-api/src/routes/member-model-http.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { transaction } from '../../packages/db/transaction.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { ModelConnectionMetadataSchema, ExecutionGrantMetadataSchema, ExecutionAttemptMetadataSchema, type ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createServer } from 'node:http';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { createLocalFixtureModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { createPrivateResultService } from '../../modules/autopilot-work/results.js';
import { ModelStepMetadataSchema, ModelStepApprovalMetadataSchema } from '../../contracts/execution/v2/model-step.js';
import { MemberModelHttpOverviewSchema } from '../../contracts/execution/v2/member-model-http.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_member_model_http_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({connectionString});
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({connectionString:roleUrl(migrator),options:`-c search_path=${schema} -c statement_timeout=10000`,max:8});
const app = new Pool({connectionString:roleUrl(runtime),options:`-c search_path=${schema} -c statement_timeout=10000`,max:12});
const origin = 'https://member.example.invalid', options = {origin,environment:'local' as const,clientId:'member-http-synthetic'};
const works = createPrivateWorkCommands(app,{resolvePolicy:resolvePrivateWorkPersistencePolicy});
const enrollment = createRuntimeRegistrations(app,{environment:options.environment}), connections = createAgentConnections(app,{environment:options.environment,clientId:options.clientId});
const selection: ModelSelection = {providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
const runs=createExecutionRuns(app), prerequisites=createExecutionPrerequisites(app,{environment:options.environment,clientId:options.clientId});
class ObservedStore extends FakeObjectStore { puts=0; override async putImmutable(...args:Parameters<FakeObjectStore['putImmutable']>) {this.puts++;return super.putImmutable(...args);} }
const store=new ObservedStore(), results=createPrivateResultService(app,{store,resolvePolicy:resolvePrivateWorkPersistencePolicy});
let posts=0;
const provider=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.headers.authorization!=='Bearer synthetic-fixture-only'){res.statusCode=401;res.end('{}');return;}
  if(req.method==='GET'){res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic'}));return;}
  posts++;let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
    const body=JSON.parse(raw);assert.equal(body.model,'synthetic-model');assert.deepEqual(body.tools,[]);
    res.end(JSON.stringify({id:'synthetic-response',object:'response',model:'synthetic-model',status:'completed',
      output:[{id:'synthetic-message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'PRIVATE_HTTP_SYNTHETIC_OUTPUT',annotations:[]}]}],
      usage:{input_tokens:3,output_tokens:4,total_tokens:7}}));
  });
});
let created = false, transport: Awaited<ReturnType<typeof createMemberModelHttpTransport>>;
before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created=true; await migrate(owner);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
  const prefix = template.slice(template.indexOf('BEGIN;'),template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public',`SCHEMA ${schema}`).replaceAll(':"runtime"',`"${runtime}"`);
  const grants = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'",`'${runtime}'`).replace("n.nspname='public'",`n.nspname='${schema}'`);
  const q=await owner.connect();
  try {await q.query(prefix);const rows=await q.query(grants);assert.equal(rows.rowCount,2);for(const row of rows.rows)await q.query(Object.values(row)[0] as string);await q.query('COMMIT');}
  catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address==='object');
  const host=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,
    recover:async()=>({generation:'1',expiresAt:new Date(Date.now()+60000).toISOString()}),
    resolveCredential:async()=>({key:new TextEncoder().encode('synthetic-fixture-only'),expiresAt:new Date(Date.now()+60000).toISOString()})});
  transport=await createMemberModelHttpTransport(app,{...options,host,store,resolvePolicy:resolvePrivateWorkPersistencePolicy,sourceNetwork:r=>r.headers.get('X-Test-Network')??'synthetic-default'});
});
after(async()=>{provider.closeAllConnections();await new Promise<void>((resolve,reject)=>provider.close(e=>e?reject(e):resolve()));await app.end();await owner.end();try{if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`);}finally{await admin.end();}});
beforeEach(async()=>{await owner.query('TRUNCATE communities CASCADE');await owner.query('TRUNCATE auth_rate_limits');posts=0;store.puts=0;});
async function member() {
  const user=randomUUID(),community=randomUUID(),raw=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic member HTTP')",[community]);
  const row=(await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic HTTP owner','not-a-login',$4) RETURNING *`,[user,community,user+'@example.invalid',randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[tokenHash(raw),user,csrf]);
  const actor:Actor={...row,session_hash:tokenHash(raw),csrf_token:csrf};
  const context=await withMemberScope(app,{actor,scope:'personal'},async()=>{},async(_q,c)=>c);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,true,10485760)`,[context.scope.scope_id,context.subject_principal.principal_id]);
  return {actor,context,headers:{Cookie:'__Host-freedom_session='+raw,'X-CSRF-Token':csrf,Origin:origin}};
}
type Member=Awaited<ReturnType<typeof member>>;
async function fixture() {
  const f=await member(),pair=await generateKeyPair('ES256',{extractable:true});
  const challenge=await enrollment.begin(f.actor,{key:randomUUID(),publicJwk:parseRuntimePublicJwk(await exportJWK(pair.publicKey))});
  const proof=await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(pair.privateKey);
  const device=await enrollment.confirm(f.actor,{key:randomUUID(),challengeId:challenge.challenge_id,proof});
  const connection=await connections.create(f.actor,{key:randomUUID(),runtimeDeviceId:device.runtimeDeviceId});
  await transaction(app,q=>insertInitialRefreshFamily(q,connection.connectionId,new Date(connection.issuedAt),new Date(connection.expiresAt)));
  const work=await works.create(f.actor,{key:randomUUID(),title:'Synthetic HTTP private goal',objective:'PRIVATE_BODY_NEVER_IN_HTTP_METADATA'});
  const run=await runs.create(f.actor,{key:randomUUID(),workId:work.workId,expectedWorkVersion:'1'});
  const model=await prerequisites.models.create(f.actor,{key:randomUUID(),connectionId:connection.connectionId,expectedConnectionVersion:'1',selection});
  const grant=await prerequisites.grants.create(f.actor,{key:randomUUID(),runId:run.runId,expectedRunVersion:'1',expectedWorkVersion:'1',
    connectionId:connection.connectionId,expectedConnectionVersion:'1',modelConnectionId:model.modelConnectionId,expectedModelVersion:'1',consent:true});
  await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
    VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`,[randomUUID(),f.context.scope.scope_id,f.context.subject_principal.principal_id,options.environment,options.clientId,JSON.stringify(selection)]);
  return {...f,device,connection,work,run,model,grant};
}
function post(f:Member,path:string,value:unknown,headers:Record<string,string>={}) {
  return transport.request(origin+path,{method:'POST',headers:{...f.headers,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"1"','X-Test-Network':randomUUID(),...headers},body:JSON.stringify(value)});
}
function get(f:Member,path:string,headers:Record<string,string>={}) {
  return transport.request(origin+path,{headers:{Cookie:f.headers.Cookie,'X-Test-Network':randomUUID(),...headers}});
}
async function expect(response:Response,status:number,etag?:string) {
  assert.equal(response.status,status,await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
  if(etag!==undefined)assert.equal(response.headers.get('ETag'),`"${etag}"`);
  if(status>=400){assert.equal(response.headers.get('ETag'),null);const raw=await response.clone().text();if(!raw)return response;const dto=JSON.parse(raw);assert.deepEqual(Object.keys(dto).sort(),['code','detail','status','title','type']);assert.equal(dto.detail,'Request could not be completed.');}
  return response;
}

async function approved() {
  const f=await fixture(),body={runId:f.run.runId,grantId:f.grant.grantId,expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20},key=randomUUID();
  const approval=ModelStepApprovalMetadataSchema.parse(await(await expect(await post(f,'/api/v1/me/model-step-approvals',body,{'Idempotency-Key':key}),201,'1')).json());
  assert.deepEqual(await(await expect(await post(f,'/api/v1/me/model-step-approvals',body,{'Idempotency-Key':key}),201,'1')).json(),approval);
  return {...f,approval};
}
async function activated() {
  const f=await approved(),body={approvalId:f.approval.approvalId,expectedRunVersion:'1'},key=randomUUID();
  const step=ModelStepMetadataSchema.parse(await(await expect(await post(f,'/api/v1/me/model-steps',body,{'Idempotency-Key':key}),201,'1')).json());
  assert.deepEqual(await(await expect(await post(f,'/api/v1/me/model-steps',body,{'Idempotency-Key':key}),201,'1')).json(),step);
  return {...f,step};
}
test('MEMBER-MODEL-01 real member HTTP approval, activation and one awaited dispatch finalizes Asset/Result before response',async()=>{
  const f=await activated();assert.equal(posts,0);assert.equal(store.puts,0);
  const done=ModelStepMetadataSchema.parse(await(await expect(await post(f,`/api/v1/me/model-steps/${f.step.stepId}:execute`,{}),200,'4')).json());
  assert.equal(done.state,'succeeded');assert.equal(done.usageStatus,'known');assert.equal(done.evidenceOrigin,'synthetic_local_fixture');assert.equal(done.costStatus,'unknown');
  assert.equal(posts,1);assert.equal(store.puts,1);
  const result=await results.readCurrent(f.actor,{workId:f.work.workId});assert(result);assert.equal(result.text,'PRIVATE_HTTP_SYNTHETIC_OUTPUT');assert.equal(result.provenance,'model');assert.equal(result.aggregateVersion,'2');
  assert.equal((await owner.query('SELECT state FROM execution_runs')).rows[0].state,'succeeded');
  assert.equal((await owner.query('SELECT count(*)::int n FROM private_model_work_results')).rows[0].n,1);
  const read=await expect(await get(f,`/api/v1/me/model-steps/${done.stepId}`),200,'4');assert.deepEqual(await read.json(),done);
  const metadata=JSON.stringify(done);for(const secret of ['PRIVATE_HTTP_SYNTHETIC_OUTPUT','PRIVATE_BODY_NEVER','synthetic-fixture-only','observation','capability','providerUrl'])assert(!metadata.includes(secret));
  const role=(await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false});
});
test('MEMBER-MODEL-02 bounded owner discovery supplies exact versions, current policy choices and no objective or provider credentials',async()=>{
  const f=await activated(),foreign=await fixture();
  const overview=MemberModelHttpOverviewSchema.parse(await(await expect(await get(f,'/api/v1/me/model-step-overview'),200)).json());
  assert.deepEqual(overview.works,[{workId:f.work.workId,title:'Synthetic HTTP private goal',state:'draft',aggregateVersion:'1'}]);
  assert.deepEqual(overview.allowedSelections,[{selection,maxOutputTokens:20}]);assert.equal(overview.configuration,'configured');assert.equal(overview.persistenceAvailable,true);
  assert.equal(overview.runs[0].state,'running');assert.equal(overview.runs[0].aggregateVersion,'2');assert.equal(overview.models[0].modelConnectionId,f.model.modelConnectionId);
  assert.equal(overview.grants[0].grantId,f.grant.grantId);assert.equal(overview.approvals[0].approvalId,f.approval.approvalId);assert.deepEqual(overview.steps,[f.step]);
  const raw=JSON.stringify(overview);assert(!raw.includes(foreign.work.workId));assert(!raw.includes('PRIVATE_BODY_NEVER'));assert(!raw.includes('synthetic-fixture-only'));
  await expect(await get(foreign,`/api/v1/me/model-steps/${f.step.stepId}`),404);
  assert.equal(posts,0);assert.equal(store.puts,0);
});
test('MEMBER-MODEL-03 reserved pause and stop fence dispatch; approval revocation remains owner-readable',async()=>{
  for(const action of ['pause','stop']){const f=await activated();
    const controlled=ModelStepMetadataSchema.parse(await(await expect(await post(f,`/api/v1/me/model-steps/${f.step.stepId}:${action}`,{}),200,'2')).json());
    assert.equal(controlled.state,'cancelled');const response=await post(f,`/api/v1/me/model-steps/${f.step.stepId}:execute`,{}, {'If-Match':'"2"'});assert(response.status>=400);
    const revoked=ModelStepApprovalMetadataSchema.parse(await(await expect(await post(f,`/api/v1/me/model-step-approvals/${f.approval.approvalId}:revoke`,{}),200,'2')).json());assert.equal(revoked.state,'revoked');
    assert.deepEqual(await(await expect(await get(f,`/api/v1/me/model-step-approvals/${f.approval.approvalId}`),200,'2')).json(),revoked);
  }assert.equal(posts,0);assert.equal(store.puts,0);
});
test('MEMBER-MODEL-04 stale primary/secondary versions deny effects and policy maximum remains authoritative',async()=>{
  const f=await fixture(),body={runId:f.run.runId,grantId:f.grant.grantId,expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20};
  await expect(await post(f,'/api/v1/me/model-step-approvals',body,{'If-Match':'"2"'}),412);
  await expect(await post(f,'/api/v1/me/model-step-approvals',{...body,expectedGrantVersion:'2'}),412);
  await expect(await post(f,'/api/v1/me/model-step-approvals',{...body,expectedWorkVersion:'2'}),412);
  const over=await post(f,'/api/v1/me/model-step-approvals',{...body,maxOutputTokens:21});assert(over.status>=400);
  assert.equal((await owner.query('SELECT count(*)::int n FROM model_export_approvals')).rows[0].n,0);assert.equal(posts,0);assert.equal(store.puts,0);
});

test('MEMBER-MODEL-05 persistence withdrawal hides Work/export content but retains owner metadata and human Stop',async()=>{
  const f=await activated();await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1 WHERE scope_id=$1',[f.context.scope.scope_id]);
  const overview=MemberModelHttpOverviewSchema.parse(await(await expect(await get(f,'/api/v1/me/model-step-overview'),200)).json());
  assert.equal(overview.persistenceAvailable,false);assert.deepEqual(overview.works,[]);assert.deepEqual(overview.allowedSelections,[]);assert.equal(overview.steps[0].stepId,f.step.stepId);
  assert(!JSON.stringify(overview).includes('Synthetic HTTP private goal'));await expect(await get(f,`/api/v1/me/model-steps/${f.step.stepId}`),200,'1');
  assert((await post(f,`/api/v1/me/model-steps/${f.step.stepId}:execute`,{})).status>=400);
  const stopped=await(await expect(await post(f,`/api/v1/me/model-steps/${f.step.stepId}:stop`,{}),200,'2')).json();assert.equal(stopped.state,'cancelled');assert.equal(posts,0);assert.equal(store.puts,0);
});
test('MEMBER-MODEL-06 failed PostgreSQL policy source is unavailable, never interpreted as a withdrawn policy',async()=>{
  const f=await fixture();await owner.query(`REVOKE SELECT ON private_work_persistence_policy FROM ${runtime}`);
  try{const response=await expect(await get(f,'/api/v1/me/model-step-overview'),503);assert.equal((await response.json()).code,'member_model_http_unavailable');}
  finally{await owner.query(`GRANT SELECT ON private_work_persistence_policy TO ${runtime}`);}
  assert.equal(posts,0);assert.equal(store.puts,0);
});
