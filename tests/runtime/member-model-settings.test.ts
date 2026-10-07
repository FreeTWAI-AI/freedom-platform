import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { transaction } from '../../packages/db/transaction.js';
import { login, authenticate, hashPassword } from '../../modules/identity-membership/service.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createCredentialVault, type CredentialVault } from '../../apps/credential-broker/src/vault.js';
import { createBrokerCredentialStore, getCredentialWriteBinding } from '../../apps/credential-broker/src/store.js';
import { createMemberModelSettings } from '../../modules/agent-execution/member-model-settings.js';
import { createMemberModelSettingsHttpTransport } from '../../apps/platform-api/src/routes/member-model-settings-http.js';
import { MemberModelSettingsOverviewSchema } from '../../contracts/execution/v2/member-model-settings.js';
import { BrokerModelSelectionSchema, ModelCredentialMetadataSchema } from '../../contracts/execution/v2/model-credential.js';
import type { z } from 'zod';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit disposable fp_* TEST_DATABASE_URL required.');
const schema = `fp_settings_${process.pid}_${Date.now()}`, migrator = schema+'_owner', runtime = schema+'_app', brokerRole = schema+'_broker';
const admin = new Pool({connectionString});
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({connectionString:roleUrl(migrator),options:`-c search_path=${schema} -c statement_timeout=10000`,max:8});
const app = new Pool({connectionString:roleUrl(runtime),options:`-c search_path=${schema} -c statement_timeout=10000`,max:8});
const broker = new Pool({connectionString:roleUrl(brokerRole),options:`-c search_path=${schema} -c statement_timeout=10000`,max:8});
const origin = 'https://member.example.invalid', setupOrigin = 'https://broker.example.invalid';
const configuration = {environment:'local' as const,clientId:'settings-synthetic'};
const selection: z.infer<typeof BrokerModelSelectionSchema> = {providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',
  artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
const settings = createMemberModelSettings(app,{...configuration,selections:[selection]});
const enrollment = createRuntimeRegistrations(app,{environment:configuration.environment}), connections = createAgentConnections(app,configuration);
const prerequisites = createExecutionPrerequisites(app,configuration);
let created = false, unavailable = false, recoveryCalls = 0;
const recover = async () => { recoveryCalls++; if (unavailable) throw new Error('synthetic-recovery-down'); return {generation:'1',expiresAt:new Date(Date.now()+60000).toISOString()}; };
let vault: CredentialVault, store: ReturnType<typeof createBrokerCredentialStore>;
let transport: Awaited<ReturnType<typeof createMemberModelSettingsHttpTransport>>;
const substitute = (sql:string) => sql.replaceAll('SCHEMA public',`SCHEMA ${schema}`).replaceAll("'public'",`'${schema}'`)
  .replaceAll(':"runtime"',`"${runtime}"`).replaceAll(":'runtime'",`'${runtime}'`)
  .replaceAll(':"broker"',`"${brokerRole}"`).replaceAll(":'broker'",`'${brokerRole}'`);
async function generated(q: PoolClient, sql:string) { for (const row of (await q.query(substitute(sql))).rows) await q.query(Object.values(row)[0] as string); }
async function grants() {
  const runtimeTemplate = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
  const brokerTemplate = await readFile(new URL('../../deploy/cloudflare/sql/40-credential-broker-grants.psql',import.meta.url),'utf8');
  const q = await owner.connect();
  try {
    await q.query(substitute(runtimeTemplate.slice(runtimeTemplate.indexOf('BEGIN;'),runtimeTemplate.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))));
    for (const marker of ['PRIVATE POLICY GRANTS','BROKER CREDENTIAL EXCLUSIONS','MODEL BROKER AUTHORIZATION EXCLUSIONS'])
      await generated(q,runtimeTemplate.split(`-- BEGIN ${marker}\n`)[1].split('\n\\gexec')[0]);
    await q.query('COMMIT');
    await q.query(substitute(brokerTemplate.slice(brokerTemplate.indexOf('BEGIN;'),brokerTemplate.indexOf('-- BEGIN BROKER COLUMN RESET'))));
    await generated(q,brokerTemplate.split('-- BEGIN BROKER COLUMN RESET\n')[1].split('\n\\gexec')[0]);
    await q.query(substitute(brokerTemplate.split('-- END BROKER COLUMN RESET\n')[1].split('-- BEGIN BROKER ROLE GUARD')[0]));
    await generated(q,brokerTemplate.split('-- BEGIN BROKER ROLE GUARD\n')[1].split('\n\\gexec')[0]);
    await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
}
before(async()=>{
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${brokerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime},${brokerRole}`);
  created = true; await migrate(owner); await grants();
  const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  vault = createCredentialVault({kek:{current:async()=>({keyId:'settings-synthetic-kek',key}),readById:async id=>id==='settings-synthetic-kek'?key:null},recover});
  store = createBrokerCredentialStore(broker,{...configuration,vault,recover});
  transport = await createMemberModelSettingsHttpTransport(app,{...configuration,origin,setupOrigin,selections:[selection],sourceNetwork:r=>r.headers.get('X-Test-Network')??'settings-default'});
});
after(async()=>{
  await Promise.all([owner.end(),app.end(),broker.end()]);
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${brokerRole},${runtime},${migrator}`); } finally { await admin.end(); }
});
beforeEach(async()=>{await owner.query('TRUNCATE communities CASCADE');await owner.query('TRUNCATE auth_rate_limits');unavailable=false;recoveryCalls=0;});
async function member() {
  const user = randomUUID(), community = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic settings member')",[community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic settings owner',$4,$5) RETURNING *`,[user,community,user+'@example.invalid',hashPassword('settings-fixture-password'),randomUUID()])).rows[0];
  const signed = await login(app,row.email,'settings-fixture-password'), actor = await authenticate(app,signed.token);
  return {actor,cookie:'__Host-freedom_session='+signed.token};
}
async function fixture() {
  const f = await member(), pair = await generateKeyPair('ES256',{extractable:true});
  const challenge = await enrollment.begin(f.actor,{key:randomUUID(),publicJwk:parseRuntimePublicJwk(await exportJWK(pair.publicKey))});
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(pair.privateKey);
  const device = await enrollment.confirm(f.actor,{key:randomUUID(),challengeId:challenge.challenge_id,proof});
  const connection = await connections.create(f.actor,{key:randomUUID(),runtimeDeviceId:device.runtimeDeviceId});
  await transaction(app,q=>insertInitialRefreshFamily(q,connection.connectionId,new Date(connection.issuedAt),new Date(connection.expiresAt)));
  const model = await prerequisites.models.create(f.actor,{key:randomUUID(),connectionId:connection.connectionId,expectedConnectionVersion:'1',selection});
  const intent = await store.prepareCreate(f.actor,{key:randomUUID(),modelConnectionId:model.modelConnectionId,expectedModelVersion:'1',consent:true});
  const bytes = new TextEncoder().encode('SETTINGS_SYNTHETIC_KEY_NEVER_WIRE');
  const sealed = await vault.seal(getCredentialWriteBinding(intent),bytes); bytes.fill(0);
  const credential = await store.commit(f.actor,intent,sealed);
  return {...f,device,connection,model,credential};
}
type Member = Awaited<ReturnType<typeof member>>;
function get(f:Member,path='/api/v1/me/model-settings',headers:Record<string,string>={}) {
  return transport.request(origin+path,{headers:{Cookie:f.cookie,'X-Test-Network':randomUUID(),...headers}});
}
async function response(r:Response,status:number) {
  assert.equal(r.status,status,await r.clone().text());
  assert.equal(r.headers.get('Cache-Control'),'private, no-store');assert.equal(r.headers.get('Pragma'),'no-cache');
  assert.equal(r.headers.get('Cross-Origin-Resource-Policy'),'same-origin');assert.equal(r.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(r.headers.get('ETag'),null);
  if (status>=400) {
    const dto = await r.clone().json();assert.deepEqual(Object.keys(dto).sort(),['code','detail','status','title','type']);
    assert.equal(dto.detail,'Request could not be completed.');
  }
  return r;
}

test('SETTINGS-01 first member read uses canonical lazy identity, captured catalog and unavailable setup without domain writes',async()=>{
  const f = await member(), choices = [{...selection}], options = {...configuration,selections:choices};
  const captured = createMemberModelSettings(app,options);choices[0].modelRef='MUTATED';options.clientId='other-client';
  const first = await captured.readOverview(f.actor);
  assert.deepEqual(first.connections,[]);assert.deepEqual(first.models,[]);assert.deepEqual(first.credentials,[]);
  assert.deepEqual(first.selectionOptions,[selection]);assert.deepEqual(first.setup,{state:'unavailable'});
  assert.equal((await owner.query('SELECT count(*)::int n FROM principals WHERE user_ref=$1',[f.actor.user_id])).rows[0].n,1);
  for (const table of ['model_connections','broker_model_credentials','broker_credential_vault','scoped_command_receipts','scoped_transition_journal'])
    assert.equal((await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
  const offline = await createMemberModelSettingsHttpTransport(app,{...configuration,origin,selections:[selection]});
  const absent = await response(await offline.request(origin+'/api/v1/me/model-settings',{headers:{Cookie:f.cookie}}),200);
  assert.deepEqual((await absent.json()).setup,{state:'unavailable'});
  const installed = MemberModelSettingsOverviewSchema.parse(await(await response(await get(f),200)).json());
  assert.deepEqual(installed.setup,{state:'installed',setupOrigin});assert.equal(installed.operational_authority,false);
  assert.equal(Object.isFrozen(first.selectionOptions[0]),true);
});

test('SETTINGS-02 genuine rotated/revoked history survives unavailable recovery and inaccessible Work, policy and vault',async()=>{
  const f = await fixture(), replacement = await prerequisites.models.create(f.actor,{key:randomUUID(),connectionId:f.connection.connectionId,expectedConnectionVersion:'1',selection});
  const intent = await store.prepareRotate(f.actor,{key:randomUUID(),credentialId:f.credential.credentialId,expectedVersion:'1',
    replacementModelConnectionId:replacement.modelConnectionId,expectedReplacementModelVersion:'1',consent:true});
  const bytes = new TextEncoder().encode('SETTINGS_SYNTHETIC_KEY_NEVER_WIRE'), sealed = await vault.seal(getCredentialWriteBinding(intent),bytes);bytes.fill(0);
  const next = await store.commit(f.actor,intent,sealed);
  await prerequisites.models.revoke(f.actor,{key:randomUUID(),modelConnectionId:replacement.modelConnectionId,expectedVersion:'1'});
  await connections.revoke(f.actor,{key:randomUUID(),connectionId:f.connection.connectionId,expectedVersion:'1'});
  unavailable=true;const priorCalls=recoveryCalls;
  const role = (await app.query('SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolbypassrls:false,rolinherit:false});
  await assert.rejects(app.query('SELECT envelope FROM broker_credential_vault'),{code:'42501'});
  await assert.rejects(app.query('UPDATE broker_model_credentials SET state=state'),{code:'42501'});
  await owner.query(`REVOKE SELECT ON private_work_persistence_policy,model_inference_export_policy,work_items FROM ${runtime}`);
  try {
    const overview = MemberModelSettingsOverviewSchema.parse(await(await response(await get(f),200)).json());
    assert.equal(overview.connections[0].state,'revoked');assert(overview.models.every(m=>m.state==='revoked'));
    assert.deepEqual(overview.credentials.map(c=>c.credentialId),[next.credentialId,f.credential.credentialId]);
    const old = ModelCredentialMetadataSchema.parse(await(await response(await get(f,`/api/v1/me/model-credentials/${f.credential.credentialId}`),200)).json());
    assert.equal(old.state,'rotated');assert.equal(old.aggregateVersion,'2');assert.equal(old.replacementCredentialId,next.credentialId);
    assert.equal(overview.models[0].aggregateVersion,'2');assert.equal(next.state,'active');assert.equal(recoveryCalls,priorCalls);
    const raw = JSON.stringify({overview,old});
    for (const forbidden of ['SETTINGS_SYNTHETIC_KEY','wrappedDek','ciphertext','binding','ownerUserId','session_hash','contextSha256','workId','claims','capability']) assert(!raw.includes(forbidden));
  } finally { await owner.query(`GRANT SELECT ON private_work_persistence_policy,model_inference_export_policy,work_items TO ${runtime}`); }
});

test('SETTINGS-03 owner, original session, onboarding, personal principal/scope and configured environment/client fence history',async()=>{
  const f = await fixture(), foreign = await member();
  await response(await get(foreign,`/api/v1/me/model-credentials/${f.credential.credentialId}`),404);
  assert.deepEqual((await settings.readOverview(foreign.actor)).credentials,[]);
  for (const changed of [{environment:'staging-next' as const,clientId:configuration.clientId},{...configuration,clientId:'other-client'}]) {
    const isolated = createMemberModelSettings(app,{...changed,selections:[selection]});
    assert.deepEqual((await isolated.readOverview(f.actor)).credentials,[]);
    await assert.rejects(isolated.readCredential(f.actor,{credentialId:f.credential.credentialId}),{code:'not_found'});
  }
  await assert.rejects(settings.readOverview({...f.actor,community_id:foreign.actor.community_id}),{code:'session_expired'});
  await owner.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[f.actor.user_id]);
  await response(await get(f),403);
  await owner.query('UPDATE users SET onboarding_required=false WHERE user_id=$1',[f.actor.user_id]);
  await owner.query("UPDATE principals SET status='disabled' WHERE user_ref=$1",[f.actor.user_id]);
  await response(await get(f),403);
  await owner.query("UPDATE principals SET status='active' WHERE user_ref=$1",[f.actor.user_id]);
  await owner.query("UPDATE resource_scopes SET status='disabled' WHERE owner_principal_id=(SELECT principal_id FROM principals WHERE user_ref=$1)",[f.actor.user_id]);
  await response(await get(f),403);
  await owner.query("UPDATE resource_scopes SET status='active' WHERE owner_principal_id=(SELECT principal_id FROM principals WHERE user_ref=$1)",[f.actor.user_id]);
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
  await response(await get(f),401);
});

test('SETTINGS-04 actual last credential SELECT delivery after original session expiry cannot return private metadata',async()=>{
  const f = await fixture(); let reached!:()=>void, release!:()=>void;
  const gate = new Promise<void>(r=>release=r), entered = new Promise<void>(r=>reached=r), sqls:string[]=[];
  const waiting = {async connect() {
    const q = await app.connect();
    return new Proxy(q,{get(target,key) {
      if (key==='query') return async(sql:string,values?:unknown[])=>{
        sqls.push(sql);const result = await q.query(sql,values);
        if (sql.includes('FROM broker_model_credentials')) { reached();await gate; }
        return result;
      };
      const value = Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
  }} as Pool;
  await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '800 milliseconds' WHERE token_hash=$1",[f.actor.session_hash]);
  const operation = createMemberModelSettings(waiting,{...configuration,selections:[selection]}).readOverview(f.actor), rejected = assert.rejects(operation,{code:'session_expired'});
  try { await entered;await delay(850); } finally { release(); }
  await rejected;
  assert(sqls.at(-3)?.includes('FROM broker_model_credentials'));assert(sqls.at(-1)?.includes('ROLLBACK'));
  const domains = sqls.filter(sql=>/FROM (agent_connections|model_connections|broker_model_credentials)/.test(sql));
  assert.equal(domains.length,3);assert(domains.every(sql=>!sql.includes('FOR UPDATE')&&!/\b(binding|envelope)\b/.test(sql)));
  assert(sqls.some(sql=>sql.includes('expires_at>clock_timestamp()')));
});

test('SETTINGS-05 closed GET transport rejects alternative credentials, duplicate cookies, headers, origins and body without pulling secret input',async()=>{
  const f = await member();
  const credentials:Record<string,string>[] = [{Authorization:'Bearer synthetic-machine'},{DPoP:'synthetic-proof'},{'X-Freedom-Connection':randomUUID()},
    {'X-Freedom-Nonce':'synthetic-nonce'},{Cookie:f.cookie+'; '+f.cookie},{Cookie:f.cookie+'; '+f.cookie.replace('=',' \t=')}];
  for (const headers of credentials) await response(await get(f,undefined,headers),403);
  const readHeaders:Record<string,string>[] = [{'If-None-Match':'*'},{'If-Modified-Since':new Date().toUTCString()},{'If-Unmodified-Since':new Date().toUTCString()},
    {'If-Range':'*'},{Range:'bytes=0-1'},{'Idempotency-Key':randomUUID()},{'If-Match':'"1"'},{'Content-Length':'0'},{'Transfer-Encoding':'chunked'}];
  for (const headers of readHeaders)
    await response(await get(f,undefined,headers),400);
  await response(await get(f,undefined,{'Content-Encoding':'gzip'}),415);
  await response(await get(f,undefined,{Origin:setupOrigin}),403);
  await response(await get(f,undefined,{'Sec-Fetch-Site':'cross-site'}),403);
  await response(await get(f,undefined,{Host:'other.example.invalid'}),403);
  for (const suffix of ['?next=synthetic-secret','%2f','/../model-settings?x=1'])
    assert((await get(f,'/api/v1/me/model-settings'+suffix)).status>=400);
  await response(await get(f,'/api/v1/me/model-credentials/'+randomUUID()+':revoke'),404);
  let pulls=0;
  const stream = new ReadableStream<Uint8Array>({pull(){pulls++;throw new Error('secret pull forbidden');}},{highWaterMark:0});
  const request = new Request(origin+'/api/v1/me/model-settings',{method:'POST',headers:{Cookie:f.cookie,Origin:origin},body:stream,duplex:'half'} as RequestInit);
  const denied = await response(await transport.fetch(request),405);assert.equal(denied.headers.get('Allow'),'GET');assert.equal(pulls,0);
  await response(await transport.request(origin+'/api/v1/me/model-settings',{headers:{'X-Test-Network':randomUUID()}}),401);
});

test('SETTINGS-06 committed execution-member quota counts failed genuine-member boundary requests and remains bounded',async()=>{
  const f = await member(), network = 'settings-stable-network';
  for (let i=0;i<60;i++) await response(await transport.request(origin+'/api/v1/me/model-settings',{headers:{'X-Test-Network':network}}),401);
  const denied = await response(await get(f,undefined,{'X-Test-Network':network}),429);
  assert.equal(denied.headers.get('Retry-After'),'60');assert.equal((await denied.json()).code,'member_model_settings_rate_limited');
  assert.equal((await owner.query('SELECT max(attempts)::int n FROM auth_rate_limits')).rows[0].n,61);
  await response(await get(f),200);
});

test('SETTINGS-07 configuration and Actor accessors never execute, origins stay closed and 50-choice catalog is captured',async()=>{
  let getters=0;
  const hostile = {environment:configuration.environment,clientId:configuration.clientId,get selections(){getters++;return [selection];}};
  assert.throws(()=>createMemberModelSettings(app,hostile));assert.equal(getters,0);
  await assert.rejects(createMemberModelSettingsHttpTransport(app,{...configuration,origin,get selections(){getters++;return [selection];}}));assert.equal(getters,0);
  for (const extra of [{setupOrigin:origin},{setupOrigin:'https://member.example.invalid:444'},{setupOrigin:setupOrigin+'/'},
    {setupOrigin:'http://broker.example.invalid'},{origin:origin+'/'},{origin:'https://user@member.example.invalid'},{secret:'forbidden'}])
    await assert.rejects(createMemberModelSettingsHttpTransport(app,{...configuration,origin,selections:[selection],...extra}));
  const choices = Array.from({length:50},(_,i)=>({...selection,modelRef:'synthetic-choice-'+i}));
  const f = await member(), fifty = createMemberModelSettings(app,{...configuration,selections:choices});choices[0].modelRef='MUTATED';
  assert.equal((await fifty.readOverview(f.actor)).selectionOptions.length,50);
  assert.equal((await fifty.readOverview(f.actor)).selectionOptions[0].modelRef,'synthetic-choice-0');
  assert.throws(()=>createMemberModelSettings(app,{...configuration,selections:[...choices,selection]}));
  const actor = {...f.actor};Object.defineProperty(actor,'session_hash',{get(){getters++;return f.actor.session_hash;}});
  await assert.rejects(settings.readOverview(actor));assert.equal(getters,0);
});

test('SETTINGS-08 original local HTTP loopback metadata remains available with unavailable setup and closed origin boundaries',async()=>{
  const f = await member(), localOrigin = 'http://127.0.0.1:7331';
  const local = await createMemberModelSettingsHttpTransport(app,{...configuration,origin:localOrigin,selections:[selection]});
  const overview = MemberModelSettingsOverviewSchema.parse(await(await response(await local.request(localOrigin+'/api/v1/me/model-settings',{headers:{Cookie:f.cookie.replace('__Host-freedom_session=','freedom_local_session=')}}),200)).json());
  assert.deepEqual(overview.setup,{state:'unavailable'});
  for (const invalid of [{origin:'http://member.example.invalid'},{origin:localOrigin,environment:'staging-next' as const},
    {origin:localOrigin,setupOrigin},{origin:'http://localhost:7331.evil.invalid'}])
    await assert.rejects(createMemberModelSettingsHttpTransport(app,{...configuration,selections:[selection],...invalid}));
});
