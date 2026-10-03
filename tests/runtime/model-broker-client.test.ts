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
const schema = `fp_broker_client_${process.pid}_${Date.now()}`, migrator = schema+'_owner', runtime = schema+'_app', brokerRole = schema+'_broker';
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

import { createModelBrokerClient, bindModelBrokerClient, type ModelBrokerClient, type ModelBrokerClientOptions } from '../../apps/platform-api/src/model-broker-client.js';
import { base64url } from 'jose';
const mainOrigin='http://127.0.0.1:4398';
async function clientOptions(exchange:ModelBrokerClientOptions['exchange'],recoverPort=recover) {
  const requestKeys=await generateKeyPair('EdDSA'),responseKeys=await generateKeyPair('EdDSA');
  const opts:ModelBrokerClientOptions={...options,origin:mainOrigin,issuer:authOptions.issuer,audience:authOptions.audience,
    requestKey:requestKeys.privateKey as CryptoKey,requestKid:'main-1',responseKeys:new Map([['broker-1',responseKeys.publicKey as CryptoKey]]),
    brokerIdentity:'synthetic-broker',responseAudience:'synthetic-main',recover:recoverPort,exchange};
  return {opts,requestKeys,responseKeys};
}
const claims=(request:bridge.ModelBrokerRequest)=>JSON.parse(new TextDecoder().decode(base64url.decode(request.assertion.split('.')[1])));
function responsePayload(request:bridge.ModelBrokerRequest,changes:Record<string,unknown>={}) {
  const requestClaims=claims(request),now=Date.now();
  return {profile:'model-broker.response/v1',issuer:'synthetic-broker',audience:'synthetic-main',purpose:'model-broker.response',
    environment:options.environment,clientId:options.clientId,authorizationRef:request.authorizationRef,nonce:request.nonce,
    commandDigest:requestClaims.commandDigest,recoveryGeneration:requestClaims.recoveryGeneration,issuedAt:new Date(now-1).toISOString(),expiresAt:new Date(now+5000).toISOString(),
    outcome:{kind:'problem',code:'model_step_result_unavailable'},operational_authority:false,...changes};
}
const signResponse=async(body:unknown,key:CryptoKey,header:Record<string,unknown>={})=>({response:await new CompactSign(new TextEncoder().encode(typeof body==='string'?body:JSON.stringify(body)))
  .setProtectedHeader({alg:'EdDSA',typ:'freedom-model-broker-response+jws',kid:'broker-1',...header}).sign(key)});
const brokerFault=(error:unknown)=>Boolean(error&&typeof error==='object'&&(error as {code?:string}).code==='model_broker_unavailable');

test('CLIENT-01 opaque binding and actual Ed25519 direction reuse reject wrong host/pool/environment and key substitution',async()=>{
  const f=await authorized(),keys=await clientOptions(async()=>{throw Error('unused');});
  await assert.rejects(createModelBrokerClient(app,{...keys.opts,responseKeys:new Map([['broker-1',keys.requestKeys.publicKey as CryptoKey]])}),brokerFault);
  let actual=0,mutated=0;const opts={...keys.opts,exchange:async(request:bridge.ModelBrokerRequest)=>{actual++;return signResponse(responsePayload(request),keys.requestKeys.privateKey as CryptoKey);}};
  const client=await createModelBrokerClient(app,opts);
  (opts.responseKeys as Map<string,CryptoKey>).set('broker-1',keys.requestKeys.publicKey as CryptoKey);
  opts.exchange=async()=>{mutated++;throw Error('mutated');};opts.issuer='other-main';
  for(const tuple of [[owner,mainOrigin,'local',options.clientId],[app,'http://127.0.0.1:4399','local',options.clientId],
    [app,mainOrigin,'next',options.clientId],[app,mainOrigin,'local','different']] as const)assert.throws(()=>bindModelBrokerClient(client,tuple[0],tuple[1],tuple[2],tuple[3]),brokerFault);
  assert.throws(()=>bindModelBrokerClient({} as ModelBrokerClient,app,mainOrigin,'local',options.clientId),brokerFault);
  await assert.rejects(bindModelBrokerClient(client,app,mainOrigin,'local',options.clientId).activate(f.actor,{...f.input.command.input,key:randomUUID()}),brokerFault);
  assert.equal(actual,1);assert.equal(mutated,0);
});
test('CLIENT-02 real signed responses with wrong binding, time or duplicate keys cannot become SQL metadata',async()=>{
  const f=await authorized(),keys=await clientOptions(async()=>{throw Error('unused');});
  for(const change of [{nonce:randomBytes(32).toString('base64url')},{commandDigest:'a'.repeat(64)},{recoveryGeneration:'2'},
    {authorizationRef:randomUUID()},{issuer:'other-broker'},{audience:'synthetic-broker'},{purpose:'model-broker.execute'},
    {issuedAt:new Date(Date.now()+60000).toISOString()},{expiresAt:new Date(Date.now()-1000).toISOString()},
    {issuedAt:new Date(Date.now()-1).toISOString(),expiresAt:new Date(Date.now()+10001).toISOString()}]) {
    const client=await createModelBrokerClient(app,{...keys.opts,exchange:request=>signResponse(responsePayload(request,change),keys.responseKeys.privateKey as CryptoKey)});
    await assert.rejects(bindModelBrokerClient(client,app,mainOrigin,'local',options.clientId).activate(f.actor,{...f.input.command.input,key:randomUUID()}),brokerFault);
  }
  const duplicate=await createModelBrokerClient(app,{...keys.opts,exchange:request=>{
    const body=JSON.stringify(responsePayload(request)).replace('"nonce":',`"nonce":"forged","nonce":`);return signResponse(body,keys.responseKeys.privateKey as CryptoKey);
  }});
  await assert.rejects(bindModelBrokerClient(duplicate,app,mainOrigin,'local',options.clientId).activate(f.actor,{...f.input.command.input,key:randomUUID()}),brokerFault);
  assert.equal((await owner.query('SELECT count(*)::int n FROM model_text_steps')).rows[0].n,0);
  assert.equal((await owner.query('SELECT count(*)::int n FROM private_model_work_results')).rows[0].n,0);
});
test('CLIENT-03 actual signed success-looking Step with no genuine SQL Step/Result cannot manufacture completion',async()=>{
  const f=await authorized(),keys=await clientOptions(async()=>{throw Error('unused');});
  const step={stepId:randomUUID(),attemptId:randomUUID(),attemptNumber:1,runId:f.run.runId,workId:f.work.workId,inputWorkVersion:'1',
    approvalId:f.approval.approvalId,state:'succeeded',aggregateVersion:'4',activatedRunVersion:'2',taskLeaseEpoch:'2',controlEpoch:'1',selection,
    evidenceOrigin:'synthetic_local_fixture',expiresAt:new Date(Date.now()+10000).toISOString(),usageStatus:'known',costStatus:'unknown',operational_authority:false};
  const client=await createModelBrokerClient(app,{...keys.opts,exchange:request=>signResponse(responsePayload(request,{outcome:{kind:'metadata',step}}),keys.responseKeys.privateKey as CryptoKey)});
  await assert.rejects(bindModelBrokerClient(client,app,mainOrigin,'local',options.clientId).activate(f.actor,{...f.input.command.input,key:randomUUID()}),brokerFault);
  assert.equal((await owner.query('SELECT result_id FROM private_work_result_targets WHERE work_item_id=$1',[f.work.workId])).rows[0]?.result_id??null,null);
  assert.equal((await owner.query('SELECT count(*)::int n FROM private_model_work_results')).rows[0].n,0);
});
test('CLIENT-04 actual 45 second main timeout prevents a new exchange after blocked predispatch recovery resolves',async()=>{
  const f=await authorized();let count=0,exchanges=0,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),blocked=new Promise<void>(r=>{entered=r;});
  const mainRecovery=async()=>{if(++count===4){entered();await gate;}return {generation:'1',expiresAt:new Date(Date.now()+120000).toISOString()};};
  const keys=await clientOptions(async()=>{exchanges++;throw Error('must not exchange after timeout');},mainRecovery);
  const module=process.env.MODEL_BROKER_CLIENT_COUNTERFACTUAL?await import(process.env.MODEL_BROKER_CLIENT_COUNTERFACTUAL):{createModelBrokerClient,bindModelBrokerClient};
  const client=await module.createModelBrokerClient(app,keys.opts);
  const started=performance.now(),pending=module.bindModelBrokerClient(client,app,mainOrigin,'local',options.clientId).activate(f.actor,{...f.input.command.input,key:randomUUID()});
  const rejected=assert.rejects(pending,brokerFault);
  try {
    await blocked;await rejected;assert(performance.now()-started>=45000,'real 45s timer must run');assert.equal(exchanges,0);
  } finally {release();await delay(100);}
  assert.equal(exchanges,0,'late predispatch recovery must not initiate a new broker exchange');
  assert.equal((await owner.query('SELECT count(*)::int n FROM model_text_steps')).rows[0].n,0);
});
