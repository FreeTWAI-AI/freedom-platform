import { createServer } from 'node:http';
import { createModelBrokerAuthorizations, type OpaqueModelBrokerInvocation } from '../../modules/agent-control/model-broker-authorizations.js';
import * as bridge from '../../contracts/execution/v2/model-broker-bridge.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createModelStepService } from '../../modules/agent-execution/model-step-service.js';
import { createUnavailableModelStepHost, createLocalFixtureModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { transaction } from '../../packages/db/transaction.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { login, authenticate, hashPassword } from '../../modules/identity-membership/service.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createCredentialVault, type CredentialVault } from '../../apps/credential-broker/src/vault.js';
import { createBrokerCredentialStore, getCredentialWriteBinding, type OpaqueCredentialWriteIntent } from '../../apps/credential-broker/src/store.js';
import { ModelStepBindingSchema } from '../../contracts/execution/v2/model-step.js';
import { ModelCredentialMetadataSchema } from '../../contracts/execution/v2/model-credential.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit disposable fp_* TEST_DATABASE_URL required.');
const schema = `fp_broker_auth_${process.pid}_${Date.now()}`, migrator = schema+'_owner', runtime = schema+'_app', brokerRole = schema+'_broker';
const admin = new Pool({ connectionString });
const roleUrl = (role: string) => { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); };
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const broker = new Pool({ connectionString: roleUrl(brokerRole), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const options = { environment: 'local' as const, clientId: 'credential-store-synthetic' };
const selection = { providerRef: 'openai', modelRef: 'synthetic-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset' as const, credentialCustody: 'platform_vault' as const, engineLocation: 'platform' as const, billingSource: 'user_byok' as const };
const enrollment = createRuntimeRegistrations(app,{ environment: options.environment });
const connections = createAgentConnections(app,options), prerequisites = createExecutionPrerequisites(app,options);
let generation = '1', recoveryExpiry: number | undefined, recoveryCalls = 0, unavailable = false, created = false;
const recover = async () => { recoveryCalls++; if (unavailable) throw new Error('synthetic-private-error');
  return { generation, expiresAt: new Date(recoveryExpiry ?? Date.now()+60_000).toISOString() }; };
let vault: CredentialVault, store: ReturnType<typeof createBrokerCredentialStore>;
const substitute = (sql: string) => sql.replaceAll('SCHEMA public',`SCHEMA ${schema}`).replaceAll("'public'",`'${schema}'`)
  .replaceAll(':"runtime"',`"${runtime}"`).replaceAll(":'runtime'",`'${runtime}'`)
  .replaceAll(':"broker"',`"${brokerRole}"`).replaceAll(":'broker'",`'${brokerRole}'`);
async function generated(q: PoolClient, sql: string) { for (const row of (await q.query(substitute(sql))).rows) await q.query(Object.values(row)[0] as string); }
async function grants() {
  const runtimeTemplate = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
  const brokerTemplate = await readFile(new URL('../../deploy/cloudflare/sql/40-credential-broker-grants.psql',import.meta.url),'utf8');
  const q = await owner.connect();
  try {
    await q.query(substitute(runtimeTemplate.slice(runtimeTemplate.indexOf('BEGIN;'),runtimeTemplate.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))));
    await generated(q,runtimeTemplate.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]);
    await generated(q,runtimeTemplate.split('-- BEGIN BROKER CREDENTIAL EXCLUSIONS\n')[1].split('\n\\gexec')[0]);
    await generated(q,runtimeTemplate.split('-- BEGIN MODEL BROKER AUTHORIZATION EXCLUSIONS\n')[1].split('\n\\gexec')[0]);
    await q.query('COMMIT');
    await q.query(substitute(brokerTemplate.slice(brokerTemplate.indexOf('BEGIN;'),brokerTemplate.indexOf('-- BEGIN BROKER COLUMN RESET'))));
    await generated(q,brokerTemplate.split('-- BEGIN BROKER COLUMN RESET\n')[1].split('\n\\gexec')[0]);
    await q.query(substitute(brokerTemplate.split('-- END BROKER COLUMN RESET\n')[1].split('-- BEGIN BROKER ROLE GUARD')[0]));
    await generated(q,brokerTemplate.split('-- BEGIN BROKER ROLE GUARD\n')[1].split('\n\\gexec')[0]);
    await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
}
before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${brokerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime},${brokerRole}`);
  created = true; await migrate(owner); await grants();
  await owner.query(`GRANT SELECT ON model_broker_authorizations,model_export_approvals,model_text_steps,execution_grants,execution_runs,work_items TO ${brokerRole}; GRANT UPDATE(accepted_at) ON model_broker_authorizations TO ${brokerRole}`);
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 },false,['encrypt','decrypt']);
  vault = createCredentialVault({ kek: { current: async()=>({ keyId:'synthetic-test-kek',key }), readById: async id=>id==='synthetic-test-kek'?key:null }, recover });
  store = createBrokerCredentialStore(broker,{...options,vault,recover});
});
after(async () => {
  await Promise.all([owner.end(),app.end(),broker.end()]);
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${brokerRole},${runtime},${migrator}`); } finally { await admin.end(); }
});
beforeEach(async()=>{ await owner.query('TRUNCATE communities CASCADE'); generation='1'; recoveryExpiry=undefined; unavailable=false; recoveryCalls=0; });
async function fixture() {
  const user = randomUUID(), community = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic broker owner')",[community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner',$5,$4) RETURNING *`,[user,community,user+'@example.invalid',randomUUID(),hashPassword('synthetic-member-password')])).rows[0];
  const signedIn=await login(app,row.email,'synthetic-member-password');
  const actor=await authenticate(app,signedIn.token);
  const context=await withMemberScope(app,{actor,scope:'personal'},async()=>{},async(_q,c)=>c);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit) VALUES($1,'work.private-draft',$2,1,true,10485760)`,[context.scope.scope_id,context.subject_principal.principal_id]);
  await withMemberScope(app,{actor,scope:'personal'},async()=>{},async()=>{});
  const key = await generateKeyPair('ES256',{extractable:true});
  const challenge = await enrollment.begin(actor,{key:randomUUID(),publicJwk:parseRuntimePublicJwk(await exportJWK(key.publicKey))});
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(key.privateKey);
  const device = await enrollment.confirm(actor,{key:randomUUID(),challengeId:challenge.challenge_id,proof});
  const connection = await connections.create(actor,{key:randomUUID(),runtimeDeviceId:device.runtimeDeviceId});
  await transaction(app,q=>insertInitialRefreshFamily(q,connection.connectionId,new Date(connection.issuedAt),new Date(connection.expiresAt)));
  const model = await prerequisites.models.create(actor,{key:randomUUID(),connectionId:connection.connectionId,expectedConnectionVersion:'1',selection});
  return {actor,model,connection,context};
}

const authOptions={...options,issuer:'synthetic-main',audience:'synthetic-broker',recover};
const issuer=createModelBrokerAuthorizations(app,authOptions), authority=createModelBrokerAuthorizations(broker,authOptions);
const works=createPrivateWorkCommands(app,{resolvePolicy:resolvePrivateWorkPersistencePolicy}),runs=createExecutionRuns(app);
const steps=createModelStepService(app,{...options,host:createUnavailableModelStepHost()});
async function authorized(ttlMs=60000) {
  const f=await fixture();
  const intent=await store.prepareCreate(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedModelVersion:'1',consent:true});
  const sealed=await vault.seal(getCredentialWriteBinding(intent),new TextEncoder().encode('synthetic-authorization-secret'));
  await store.commit(f.actor,intent,sealed);
  const work=await works.create(f.actor,{key:randomUUID(),title:'Synthetic title',objective:'Synthetic objective'});
  const run=await runs.create(f.actor,{key:randomUUID(),workId:work.workId,expectedWorkVersion:'1'});
  const grant=await prerequisites.grants.create(f.actor,{key:randomUUID(),runId:run.runId,expectedRunVersion:'1',expectedWorkVersion:'1',connectionId:f.connection.connectionId,expectedConnectionVersion:'1',modelConnectionId:f.model.modelConnectionId,expectedModelVersion:'1',consent:true});
  await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`,[randomUUID(),f.context.scope.scope_id,f.context.subject_principal.principal_id,options.environment,options.clientId,JSON.stringify(selection)]);
  const approval=await steps.approvals.create(f.actor,{key:randomUUID(),runId:run.runId,grantId:grant.grantId,expectedRunVersion:'1',expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20});
  recoveryExpiry=Date.now()+ttlMs;
  const input={operation:'activate' as const,command:{operation:'activate' as const,input:{key:randomUUID(),approvalId:approval.approvalId,expectedApprovalVersion:'1',expectedRunVersion:'1'}},nonce:randomBytes(32).toString('base64url')};
  const payload=await issuer.issue(f.actor,input);
  return {...f,approval,work,run,grant,input,payload};
}
test('AUTH-01 genuine logged-in session issues immutable exact SQL command; concurrent nonce accepts once',async()=>{
  const f=await authorized(),[a,b]=await Promise.all([authority.claim(f.payload),authority.claim(f.payload)]);
  assert.equal(Number(a.fresh)+Number(b.fresh),1);
  const data=authority.read(a.invocation);assert.equal(data.actor.session_hash,f.actor.session_hash);assert.deepEqual(data.command,f.input.command);
  assert.equal(data.modelConnectionId,f.model.modelConnectionId);assert.equal(data.credentialPin.expectedGeneration,'1');
  await transaction(broker,q=>authority.assertCurrent(q,a.invocation));
  await assert.rejects(broker.query('UPDATE model_broker_authorizations SET command_digest=$1',[randomBytes(32).toString('hex')]),(e:any)=>['23514','42501'].includes(e.code));
  await assert.rejects(app.query('SELECT envelope FROM broker_credential_vault'),(e:any)=>e.code==='42501');
  assert.throws(()=>authority.read({} as OpaqueModelBrokerInvocation));
  const other=createModelBrokerAuthorizations(broker,authOptions);assert.throws(()=>other.read(a.invocation));
});
test('AUTH-02 trusted-looking claims cannot alter original SQL nonce, digest, identity or command',async()=>{
  const f=await authorized();
  for(const extra of [{nonce:randomBytes(32).toString('base64url')},{commandDigest:randomBytes(32).toString('hex')},{environment:'next'},
    {issuer:'other'},{audience:'other'},{recoveryGeneration:'2'},{operation:'execute',purpose:'model-broker.execute'},{authorizationRef:randomUUID()},
    {actor:{user_id:f.actor.user_id}},{prompt:'forged'}])await assert.rejects(authority.claim({...f.payload,...extra} as any));
  assert.equal((await owner.query('SELECT accepted_at FROM model_broker_authorizations')).rows[0].accepted_at,null);
  assert.deepEqual(await issuer.issue(f.actor,{...f.input,nonce:randomBytes(32).toString('base64url')}),f.payload);
  await assert.rejects(issuer.issue(f.actor,{...f.input,command:{...f.input.command,input:{...f.input.command.input,expectedRunVersion:'2'}}}));
});
test('AUTH-03 original session withdrawal rejects captured guard and replay despite a new genuine session',async()=>{
  const f=await authorized(),accepted=await authority.claim(f.payload);
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
  await assert.rejects(transaction(broker,q=>authority.assertCurrent(q,accepted.invocation)));
  await assert.rejects(authority.claim(f.payload));
  const another=await login(app,f.actor.email,'synthetic-member-password'),actor=await authenticate(app,another.token);
  await assert.rejects(issuer.issue(actor,f.input));
});
test('AUTH-04 recovery floor movement and exact credential termination invalidate captured invocation',async()=>{
  const f=await authorized(),accepted=await authority.claim(f.payload);generation='2';
  await assert.rejects(transaction(broker,q=>authority.assertCurrent(q,accepted.invocation)));generation='1';
  const pin=authority.read(accepted.invocation).credentialPin;
  await store.revoke(f.actor,{key:randomUUID(),credentialId:pin.credentialId,expectedVersion:'1'});
  await assert.rejects(transaction(broker,q=>authority.assertCurrent(q,accepted.invocation)));
  await assert.rejects(authority.claim(f.payload));
});
test('AUTH-05 exclusive SQL and post-await expiry prevent nonce acceptance and metadata replay',async()=>{
  const f=await authorized(300),accepted=await authority.claim(f.payload);await delay(350);
  await assert.rejects(authority.claim(f.payload));await assert.rejects(transaction(broker,q=>authority.assertCurrent(q,accepted.invocation)));
});
test('AUTH-06 strict reference contracts reject Actor, session hash, proof, prompt, credentials and protected-header JWK',()=>{
  const request={authorizationRef:randomUUID(),nonce:randomBytes(32).toString('base64url'),assertion:'e30.e30.c2ln'};
  for(const key of ['actor','session_hash','cookie','prompt','context','proof','credential','providerUrl'])assert.equal(bridge.ModelBrokerRequestSchema.safeParse({...request,[key]:'forged'}).success,false);
  assert.equal(bridge.ModelBrokerProtectedHeaderSchema.safeParse({alg:'EdDSA',typ:'freedom-model-broker-assertion+jws',kid:'test',jwk:{}}).success,false);
  assert.equal(bridge.ModelBrokerCommandSchema.safeParse({operation:'execute',input:{key:randomUUID(),stepId:randomUUID(),expectedVersion:'1',expectedApprovalVersion:'1'}}).success,false);
});

test('AUTH-07 actual blocked SQL delivery across exclusive expiry rejects acceptance and leaves nonce unspent',async()=>{
  const f=await authorized(800),q=await owner.connect();let pending:Promise<unknown>|undefined;
  try {
    await q.query('BEGIN');await q.query('LOCK TABLE broker_model_credentials IN ACCESS EXCLUSIVE MODE');
    const pid=(await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending=authority.claim(f.payload);const rejected=assert.rejects(pending);
    let observed=false;
    for(let i=0;i<100;i++) {if((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n){observed=true;break;}await delay(10);}
    assert(observed,'actual SQL wait must be observed');await delay(850);await q.query('COMMIT');await rejected;
    assert.equal((await owner.query('SELECT accepted_at FROM model_broker_authorizations WHERE authorization_id=$1',[f.payload.authorizationRef])).rows[0].accepted_at,null);
  } finally {await q.query('ROLLBACK');q.release();if(pending)await pending.catch(()=>{});}
});

test('AUTH-08 exact execute CAS is required at claim but captured authority survives legitimate domain version advances',async()=>{
  const f=await authorized(),activatedAuth=await authority.claim(f.payload);
  const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');assert.equal(req.method,'GET');res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic-fixture'}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address();assert(address&&typeof address==='object');
    const resolver=await store.createResolver(f.actor,authority.read(activatedAuth.invocation).credentialPin);
    const host=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,recover,resolveCredential:resolver});
    const actualSteps=createModelStepService(app,{...options,host});
    const step=await actualSteps.activate(f.actor,f.input.command.input,q=>authority.assertCurrent(q,activatedAuth.invocation));
    assert.deepEqual(await issuer.issue(f.actor,{...f.input,nonce:randomBytes(32).toString('base64url')}),f.payload);
    await transaction(broker,q=>authority.assertCurrent(q,activatedAuth.invocation));
    const command={operation:'execute' as const,input:{key:randomUUID(),stepId:step.stepId,expectedVersion:'1'}};
    const payload=await issuer.issue(f.actor,{operation:'execute',command,nonce:randomBytes(32).toString('base64url')});
    const claimed=await authority.claim(payload);assert(claimed.fresh);
    const begun=await actualSteps.begin(f.actor,command.input,q=>authority.assertCurrent(q,claimed.invocation));assert(begun.capability);assert.equal(begun.metadata.aggregateVersion,'2');
    await transaction(broker,q=>authority.assertCurrent(q,claimed.invocation));
    const retry=await issuer.issue(f.actor,{operation:'execute',command,nonce:randomBytes(32).toString('base64url')});
    assert.deepEqual(retry,payload);assert.equal((await authority.claim(retry)).fresh,false);
    await assert.rejects(issuer.issue(f.actor,{operation:'execute',command:{...command,input:{...command.input,key:randomUUID()}},nonce:randomBytes(32).toString('base64url')}));
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('AUTH-09 real runtime grant template clears old authorization column privileges and rejects PUBLIC bypass',async()=>{
  const template=await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
  const sql=template.split('-- BEGIN MODEL BROKER AUTHORIZATION EXCLUSIONS\n')[1].split('\n\\gexec')[0];
  await owner.query(`GRANT UPDATE(accepted_at) ON model_broker_authorizations TO ${runtime}`);
  await transaction(owner,q=>generated(q,sql));
  assert.equal((await owner.query("SELECT has_column_privilege($1,'model_broker_authorizations','accepted_at','UPDATE') allowed",[runtime])).rows[0].allowed,false);
  await assert.rejects(app.query("UPDATE model_broker_authorizations SET accepted_at=clock_timestamp()"),(e:any)=>e.code==='42501');
  await assert.rejects(app.query('DELETE FROM model_broker_authorizations'),(e:any)=>e.code==='42501');
  await owner.query('GRANT UPDATE(accepted_at) ON model_broker_authorizations TO PUBLIC');
  try {await assert.rejects(transaction(owner,q=>generated(q,sql)),/Unsafe runtime model broker authorization privileges/);}
  finally {await owner.query('REVOKE UPDATE(accepted_at) ON model_broker_authorizations FROM PUBLIC');}
});
