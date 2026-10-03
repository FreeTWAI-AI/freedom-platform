import { createServer } from 'node:http';
import { createCredentialIngestAuthorizations } from '../../modules/agent-control/credential-ingest-authorizations.js';
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
import { createBrokerCredentialStore, getCredentialWriteBinding, getCredentialWriteIntentMetadata, type OpaqueCredentialWriteIntent } from '../../apps/credential-broker/src/store.js';
import { ModelStepBindingSchema } from '../../contracts/execution/v2/model-step.js';
import { ModelCredentialMetadataSchema } from '../../contracts/execution/v2/model-credential.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit disposable fp_* TEST_DATABASE_URL required.');
const schema = `fp_ingest_auth_${process.pid}_${Date.now()}`, migrator = schema+'_owner', runtime = schema+'_app', brokerRole = schema+'_broker';
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


const ingestOptions={...options,issuer:'synthetic-ingest-main',audience:'synthetic-ingest-broker',setupOrigin:'https://broker.example.invalid',recover};
const issuer=createCredentialIngestAuthorizations(app,ingestOptions),authority=createCredentialIngestAuthorizations(broker,ingestOptions);
const nonce=()=>randomBytes(32).toString('base64url'),tokenHash=()=>randomBytes(32).toString('hex');
async function authorized(ttlMs=60000){const f=await fixture();recoveryExpiry=Date.now()+ttlMs;
 const command={operation:'create' as const,input:{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedModelVersion:'1',consent:true as const}};
 const claims=await issuer.issue(f.actor,{command,nonce:nonce()});return {...f,command,claims,cookieHash:tokenHash(),csrfHash:tokenHash()};}
async function prepared(f:Awaited<ReturnType<typeof authorized>>){const invocation=await authority.claimBootstrap(f.claims,{cookieHash:f.cookieHash,csrfHash:f.csrfHash});
 const intent=await store.prepareCreate(f.actor,f.command.input,q=>authority.assertCurrent(q,invocation));
 const {binding,expiresAt}=getCredentialWriteIntentMetadata(intent);
 await authority.claimSubmission(invocation,{binding,writeExpiresAt:new Date(Math.min(Date.parse(expiresAt),Date.parse(f.claims.expiresAt))).toISOString(),cookieHash:f.cookieHash,csrfHash:f.csrfHash});
 return {invocation,intent,binding};}
test('INGEST-AUTH-01 genuine original SQL member create has distinct one-use setup and submission transitions',async()=>{
 const f=await authorized();const outcomes=await Promise.allSettled([authority.claimBootstrap(f.claims,{cookieHash:f.cookieHash,csrfHash:f.csrfHash}),authority.claimBootstrap(f.claims,{cookieHash:f.cookieHash,csrfHash:f.csrfHash})]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);const good=outcomes.find(r=>r.status==='fulfilled');assert(good&&good.status==='fulfilled');
 const invocation=good.value,data=authority.read(invocation);assert.equal(data.actor.session_hash,f.actor.session_hash);assert.deepEqual(data.command,f.command);assert.equal(data.model.modelConnectionId,f.model.modelConnectionId);
 assert.throws(()=>authority.read({} as any));assert.throws(()=>createCredentialIngestAuthorizations(broker,ingestOptions).read(invocation));
 const intent=await store.prepareCreate(f.actor,f.command.input,q=>authority.assertCurrent(q,invocation)),meta=getCredentialWriteIntentMetadata(intent);
 assert.equal(Date.parse(meta.expiresAt)-Date.parse(meta.binding.issuedAt),30000);assert(Object.isFrozen(meta));
 const submit={binding:meta.binding,writeExpiresAt:meta.expiresAt,cookieHash:f.cookieHash,csrfHash:f.csrfHash};
 const submissions=await Promise.allSettled([authority.claimSubmission(invocation,submit),authority.claimSubmission(invocation,submit)]);assert.equal(submissions.filter(r=>r.status==='fulfilled').length,1);
 const sealed=await vault.seal(meta.binding,new TextEncoder().encode('synthetic-ingest-direct-key'));
 const result=await store.commit(f.actor,intent,sealed,q=>authority.assertCurrent(q,invocation));assert.equal(result.state,'active');assert.equal(result.operational_authority,false);
 assert.equal((await owner.query('SELECT state FROM model_connections WHERE model_connection_id=$1',[f.model.modelConnectionId])).rows[0].state,'unverified');
 const outcome=await issuer.readOwnerOutcome(f.actor,f.claims.authorizationRef);assert.equal(outcome.state,'committed');assert.equal(outcome.credential?.credentialId,result.credentialId);
 assert.deepEqual(await issuer.issue(f.actor,{command:f.command,nonce:nonce()}),f.claims);
 unavailable=true;assert.equal((await issuer.readOwnerOutcome(f.actor,f.claims.authorizationRef)).state,'committed');
});
test('INGEST-AUTH-02 strict typed nonce/purpose/current SQL binding rejects mutation before any intent',async()=>{
 const f=await authorized();for(const extra of [{purpose:'model-broker.activate'},{issuer:'other'},{audience:'other'},{setupOrigin:'https://other.example.invalid'},
  {nonce:nonce()},{recoveryGeneration:'2'},{commandDigest:tokenHash()},{actor:{user_id:f.actor.user_id}},{secret:'synthetic-key'}])await assert.rejects(authority.claimBootstrap({...f.claims,...extra} as any,{cookieHash:f.cookieHash,csrfHash:f.csrfHash}));
 assert.equal((await owner.query('SELECT bootstrap_claimed_at FROM credential_ingest_authorizations')).rows[0].bootstrap_claimed_at,null);
 assert.deepEqual(await issuer.issue(f.actor,{command:f.command,nonce:nonce()}),f.claims);
 await assert.rejects(issuer.issue(f.actor,{command:{...f.command,input:{...f.command.input,expectedModelVersion:'2'}},nonce:nonce()}));
 assert.throws(()=>getCredentialWriteIntentMetadata({} as any));await assert.rejects(store.prepareCreate(f.actor,f.command.input,{} as any));
});
test('INGEST-AUTH-03 revoked original session and advanced external recovery cannot be replaced by another genuine session',async()=>{
 const f=await authorized(),invocation=await authority.claimBootstrap(f.claims,{cookieHash:f.cookieHash,csrfHash:f.csrfHash});generation='2';
 await assert.rejects(transaction(broker,q=>authority.assertCurrent(q,invocation)));generation='1';
 await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
 await assert.rejects(store.prepareCreate(f.actor,f.command.input,q=>authority.assertCurrent(q,invocation)));
 const signed=await login(app,f.actor.email,'synthetic-member-password'),another=await authenticate(app,signed.token);
 await assert.rejects(issuer.issue(another,{command:f.command,nonce:nonce()}));
 assert.equal((await issuer.readOwnerOutcome(another,f.claims.authorizationRef)).state,'setup_claimed');
});
test('INGEST-AUTH-04 genuine same-byte rotation commits only this replacement and preserves final original-session guard',async()=>{
 const f=await authorized(),p=await prepared(f),bytes=new TextEncoder().encode('same-synthetic-ingest-key');
 const old=await store.commit(f.actor,p.intent,await vault.seal(p.binding,bytes),q=>authority.assertCurrent(q,p.invocation));
 const replacement=await prerequisites.models.create(f.actor,{key:randomUUID(),connectionId:f.connection.connectionId,expectedConnectionVersion:'1',selection});
 const command={operation:'rotate' as const,input:{key:randomUUID(),credentialId:old.credentialId,expectedVersion:'1',replacementModelConnectionId:replacement.modelConnectionId,expectedReplacementModelVersion:'1',consent:true as const}};
 const claims=await issuer.issue(f.actor,{command,nonce:nonce()}),cookieHash=tokenHash(),csrfHash=tokenHash();
 const invocation=await authority.claimBootstrap(claims,{cookieHash,csrfHash});const intent=await store.prepareRotate(f.actor,command.input,q=>authority.assertCurrent(q,invocation));const meta=getCredentialWriteIntentMetadata(intent);
 await authority.claimSubmission(invocation,{binding:meta.binding,writeExpiresAt:meta.expiresAt,cookieHash,csrfHash});
 const fresh=await store.commit(f.actor,intent,await vault.seal(meta.binding,bytes),q=>authority.assertCurrent(q,invocation));assert.equal(fresh.generation,'2');assert.notEqual(fresh.credentialId,old.credentialId);
 await transaction(broker,q=>authority.assertCurrent(q,invocation));assert.deepEqual(await issuer.issue(f.actor,{command,nonce:nonce()}),claims);
 const history=await store.read(f.actor,{credentialId:old.credentialId});assert.equal(history.state,'rotated');assert.equal(history.replacementCredentialId,fresh.credentialId);
 assert.equal((await issuer.readOwnerOutcome(f.actor,claims.authorizationRef)).credential?.credentialId,fresh.credentialId);bytes.fill(0);
});
