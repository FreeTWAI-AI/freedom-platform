import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256, type AssetObjectKey, type PreparedRepresentation } from '../../packages/asset-storage/index.js';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createDeviceAuthorizations } from '../../modules/agent-control/device-authorizations.js';
import { createBootstrapSessions } from '../../modules/agent-control/bootstrap-sessions.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { createRuntimeRegistrationChallenge, parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createModelStepService } from '../../modules/agent-execution/model-step-service.js';
import { createLocalFixtureModelStepHost, type OpaqueModelObservation } from '../../modules/agent-execution/model-step-host.js';
import { createPrivateModelResultService } from '../../modules/agent-execution/model-results.js';
import { createPrivateResultService } from '../../modules/autopilot-work/results.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { type ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import type { ModelStepApprovalCreateInput } from '../../contracts/execution/v2/model-step.js';
import type { BootstrapSessionHost } from '../../contracts/execution/v1/bootstrap-session.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('ModelStep adversarial tests require an explicit disposable fp_* TEST_DATABASE_URL.');
const schema = `fp_model_step_adv_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const hostOptions = { environment: 'local' as const, clientId: 'model-step-adversarial-review' };
const api = createExecutionPrerequisites(app, hostOptions), runs = createExecutionRuns(app);
let created = false;
let pairing: Awaited<ReturnType<typeof createDeviceAuthorizations>>;
let sessions: Awaited<ReturnType<typeof createBootstrapSessions>>;
let host: BootstrapSessionHost;
let pairingHost: Parameters<typeof createDeviceAuthorizations>[1]['host'];

before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created = true; await migrate(owner);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const prefix = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtime}"`);
  const grants = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try { await q.query(prefix); const statements = await q.query(grants); assert.ok((statements.rowCount ?? 0) >= 1);
    for (const statement of statements.rows) await q.query(Object.values(statement)[0] as string); await q.query('COMMIT'); }
  catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  const issuer = await generateKeyPair('ES256');
  host = { ...hostOptions, issuerKid: 'synthetic-issuer', issuer: 'https://issuer.example.invalid/', audience: 'https://platform.example.invalid/',
    bootstrapUri: 'https://platform.example.invalid/execution-api/v1/bootstrap',
    refreshUri: 'https://platform.example.invalid/execution-api/v1/auth/refresh', nonceUri: 'https://platform.example.invalid/execution-api/v1/auth/nonce',
    keys: [{ kid: 'synthetic-issuer', purpose: 'bootstrap_access', environment: 'local',
      publicJwk: parseRuntimePublicJwk(await exportJWK(issuer.publicKey)), notBeforeMs: 0, notAfterMs: Number.MAX_SAFE_INTEGER, revoked: false }] };
  const { refreshUri: _refresh, nonceUri: _nonce, ...base } = host;
  pairingHost = { ...base, beginUri: 'https://platform.example.invalid/device/begin', pollUri: 'https://platform.example.invalid/device/poll',
    verificationUri: 'https://platform.example.invalid/device', clientDisplayName: 'Synthetic execution review device' };
  pairing = await createDeviceAuthorizations(app, { host: pairingHost, signingKey: issuer.privateKey });
  sessions = await createBootstrapSessions(app, { host, signingKey: issuer.privateKey });
});
after(async () => {
  await app.end(); await owner.end();
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); }
});
const status = (...codes: number[]) => (error: unknown) => codes.includes((error as { status?: number })?.status ?? 0);
const sqlCode = (...codes: string[]) => (error: unknown) => codes.includes((error as { code?: string })?.code ?? '');
const selection: ModelSelection = { providerRef: 'openai', modelRef: 'synthetic-text-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset', credentialCustody: 'local_keychain', engineLocation: 'runtime_local', billingSource: 'user_byok' };
const hash = (text: string) => createHash('sha256').update(text, 'ascii').digest('base64url');
async function dbNow() { return Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms); }
async function waitUntil(ms: number) {
  for (let i = 0; i < 500; i++) { if (await dbNow() >= ms) return; await delay(10); }
  assert.fail('PostgreSQL clock did not reach the expected expiry');
}
async function blockedBy(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 300; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL lock wait was not observed');
}
async function member() {
  const user = randomUUID(), community = randomUUID(), session = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic execution authority review')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, c) => c);
  return { actor, context };
}
async function paired(existing?: Awaited<ReturnType<typeof member>>) {
  const human = existing ?? await member(), device = await generateKeyPair('ES256');
  const publicJwk = parseRuntimePublicJwk(await exportJWK(device.publicKey));
  const sign = (typ: string, claims: Record<string, unknown>) => new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ, jwk: publicJwk }).sign(device.privateKey);
  const base = { client_id: hostOptions.clientId, environment: 'local', runtime_kind: 'agent-kit', scope: 'bootstrap.status.read', htm: 'POST' };
  const beginProof = await sign('freedom-device-pairing+jwt', { ...base, purpose: 'device_pairing_begin', jti: randomUUID(),
    iat: Math.floor(await dbNow()/1000), htu: pairingHost.beginUri });
  const started = await pairing.begin({ publicJwk, runtimeKind: 'agent-kit', proof: beginProof });
  await pairing.decide(human.actor, { key: randomUUID(), userCode: started.userCode, authorizationId: started.authorizationId,
    requestDigest: started.requestDigest, decision: 'approve' });
  // Read only the synthetic challenge through the dedicated migrator session.
  // This skips the initial five-second poll, while all proof/exchange/091
  // persistence follows the real implementation without invented families.
  const row = (await owner.query(`SELECT c.* FROM runtime_registration_challenges c JOIN device_authorizations a USING(challenge_id)
    WHERE a.authorization_id=$1`, [started.authorizationId])).rows[0];
  const challenge = createRuntimeRegistrationChallenge({ challenge_id: row.challenge_id, runtime_device_id: row.runtime_device_id,
    owner_member_id: row.owner_user_id, owner_principal_id: row.owner_principal_id, scope_id: row.scope_id,
    environment: row.environment, key_thumbprint: row.key_thumbprint, nonce: row.nonce,
    issued_at: row.issued_at.toISOString(), expires_at: row.expires_at.toISOString() });
  const enrollmentProof = await new CompactSign(new TextEncoder().encode(challenge.payload))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(device.privateKey);
  const initial = await pairing.poll({ authorizationId: started.authorizationId, deviceCode: started.deviceCode, enrollmentProof,
    proof: await sign('freedom-device-pairing+jwt', { ...base, purpose: 'device_pairing_poll', jti: randomUUID(), iat: Math.floor(await dbNow()/1000),
      htu: pairingHost.pollUri, authorization_id: started.authorizationId, request_digest: started.requestDigest,
      nonce: started.nonce, device_code_hash: hash(started.deviceCode) }) });
  assert.equal(initial.status, 'issued'); if (initial.status !== 'issued') throw Error('Genuine 091 device exchange required');
  return { ...human, initial, sign, enrollmentProof, beginProof, runtimeDeviceId: challenge.runtime_device_id };
}
async function fixture(target = api, workVersion = '1') {
  const f = await paired(), workId = randomUUID();
  await owner.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision,aggregate_version)
    VALUES($1,'personal_execution',$2,$3,$4,'Synthetic model draft','Synthetic fixture objective','draft',NULL,$5)`,
  [workId, f.context.scope.scope_id, f.context.subject_principal.principal_id, f.actor.user_id, workVersion]);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,$2,'work.private-draft',1,true,1048576)`, [f.context.scope.scope_id, f.context.subject_principal.principal_id]);
  const run = await runs.create(f.actor, { key: randomUUID(), workId, expectedWorkVersion: workVersion });
  const modelInput = { key: randomUUID(), connectionId: f.initial.connectionId, expectedConnectionVersion: '1', selection: { ...selection } };
  const model = await target.models.create(f.actor, modelInput);
  const grantInput = { key: randomUUID(), runId: run.runId, expectedRunVersion: '1', expectedWorkVersion: workVersion,
    connectionId: f.initial.connectionId, expectedConnectionVersion: '1', modelConnectionId: model.modelConnectionId, expectedModelVersion: '1', consent: true as const };
  const grant = await target.grants.create(f.actor, grantInput);
  const attemptInput = { key: randomUUID(), runId: run.runId, grantId: grant.grantId, expectedRunVersion: '1', expectedGrantVersion: '1' };
  return { ...f, workId, run, model, grant, modelInput, grantInput, attemptInput };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function workVersion(workId: string) {
  return (await owner.query('SELECT aggregate_version::text version FROM work_items WHERE work_item_id=$1', [workId])).rows[0].version as string;
}
async function refreshInput(f: Fixture) {
  const refresh = f.initial.refresh;
  return { familyId: refresh.familyId, refreshHandle: refresh.handle,
    proof: await f.sign('freedom-bootstrap-refresh+jwt', { purpose: 'bootstrap_refresh', client_id: hostOptions.clientId, environment: 'local',
      connection_id: f.initial.connectionId, family_id: refresh.familyId, generation: refresh.generation, refresh_handle_hash: hash(refresh.handle),
      jti: randomUUID(), iat: Math.floor(await dbNow()/1000), htm: 'POST', htu: host.refreshUri }) };
}

class ObservedStore extends FakeObjectStore {
  puts = 0; gets = 0; onPut?: () => Promise<void>; onGet?: () => Promise<void>;
  override async putImmutable(key: AssetObjectKey, value: PreparedRepresentation) {
    this.puts++; await this.onPut?.(); return super.putImmutable(key, value);
  }
  override async get(key: AssetObjectKey) { this.gets++; await this.onGet?.(); return super.get(key); }
}
async function scopedRows(f: Fixture, table: string) {
  assert.match(table, /^[a-z][a-z_]+$/);
  return (await owner.query(`SELECT to_jsonb(t) row FROM ${schema}.${table} t WHERE scope_id=$1 ORDER BY to_jsonb(t)::text`,
    [f.context.scope.scope_id])).rows;
}
async function verifyRoles() {
  for (const [pool, name] of [[owner, migrator], [app, runtime]] as const)
    assert.deepEqual((await pool.query('SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
      { current_user: name, session_user: name, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
}

function syntheticResponse(text = 'Synthetic isolated draft.', model = selection.modelRef) {
  return { id: 'resp_synthetic', object: 'response', model, status: 'completed', error: null, incomplete_details: null,
    output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] }],
    usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12, input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 } }, tools: [], tool_choice: 'none', parallel_tool_calls: false, store: false, background: false };
}
// This endpoint is isolated synthetic protocol evidence, never provider
// authentication, actual billing, model readiness or a production credential.
async function syntheticProvider(onRequest?: (response: ServerResponse) => Promise<void>) {
  const requests: { method?: string; url?: string; body: unknown; authorization?: string; apiKey?: string }[] = [];
  const probes: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        probes.push(request.url ?? ''); response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ id: selection.modelRef, object: 'model', created: 1, owned_by: 'synthetic-local-fixture' })); return;
      }
      const parts: Buffer[] = [];
      for await (const chunk of request) parts.push(Buffer.from(chunk));
      requests.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(parts).toString('utf8')),
        authorization: request.headers.authorization, apiKey: request.headers['x-api-key'] as string | undefined });
      if (onRequest) await onRequest(response);
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(syntheticResponse())); }
    } catch { response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { requests, probes, origin: `http://127.0.0.1:${address.port}`, endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}


test('MODELSTEP-ADV baseline uses real non-superuser pairing and preserves old blocked Attempt authority', async () => {
  await verifyRoles(); const f = await fixture();
  const blocked = await api.attempts.create(f.actor, f.attemptInput);
  assert.equal(blocked.state, 'preflight_blocked'); assert.equal(blocked.operational_authority, false);
  assert.equal(blocked.grant.familyId, f.initial.refresh.familyId);
  await assert.rejects(api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID(), state: 'active',
    activationBinding: { modelReady: true }, operational_authority: true } as never));
  assert.equal(await workVersion(f.workId), '1');
  assert.equal((await runs.read(f.actor, { runId: f.run.runId })).state, 'created');
  await assert.rejects(app.query('UPDATE private_work_persistence_policy SET revision=revision+1 WHERE scope_id=$1',
    [f.context.scope.scope_id]), sqlCode('42501'));
  assert.deepEqual(await api.attempts.read(f.actor, { attemptId: blocked.attemptId }), blocked);
});

function approvalInput(f: Fixture): ModelStepApprovalCreateInput {
  return { key: randomUUID(), runId: f.run.runId, grantId: f.grant.grantId, expectedRunVersion: '1',
    expectedGrantVersion: '1', expectedWorkVersion: f.run.inputWorkVersion, consent: true, maxOutputTokens: 20 };
}
async function enableExportPolicy(f: Fixture) {
  const policyId = randomUUID();
  await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,
    selection,revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`,
    [policyId,f.context.scope.scope_id,f.context.subject_principal.principal_id,hostOptions.environment,hostOptions.clientId,JSON.stringify(selection)]);
  return policyId;
}
async function snapshot(f: Fixture) {
  const data: Record<string, unknown> = {};
  for (const table of ['work_items','model_connections','execution_grants','execution_attempts','execution_runs',
    'model_export_approvals','model_text_steps','scoped_command_receipts','scoped_transition_journal','scoped_outbox'])
    data[table] = await scopedRows(f, table);
  return data;
}
async function unchangedAfter(f: Fixture, task: () => Promise<unknown>, rejection?: (error: unknown) => boolean) {
  const before = await snapshot(f);
  if (rejection) await assert.rejects(task(), rejection); else await assert.rejects(task());
  assert.deepEqual(await snapshot(f), before);
}

function directApproval(q: PoolClient | Pool, f: Fixture, policyId: string) {
  return q.query(`INSERT INTO model_export_approvals(approval_id,grant_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,
    environment,client_id,selection,input_work_version,grant_version,base_run_version,policy_id,export_policy_revision,
    persistence_policy_revision,context_sha256,input_byte_size,max_output_tokens,consent,creation_key,issued_at,expires_at)
    SELECT $1,g.grant_id,g.run_id,g.work_item_id,g.owner_user_id,g.owner_principal_id,g.scope_id,g.environment,g.client_id,g.selection,
      g.input_work_version,g.aggregate_version,g.run_version,p.policy_id,p.revision,g.persistence_policy_revision,
      encode(sha256(model_step_context_bytes(to_jsonb(w))),'hex'),octet_length(model_step_context_bytes(to_jsonb(w))),20,true,$2,
      date_trunc('milliseconds',clock_timestamp()),g.expires_at
    FROM execution_grants g JOIN work_items w ON w.work_item_id=g.work_item_id
      JOIN model_inference_export_policy p ON p.policy_id=$4 WHERE g.grant_id=$3 RETURNING approval_id`,
    [randomUUID(),randomUUID(),f.grant.grantId,policyId]);
}

test('MODELSTEP-ADV direct SQL export approval is immutable, exact, and operator policy is not app-writable', async () => {
  const f = await fixture(), policyId = await enableExportPolicy(f), row = (await directApproval(app,f,policyId)).rows[0];
  for (const query of [
    'UPDATE model_inference_export_policy SET revision=revision+1 WHERE policy_id=$1',
    'DELETE FROM model_inference_export_policy WHERE policy_id=$1',
  ]) await assert.rejects(app.query(query,[policyId]),sqlCode('42501'));
  await assert.rejects(app.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,
    selection,revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,'local','unauthorized',$4,1,true,16384,20)`,
    [randomUUID(),f.context.scope.scope_id,f.context.subject_principal.principal_id,JSON.stringify(selection)]),sqlCode('42501'));
  await assert.rejects(app.query('UPDATE model_export_approvals SET context_sha256=$2 WHERE approval_id=$1',[row.approval_id,'a'.repeat(64)]),sqlCode('23514'));
  await assert.rejects(app.query('DELETE FROM model_export_approvals WHERE approval_id=$1',[row.approval_id]),sqlCode('23514'));
  const peer = await member();
  for (const overrides of [
    { context_sha256:'a'.repeat(64) },{export_policy_revision:'2'}, {input_byte_size:1}, {max_output_tokens:21},
    {owner_user_id:peer.actor.user_id,owner_principal_id:peer.context.subject_principal.principal_id,scope_id:peer.context.scope.scope_id},
  ]) await assert.rejects(app.query(`INSERT INTO model_export_approvals
    SELECT (jsonb_populate_record(NULL::model_export_approvals,to_jsonb(a)||$2::jsonb)).*
    FROM model_export_approvals a WHERE approval_id=$1`,[row.approval_id,JSON.stringify({approval_id:randomUUID(),creation_key:randomUUID(),...overrides})]),sqlCode('23514','23503'));
  assert.equal((await scopedRows(f,'model_export_approvals')).length,1);
  assert.equal((await scopedRows(f,'model_text_steps')).length,0); assert.equal(await workVersion(f.workId),'1');
});

test('MODELSTEP-ADV deferred direct SQL approval COMMIT crossing real Grant expiry rolls everything back', async () => {
  const f = await fixture(createExecutionPrerequisites(app,{...hostOptions,grantTtlSeconds:1})), policyId = await enableExportPolicy(f);
  const before = await snapshot(f), q = await app.connect();
  try {
    await q.query('BEGIN'); assert.equal((await directApproval(q,f,policyId)).rowCount,1);
    await waitUntil(Date.parse(f.grant.expiresAt)+5);
    await assert.rejects(q.query('COMMIT'),sqlCode('23514'));
  } finally { await q.query('ROLLBACK'); q.release(); }
  assert.deepEqual(await snapshot(f),before); assert.equal(await workVersion(f.workId),'1');
});

async function stepFixture(onRequest?: (response: ServerResponse) => Promise<void>, target = api, maxAge = 90000) {
  const provider = await syntheticProvider(onRequest);
  try {
    const f = await fixture(target), policyId = await enableExportPolicy(f);
    const recovery = { generation: '1', maxAge, credential:'synthetic-fixture-key' };
    const host = createLocalFixtureModelStepHost({ environment:'local', origin:provider.origin,
      recover: async () => ({ generation:recovery.generation, expiresAt:new Date(Date.now()+recovery.maxAge).toISOString() }),
      resolveCredential: async binding => {
        assert.deepEqual(binding.selection,selection);
        return { key:new TextEncoder().encode(recovery.credential),expiresAt:new Date(Date.now()+90000).toISOString() };
      } });
    const steps = createModelStepService(app,{...hostOptions,host}), store = new ObservedStore();
    const results = createPrivateModelResultService(app,{store,steps,host,resolvePolicy:resolvePrivateWorkPersistencePolicy});
    const human = createPrivateResultService(app,{store,resolvePolicy:resolvePrivateWorkPersistencePolicy});
    return {...f,provider,policyId,recovery,host,steps,store,results,human};
  } catch (error) { await provider.close(); throw error; }
}
type StepFixture = Awaited<ReturnType<typeof stepFixture>>;
async function activate(s: StepFixture) {
  const approvedInput = approvalInput(s), approval = await s.steps.approvals.create(s.actor,approvedInput);
  const activateInput = {key:randomUUID(),approvalId:approval.approvalId,expectedApprovalVersion:'1',expectedRunVersion:'1'};
  const activation = await s.steps.activate(s.actor,activateInput);
  return {...s,approval,approvedInput,activation,activateInput};
}
async function begin(s: Awaited<ReturnType<typeof activate>>) {
  const beginInput = {key:randomUUID(),stepId:s.activation.stepId,expectedVersion:s.activation.aggregateVersion};
  const begun = await s.steps.begin(s.actor,beginInput); assert.ok(begun.capability);
  const capability = begun.capability!;
  const contextBytes = await s.steps.context(s.actor,capability);
  return {...s,beginInput,begun,capability,contextBytes};
}
async function observe(s: Awaited<ReturnType<typeof begin>>) {
  const observation = await s.host.dispatch(s.capability,s.contextBytes), recorded = await s.steps.record(s.actor,s.capability,observation);
  return {...s,observation,recorded};
}

test('MODELSTEP-ADV one real local HTTP dispatch produces one typed private AI Asset Result and safe historical replay', async () => {
  const f = await stepFixture();
  try {
    const s = await observe(await begin(await activate(f)));
    assert.equal(s.activation.state,'reserved'); assert.equal(s.activation.attemptNumber,1);
    assert.equal(s.activation.evidenceOrigin,'synthetic_local_fixture'); assert.equal(s.activation.operational_authority,false);
    await assert.rejects(runs.read(s.actor,{runId:s.run.runId}),status(409));
    assert.equal((await owner.query('SELECT state FROM execution_runs WHERE run_id=$1',[s.run.runId])).rows[0].state,'running');
    assert.equal(s.provider.requests.length,1); assert.deepEqual(s.provider.probes,Array(2).fill(`/v1/models/${encodeURIComponent(selection.modelRef)}`));
    const body = s.provider.requests[0].body as {model:string;input:{content:{text:string}[]}[];tools:unknown[]};
    assert.equal(body.model,selection.modelRef); assert.deepEqual(body.tools,[]);
    assert.equal(createHash('sha256').update(body.input[0].content[0].text).digest('hex'),s.approval.contextSha256);
    const finalInput = {key:randomUUID(),stepId:s.activation.stepId,expectedVersion:s.recorded.aggregateVersion};
    const result = await s.results.finalize(s.actor,finalInput,s.observation);
    assert.equal(result.provenance,'model'); assert.equal(result.evidenceOrigin,'synthetic_local_fixture');
    assert.equal(result.costStatus,'unknown'); assert.equal(result.operational_authority,false);
    assert.equal(result.attemptId,s.activation.attemptId); assert.equal(result.revision,'1'); assert.equal(result.aggregateVersion,'2');
    const current = await s.human.readCurrent(s.actor,{workId:s.workId});
    assert.equal(current?.resultId,result.resultId); assert.equal(current?.text,'Synthetic isolated draft.');
    assert.equal(current?.provenance,'model'); assert.equal(current?.model?.evidenceOrigin,'synthetic_local_fixture');
    assert.equal((await s.human.list(s.actor,{workId:s.workId})).items[0].provenance,'model');
    assert.equal((await s.steps.read(s.actor,{stepId:s.activation.stepId})).state,'succeeded');
    assert.equal((await owner.query('SELECT state FROM execution_runs WHERE run_id=$1',[s.run.runId])).rows[0].state,'succeeded');
    assert.equal(await workVersion(s.workId),'2'); assert.equal(s.store.puts,1);
    assert.equal((await scopedRows(s,'private_model_work_results')).length,1);
    assert.equal((await scopedRows(s,'private_work_results')).length,0);
    const before = await snapshot(s);
    assert.deepEqual(await s.results.finalize(s.actor,finalInput,{} as OpaqueModelObservation),result);
    assert.deepEqual(await snapshot(s),before); assert.equal(s.provider.requests.length,1); assert.equal(s.store.puts,1);
    const wire = JSON.stringify(before); assert.ok(!wire.includes('Synthetic isolated draft.')); assert.ok(!wire.includes('synthetic-fixture-key'));
  } finally { await f.provider.close(); }
});

test('MODELSTEP-ADV export approval rejects caller authority, stale CAS and cross-owner or wrong host before transport', async () => {
  const f = await stepFixture();
  try {
    const input = approvalInput(f);
    for (const extra of [{prompt:'SMUGGLED_PRIVATE_PROMPT'},{modelReady:true},{operational_authority:true},{providerUrl:f.provider.endpoint},
      {policyRevision:'2'},{scopeId:f.context.scope.scope_id},{recoveryGeneration:'1'},{credential:'synthetic-fixture-key'},
      {maxOutputTokens:21},{consent:false},{binding:{ready:true}}])
      await unchangedAfter(f,()=>f.steps.approvals.create(f.actor,{...input,key:randomUUID(),...extra} as never));
    for (const field of ['expectedRunVersion','expectedGrantVersion','expectedWorkVersion'] as const)
      await unchangedAfter(f,()=>f.steps.approvals.create(f.actor,{...input,key:randomUUID(),[field]:'2'}),status(412));
    const stranger = await member();
    await unchangedAfter(f,()=>f.steps.approvals.create(stranger.actor,input),status(404));
    for (const options of [{...hostOptions,environment:'staging-next' as const},{...hostOptions,clientId:'different-client'}]) {
      const other = createModelStepService(app,{...options,host:f.host});
      await unchangedAfter(f,()=>other.approvals.create(f.actor,input),status(404));
    }
    const approved = await f.steps.approvals.create(f.actor,input);
    await owner.query('UPDATE model_inference_export_policy SET revision=revision+1 WHERE policy_id=$1',[f.policyId]);
    await unchangedAfter(f,()=>f.steps.activate(f.actor,{key:randomUUID(),approvalId:approved.approvalId,expectedApprovalVersion:'1',expectedRunVersion:'1'}),status(409));
    await owner.query('UPDATE model_inference_export_policy SET revision=revision+1,export_allowed=false WHERE policy_id=$1',[f.policyId]);
    await unchangedAfter(f,()=>f.steps.approvals.create(f.actor,input),status(403));
    assert.equal((await f.steps.approvals.read(f.actor,{approvalId:approved.approvalId})).approvalId,approved.approvalId);
    assert.equal((await f.steps.approvals.revoke(f.actor,{key:randomUUID(),approvalId:approved.approvalId,expectedVersion:'1'})).state,'revoked');
    assert.equal(f.provider.requests.length,0); assert.equal(f.provider.probes.length,0); assert.equal(f.store.puts,0);
  } finally { await f.provider.close(); }
});

test('MODELSTEP-ADV concurrent activation and begin mint one committed step and one capability; replay cannot resend', async () => {
  const f = await stepFixture();
  try {
    const approval = await f.steps.approvals.create(f.actor,approvalInput(f));
    const activateInput = {key:randomUUID(),approvalId:approval.approvalId,expectedApprovalVersion:'1',expectedRunVersion:'1'};
    const activations = await Promise.all([f.steps.activate(f.actor,activateInput),f.steps.activate(f.actor,activateInput)]);
    assert.deepEqual(activations[0],activations[1]);
    const input = {key:randomUUID(),stepId:activations[0].stepId,expectedVersion:'1'};
    const begun = await Promise.all([f.steps.begin(f.actor,input),f.steps.begin(f.actor,input)]);
    assert.deepEqual(begun[0].metadata,begun[1].metadata); assert.equal(begun.filter(b=>b.capability!==null).length,1);
    const cap = begun.find(b=>b.capability!==null)!.capability!, bytes = await f.steps.context(f.actor,cap);
    const replay = await f.steps.begin(f.actor,input); assert.equal(replay.capability,null);
    assert.equal((await scopedRows(f,'model_text_steps')).length,1); assert.equal((await scopedRows(f,'execution_attempts')).length,1);
    await assert.rejects(f.host.dispatch({...cap} as never,bytes)); assert.equal(f.provider.requests.length,0);
    const observation = await f.host.dispatch(cap,bytes); await f.steps.record(f.actor,cap,observation);
    await assert.rejects(f.host.dispatch(cap,bytes)); assert.equal(f.provider.requests.length,1);
    await assert.rejects(f.steps.begin(f.actor,{...input,key:randomUUID(),expectedVersion:'3'}));
    assert.equal(f.provider.requests.length,1); assert.equal(f.store.puts,0);
  } finally { await f.provider.close(); }
});

test('MODELSTEP-ADV old blocked and active Attempts share immutable lifetime numbering and sixteen-attempt cap', async () => {
  const f = await stepFixture();
  try {
    const originals: Awaited<ReturnType<typeof api.attempts.create>>[] = [], blockedInputs: typeof f.attemptInput[] = [];
    for (let i=0;i<15;i++) { const input={...f.attemptInput,key:randomUUID()};blockedInputs.push(input);originals.push(await api.attempts.create(f.actor,input)); }
    const s = await activate(f); assert.equal(s.activation.attemptNumber,16);
    const rows = (await owner.query('SELECT attempt_number,state FROM execution_attempts WHERE run_id=$1 ORDER BY attempt_number',[f.run.runId])).rows;
    assert.deepEqual(rows.map(r=>r.attempt_number),Array.from({length:16},(_,i)=>i+1)); assert.equal(rows[15].state,'active');
    for (const old of originals) assert.deepEqual(await api.attempts.read(f.actor,{attemptId:old.attemptId}),old);
    await unchangedAfter(f,()=>api.attempts.create(f.actor,{...f.attemptInput,key:randomUUID()}),status(409));
    await unchangedAfter(f,()=>api.attempts.create(f.actor,blockedInputs[0]),status(409));
    await assert.rejects(app.query('UPDATE execution_attempts SET attempt_number=1 WHERE attempt_id=$1',[s.activation.attemptId]),sqlCode('23514','23505'));
    await assert.rejects(app.query('DELETE FROM execution_attempts WHERE attempt_id=$1',[s.activation.attemptId]),sqlCode('23514'));
    await assert.rejects(runs.pause(f.actor,{key:randomUUID(),runId:f.run.runId,expectedVersion:'2'}),status(409));
    const stopped = await f.steps.control(f.actor,{key:randomUUID(),stepId:s.activation.stepId,expectedVersion:'1',action:'stop'});
    assert.equal(stopped.state,'cancelled'); assert.equal((await owner.query('SELECT state FROM execution_runs WHERE run_id=$1',[f.run.runId])).rows[0].state,'cancelled');
    assert.equal(f.provider.requests.length,0);
  } finally { await f.provider.close(); }
  const exhausted = await stepFixture();
  try {
    for (let i=0;i<16;i++) await api.attempts.create(exhausted.actor,{...exhausted.attemptInput,key:randomUUID()});
    const approved = await exhausted.steps.approvals.create(exhausted.actor,approvalInput(exhausted));
    await unchangedAfter(exhausted,()=>exhausted.steps.activate(exhausted.actor,{key:randomUUID(),approvalId:approved.approvalId,expectedApprovalVersion:'1',expectedRunVersion:'1'}),status(429));
    assert.equal(exhausted.provider.requests.length,0);
  } finally { await exhausted.provider.close(); }
});

test('MODELSTEP-ADV consumed dispatch with lost provider acknowledgement retains unknown usage and never retries', async () => {
  const f = await stepFixture(async response=>{response.destroy();});
  try {
    const s = await begin(await activate(f));
    await assert.rejects(s.host.dispatch(s.capability,s.contextBytes)); assert.equal(s.provider.requests.length,1);
    const unknown = await s.steps.unknown(s.actor,s.capability); assert.equal(unknown.state,'outcome_unknown'); assert.equal(unknown.usageStatus,'unknown');
    const row = (await owner.query('SELECT reservation_held,usage_status,observation FROM model_text_steps WHERE step_id=$1',[s.activation.stepId])).rows[0];
    assert.deepEqual(row,{reservation_held:true,usage_status:'unknown',observation:null});
    await assert.rejects(s.host.dispatch(s.capability,s.contextBytes)); await assert.rejects(s.steps.begin(s.actor,s.beginInput));
    await assert.rejects(s.results.finalize(s.actor,{key:randomUUID(),stepId:s.activation.stepId,expectedVersion:unknown.aggregateVersion},{} as OpaqueModelObservation));
    assert.equal(s.provider.requests.length,1); assert.equal(s.store.puts,0); assert.equal((await scopedRows(s,'private_model_work_results')).length,0);
    assert.equal((await owner.query('SELECT state FROM execution_runs WHERE run_id=$1',[s.run.runId])).rows[0].state,'reconciling');
  } finally { await f.provider.close(); }
});

test('MODELSTEP-ADV direct dispatch cannot omit permit or release an unresolved token reservation', async () => {
  const f = await stepFixture();
  try {
    const s = await activate(f), before = await snapshot(f);
    await assert.rejects(app.query(`UPDATE model_text_steps SET state='dispatched',aggregate_version=aggregate_version+1,
      usage_status='unknown',dispatched_at=date_trunc('milliseconds',clock_timestamp()),permit_expires_at=NULL WHERE step_id=$1`,
      [s.activation.stepId]),sqlCode('23514'));
    assert.deepEqual(await snapshot(f),before);
    const b = await begin(s);
    await assert.rejects(app.query('UPDATE model_text_steps SET reservation_held=false,aggregate_version=aggregate_version+1 WHERE step_id=$1',
      [s.activation.stepId]),sqlCode('23514'));
    const o = await observe(b);
    await assert.rejects(app.query('UPDATE model_text_steps SET reservation_held=false,aggregate_version=aggregate_version+1 WHERE step_id=$1',
      [o.activation.stepId]),sqlCode('23514'));
    assert.equal(o.provider.requests.length,1); assert.equal(o.store.puts,0);
  } finally { await f.provider.close(); }
});

async function completedHuman(s: StepFixture, text: string, version: string) {
  const bytes = new TextEncoder().encode(text);
  const prepared = await s.human.prepare(s.actor,{key:randomUUID(),targetWorkId:s.workId,expectedVersion:version,
    contentType:'text/plain',byteSize:bytes.byteLength,sha256:await sha256(bytes)});
  const lease = await s.human.claim(s.actor,{key:randomUUID(),intentId:prepared.intentId});
  const input = {key:randomUUID(),intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  await s.human.write(s.actor,{...input,key:randomUUID()},new ReadableStream({start(c){c.enqueue(bytes);c.close();}}));
  return s.human.finalize(s.actor,input);
}

test('MODELSTEP-ADV AI then human then AI shares one revision history and preserves each typed provenance', async () => {
  const f = await stepFixture();
  try {
    const first = await observe(await begin(await activate(f)));
    const ai1 = await f.results.finalize(f.actor,{key:randomUUID(),stepId:first.activation.stepId,expectedVersion:first.recorded.aggregateVersion},first.observation);
    const human = await completedHuman(f,'Human replacement draft.','2');
    assert.equal(human.revision,'2'); assert.equal(human.aggregateVersion,'3'); assert.equal(human.provenance,'human');
    const run = await runs.create(f.actor,{key:randomUUID(),workId:f.workId,expectedWorkVersion:'3'});
    const grant = await api.grants.create(f.actor,{...f.grantInput,key:randomUUID(),runId:run.runId,expectedWorkVersion:'3'});
    const next = await observe(await begin(await activate({...f,run,grant})));
    const ai2 = await f.results.finalize(f.actor,{key:randomUUID(),stepId:next.activation.stepId,expectedVersion:next.recorded.aggregateVersion},next.observation);
    assert.equal(ai2.revision,'3'); assert.equal(ai2.aggregateVersion,'4'); assert.equal(await workVersion(f.workId),'4');
    const history = await f.human.list(f.actor,{workId:f.workId});
    assert.deepEqual(history.items.map(r=>[r.revision,r.provenance]),[['3','model'],['2','human'],['1','model']]);
    assert.equal((await f.human.readCurrent(f.actor,{workId:f.workId}))?.resultId,ai2.resultId);
    const humanRead = await f.human.readResult(f.actor,{workId:f.workId,resultId:human.resultId});
    assert.equal(humanRead.text,'Human replacement draft.'); assert.equal(humanRead.provenance,'human'); assert.equal('model' in humanRead,false);
    const aiRead = await f.human.readResult(f.actor,{workId:f.workId,resultId:ai1.resultId});
    assert.equal(aiRead.provenance,'model'); assert.equal(aiRead.model?.attemptId,first.activation.attemptId);
    assert.equal((await scopedRows(f,'private_model_work_results')).length,2); assert.equal((await scopedRows(f,'private_work_results')).length,1);
    assert.equal((await scopedRows(f,'private_work_result_index')).length,3); assert.equal(f.provider.requests.length,2); assert.equal(f.store.puts,3);
    await assert.rejects(app.query('INSERT INTO private_work_results(result_id,intent_id) VALUES($1,$2)',[randomUUID(),ai2.intentId]),sqlCode('23514'));
    assert.equal(await workVersion(f.workId),'4');
  } finally { await f.provider.close(); }
});

test('MODELSTEP-ADV final Result receipt INSERT wait crossing real lease expiry rolls back Result, pointer and Work CAS', async () => {
  const f = await stepFixture(undefined,api,1500), getEntered = barrier(), getRelease = barrier();
  let q: PoolClient | undefined;
  try {
    const s = await observe(await begin(await activate(f))); f.store.onGet=async()=>{getEntered.release();await getRelease.promise;};
    const outcome = Promise.allSettled([s.results.finalize(s.actor,{key:randomUUID(),stepId:s.activation.stepId,expectedVersion:s.recorded.aggregateVersion},s.observation)]);
    await getEntered.promise; q=await owner.connect(); await q.query('BEGIN');
    await q.query('LOCK TABLE scoped_command_receipts IN SHARE MODE'); getRelease.release(); await blockedBy(q);
    await waitUntil(Date.parse(s.activation.expiresAt)+5); await q.query('COMMIT'); q.release(); q=undefined;
    const completed = (await outcome)[0]; assert.equal(completed.status,'rejected');
    assert.equal((await scopedRows(f,'private_model_work_results')).length,0);
    assert.equal((await scopedRows(f,'private_work_result_index')).length,0); assert.equal((await scopedRows(f,'private_work_result_targets')).length,0);
    assert.equal(await workVersion(f.workId),'1'); assert.equal(f.store.puts,1); assert.equal(f.provider.requests.length,1);
    assert.equal((await f.steps.read(f.actor,{stepId:s.activation.stepId})).state,'awaiting_result');
    const row=(await owner.query('SELECT reservation_held,usage_status FROM model_text_steps WHERE step_id=$1',[s.activation.stepId])).rows[0];
    assert.deepEqual(row,{reservation_held:true,usage_status:'known'});
  } finally { getRelease.release(); if(q){await q.query('ROLLBACK');q.release();} await f.provider.close(); }
});

type Revocation = 'stop'|'grant'|'model'|'connection'|'family'|'export_revision'|'persistence_revision'|'work_edit'|'recovery'|'credential';
async function revoke(s: Awaited<ReturnType<typeof begin>>, kind: Revocation) {
  switch(kind) {
    case 'stop': await s.steps.control(s.actor,{key:randomUUID(),stepId:s.activation.stepId,expectedVersion:s.begun.metadata.aggregateVersion,action:'stop'}); break;
    case 'grant': await api.grants.revoke(s.actor,{key:randomUUID(),grantId:s.grant.grantId,expectedVersion:'1'}); break;
    case 'model': await api.models.revoke(s.actor,{key:randomUUID(),modelConnectionId:s.model.modelConnectionId,expectedVersion:'1'}); break;
    case 'connection': await createAgentConnections(app,hostOptions).revoke(s.actor,{key:randomUUID(),connectionId:s.initial.connectionId,expectedVersion:'1'}); break;
    case 'family': { const input=await refreshInput(s);await sessions.refresh(input);await assert.rejects(sessions.refresh(await refreshInput(s)),status(401));break; }
    case 'export_revision': await owner.query('UPDATE model_inference_export_policy SET revision=revision+1 WHERE policy_id=$1',[s.policyId]); break;
    case 'persistence_revision': await owner.query('UPDATE private_work_persistence_policy SET revision=revision+1 WHERE scope_id=$1',[s.context.scope.scope_id]); break;
    case 'work_edit': await owner.query("UPDATE work_items SET objective='New human objective',aggregate_version=aggregate_version+1 WHERE work_item_id=$1",[s.workId]); break;
    case 'recovery': s.recovery.generation='2'; break;
    case 'credential': s.recovery.credential='synthetic-rotated-fixture-key'; break;
  }
}

test('MODELSTEP-ADV committed Stop, exact backing revocation or recovery/credential change rejects a genuine capability before POST', async () => {
  for (const kind of ['stop','grant','model','connection','family','export_revision','persistence_revision','work_edit','recovery','credential'] as const) {
    const f=await stepFixture();
    try {
      const s=await begin(await activate(f));await revoke(s,kind);
      const before=await snapshot(f);await assert.rejects(s.host.dispatch(s.capability,s.contextBytes));
      assert.equal(s.provider.requests.length,0,kind);assert.equal(s.store.puts,0,kind);assert.deepEqual(await snapshot(f),before,kind);
      await assert.rejects(s.host.dispatch(s.capability,s.contextBytes));assert.equal(s.provider.requests.length,0,kind);
      assert.equal((await scopedRows(f,'private_model_work_results')).length,0);
    } finally {await f.provider.close();}
  }
});

test('MODELSTEP-ADV Stop or verified family reuse while an actual HTTP request is outstanding fences late output without a Result', async () => {
  for (const kind of ['stop','family','export_revision'] as const) {
    const entered=barrier(),release=barrier(),f=await stepFixture(async response=>{
      entered.release();await release.promise;response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(syntheticResponse()));
    });
    try {
      const s=await begin(await activate(f)),pending=s.host.dispatch(s.capability,s.contextBytes);
      await entered.promise;await revoke(s,kind);release.release();const observation=await pending;
      await unchangedAfter(f,()=>s.steps.record(s.actor,s.capability,observation));
      await assert.rejects(s.results.finalize(s.actor,{key:randomUUID(),stepId:s.activation.stepId,expectedVersion:'2'},observation));
      assert.equal(f.provider.requests.length,1);assert.equal(f.store.puts,0);assert.equal((await scopedRows(f,'private_model_work_results')).length,0);
      const unknown=await s.steps.unknown(s.actor,s.capability);assert.equal(unknown.state,'outcome_unknown');
      assert.equal((await owner.query('SELECT reservation_held FROM model_text_steps WHERE step_id=$1',[s.activation.stepId])).rows[0].reservation_held,true);
    } finally {release.release();await f.provider.close();}
  }
});

test('MODELSTEP-ADV recovery or credential changes during actual Asset GET verification reject final publication after PUT', async () => {
  for(const kind of ['recovery','credential'] as const) {
    const f=await stepFixture(),entered=barrier(),release=barrier();
    try {
      const s=await observe(await begin(await activate(f)));
      f.store.onGet=async()=>{entered.release();await release.promise;};
      const outcome=Promise.allSettled([s.results.finalize(s.actor,{key:randomUUID(),stepId:s.activation.stepId,expectedVersion:s.recorded.aggregateVersion},s.observation)]);
      await entered.promise;await revoke(s,kind);release.release();assert.equal((await outcome)[0].status,'rejected');
      assert.equal(f.store.puts,1);assert.equal(f.provider.requests.length,1);assert.equal(await workVersion(f.workId),'1');
      assert.equal((await scopedRows(f,'private_model_work_results')).length,0);assert.equal((await scopedRows(f,'private_work_result_targets')).length,0);
      assert.equal((await f.steps.read(f.actor,{stepId:s.activation.stepId})).state,'awaiting_result');
      await assert.rejects(s.results.finalize(s.actor,{key:randomUUID(),stepId:s.activation.stepId,expectedVersion:s.recorded.aggregateVersion},s.observation));
      assert.equal(f.store.puts,1);assert.equal(f.provider.requests.length,1);
    } finally {release.release();await f.provider.close();}
  }
});

test('MODELSTEP-ADV fresh caller observations never finalize; committed replay remains no-effect and denies onboarding or persistence withdrawal', async () => {
  const f=await stepFixture();
  try {
    const s=await observe(await begin(await activate(f))),input={key:randomUUID(),stepId:s.activation.stepId,expectedVersion:s.recorded.aggregateVersion};
    await unchangedAfter(f,()=>f.results.finalize(f.actor,input,{text:'Forged draft',modelReady:true,evidenceOrigin:'provider_https'} as never));
    assert.equal(f.store.puts,0);
    const result=await f.results.finalize(f.actor,input,s.observation);await api.grants.revoke(f.actor,{key:randomUUID(),grantId:f.grant.grantId,expectedVersion:'1'});
    assert.deepEqual(await f.results.finalize(f.actor,input,{} as never),result);assert.equal(f.store.puts,1);assert.equal(f.provider.requests.length,1);
    await owner.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[f.actor.user_id]);
    await assert.rejects(f.results.finalize(f.actor,input,{} as never),status(403));
    await owner.query('UPDATE users SET onboarding_required=false WHERE user_id=$1',[f.actor.user_id]);
    await owner.query('UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=false WHERE scope_id=$1',[f.context.scope.scope_id]);
    await assert.rejects(f.results.finalize(f.actor,input,{} as never),status(503));
    assert.equal(f.store.puts,1);assert.equal(f.provider.requests.length,1);assert.equal(await workVersion(f.workId),'2');
  }finally{await f.provider.close();}
});

test('MODELSTEP-ADV new begin and metadata-only begin replay revalidate after actual receipt SELECT waits across Grant expiry', async () => {
  for(const replay of [false,true]) {
    const short=createExecutionPrerequisites(app,{...hostOptions,grantTtlSeconds:1}),f=await stepFixture(undefined,short);
    let holder:PoolClient|undefined;
    try {
      const s=await activate(f),input={key:randomUUID(),stepId:s.activation.stepId,expectedVersion:'1'};
      if(replay) assert.ok((await s.steps.begin(s.actor,input)).capability);
      const before=await snapshot(f);holder=await owner.connect();await holder.query('BEGIN');
      await holder.query('LOCK TABLE scoped_command_receipts IN ACCESS EXCLUSIVE MODE');
      const outcome=Promise.allSettled([s.steps.begin(s.actor,input)]);await blockedBy(holder);
      await waitUntil(Date.parse(s.grant.expiresAt)+5);await holder.query('COMMIT');holder.release();holder=undefined;
      assert.equal((await outcome)[0].status,'rejected');assert.deepEqual(await snapshot(f),before);
      await unchangedAfter(f,()=>s.steps.begin(s.actor,input),status(409));assert.equal(f.provider.requests.length,0);assert.equal(f.store.puts,0);
    }finally{if(holder){await holder.query('ROLLBACK');holder.release();}await f.provider.close();}
  }
});

test('MODELSTEP-ADV recording genuine output rechecks recovery after actual receipt INSERT wait and rolls back known usage', async () => {
  const f=await stepFixture();let holder:PoolClient|undefined;
  try {
    const s=await begin(await activate(f)),observation=await s.host.dispatch(s.capability,s.contextBytes),before=await snapshot(f);
    holder=await owner.connect();await holder.query('BEGIN');await holder.query('LOCK TABLE scoped_command_receipts IN SHARE MODE');
    const outcome=Promise.allSettled([s.steps.record(s.actor,s.capability,observation)]);await blockedBy(holder);
    s.recovery.generation='2';await holder.query('COMMIT');holder.release();holder=undefined;
    assert.equal((await outcome)[0].status,'rejected');assert.deepEqual(await snapshot(f),before);
    assert.equal((await s.steps.read(s.actor,{stepId:s.activation.stepId})).state,'dispatched');
    assert.equal((await s.steps.read(s.actor,{stepId:s.activation.stepId})).usageStatus,'unknown');
    assert.equal(f.provider.requests.length,1);assert.equal(f.store.puts,0);
  }finally{if(holder){await holder.query('ROLLBACK');holder.release();}await f.provider.close();}
});

test('MODELSTEP-ADV human Work edit while actual Asset PUT is outstanding defeats model publication without holding Work locks across I/O', async () => {
  const f=await stepFixture(),entered=barrier(),release=barrier();
  try {
    const s=await observe(await begin(await activate(f)));f.store.onPut=async()=>{entered.release();await release.promise;};
    const outcome=Promise.allSettled([s.results.finalize(s.actor,{key:randomUUID(),stepId:s.activation.stepId,expectedVersion:s.recorded.aggregateVersion},s.observation)]);
    await entered.promise;const q=await owner.connect();
    try{await q.query('BEGIN');await q.query('SELECT work_item_id FROM work_items WHERE work_item_id=$1 FOR UPDATE NOWAIT',[s.workId]);
      await q.query("UPDATE work_items SET objective='Concurrent human edit',aggregate_version=aggregate_version+1 WHERE work_item_id=$1",[s.workId]);await q.query('COMMIT');
    }finally{await q.query('ROLLBACK');q.release();}
    release.release();assert.equal((await outcome)[0].status,'rejected');
    assert.equal(f.store.puts,1);assert.equal(f.provider.requests.length,1);assert.equal(await workVersion(f.workId),'2');
    assert.equal((await scopedRows(f,'private_model_work_results')).length,0);assert.equal((await scopedRows(f,'private_work_result_targets')).length,0);
    const retained=(await owner.query('SELECT state,usage_status,reservation_held FROM model_text_steps WHERE step_id=$1',[s.activation.stepId])).rows[0];
    assert.deepEqual(retained,{state:'awaiting_result',usage_status:'known',reservation_held:true});
    await assert.rejects(s.results.finalize(s.actor,{key:randomUUID(),stepId:s.activation.stepId,expectedVersion:s.recorded.aggregateVersion},s.observation));
    assert.equal(f.provider.requests.length,1);assert.equal(f.store.puts,1);
  }finally{release.release();await f.provider.close();}
});
