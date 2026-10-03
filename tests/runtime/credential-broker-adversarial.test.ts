import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile,writeFile,mkdtemp,rm,link } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPrivateModelResultService} from '../../modules/agent-execution/model-results.js';
import {createPrivateResultService} from '../../modules/autopilot-work/results.js';
import {assertObjectKey,validateRange,type ObjectStore,type ObjectMetadata} from '../../packages/asset-storage/index.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { transaction } from '../../packages/db/transaction.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import type { CreateExecutionGrantInput, ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import { createServer } from 'node:http';
import { createModelStepService } from '../../modules/agent-execution/model-step-service.js';
import { createLocalFixtureModelStepHost, createUnavailableModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_credential_adv_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`, brokerRole = `${schema}_broker`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const broker = new Pool({ connectionString: roleUrl(brokerRole), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const options = { environment: 'local' as const, clientId: 'credential-broker-independent-review' };
const api = createExecutionPrerequisites(app, options), runs = createExecutionRuns(app);
const works = createPrivateWorkCommands(app, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
const enrollment = createRuntimeRegistrations(app, { environment: options.environment }), connections = createAgentConnections(app, options);
const selection: ModelSelection = { providerRef: 'openai', modelRef: 'synthetic-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset', credentialCustody: 'platform_vault', engineLocation: 'platform', billingSource: 'user_byok' };
let created = false;
before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${brokerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime},${brokerRole}`);
  created = true; await migrate(owner);
  await applyRuntimeGrants(); await applyBrokerGrants();
});
after(async () => { await broker.end();await app.end();await owner.end();try {
  if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${brokerRole},${migrator}`);
}finally{await admin.end();} });
const status = (...values:number[]) => (error:unknown) => values.includes((error as {status?:number})?.status??0);
const sqlCode = (...values: string[]) => (error: unknown) => values.includes((error as { code?: string }).code ?? '');
async function count(table: string) { return (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n; }
const tracked = ['model_connections','execution_grants','execution_attempts','scoped_transition_journal','scoped_outbox','scoped_command_receipts'];
const counts = () => Promise.all(tracked.map(count));
async function member() {
  const user = randomUUID(), session = randomUUID(), community=randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic credential review')",[community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q,c) => c);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,true,10485760)`, [context.scope.scope_id, context.subject_principal.principal_id]);
  return { actor, context };
}
async function fixture() {
  const f = await member(), pair = await generateKeyPair('ES256', { extractable: true });
  const challenge = await enrollment.begin(f.actor, { key: randomUUID(), publicJwk: parseRuntimePublicJwk(await exportJWK(pair.publicKey)) });
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(pair.privateKey);
  const device = await enrollment.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof });
  const connection = await connections.create(f.actor, { key: randomUUID(), runtimeDeviceId: device.runtimeDeviceId });
  // Real 091 initial family/head built through its server composition helper.
  // No model evidence or machine execution credentials are fabricated.
  const family = await transaction(app, q => insertInitialRefreshFamily(q, connection.connectionId, new Date(connection.issuedAt), new Date(connection.expiresAt)));
  const work = await works.create(f.actor, { key: randomUUID(), title: 'Synthetic private goal', objective: 'PRIVATE_BODY_NOT_IN_PREREQUISITES' });
  const run = await runs.create(f.actor, { key: randomUUID(), workId: work.workId, expectedWorkVersion: '1' });
  const modelInput = { key: randomUUID(), connectionId: connection.connectionId, expectedConnectionVersion: '1', selection };
  const model = await api.models.create(f.actor, modelInput);
  const grantInput: CreateExecutionGrantInput = { key: randomUUID(), runId: run.runId, expectedRunVersion: '1', expectedWorkVersion: '1',
    connectionId: connection.connectionId, expectedConnectionVersion: '1', modelConnectionId: model.modelConnectionId, expectedModelVersion: '1', consent: true };
  return { ...f, device, connection, family, work, run, model, modelInput, grantInput };
}

import {base64url} from 'jose';
import {createCredentialVault,CredentialVaultError} from '../../apps/credential-broker/src/vault.js';
import {createSignedRecoverySource,CredentialRecoveryError} from '../../apps/credential-broker/src/recovery.js';
import {BrokerCredentialEnvelopeSchema,ModelCredentialBindingSchema,type ModelCredentialBinding} from '../../contracts/execution/v2/model-credential.js';
const secretText='SYNTHETIC_PRIVATE_CREDENTIAL_REVIEW';
const bytes=()=>new TextEncoder().encode(secretText);
const iso=(ms:number)=>new Date(ms).toISOString();
const barrier=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};};
const vaultFault=(error:unknown)=>error instanceof CredentialVaultError&&error.message==='credential_vault_unavailable'&&!error.message.includes(secretText);
const recoveryFault=(error:unknown)=>error instanceof CredentialRecoveryError&&error.message==='credential_recovery_unavailable';
function cryptoBinding(now=Date.now()):ModelCredentialBinding {
 return ModelCredentialBindingSchema.parse({profile:'model-credential.binding/v1',credentialId:randomUUID(),generation:'1',modelConnectionId:randomUUID(),modelVersion:'1',ownerUserId:randomUUID(),ownerPrincipalId:randomUUID(),scopeId:randomUUID(),environment:'local',clientId:'independent-broker-review',runtimeDeviceId:randomUUID(),connectionId:randomUUID(),familyId:randomUUID(),selection:{providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'},recoveryGeneration:'1',issuedAt:iso(now),expiresAt:iso(now+60000)});
}
async function cryptoFixture(){
 const state={now:Date.now(),generation:'1',missing:false,keyId:'synthetic-kek-1'};
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const other=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const kek={current:async()=>({keyId:state.keyId,key}),readById:async(id:string)=>state.missing?null:id==='synthetic-kek-1'?key:id==='synthetic-kek-2'?other:null};
 const recover=async()=>({generation:state.generation,expiresAt:iso(state.now+120000)});
 const vault=createCredentialVault({kek,recover,now:()=>state.now}),binding=cryptoBinding(state.now);
 return {state,key,other,kek,recover,vault,binding};
}
const flip=(value:string)=>{const raw=base64url.decode(value);raw[0]^=1;return base64url.encode(raw);};

test('BROKER-ADV real AES-GCM wraps independently randomized DEKs and binds every ownership/custody/version field',async()=>{
 const f=await cryptoFixture(),handle=await f.vault.seal(f.binding,bytes()),envelope=f.vault.readSealedCredential(handle,f.binding);
 const plain=await f.vault.open(f.binding,envelope);try{assert.equal(new TextDecoder().decode(plain),secretText);}finally{plain.fill(0);}
 const second=await f.vault.seal(f.binding,bytes()),otherEnvelope=f.vault.readSealedCredential(second,f.binding);assert.notEqual(envelope.nonce,otherEnvelope.nonce);assert.notEqual(envelope.wrapNonce,otherEnvelope.wrapNonce);assert.notEqual(envelope.wrappedDek,otherEnvelope.wrappedDek);assert.ok(!JSON.stringify(envelope).includes(secretText));
 for(const field of ['credentialId','modelConnectionId','ownerUserId','ownerPrincipalId','scopeId','runtimeDeviceId','connectionId','familyId'] as const)
  await assert.rejects(f.vault.open({...f.binding,[field]:randomUUID()},envelope),vaultFault);
 for(const changed of [{generation:'2'},{modelVersion:'2'},{environment:'staging-next' as const},{clientId:'other-review'},{issuedAt:iso(f.state.now-1)},{expiresAt:iso(f.state.now+59999)},
  {selection:{...f.binding.selection,providerRef:'anthropic' as const}},{selection:{...f.binding.selection,modelRef:'different-synthetic-model'}}])
  await assert.rejects(f.vault.open({...f.binding,...changed},envelope),vaultFault);
 for(const field of ['nonce','wrapNonce','ciphertext','wrappedDek'] as const)await assert.rejects(f.vault.open(f.binding,{...envelope,[field]:flip(envelope[field])}),vaultFault);
 await assert.rejects(f.vault.open(f.binding,{...envelope,keyId:'synthetic-kek-2'}),vaultFault);
 await assert.rejects(f.vault.open(f.binding,{...envelope,ciphertext:otherEnvelope.ciphertext}),vaultFault);
 await assert.rejects(f.vault.open(f.binding,{...envelope,wrappedDek:otherEnvelope.wrappedDek}),vaultFault);
});

test('BROKER-ADV parsed/copied encrypted DTOs cannot mint opaque sealed provenance and missing key/recovery has no fallback',async()=>{
 const f=await cryptoFixture(),h=await f.vault.seal(f.binding,bytes()),e=f.vault.readSealedCredential(h,f.binding),other=await cryptoFixture();
 for(const fake of [{},{...h},BrokerCredentialEnvelopeSchema.parse(e),JSON.parse(JSON.stringify(e))])assert.throws(()=>f.vault.readSealedCredential(fake as never,f.binding),vaultFault);
 assert.throws(()=>other.vault.readSealedCredential(h,f.binding),vaultFault);
 assert.throws(()=>f.vault.readSealedCredential(h,{...f.binding,generation:'2'}),vaultFault);
 f.state.missing=true;await assert.rejects(f.vault.open(f.binding,e),vaultFault);f.state.missing=false;
 f.state.generation='2';await assert.rejects(f.vault.open(f.binding,e),vaultFault);
 // An old, otherwise authentic ciphertext is denied even by a fresh vault,
 // independently of an in-process prior-generation memo.
 const restored=createCredentialVault({kek:f.kek,recover:f.recover,now:()=>f.state.now});await assert.rejects(restored.open(f.binding,e),vaultFault);
 assert.throws(()=>createCredentialVault({} as never),vaultFault);
 const noKey=createCredentialVault({kek:{current:async()=>({keyId:'synthetic',key:null as never}),readById:async()=>null},recover:f.recover});await assert.rejects(noKey.seal(f.binding,bytes()),vaultFault);
});

test('BROKER-ADV credential expiry and recovery advance during a real crypto key await reject returned plaintext',async()=>{
 for(const kind of ['expiry','recovery','key'] as const){
  const f=await cryptoFixture(),h=await f.vault.seal(f.binding,bytes()),e=f.vault.readSealedCredential(h,f.binding),entered=barrier(),release=barrier();
  let reads=0;const vault=createCredentialVault({kek:{current:f.kek.current,readById:async()=>{reads++;if(reads===1){entered.release();await release.promise;}return kind==='key'&&reads>1?f.other:f.key;}},recover:f.recover,now:()=>f.state.now});
  const pending=vault.open(f.binding,e);await entered.promise;
  if(kind==='expiry')f.state.now+=60001;if(kind==='recovery')f.state.generation='2';release.release();await assert.rejects(pending,vaultFault);
 }
 const f=await cryptoFixture(),entered=barrier(),release=barrier();
 const vault=createCredentialVault({kek:{...f.kek,current:async()=>{entered.release();await release.promise;return {keyId:f.state.keyId,key:f.key};}},recover:f.recover,now:()=>f.state.now});
 const original=bytes(),pending=vault.seal(f.binding,original);await entered.promise;original.fill(65);release.release();const h=await pending,plain=await vault.open(f.binding,vault.readSealedCredential(h,f.binding));try{assert.equal(new TextDecoder().decode(plain),secretText);}finally{plain.fill(0);}
});

async function recoveryFixture(){
 const pair=await crypto.subtle.generateKey('Ed25519',false,['sign','verify']) as CryptoKeyPair;
 const state={now:Date.now(),generation:'1',floor:'1',raw:'',floorExpires:0};state.floorExpires=state.now+90000;
 const claims=(extra:Record<string,unknown>={})=>({profile:'credential-broker.recovery/v1',purpose:'credential-broker.recovery',authority:'synthetic-recovery-authority',environment:'local',generation:state.generation,issuedAt:iso(state.now),expiresAt:iso(state.now+60000),...extra});
 const sign=(body:unknown,header:Record<string,unknown>={})=>new CompactSign(new TextEncoder().encode(typeof body==='string'?body:JSON.stringify(body))).setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-recovery+jws',kid:'synthetic-signing-1',...header} as never).sign(pair.privateKey);
 const readSignedState=async()=>state.raw,readMonotonicFloor=async()=>({generation:state.floor,expiresAt:iso(state.floorExpires)});
 const options={readSignedState,readMonotonicFloor,pinnedKeys:[{keyId:'synthetic-signing-1',key:pair.publicKey}],authority:'synthetic-recovery-authority',environment:'local' as const,now:()=>state.now};
 state.raw=await sign(claims());return {state,pair,claims,sign,options,source:createSignedRecoverySource(options)};
}

test('BROKER-ADV actual Ed25519 signed recovery rejects restored generations with a fresh verifier and separate floor',async()=>{
 const f=await recoveryFixture(),old=f.state.raw;assert.equal((await f.source.recover()).generation,'1');
 f.state.generation='2';f.state.floor='2';f.state.raw=await f.sign(f.claims());assert.equal((await f.source.recover()).generation,'2');
 f.state.raw=old;await assert.rejects(f.source.recover(),recoveryFault);await assert.rejects(createSignedRecoverySource(f.options).recover(),recoveryFault);
 f.state.floor='1';await assert.rejects(f.source.recover(),recoveryFault);
});

test('BROKER-ADV signed recovery pins kid/authority/environment, precise times, strict JSON and an independently live floor',async()=>{
 const f=await recoveryFixture();
 for(const changes of [{authority:'wrong-authority'},{environment:'staging-next' as const},{generation:'0'},{generation:'01'},{generation:'9223372036854775808'},
  {issuedAt:iso(f.state.now+1)},{expiresAt:iso(f.state.now)},{expiresAt:iso(f.state.now+300001)},{purpose:'other'},{operational_authority:true}]){
  f.state.raw=await f.sign(f.claims(changes));await assert.rejects(createSignedRecoverySource(f.options).recover(),recoveryFault);
 }
 f.state.raw=await f.sign(f.claims(),{kid:'wrong-key'});await assert.rejects(f.source.recover(),recoveryFault);
 f.state.raw=await f.sign(f.claims(),{jwk:await crypto.subtle.exportKey('jwk',f.pair.publicKey)});await assert.rejects(f.source.recover(),recoveryFault);
 f.state.raw=await f.sign(JSON.stringify(f.claims()).replace('"generation":"1"','"generation":"1","\\u0067eneration":"1"'));await assert.rejects(f.source.recover(),recoveryFault);
 f.state.raw=await f.sign(f.claims());const segments=f.state.raw.split('.');segments[2]=flip(segments[2]);f.state.raw=segments.join('.');await assert.rejects(f.source.recover(),recoveryFault);
 f.state.raw=await f.sign(f.claims());f.state.floorExpires=f.state.now;await assert.rejects(f.source.recover(),recoveryFault);f.state.floorExpires=f.state.now+90000;
 f.state.floor='2';await assert.rejects(f.source.recover(),recoveryFault);
});

test('BROKER-ADV external floor changing during signed-state await rejects an otherwise valid old signed observation',async()=>{
 const f=await recoveryFixture(),entered=barrier(),release=barrier();
 const source=createSignedRecoverySource({...f.options,readSignedState:async()=>{entered.release();await release.promise;return f.state.raw;}});
 const pending=source.recover();await entered.promise;f.state.floor='2';release.release();await assert.rejects(pending,recoveryFault);
});

import {createBrokerCredentialStore,getCredentialWriteBinding} from '../../apps/credential-broker/src/store.js';
import {ModelStepBindingSchema,type ModelStepBinding} from '../../contracts/execution/v2/model-step.js';
import type {CredentialVault} from '../../apps/credential-broker/src/vault.js';
async function applyTemplate(file:string,role:string,name:string){
 const template=(await readFile(new URL('../../deploy/cloudflare/sql/'+file,import.meta.url),'utf8')).replace(/^\\set .*$/mg,'')
  .replaceAll('SCHEMA public','SCHEMA '+schema).replaceAll("n.nspname='public'","n.nspname='"+schema+"'")
  .replaceAll("'public','CREATE'","'"+schema+"','CREATE'").replaceAll(':"'+name+'"','"'+role+'"').replaceAll(":'"+name+"'","'"+role+"'");
 const q=await owner.connect();try{const pieces=template.split('\\gexec');for(let i=0;i<pieces.length;i++){
  const result=await q.query(pieces[i]);if(i<pieces.length-1){const last=Array.isArray(result)?result[result.length-1]:result;for(const row of last.rows)await q.query(Object.values(row)[0] as string);}
 }}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
}
const applyRuntimeGrants=()=>applyTemplate('20-runtime-grants.psql',runtime,'runtime');
const applyBrokerGrants=()=>applyTemplate('40-credential-broker-grants.psql',brokerRole,'broker');
async function storeFixture(ttl=60,wrap?:(v:CredentialVault)=>CredentialVault){
 const f=await fixture(),rf=await recoveryFixture(),k=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const vault=createCredentialVault({kek:{current:async()=>({keyId:'synthetic-sql-kek',key:k}),readById:async(id)=>id==='synthetic-sql-kek'?k:null},recover:rf.source.recover});
 const store=createBrokerCredentialStore(broker,{...options,vault:wrap?wrap(vault):vault,recover:rf.source.recover,credentialTtlSeconds:ttl});
 const input={key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedModelVersion:'1',consent:true as const};
 const intent=await store.prepareCreate(f.actor,input),binding=getCredentialWriteBinding(intent),sealed=await vault.seal(binding,bytes());
 const credential=await store.commit(f.actor,intent,sealed);return {...f,rf,vault,store,input,intent,binding,sealed,credential};
}
// Typed data only. This helper exercises custody matching; it never claims a
// Step capability or operational provider authorization. The final HTTP test
// separately obtains an actual private host capability through the real service.
function custodyStep(f:Awaited<ReturnType<typeof storeFixture>>):ModelStepBinding{
 const b=f.binding;return ModelStepBindingSchema.parse({profile:'model-step.binding/v1',stepId:randomUUID(),attemptId:randomUUID(),intentId:randomUUID(),approvalId:randomUUID(),approvalVersion:'1',runId:f.run.runId,workId:f.work.workId,inputWorkVersion:'1',baseRunVersion:'1',runVersion:'2',baseTaskLeaseEpoch:'1',taskLeaseEpoch:'2',controlEpoch:'1',ownerUserId:b.ownerUserId,ownerPrincipalId:b.ownerPrincipalId,scopeId:b.scopeId,environment:b.environment,clientId:b.clientId,runtimeDeviceId:b.runtimeDeviceId,runtimeVersion:'1',connectionId:b.connectionId,connectionVersion:'1',familyId:b.familyId,modelConnectionId:b.modelConnectionId,modelVersion:b.modelVersion,selection:b.selection,grantId:randomUUID(),grantVersion:'1',persistencePolicyRevision:'private-work.v1',exportPolicyId:randomUUID(),exportPolicyRevision:'1',contextSha256:'a'.repeat(64),inputByteSize:10,maxOutputTokens:20});
}
const pin=(f:Awaited<ReturnType<typeof storeFixture>>)=>({credentialId:f.credential.credentialId,expectedGeneration:f.credential.generation});
async function replacement(f:Awaited<ReturnType<typeof storeFixture>>){return api.models.create(f.actor,{...f.modelInput,key:randomUUID()});}
async function rotateIntent(f:Awaited<ReturnType<typeof storeFixture>>,id:string){return f.store.prepareRotate(f.actor,{key:randomUUID(),credentialId:f.credential.credentialId,expectedVersion:'1',replacementModelConnectionId:id,expectedReplacementModelVersion:'1',consent:true});}
async function actualBlocking(q:PoolClient){const pid=(await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;for(let i=0;i<200;i++){if((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n)return;await delay(10);}assert.fail('Actual SQL lock wait absent');}

test('BROKER-ADV real dedicated SQL roles exclude ciphertext table and every column; grant guards reject PUBLIC and SET-role leaks',async()=>{
 const f=await storeFixture();assert.equal((await app.query('SELECT credential_id FROM broker_model_credentials WHERE credential_id=$1',[f.credential.credentialId])).rowCount,1);
 for(const query of ['SELECT * FROM broker_credential_vault','SELECT envelope FROM broker_credential_vault','SELECT credential_id FROM broker_credential_vault','SELECT to_jsonb(v) FROM broker_credential_vault v','UPDATE broker_model_credentials SET state=state','DELETE FROM broker_credential_vault',`SET ROLE ${brokerRole}`])await assert.rejects(app.query(query),sqlCode('42501'));
 for(const query of ['UPDATE broker_credential_vault SET envelope=envelope','DELETE FROM broker_credential_vault',`SET ROLE ${migrator}`])await assert.rejects(broker.query(query),sqlCode('42501'));
 const privileges=await owner.query(`SELECT attname,has_column_privilege($1,'broker_credential_vault',attnum,'SELECT,INSERT,UPDATE,REFERENCES') p FROM pg_attribute WHERE attrelid='broker_credential_vault'::regclass AND attnum>0 AND NOT attisdropped`,[runtime]);assert(privileges.rows.every(r=>!r.p));
 await owner.query('GRANT SELECT(envelope) ON broker_credential_vault TO PUBLIC');try{await assert.rejects(applyRuntimeGrants(),/Unsafe runtime broker privileges/);}finally{await owner.query('REVOKE SELECT(envelope) ON broker_credential_vault FROM PUBLIC');}
 await admin.query(`GRANT ${brokerRole} TO ${runtime} WITH INHERIT FALSE,SET TRUE`);try{await assert.rejects(applyRuntimeGrants(),/Unsafe runtime private policy privileges/);}finally{await admin.query(`REVOKE ${brokerRole} FROM ${runtime}`);}
 await applyRuntimeGrants();
 await owner.query('GRANT UPDATE(envelope) ON broker_credential_vault TO PUBLIC');try{await assert.rejects(applyBrokerGrants(),/Unsafe dedicated broker role/);}finally{await owner.query('REVOKE UPDATE(envelope) ON broker_credential_vault FROM PUBLIC');}
 await applyBrokerGrants();
});

test('BROKER-ADV exact opaque provenance, current owner/session and pinned generation cannot be replaced with parsed metadata',async()=>{
 const f=await storeFixture(),other=await member(),before=await count('broker_credential_vault');
 for(const fake of [{},JSON.parse(JSON.stringify(f.credential)),{...f.intent}])await assert.rejects(f.store.commit(f.actor,fake as never,f.sealed),status(409));
 await assert.rejects(f.store.commit(other.actor,f.intent,f.sealed),status(409));
 await assert.rejects(f.store.commit(f.actor,f.intent,JSON.parse(JSON.stringify(f.vault.readSealedCredential(f.sealed,f.binding))) as never),status(409));
 assert.equal(await count('broker_credential_vault'),before);assert.deepEqual(await f.store.commit(f.actor,f.intent,f.sealed),f.credential);
 await assert.rejects(f.store.read(other.actor,{credentialId:f.credential.credentialId}),status(404));
 await assert.rejects(f.store.createResolver(f.actor,{...pin(f),expectedGeneration:'2'}),status(409));
 const resolve=await f.store.createResolver(f.actor,pin(f)),step=custodyStep(f);
 for(const field of ['ownerUserId','ownerPrincipalId','scopeId','runtimeDeviceId','connectionId','familyId','modelConnectionId'] as const)await assert.rejects(resolve({...step,[field]:randomUUID()}),status(409));
 for(const changed of [{modelVersion:'2'},{environment:'staging-next' as const},{clientId:'foreign-client'},{selection:{...step.selection,providerRef:'anthropic' as const}}])await assert.rejects(resolve({...step,...changed}),status(409));
 const result=await resolve(step);try{assert.equal(new TextDecoder().decode(result.key),secretText);}finally{result.key.fill(0);}
 await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);await assert.rejects(resolve(step),status(409));await assert.rejects(f.store.commit(f.actor,f.intent,f.sealed),status(401));
});

test('BROKER-ADV concurrent CAS rotations elect one replacement and same-key material cannot revive an old generation',async()=>{
 const f=await storeFixture(),resolve=await f.store.createResolver(f.actor,pin(f)),a=await replacement(f),b=await replacement(f);
 const intents=await Promise.all([rotateIntent(f,a.modelConnectionId),rotateIntent(f,b.modelConnectionId)]),sealed=await Promise.all(intents.map(i=>f.vault.seal(getCredentialWriteBinding(i),bytes())));
 const outcomes=await Promise.allSettled(intents.map((i,n)=>f.store.commit(f.actor,i,sealed[n])));assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
 const winner=outcomes.findIndex(o=>o.status==='fulfilled'),metadata=(outcomes[winner] as PromiseFulfilledResult<typeof f.credential>).value;assert.equal(metadata.generation,'2');
 assert.equal((await owner.query('SELECT state FROM model_connections WHERE model_connection_id=$1',[f.model.modelConnectionId])).rows[0].state,'revoked');
 await assert.rejects(resolve(custodyStep(f)),status(409));await assert.rejects(f.store.createResolver(f.actor,pin(f)),status(409));
 assert.deepEqual(await f.store.commit(f.actor,intents[winner],sealed[winner]),metadata);
 await f.store.revoke(f.actor,{key:randomUUID(),credentialId:metadata.credentialId,expectedVersion:'1'});await assert.rejects(f.store.commit(f.actor,intents[winner],sealed[winner]),status(409));
});

test('BROKER-ADV revoke during genuine decrypt and SQL lock expiry deny returned bytes and zero the real plaintext',async()=>{
 const entered=barrier(),release=barrier();let actual:Uint8Array|undefined;
 const f=await storeFixture(60,v=>({...v,open:async(b,e)=>{actual=await v.open(b,e);entered.release();await release.promise;return actual;}})),resolve=await f.store.createResolver(f.actor,pin(f));
 const pending=resolve(custodyStep(f));await entered.promise;await f.store.revoke(f.actor,{key:randomUUID(),credentialId:f.credential.credentialId,expectedVersion:'1'});release.release();await assert.rejects(pending,status(409));assert(actual&&actual.every(v=>v===0));
 const short=await storeFixture(1),resolver=await short.store.createResolver(short.actor,pin(short)),lock=await owner.connect();
 try{await lock.query('BEGIN');await lock.query('SELECT credential_id FROM broker_model_credentials WHERE credential_id=$1 FOR UPDATE',[short.credential.credentialId]);const waited=short.store.commit(short.actor,short.intent,short.sealed);await actualBlocking(lock);await delay(1100);await lock.query('COMMIT');await assert.rejects(waited,status(409));}finally{await lock.query('ROLLBACK');lock.release();}
});

test('BROKER-ADV timeout discards a late real decrypted plaintext and recovery withdrawal rejects stored state',async()=>{
 let actual:Uint8Array|undefined;const entered=barrier(),release=barrier();
 const f=await storeFixture(60,v=>({...v,open:async(b,e)=>{actual=await v.open(b,e);entered.release();await release.promise;return actual;}})),resolve=await f.store.createResolver(f.actor,pin(f));
 const pending=resolve(custodyStep(f));await entered.promise;await assert.rejects(pending,status(409));release.release();await delay(20);assert(actual&&actual.every(v=>v===0));
 const g=await storeFixture(),r=await g.store.createResolver(g.actor,pin(g));g.rf.state.floor='2';await assert.rejects(r(custodyStep(g)));assert.deepEqual(await g.store.read(g.actor,{credentialId:g.credential.credentialId}),g.credential);
 const persisted=JSON.stringify((await owner.query(`SELECT data::text FROM scoped_transition_journal UNION ALL SELECT payload::text FROM scoped_outbox UNION ALL SELECT response::text FROM scoped_command_receipts`)).rows);assert(!persisted.includes(secretText));
 const envelopes=await owner.query('SELECT envelope FROM broker_credential_vault');for(const row of envelopes.rows)for(const field of ['ciphertext','wrappedDek'])assert(!persisted.includes(row.envelope[field]));
});

test('BROKER-ADV historical owner metadata and safe revoke survive recovery advance',async()=>{
 const f=await storeFixture(),resolve=await f.store.createResolver(f.actor,pin(f));f.rf.state.floor='2';f.rf.state.generation='2';f.rf.state.raw=await f.rf.sign(f.rf.claims());
 await assert.rejects(resolve(custodyStep(f)));assert.deepEqual(await f.store.read(f.actor,{credentialId:f.credential.credentialId}),f.credential);
 assert.equal((await f.store.revoke(f.actor,{key:randomUUID(),credentialId:f.credential.credentialId,expectedVersion:'1'})).state,'revoked');
});


test('BROKER-ADV real local host capability dispatches once and rotated pinned generation prevents another provider POST',async()=>{
 let posts=0;const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.headers.authorization!=='Bearer '+secretText){res.statusCode=401;res.end('{}');return;}
  if(req.method==='GET'){res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic-fixture'}));return;}
  posts++;req.resume();req.on('end',()=>res.end(JSON.stringify({id:'synthetic-response',object:'response',model:'synthetic-model',status:'completed',output:[{id:'synthetic-message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'PRIVATE_SYNTHETIC_MODEL_OUTPUT',annotations:[]}]}],usage:{input_tokens:3,output_tokens:4,total_tokens:7}})));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
 const objectDir=await mkdtemp(join(tmpdir(),'fp-credential-object-'));let puts=0;
 const file=(key:Parameters<ObjectStore['head']>[0])=>{assertObjectKey(key);return join(objectDir,key.replaceAll('/','_'));};
 const read=async(key:Parameters<ObjectStore['head']>[0])=>{try{return JSON.parse(await readFile(file(key),'utf8')) as {metadata:ObjectMetadata;bytes:string};}catch(error){if((error as {code?:string}).code==='ENOENT')return null;throw error;}};
 const store:ObjectStore={putImmutable:async(key,value)=>{const pendingFile=join(objectDir,'pending-'+randomUUID());await writeFile(pendingFile,JSON.stringify({metadata:value.metadata,bytes:Buffer.from(value.bytes).toString('base64')}),{flag:'wx'});try{await link(pendingFile,file(key));puts++;return 'created';}catch(error){if((error as {code?:string}).code==='EEXIST')return 'exists';throw error;}finally{await rm(pendingFile,{force:true});}},head:async key=>{const value=await read(key);return value?{metadata:value.metadata}:null;},get:async(key,range)=>{const value=await read(key);if(!value)return null;let bytes=new Uint8Array(Buffer.from(value.bytes,'base64'));if(range){validateRange(range,bytes.byteLength);bytes=bytes.slice(range.offset,range.offset+range.length);}return {metadata:value.metadata,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};},delete:async key=>{const value=await read(key);if(!value)return 'missing';await rm(file(key));return 'deleted';}};
 async function operational(){const f=await storeFixture(),resolveCredential=await f.store.createResolver(f.actor,pin(f));
  const host=createLocalFixtureModelStepHost({environment:'local',origin,recover:f.rf.source.recover,resolveCredential});
  const steps=createModelStepService(app,{...options,host}),grant=await api.grants.create(f.actor,f.grantInput);
  await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`,[randomUUID(),f.context.scope.scope_id,f.context.subject_principal.principal_id,options.environment,options.clientId,JSON.stringify(selection)]);
  const approval=await steps.approvals.create(f.actor,{key:randomUUID(),runId:f.run.runId,grantId:grant.grantId,expectedRunVersion:'1',expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20});
  const active=await steps.activate(f.actor,{key:randomUUID(),approvalId:approval.approvalId,expectedApprovalVersion:'1',expectedRunVersion:'1'}),begun=await steps.begin(f.actor,{key:randomUUID(),stepId:active.stepId,expectedVersion:'1'});assert(begun.capability);const contextBytes=await steps.context(f.actor,begun.capability);return {...f,host,steps,begun,contextBytes};}
 try{const first=await operational();for(const fake of [{},{...first.begun.capability},JSON.parse(JSON.stringify(first.credential)),custodyStep(first)])await assert.rejects(first.host.dispatch(fake as never,first.contextBytes));assert.equal(posts,0);const observation=await first.host.dispatch(first.begun.capability!,first.contextBytes);assert.equal(posts,1);const recorded=await first.steps.record(first.actor,first.begun.capability!,observation);assert.equal(recorded.state,'awaiting_result');
  const results=createPrivateModelResultService(app,{store,steps:first.steps,host:first.host,resolvePolicy:resolvePrivateWorkPersistencePolicy}),readResults=createPrivateResultService(app,{store,resolvePolicy:resolvePrivateWorkPersistencePolicy}),finalInput={key:randomUUID(),stepId:recorded.stepId,expectedVersion:recorded.aggregateVersion};
  const result=await results.finalize(first.actor,finalInput,observation);assert.equal(result.provenance,'model');assert.equal(result.operational_authority,false);assert.equal((await first.steps.read(first.actor,{stepId:recorded.stepId})).state,'succeeded');assert.equal((await readResults.readCurrent(first.actor,{workId:first.work.workId}))?.text,'PRIVATE_SYNTHETIC_MODEL_OUTPUT');assert.equal(puts,1);assert.deepEqual(await results.finalize(first.actor,finalInput,{} as never),result);assert.equal(puts,1);assert.equal(posts,1);
  await assert.rejects(readResults.readCurrent((await member()).actor,{workId:first.work.workId}));
  await assert.rejects(first.host.dispatch(first.begun.capability!,first.contextBytes));assert.equal(posts,1);
  const stale=await operational(),newModel=await replacement(stale),intent=await rotateIntent(stale,newModel.modelConnectionId),sealed=await stale.vault.seal(getCredentialWriteBinding(intent),bytes());await stale.store.commit(stale.actor,intent,sealed);
  await assert.rejects(stale.host.dispatch(stale.begun.capability!,stale.contextBytes));assert.equal(posts,1,'Old pinned generation emits zero additional POST');
  await assert.rejects(stale.host.verify(JSON.parse(JSON.stringify(custodyStep(stale)))));assert.equal(posts,1);
 }finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await rm(objectDir,{recursive:true,force:true});}
});


test('BROKER-ADV expired credential and externally revoked model retain owner controls without incrementing model twice',async()=>{
 const f=await storeFixture(1),other=await member(),resolve=await f.store.createResolver(f.actor,pin(f));await api.models.revoke(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedVersion:'1'});await delay(1100);
 assert.deepEqual(await f.store.read(f.actor,{credentialId:f.credential.credentialId}),f.credential);await assert.rejects(resolve(custodyStep(f)));
 await assert.rejects(f.store.revoke(other.actor,{key:randomUUID(),credentialId:f.credential.credentialId,expectedVersion:'1'}),status(404));
 const input={key:randomUUID(),credentialId:f.credential.credentialId,expectedVersion:'1'},result=await f.store.revoke(f.actor,input);assert.equal(result.state,'revoked');assert.deepEqual(await f.store.revoke(f.actor,input),result);
 assert.equal((await owner.query('SELECT aggregate_version::text FROM model_connections WHERE model_connection_id=$1',[f.model.modelConnectionId])).rows[0].aggregate_version,'2');
 await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);await assert.rejects(f.store.read(f.actor,{credentialId:f.credential.credentialId}),status(401));await assert.rejects(f.store.revoke(f.actor,input),status(401));
});

test('BROKER-ADV resolver clips fresh signed recovery validity and historical read rechecks session expiry after an actual SQL wait',async()=>{
 const f=await storeFixture(),resolve=await f.store.createResolver(f.actor,pin(f)),until=Date.now()+6000;f.rf.state.raw=await f.rf.sign(f.rf.claims({expiresAt:iso(until)}));
 const result=await resolve(custodyStep(f));try{assert.equal(result.expiresAt,iso(until));}finally{result.key.fill(0);}
 const lock=await owner.connect();try{await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '0.7 seconds' WHERE token_hash=$1",[f.actor.session_hash]);await lock.query('BEGIN');await lock.query('SELECT credential_id FROM broker_model_credentials WHERE credential_id=$1 FOR UPDATE',[f.credential.credentialId]);const pending=f.store.read(f.actor,{credentialId:f.credential.credentialId});await actualBlocking(lock);await delay(800);await lock.query('COMMIT');await assert.rejects(pending,status(401));}finally{await lock.query('ROLLBACK');lock.release();}
});


test('BROKER-ADV resolver snapshots recheck current human/session/scope/onboarding after genuine plaintext decrypt await',async()=>{
 for(const change of ['session','user','principal','scope','onboarding','expiry'] as const){let actual:Uint8Array|undefined;const entered=barrier(),release=barrier();
  const f=await storeFixture(60,v=>({...v,open:async(b,e)=>{actual=await v.open(b,e);entered.release();await release.promise;return actual;}})),resolve=await f.store.createResolver(f.actor,pin(f)),pending=resolve(custodyStep(f));await entered.promise;
  if(change==='session')await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
  if(change==='user')await owner.query('UPDATE users SET active=false WHERE user_id=$1',[f.actor.user_id]);
  if(change==='onboarding')await owner.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[f.actor.user_id]);
  if(change==='principal')await owner.query("UPDATE principals SET status='disabled' WHERE principal_id=$1",[f.context.subject_principal.principal_id]);
  if(change==='scope')await owner.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1",[f.context.scope.scope_id]);
  if(change==='expiry')await owner.query('UPDATE sessions SET expires_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
  release.release();await assert.rejects(pending,status(409));assert(actual&&actual.every(v=>v===0));
 }
});


test('BROKER-ADV trusted host clears original real broker plaintext after copying credential bytes',async()=>{
 const f=await storeFixture(),resolve=await f.store.createResolver(f.actor,pin(f)),returned:Uint8Array[]=[];
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic-fixture'}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address==='object');
 const host=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,recover:f.rf.source.recover,resolveCredential:async binding=>{const result=await resolve(binding);returned.push(result.key);return result;}});
 try{await host.verify(custodyStep(f));assert(returned.length>0);assert(returned.every(k=>k.every(v=>v===0)),'Host must dispose the real resolver-owned plaintext after copying');
  const invalid=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,recover:f.rf.source.recover,resolveCredential:async binding=>{const result=await resolve(binding);returned.push(result.key);return {...result,expiresAt:iso(Date.now()-1)};}});await assert.rejects(invalid.verify(custodyStep(f)));assert(returned.every(k=>k.every(v=>v===0)),'Rejected metadata must dispose original plaintext');
  const entered=barrier(),release=barrier(),late=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,recover:f.rf.source.recover,resolveCredential:async binding=>{const result=await resolve(binding);returned.push(result.key);entered.release();await release.promise;return result;}});const pending=late.verify(custodyStep(f));await entered.promise;await assert.rejects(pending);release.release();await delay(20);assert(returned.every(k=>k.every(v=>v===0)),'Late host port completion must dispose original plaintext');
 }finally{returned.forEach(k=>k.fill(0));await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});


test('BROKER-ADV exact deployed envelope CHECK rejects JSON null, omitted fields and extra fields',async()=>{
 const constraint=(await owner.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='broker_credential_vault'::regclass AND contype='c'`)).rows;assert.equal(constraint.length,1);
 await owner.query(`CREATE TABLE independent_envelope_structure(envelope jsonb NOT NULL ${constraint[0].definition})`);
 const f=await cryptoFixture(),sealed=await f.vault.seal(f.binding,bytes()),valid=f.vault.readSealedCredential(sealed,f.binding);assert.equal((await owner.query('INSERT INTO independent_envelope_structure VALUES($1)',[JSON.stringify(valid)])).rowCount,1);
 for(const key of Object.keys(valid)){const missing={...valid};delete (missing as Record<string,unknown>)[key];for(const bad of [{...valid,[key]:null},missing])await assert.rejects(owner.query('INSERT INTO independent_envelope_structure VALUES($1)',[JSON.stringify(bad)]),sqlCode('23514'));}
 await assert.rejects(owner.query('INSERT INTO independent_envelope_structure VALUES($1)',[JSON.stringify({...valid,operational_authority:true})]),sqlCode('23514'));
 await owner.query('DROP TABLE independent_envelope_structure');
});

test('BROKER-ADV ordinary app and Worker source do not import broker custody or ambient keys',async()=>{
 for(const file of ['apps/platform-api/src/server.ts','apps/platform-api/src/worker.ts','apps/platform-api/src/platform-app.ts','apps/platform-api/src/private-ai-product.ts']){
  const source=await readFile(new URL('../../'+file,import.meta.url),'utf8');assert(!/(credential-broker|createBrokerCredentialStore|createCredentialVault|createSignedRecoverySource)/.test(source),file+' must keep broker uninstalled');
 }
 const source=await readFile(new URL('../../apps/credential-broker/src/store.ts',import.meta.url),'utf8');assert(!/(process\.env|import\.meta\.env|OPENAI_API_KEY|ANTHROPIC_API_KEY)/.test(source));
});


test('BROKER-ADV expiry after the final genuine SQL snapshot await rejects and clears decrypted bytes',async()=>{
 let actual:Uint8Array|undefined;const f=await storeFixture(1,v=>({...v,open:async(b,e)=>{actual=await v.open(b,e);return actual;}})),entered=barrier(),release=barrier();let armed=false,observations=0;
 // Delay delivery of real PostgreSQL results; no SQL rows or crypto bytes are
 // fabricated. This models a slow SQL port after the server observed its clock.
 const delayed=new Proxy(broker,{get(target,key){if(key!=='query')return Reflect.get(target,key,target);return async(...args:unknown[])=>{const result=await (target.query as (...a:unknown[])=>Promise<unknown>)(...args);if(armed&&typeof args[0]==='string'&&args[0].includes('SELECT c.binding,v.envelope')&&++observations===4){entered.release();await release.promise;}return result;};}});
 const vault:CredentialVault={...f.vault,open:async(b,e)=>{actual=await f.vault.open(b,e);return actual;}};
 const store=createBrokerCredentialStore(delayed,{...options,vault,recover:f.rf.source.recover}),resolve=await store.createResolver(f.actor,pin(f));armed=true;
 const pending=resolve(custodyStep(f));await entered.promise;await delay(Math.max(0,Date.parse(f.binding.expiresAt)-Date.now()+20));release.release();
 let leaked:Awaited<ReturnType<typeof resolve>>|undefined;try{leaked=await pending;assert.fail('Expired plaintext must not be returned after the final SQL await');}catch(error){if((error as {code?:string}).code==='ERR_ASSERTION')throw error;assert(status(409)(error));}finally{leaked?.key.fill(0);}
 assert(actual&&actual.every(v=>v===0));
});


test('BROKER-ADV external signed recovery advances during final genuine SQL delivery wait and rejects old plaintext',async()=>{
 const f=await storeFixture(),entered=barrier(),release=barrier();let armed=false,observations=0,actual:Uint8Array|undefined;
 const delayed=new Proxy(broker,{get(target,key){if(key!=='query')return Reflect.get(target,key,target);return async(...args:unknown[])=>{const result=await (target.query as (...a:unknown[])=>Promise<unknown>)(...args);if(armed&&typeof args[0]==='string'&&args[0].includes('SELECT c.binding,v.envelope')&&++observations===4){entered.release();await release.promise;}return result;};}});
 const vault:CredentialVault={...f.vault,open:async(b,e)=>{actual=await f.vault.open(b,e);return actual;}},store=createBrokerCredentialStore(delayed,{...options,vault,recover:f.rf.source.recover});
 const resolve=await store.createResolver(f.actor,pin(f));armed=true;const pending=resolve(custodyStep(f));await entered.promise;
 f.rf.state.generation='2';f.rf.state.floor='2';f.rf.state.raw=await f.rf.sign(f.rf.claims());assert.equal((await f.rf.source.recover()).generation,'2');release.release();
 let leaked:Awaited<ReturnType<typeof resolve>>|undefined;try{leaked=await pending;assert.fail('Old recovery-generation plaintext must not be returned after SQL delivery await');}catch(error){if((error as {code?:string}).code==='ERR_ASSERTION')throw error;assert(status(409)(error));}finally{leaked?.key.fill(0);}
 assert(actual&&actual.every(v=>v===0));
});


test('BROKER-ADV BYOK preparation rejection clears actual host-owned credential copy before POST',async()=>{
 const {createHash}=await import('node:crypto');
 const {createModelStepCapability,encodeModelStepContext}=await import('../../modules/agent-execution/model-step-host.js');
 const f=await storeFixture(),resolve=await f.store.createResolver(f.actor,pin(f));let posts=0;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic-fixture'}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address==='object');
 const context=encodeModelStepContext({schema:'model-step.context/v1',title:'t',objective:'\\'.repeat(8120)});assert(context.byteLength<=16384);
 const binding=ModelStepBindingSchema.parse({...custodyStep(f),contextSha256:createHash('sha256').update(context).digest('hex'),inputByteSize:context.byteLength});
 const host=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,recover:f.rf.source.recover,resolveCredential:resolve});
 const verified=await host.verify(binding),cap=createModelStepCapability(binding,verified,iso(Date.now()+4000),async()=>{});
 const Original=globalThis.Uint8Array,copied:Uint8Array[]=[],known=bytes();
 try{globalThis.Uint8Array=new Proxy(Original,{construct(target,args,newTarget){const result=Reflect.construct(target,args,newTarget) as Uint8Array;if(args[0] instanceof Original&&result.byteLength===known.byteLength&&result.every((v,i)=>v===known[i]))copied.push(result);return result;}});
  await assert.rejects(host.dispatch(cap,context),(e:unknown)=>(e as {code?:string}).code==='invalid_input');assert.equal(posts,0);assert(copied.length>0,'Must capture an actual host-owned copy from real broker resolver');
  assert(copied.every(k=>k.every(v=>v===0)),'BYOK preparation rejection retained the actual host-owned plaintext credential copy');
 }finally{globalThis.Uint8Array=Original;copied.forEach(k=>k.fill(0));known.fill(0);context.fill(0);await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});


test('BROKER-ADV post-open SQL wait clears actual plaintext when host resolve times out',async()=>{
 let actual:Uint8Array|undefined;const f=await storeFixture(60),entered=barrier(),release=barrier();let armed=false,observations=0;
 const delayed=new Proxy(broker,{get(target,key){if(key!=='query')return Reflect.get(target,key,target);return async(...args:unknown[])=>{const result=await (target.query as (...a:unknown[])=>Promise<unknown>)(...args);if(armed&&typeof args[0]==='string'&&args[0].includes('SELECT c.binding,v.envelope')&&++observations===4){entered.release();await release.promise;}return result;};}});
 const vault:CredentialVault={...f.vault,open:async(b,e)=>{actual=await f.vault.open(b,e);return actual;}};
 const store=createBrokerCredentialStore(delayed,{...options,vault,recover:f.rf.source.recover}),resolve=await store.createResolver(f.actor,pin(f));armed=true;
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic-fixture'}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address==='object');
 const host=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,recover:f.rf.source.recover,resolveCredential:resolve});
 try{const pending=host.verify(custodyStep(f));await entered.promise;assert(actual&&actual.some(v=>v!==0));await assert.rejects(pending);assert(actual&&actual.every(v=>v===0),'Host has timed out but store retains decrypted plaintext behind an unbounded post-open SQL await');}
 finally{release.release();await delay(50);actual?.fill(0);await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});
