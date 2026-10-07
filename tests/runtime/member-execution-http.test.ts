import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createMemberExecutionHttpTransport } from '../../apps/platform-api/src/routes/member-execution-http.js';
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
import { MemberExecutionHttpRunMetadataSchema } from '../../contracts/execution/v1/member-execution-http.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_member_http_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({connectionString});
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({connectionString:roleUrl(migrator),options:`-c search_path=${schema} -c statement_timeout=10000`,max:8});
const app = new Pool({connectionString:roleUrl(runtime),options:`-c search_path=${schema} -c statement_timeout=10000`,max:12});
const origin = 'https://member.example.invalid', options = {origin,environment:'local' as const,clientId:'member-http-synthetic'};
const works = createPrivateWorkCommands(app,{resolvePolicy:resolvePrivateWorkPersistencePolicy});
const enrollment = createRuntimeRegistrations(app,{environment:options.environment}), connections = createAgentConnections(app,{environment:options.environment,clientId:options.clientId});
const selection: ModelSelection = {providerRef:'synthetic-provider',modelRef:'synthetic-model',processingLocation:'claimed-unverified-location',artifactCustody:'runtime_local',credentialCustody:'official_cli',engineLocation:'runtime_local',billingSource:'user_cli'};
let created = false, transport: Awaited<ReturnType<typeof createMemberExecutionHttpTransport>>;
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
  transport=await createMemberExecutionHttpTransport(app,{...options,sourceNetwork:r=>r.headers.get('X-Test-Network')??'synthetic-default'});
});
after(async()=>{await app.end();await owner.end();try{if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`);}finally{await admin.end();}});
beforeEach(async()=>{await owner.query('TRUNCATE communities CASCADE');await owner.query('TRUNCATE auth_rate_limits');});
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
  return {...f,device,connection,work};
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
async function chain(f:Awaited<ReturnType<typeof fixture>>) {
  const runBody={workId:f.work.workId},runKey=randomUUID();
  const run=MemberExecutionHttpRunMetadataSchema.parse(await(await expect(await post(f,'/api/v1/me/execution-runs',runBody,{'Idempotency-Key':runKey}),201,'1')).json());
  const modelBody={connectionId:f.connection.connectionId,selection},modelKey=randomUUID();
  const model=ModelConnectionMetadataSchema.parse(await(await expect(await post(f,'/api/v1/me/model-connections',modelBody,{'Idempotency-Key':modelKey}),201,'1')).json());
  const grantBody={expectedWorkVersion:'1',connectionId:f.connection.connectionId,expectedConnectionVersion:'1',modelConnectionId:model.modelConnectionId,expectedModelVersion:'1',consent:true},grantKey=randomUUID();
  const grant=ExecutionGrantMetadataSchema.parse(await(await expect(await post(f,`/api/v1/me/execution-runs/${run.runId}/grants`,grantBody,{'Idempotency-Key':grantKey}),201,'1')).json());
  const attemptBody={grantId:grant.grantId,expectedGrantVersion:'1'},attemptKey=randomUUID();
  const attempt=ExecutionAttemptMetadataSchema.parse(await(await expect(await post(f,`/api/v1/me/execution-runs/${run.runId}/attempts`,attemptBody,{'Idempotency-Key':attemptKey}),201)).json());
  return {...f,run,runBody,runKey,model,modelBody,modelKey,grant,grantBody,grantKey,attempt,attemptBody,attemptKey};
}
test('MEMBER-HTTP-01 genuine cookie and non-superuser roles create/read/replay closed metadata end to end',async()=>{
  const f=await chain(await fixture());
  for(const [path,body,keyValue,value] of [[ '/api/v1/me/execution-runs',f.runBody,f.runKey,f.run],['/api/v1/me/model-connections',f.modelBody,f.modelKey,f.model],[`/api/v1/me/execution-runs/${f.run.runId}/grants`,f.grantBody,f.grantKey,f.grant],[`/api/v1/me/execution-runs/${f.run.runId}/attempts`,f.attemptBody,f.attemptKey,f.attempt]] as const)
    assert.deepEqual(await(await expect(await post(f,path,body,{'Idempotency-Key':keyValue}),201)).json(),value);
  for(const [kind,id,value] of [['execution-runs',f.run.runId,f.run],['model-connections',f.model.modelConnectionId,f.model],['execution-grants',f.grant.grantId,f.grant],['execution-attempts',f.attempt.attemptId,f.attempt]] as const){
    const response=await expect(await get(f,`/api/v1/me/${kind}/${id}`),200);assert.deepEqual(await response.json(),value);if(kind==='execution-attempts')assert.equal(response.headers.get('ETag'),null);
    assert.equal(value.operational_authority,false);assert(!JSON.stringify(value).includes('PRIVATE_BODY_NEVER_IN_HTTP_METADATA'));
  }
  assert.equal(f.model.state,'unverified');assert.equal(f.grant.state,'active');assert.equal(f.attempt.state,'preflight_blocked');
  assert.deepEqual(f.attempt.blockers,['model_authentication_unavailable','model_adapter_unavailable']);
  assert.equal((await owner.query('SELECT state,aggregate_version::text FROM execution_runs')).rows[0].state,'created');
  const role=(await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false});
});
test('MEMBER-HTTP-02 pause/stop and revoked backing deny new and replayed attempts; immutable history stays readable',async()=>{
  const f=await chain(await fixture()),pauseKey=randomUUID();
  const paused=await(await expect(await post(f,`/api/v1/me/execution-runs/${f.run.runId}:pause`,{}, {'Idempotency-Key':pauseKey}),200,'2')).json();
  assert.equal(paused.state,'paused');assert.equal(paused.taskLeaseEpoch,'2');assert.equal(paused.operational_authority,false);
  assert.deepEqual(await(await expect(await post(f,`/api/v1/me/execution-runs/${f.run.runId}:pause`,{}, {'Idempotency-Key':pauseKey}),200,'2')).json(),paused);
  await expect(await post(f,`/api/v1/me/execution-runs/${f.run.runId}/attempts`,f.attemptBody,{'Idempotency-Key':f.attemptKey}),409);
  await expect(await post(f,`/api/v1/me/execution-runs/${f.run.runId}:stop`,{}, {'If-Match':'"1"'}),412);
  const stopped=await(await expect(await post(f,`/api/v1/me/execution-runs/${f.run.runId}:stop`,{}, {'If-Match':'"2"'}),200,'3')).json();assert.equal(stopped.state,'cancelled');
  const grant=await(await expect(await post(f,`/api/v1/me/execution-grants/${f.grant.grantId}:revoke`,{}),200,'2')).json();assert.equal(grant.state,'revoked');
  const model=await(await expect(await post(f,`/api/v1/me/model-connections/${f.model.modelConnectionId}:revoke`,{}),200,'2')).json();assert.equal(model.state,'revoked');
  assert.deepEqual(await(await expect(await get(f,`/api/v1/me/execution-attempts/${f.attempt.attemptId}`),200)).json(),f.attempt);
  assert.equal(f.attempt.grant.state,'active');
});
test('MEMBER-HTTP-03 foreign owners see404 for every historical record and cannot control it',async()=>{
  const f=await chain(await fixture()),other=await member();
  for(const [kind,id] of [['execution-runs',f.run.runId],['model-connections',f.model.modelConnectionId],['execution-grants',f.grant.grantId],['execution-attempts',f.attempt.attemptId]])await expect(await get(other,`/api/v1/me/${kind}/${id}`),404);
  for(const [kind,id,action] of [['execution-runs',f.run.runId,'pause'],['model-connections',f.model.modelConnectionId,'revoke'],['execution-grants',f.grant.grantId,'revoke']])await expect(await post(other,`/api/v1/me/${kind}/${id}:${action}`,{}),404);
});
test('MEMBER-HTTP-04 missing cookie, CSRF, onboarding, expired/revoked sessions fail before domain writes',async()=>{
  const f=await fixture(),path='/api/v1/me/execution-runs',body={workId:f.work.workId};
  await expect(await post(f,path,body,{Cookie:''}),401);await expect(await post(f,path,body,{'X-CSRF-Token':''}),403);
  await owner.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[f.actor.user_id]);await expect(await post(f,path,body),403);
  await owner.query('UPDATE users SET onboarding_required=false WHERE user_id=$1',[f.actor.user_id]);
  await owner.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE token_hash=$1",[f.actor.session_hash]);await expect(await post(f,path,body),401);
  await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 hour',revoked_at=clock_timestamp() WHERE token_hash=$1",[f.actor.session_hash]);await expect(await post(f,path,body),401);
  assert.equal((await owner.query('SELECT count(*)::int n FROM execution_runs')).rows[0].n,0);
});
test('MEMBER-HTTP-05 strict primary CAS and body separation reject forged authority and alternate identity',async()=>{
  const f=await fixture(),path='/api/v1/me/execution-runs',body={workId:f.work.workId};
  const headers={...f.headers,'Content-Type':'application/json','Idempotency-Key':randomUUID()};
  await expect(await transport.request(origin+path,{method:'POST',headers,body:JSON.stringify(body)}),428);
  for(const value of ['1','W/"1"','"0"','"01"','"9223372036854775808"','"1", "2"','*'])await expect(await post(f,path,body,{'If-Match':value}),400);
  for(const extra of [{expectedWorkVersion:'1'},{actor:f.actor},{key:randomUUID()},{owner:f.actor.user_id},{modelReady:true},{operational_authority:true},{grantTtlSeconds:1}])await expect(await post(f,path,{...body,...extra}),400);
  await expect(await post(f,path,body,{'If-Match':'"2"'}),412);assert.equal((await owner.query('SELECT count(*)::int n FROM execution_runs')).rows[0].n,0);
});
test('MEMBER-HTTP-06 header/credential/method boundary rejects unsafe provenance and conditional reads',async()=>{
  const f=await chain(await fixture()),path=`/api/v1/me/execution-runs/${f.run.runId}`;
  const boundaryHeaders: Record<string,string>[] = [{Origin:'https://other.invalid'},{'Sec-Fetch-Site':'cross-site'},{Authorization:'Bearer synthetic'},{DPoP:'synthetic'},{'X-Freedom-Connection':randomUUID()},{'X-Freedom-Nonce':randomUUID()},{Host:'other.invalid'},{'If-None-Match':'"1"'},{Range:'bytes=0-1'},{'If-Match':'"1"'},{'Idempotency-Key':randomUUID()}];
  for(const h of boundaryHeaders)await expect(await get(f,path,h),['Origin','Sec-Fetch-Site','Authorization','DPoP','X-Freedom-Connection','X-Freedom-Nonce','Host'].some(k=>k in h)?403:400);
  for(const method of ['HEAD','OPTIONS','POST']) {const response=await expect(await transport.request(origin+path,{method,headers:f.headers}),405);assert.equal(response.headers.get('Allow'),'GET');}
  for(const suffix of ['?x=1','#fragment','%2f'])await expect(await get(f,path+suffix),403);
  await expect(await post(f,'/api/v1/me/execution-runs',{workId:f.work.workId},{Origin:''}),403);
});
test('MEMBER-HTTP-07 CAS revoke race has one winner and replay remains exact',async()=>{
  const f=await chain(await fixture()),path=`/api/v1/me/execution-grants/${f.grant.grantId}:revoke`,key=randomUUID();
  const results=await Promise.all([post(f,path,{}, {'Idempotency-Key':key}),post(f,path,{})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);
  const won=results[0].status===200;if(won)assert.equal((await expect(await post(f,path,{}, {'Idempotency-Key':key}),200,'2')).status,200);
  await expect(await post(f,`/api/v1/me/execution-runs/${f.run.runId}/attempts`,f.attemptBody,{'Idempotency-Key':f.attemptKey}),409);
});
test('MEMBER-HTTP-08 auth failure still commits bounded limiter charge independently',async()=>{
  const f=await member(),path=`/api/v1/me/execution-runs/${randomUUID()}`,network='single-synthetic-network';
  for(let i=0;i<60;i++)await expect(await get(f,path,{Cookie:'','X-Test-Network':network}),401);
  const blocked=await expect(await get(f,path,{'X-Test-Network':network}),429);assert.equal(blocked.headers.get('Retry-After'),'60');assert.equal((await blocked.json()).code,'member_execution_http_rate_limited');
  const attempts=(await owner.query('SELECT attempts FROM auth_rate_limits ORDER BY attempts')).rows.map(r=>r.attempts);assert.deepEqual(attempts,[60,61]);
});
test('MEMBER-HTTP-09 raw SQL and unknown service faults are sanitized with no authority or private hints',async()=>{
  const f=await fixture();await owner.query("CREATE FUNCTION fp_member_http_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_SQL_CREDENTIAL_HINT'; END $$");
  await owner.query('CREATE TRIGGER fp_member_http_fault BEFORE INSERT ON execution_runs FOR EACH ROW EXECUTE FUNCTION fp_member_http_fault()');
  try {const response=await expect(await post(f,'/api/v1/me/execution-runs',{workId:f.work.workId}),500);assert.equal((await response.json()).code,'internal_error');}
  finally {await owner.query('DROP TRIGGER fp_member_http_fault ON execution_runs');await owner.query('DROP FUNCTION fp_member_http_fault()');}
  assert.equal((await owner.query('SELECT count(*)::int n FROM execution_runs')).rows[0].n,0);
});
test('MEMBER-HTTP-10 trusted config snapshots reject getters/hooks and ignore later mutation',async()=>{
  let getter=0;const bad=Object.defineProperty({...options},'sourceNetwork',{enumerable:true,get(){getter++;return()=>'';}});
  await assert.rejects(createMemberExecutionHttpTransport(app,bad));assert.equal(getter,0);
  for(const extra of [{serviceHooks:{}},{grantTtlSeconds:0},{origin:origin+'/'},{sourceNetwork:5},{grantTtlSeconds:3601},{origin:'http://remote.invalid'},{origin:'http://localhost:1234',environment:'next'},{origin:'http://127.0.0.1',environment:'staging-next'}])await assert.rejects(createMemberExecutionHttpTransport(app,{...options,...extra} as typeof options));
  for(const local of ['http://localhost:1234','http://127.0.0.1','http://[::1]:1234'])await createMemberExecutionHttpTransport(app,{...options,origin:local});
  const config={...options},snapshot=await createMemberExecutionHttpTransport(app,config);config.origin='https://changed.invalid';config.clientId='changed';
  const f=await member();await expect(await snapshot.request(origin+`/api/v1/me/execution-runs/${randomUUID()}`,{headers:{Cookie:f.headers.Cookie}}),404);
});
