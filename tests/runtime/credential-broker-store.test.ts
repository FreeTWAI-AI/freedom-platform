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
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
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
const schema = `fp_broker_store_${process.pid}_${Date.now()}`, migrator = schema+'_owner', runtime = schema+'_app', brokerRole = schema+'_broker';
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
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 },false,['encrypt','decrypt']);
  vault = createCredentialVault({ kek: { current: async()=>({ keyId:'synthetic-test-kek',key }), readById: async id=>id==='synthetic-test-kek'?key:null }, recover });
  store = createBrokerCredentialStore(broker,{...options,vault,recover});
});
after(async () => {
  await Promise.all([owner.end(),app.end(),broker.end()]);
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${brokerRole},${runtime},${migrator}`); } finally { await admin.end(); }
});
beforeEach(async()=>{ await owner.query('TRUNCATE communities CASCADE'); generation='1'; recoveryExpiry=undefined; unavailable=false; recoveryCalls=0; });
async function fixture(selected = selection) {
  const user = randomUUID(), community = randomUUID(), session = tokenHash(randomBytes(32).toString('base64url'));
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic broker owner')",[community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`,[user,community,user+'@example.invalid',randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-csrf',clock_timestamp()+interval '1 hour')",[session,user]);
  const actor: Actor = {...row,session_hash:session};
  await withMemberScope(app,{actor,scope:'personal'},async()=>{},async()=>{});
  const key = await generateKeyPair('ES256',{extractable:true});
  const challenge = await enrollment.begin(actor,{key:randomUUID(),publicJwk:parseRuntimePublicJwk(await exportJWK(key.publicKey))});
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(key.privateKey);
  const device = await enrollment.confirm(actor,{key:randomUUID(),challengeId:challenge.challenge_id,proof});
  const connection = await connections.create(actor,{key:randomUUID(),runtimeDeviceId:device.runtimeDeviceId});
  await transaction(app,q=>insertInitialRefreshFamily(q,connection.connectionId,new Date(connection.issuedAt),new Date(connection.expiresAt)));
  const model = await prerequisites.models.create(actor,{key:randomUUID(),connectionId:connection.connectionId,expectedConnectionVersion:'1',selection:selected});
  return {actor,model,connection};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const secret = () => new TextEncoder().encode('synthetic-broker-secret-NEVER-WIRE');
async function persist(f: Fixture) {
  const intent = await store.prepareCreate(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedModelVersion:'1',consent:true});
  const sealed = await vault.seal(getCredentialWriteBinding(intent),secret());
  const metadata = await store.commit(f.actor,intent,sealed);
  return {intent,sealed,metadata};
}
function locator(intent: OpaqueCredentialWriteIntent) {
  // A structural locator for the internal resolver, not an execution proof.
  const b = getCredentialWriteBinding(intent);
  return ModelStepBindingSchema.parse({profile:'model-step.binding/v1',stepId:randomUUID(),attemptId:randomUUID(),intentId:randomUUID(),approvalId:randomUUID(),approvalVersion:'1',
    runId:randomUUID(),workId:randomUUID(),inputWorkVersion:'1',baseRunVersion:'1',runVersion:'2',baseTaskLeaseEpoch:'1',taskLeaseEpoch:'2',controlEpoch:'1',
    ownerUserId:b.ownerUserId,ownerPrincipalId:b.ownerPrincipalId,scopeId:b.scopeId,environment:b.environment,clientId:b.clientId,
    runtimeDeviceId:b.runtimeDeviceId,runtimeVersion:'1',connectionId:b.connectionId,connectionVersion:'1',familyId:b.familyId,
    modelConnectionId:b.modelConnectionId,modelVersion:b.modelVersion,selection:b.selection,grantId:randomUUID(),grantVersion:'1',
    persistencePolicyRevision:'private-work.v1',exportPolicyId:randomUUID(),exportPolicyRevision:'1',contextSha256:'a'.repeat(64),inputByteSize:1,maxOutputTokens:1});
}
test('real low-privilege migration/grants retain ciphertext only for broker and receipts contain metadata',async()=>{
  const f=await fixture(),p=await persist(f);
  assert.deepEqual(ModelCredentialMetadataSchema.parse(p.metadata),p.metadata);
  assert.deepEqual(await store.commit(f.actor,p.intent,p.sealed),p.metadata);
  await assert.rejects(app.query('SELECT envelope FROM broker_credential_vault'),{code:'42501'});
  await assert.rejects(app.query('UPDATE broker_model_credentials SET state=state'),{code:'42501'});
  await assert.rejects(app.query(`SET ROLE ${brokerRole}`),{code:'42501'});
  assert.equal((await app.query('SELECT credential_id FROM broker_model_credentials')).rowCount,1);
  const facts = JSON.stringify((await owner.query("SELECT response FROM scoped_command_receipts WHERE operation='broker.credential.create' UNION ALL SELECT data FROM scoped_transition_journal WHERE operation='broker.credential.create'")).rows);
  assert.equal(facts.includes('NEVER-WIRE'),false); assert.equal(facts.includes('ciphertext'),false); assert.equal(facts.includes('wrappedDek'),false);
  await assert.rejects(broker.query('UPDATE broker_credential_vault SET envelope=envelope'),{code:'42501'});
  await assert.rejects(owner.query('DELETE FROM broker_credential_vault'),{code:'23514'});
});
test('opaque prepared/sealed provenance and current session/owner fences reject forged and withdrawn commits',async()=>{
  const f=await fixture(),outsider=await fixture();
  const intent=await store.prepareCreate(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedModelVersion:'1',consent:true});
  const sealed=await vault.seal(getCredentialWriteBinding(intent),secret());
  await assert.rejects(store.commit(f.actor,JSON.parse(JSON.stringify(intent)),sealed));
  await assert.rejects(store.commit(f.actor,intent,JSON.parse(JSON.stringify(sealed))));
  await assert.rejects(store.commit(outsider.actor,intent,sealed));
  await prerequisites.models.revoke(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedVersion:'1'});
  await assert.rejects(store.commit(f.actor,intent,sealed));
  assert.equal((await owner.query('SELECT count(*)::int n FROM broker_credential_vault')).rows[0].n,0);
});
test('same-plaintext rotation creates distinct model lifetime and invalidates old pinned resolver',async()=>{
  const f=await fixture(),p=await persist(f),resolve=await store.createResolver(f.actor,{credentialId:p.metadata.credentialId,expectedGeneration:'1'});
  const clear=await resolve(locator(p.intent)); assert.deepEqual(clear.key,secret()); clear.key.fill(0);
  const replacement=await prerequisites.models.create(f.actor,{key:randomUUID(),connectionId:f.connection.connectionId,expectedConnectionVersion:'1',selection});
  const intent=await store.prepareRotate(f.actor,{key:randomUUID(),credentialId:p.metadata.credentialId,expectedVersion:'1',replacementModelConnectionId:replacement.modelConnectionId,expectedReplacementModelVersion:'1',consent:true});
  const sealed=await vault.seal(getCredentialWriteBinding(intent),secret()),next=await store.commit(f.actor,intent,sealed);
  assert.equal(next.generation,'2'); assert.notEqual(next.credentialId,p.metadata.credentialId);
  assert.equal((await prerequisites.models.read(f.actor,{modelConnectionId:f.model.modelConnectionId})).state,'revoked');
  assert.equal((await store.read(f.actor,{credentialId:p.metadata.credentialId})).state,'rotated');
  await assert.rejects(resolve(locator(p.intent)));
  const current=await store.createResolver(f.actor,{credentialId:next.credentialId,expectedGeneration:'2'});
  const fresh=await current(locator(intent)); assert.deepEqual(fresh.key,secret()); fresh.key.fill(0);
  await assert.rejects(store.prepareCreate(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedModelVersion:'2',consent:true}));
  await assert.rejects(store.commit(f.actor,intent,await vault.seal(getCredentialWriteBinding(intent),new TextEncoder().encode('synthetic-different-secret'))));
});
test('historical owner metadata and safe revoke survive recovery outage and externally revoked family/model',async()=>{
  const f=await fixture(),p=await persist(f);
  await prerequisites.models.revoke(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedVersion:'1'});
  await connections.revoke(f.actor,{key:randomUUID(),connectionId:f.connection.connectionId,expectedVersion:'1'});
  unavailable=true; const before=recoveryCalls;
  assert.equal((await store.read(f.actor,{credentialId:p.metadata.credentialId})).state,'active');
  const input={key:randomUUID(),credentialId:p.metadata.credentialId,expectedVersion:'1'};
  const revoked=await store.revoke(f.actor,input); assert.equal(revoked.state,'revoked'); assert.equal(revoked.aggregateVersion,'2');
  assert.deepEqual(await store.revoke(f.actor,input),revoked); assert.equal(recoveryCalls,before);
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
  await assert.rejects(store.read(f.actor,{credentialId:p.metadata.credentialId}));
});
test('resolver clips current recovery expiry and rejects changed generation after actual asynchronous open',async()=>{
  const f=await fixture(),p=await persist(f);
  recoveryExpiry=Date.now()+10_000;
  const resolve=await store.createResolver(f.actor,{credentialId:p.metadata.credentialId,expectedGeneration:'1'});
  const clear=await resolve(locator(p.intent)); assert.ok(Date.parse(clear.expiresAt)<=recoveryExpiry); clear.key.fill(0);
  let release!:()=>void, decrypted:Uint8Array|undefined;
  const waiting:CredentialVault={...vault,async open(binding,envelope){decrypted=await vault.open(binding,envelope);await new Promise<void>(r=>release=r);return decrypted;}};
  const guarded=createBrokerCredentialStore(broker,{...options,vault:waiting,recover});
  const guardedResolve=await guarded.createResolver(f.actor,{credentialId:p.metadata.credentialId,expectedGeneration:'1'});
  const operation=guardedResolve(locator(p.intent)); while(!release) await delay(5);
  generation='2'; release(); await assert.rejects(operation); assert.ok(decrypted?.every(value=>value===0));
});
test('outer deadline discards actual late decrypted bytes rather than leaving an unclaimed plaintext buffer',async()=>{
  const f=await fixture(),p=await persist(f); let transferred:Uint8Array|undefined, pendingOpen:Promise<Uint8Array>|undefined;
  const late:CredentialVault={...vault,open(binding,envelope){return pendingOpen=(async()=>{
    transferred=await vault.open(binding,envelope);await delay(3100);return transferred;
  })();}};
  const guarded=createBrokerCredentialStore(broker,{...options,vault:late,recover});
  const resolve=await guarded.createResolver(f.actor,{credentialId:p.metadata.credentialId,expectedGeneration:'1'});
  await assert.rejects(resolve(locator(p.intent)));
  // The callee owns its bytes until this late promise actually transfers them.
  // Observe that handoff, rather than assuming its delay from the shorter 2.5s
  // broker timeout. The waiting resolver's cleanup reaction was registered first.
  assert.ok(pendingOpen); await pendingOpen; assert.ok(transferred?.every(value=>value===0));
});
test('actual receipt INSERT wait rechecks recovery and session decision clocks and rolls all credential facts back',async()=>{
  for (const cause of ['recovery','session'] as const) {
    generation='1'; const f=await fixture();
    const intent=await store.prepareCreate(f.actor,{key:randomUUID(),modelConnectionId:f.model.modelConnectionId,expectedModelVersion:'1',consent:true});
    const sealed=await vault.seal(getCredentialWriteBinding(intent),secret());
    const lockKey=Math.floor(Math.random()*1_000_000_000), blocker=await owner.connect();
    await owner.query(`CREATE FUNCTION ${schema}.broker_receipt_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(${lockKey}); RETURN NEW; END $$;
      CREATE TRIGGER broker_receipt_wait BEFORE INSERT ON scoped_command_receipts FOR EACH ROW
      WHEN(NEW.operation='broker.credential.create') EXECUTE FUNCTION ${schema}.broker_receipt_wait()`);
    let operation:Promise<unknown>|undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock($1)',[lockKey]);
      if(cause==='session') await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1",[f.actor.session_hash]);
      operation=store.commit(f.actor,intent,sealed); const failure=assert.rejects(operation);
      let blocked=false;
      for(let attempt=0;attempt<100;attempt++) {
        blocked=(await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'
          AND query LIKE 'INSERT INTO scoped_command_receipts%') blocked`,[brokerRole])).rows[0].blocked;
        if(blocked) break; await delay(10);
      }
      assert.equal(blocked,true,'actual new receipt INSERT must wait after domain writes');
      if(cause==='recovery') generation='2'; else await delay(550);
      await blocker.query('COMMIT'); await failure;
      assert.equal((await owner.query('SELECT count(*)::int n FROM broker_model_credentials WHERE owner_user_id=$1',[f.actor.user_id])).rows[0].n,0);
      assert.equal((await owner.query('SELECT count(*)::int n FROM broker_credential_vault')).rows[0].n,0);
      assert.equal((await owner.query("SELECT count(*)::int n FROM scoped_transition_journal WHERE operation='broker.credential.create'")).rows[0].n,0);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await operation?.catch(()=>{});
      await owner.query(`DROP TRIGGER broker_receipt_wait ON scoped_command_receipts; DROP FUNCTION ${schema}.broker_receipt_wait()`);
    }
  }
});


test('OpenRouter forward migration admits only explicit namespaced BYOK and retains real low-privilege vault isolation',async()=>{
  const chosen={...selection,providerRef:'openrouter',modelRef:'openai/gpt-4.1-mini'};
  const f=await fixture(chosen),p=await persist(f);
  assert.deepEqual(p.metadata.selection,chosen);
  assert.deepEqual((await owner.query('SELECT selection FROM model_connections WHERE model_connection_id=$1',[f.model.modelConnectionId])).rows[0].selection,chosen);
  await assert.rejects(app.query('SELECT envelope FROM broker_credential_vault'),{code:'42501'});
  const row=(await owner.query("SELECT pg_get_expr(conbin,conrelid) expression FROM pg_constraint WHERE conrelid='model_connections'::regclass AND conname='model_connections_selection_v2'")).rows[0];
  assert(row);
  const check=async(value:unknown)=>(await owner.query('SELECT '+row.expression+' AS valid FROM (SELECT $1::jsonb selection) selected',[JSON.stringify(value)])).rows[0].valid;
  assert.equal(await check(chosen),true);
  for(const providerRef of ['openai','anthropic','other'])assert.equal(await check({...chosen,providerRef}),false);
  for(const modelRef of ['openai/../secret','openai/%2Fsecret','https://foreign.test/model','openai/a/b','openai/x?key=secret'])assert.equal(await check({...chosen,modelRef}),false);
  assert.equal(await check({...chosen,credentialCustody:'official_cli',engineLocation:'runtime_local',billingSource:'user_cli'}),false);
  for(const name of ['preserve_broker_credential','preserve_credential_ingest_authorization']){
    const body=(await owner.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure',[name+'()'])).rows[0].prosrc;
    assert(body.includes("('openai','anthropic','openrouter')"));assert(body.includes("'openrouter'"));assert(body.includes("'^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$'"));
  }
  const receipt=JSON.stringify((await owner.query("SELECT response FROM scoped_command_receipts WHERE operation='broker.credential.create'")).rows);
  assert(!receipt.includes('NEVER-WIRE'));assert(!receipt.includes('ciphertext'));
});
