import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256, type AssetObjectKey, type PreparedRepresentation } from '../../packages/asset-storage/index.js';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { createDeviceAuthorizations } from '../../modules/agent-control/device-authorizations.js';
import { createBootstrapSessions } from '../../modules/agent-control/bootstrap-sessions.js';
import { createRuntimeRegistrationChallenge, parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createLocalFixtureModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { createPrivateResultService } from '../../modules/autopilot-work/results.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { type ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import type { BootstrapSessionHost } from '../../contracts/execution/v1/bootstrap-session.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('ModelStep adversarial tests require an explicit disposable fp_* TEST_DATABASE_URL.');
const schema = `fp_model_http_adv_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
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
const selection: ModelSelection = { providerRef: 'openai', modelRef: 'synthetic-text-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset', credentialCustody: 'local_keychain', engineLocation: 'runtime_local', billingSource: 'user_byok' };
const hash = (text: string) => createHash('sha256').update(text, 'ascii').digest('base64url');
async function dbNow() { return Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms); }
async function member() {
  const user = randomUUID(), community = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url'), session = tokenHash(token);
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic execution authority review')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [session, user, csrf]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: csrf };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, c) => c);
  return { actor, context, cookie: 'freedom_local_session=' + token };
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
    VALUES($1,'personal_execution',$2,$3,$4,'Synthetic model draft','PRIVATE_MODEL_HTTP_OBJECTIVE','draft',NULL,$5)`,
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

function syntheticResponse(text = 'PRIVATE_MODEL_HTTP_RESULT', model = selection.modelRef) {
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



import { Hono } from 'hono';
import { createMemberModelHttpTransport } from '../../apps/platform-api/src/routes/member-model-http.js';
import { createPrivateWorkTransport } from '../../apps/platform-api/src/routes/private-work-transport.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createPrivateAiProductTransport } from '../../apps/platform-api/src/private-ai-product.js';
import type { PlatformEnv } from '../../apps/platform-api/src/module-context.js';
import { ModelStepMetadataSchema, ModelStepApprovalMetadataSchema } from '../../contracts/execution/v2/model-step.js';
const origin = 'http://127.0.0.1:4310', base = '/api/v1/me';
const paths = { approvals: base + '/model-step-approvals', steps: base + '/model-steps', overview: base + '/model-step-overview' };
type Member = Awaited<ReturnType<typeof member>>;
type RequestApp = { request: (request: Request) => Response | Promise<Response> };
type SendOptions = { method?: string; body?: unknown; raw?: string | Uint8Array | ReadableStream<Uint8Array>; signal?: AbortSignal; headers?: Record<string,string|undefined> };
async function send(transport: RequestApp, path: string, human?: Member, input: SendOptions = {}) {
  const method = input.method ?? (input.body !== undefined || input.raw !== undefined ? 'POST' : 'GET');
  const headers = new Headers({ Origin: origin, ...(human ? { Cookie: human.cookie, 'X-CSRF-Token': human.actor.csrf_token } : {}),
    ...(!['GET','HEAD'].includes(method) ? { 'Content-Type':'application/json', 'Idempotency-Key':randomUUID(), 'If-Match':'"1"' } : {}) });
  for (const [k,v] of Object.entries(input.headers ?? {})) v === undefined ? headers.delete(k) : headers.set(k,v);
  const request = new Request(path.startsWith('http') ? path : origin + path, { method,headers,signal:input.signal,
    body: (input.raw ?? (input.body === undefined ? undefined : JSON.stringify(input.body))) as BodyInit|undefined, duplex:'half' } as RequestInit);
  const response = await transport.request(request), text = await response.text();
  assert.match(response.headers.get('Cache-Control') ?? '',/no-store/);
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  return {response,text,status:response.status,data:text ? JSON.parse(text) as Record<string,unknown> : null};
}
type Reply = Awaited<ReturnType<typeof send>>;
function failure(r: Reply,...codes:number[]) {
  assert.ok(codes.includes(r.status),`Expected ${codes.join('/')} received ${r.status}: ${r.text}`);
  assert.equal(r.response.headers.get('ETag'),null); assert.equal(r.response.headers.get('Access-Control-Allow-Origin'),null);
  if(r.text) { assert.deepEqual(Object.keys(r.data!).sort(),['code','detail','status','title','type']);
    assert.equal(r.data!.status,r.status);
    for(const secret of ['PRIVATE_MODEL_HTTP_','synthetic-fixture-key','password_hash','session_hash','SELECT ','INSERT ','stack','node_modules'])
      assert.ok(!r.text.includes(secret),`Failure leaks ${secret}`);
  }
}
async function httpFixture(onRequest?: (response: ServerResponse)=>Promise<void>) {
  const provider = await syntheticProvider(onRequest);
  try {
    const f = await fixture(), policyId = randomUUID();
    await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,
      selection,revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`,
      [policyId,f.context.scope.scope_id,f.context.subject_principal.principal_id,hostOptions.environment,hostOptions.clientId,JSON.stringify(selection)]);
    const recovery = { generation:'1', credential:'synthetic-fixture-key' };
    const modelHost = createLocalFixtureModelStepHost({ environment:'local',origin:provider.origin,
      recover:async()=>({generation:recovery.generation,expiresAt:new Date(Date.now()+90000).toISOString()}),
      resolveCredential:async()=>({key:new TextEncoder().encode(recovery.credential),expiresAt:new Date(Date.now()+90000).toISOString()}) });
    const store = new ObservedStore(), network = 'independent-' + randomUUID();
    const transport = await createMemberModelHttpTransport(app,{...hostOptions,origin,host:modelHost,store,
      resolvePolicy:resolvePrivateWorkPersistencePolicy,sourceNetwork:()=>network});
    const privateTransport = createPrivateWorkTransport(app,{origin,freedomEnv:'local',store});
    const human = createPrivateResultService(app,{store,resolvePolicy:resolvePrivateWorkPersistencePolicy});
    return {...f,provider,policyId,recovery,modelHost,store,network,transport,privateTransport,human};
  } catch(error) { await provider.close(); throw error; }
}
type HttpFixture = Awaited<ReturnType<typeof httpFixture>>;
function approvalBody(f: HttpFixture) { return {runId:f.run.runId,grantId:f.grant.grantId,expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20}; }
async function activateHttp(f: HttpFixture) {
  const a = await send(f.transport,paths.approvals,f,{body:approvalBody(f)}); assert.equal(a.status,201,a.text);
  const approval = ModelStepApprovalMetadataSchema.parse(a.data);
  const s = await send(f.transport,paths.steps,f,{body:{approvalId:approval.approvalId,expectedRunVersion:'1'}}); assert.equal(s.status,201,s.text);
  const step = ModelStepMetadataSchema.parse(s.data); assert.equal(step.state,'reserved');
  assert.equal(step.operational_authority,false);
  return {...f,approval,step};
}
async function snapshot(f: HttpFixture) {
  const rows:Record<string,unknown>={};
  for(const table of ['work_items','execution_runs','execution_grants','execution_attempts','model_export_approvals','model_text_steps',
    'private_model_work_results','private_work_results','scoped_command_receipts','scoped_transition_journal','scoped_outbox'])
    rows[table]=await scopedRows(f,table);
  return rows;
}
async function rejected(f: HttpFixture,task:()=>Promise<Reply>,...codes:number[]) {
  const before = await snapshot(f), r = await task(); failure(r,...codes); assert.deepEqual(await snapshot(f),before); return r;
}
async function completedHuman(f: HttpFixture,text:string,version:string) {
  const bytes=new TextEncoder().encode(text);
  const prepared=await f.human.prepare(f.actor,{key:randomUUID(),targetWorkId:f.workId,expectedVersion:version,contentType:'text/plain',byteSize:bytes.byteLength,sha256:await sha256(bytes)});
  const lease=await f.human.claim(f.actor,{key:randomUUID(),intentId:prepared.intentId});
  const input={key:randomUUID(),intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  await f.human.write(f.actor,{...input,key:randomUUID()},new ReadableStream({start(c){c.enqueue(bytes);c.close();}}));
  return f.human.finalize(f.actor,input);
}

// Independent runtime tests use real PostgreSQL transactions and signed 091
// enrollment, real loopback model HTTP, and a byte-validating in-memory ObjectStore.
// They exercise the actual Asset lifecycle and Result publication services.
// They do not establish remote provider authentication, billing or readiness.
test('MODEL-HTTP-ADV consent to active Attempt to one HTTP execute and private AI/human history',async()=>{
  await verifyRoles(); const f=await httpFixture();
  try {
    const s=await activateHttp(f), key=randomUUID(), path=paths.steps+'/'+s.step.stepId+':execute';
    const attempt=(await owner.query('SELECT state FROM execution_attempts WHERE attempt_id=$1',[s.step.attemptId])).rows[0];
    assert.equal(attempt.state,'active');
    const result=await send(f.transport,path,f,{body:{},headers:{'Idempotency-Key':key}}); assert.equal(result.status,200,result.text);
    const dto=ModelStepMetadataSchema.parse(result.data); assert.equal(dto.state,'succeeded');
    assert.equal(f.provider.requests.length,1); assert.equal(f.store.puts,1); assert.equal(await workVersion(f.workId),'2');
    assert.ok(!result.text.includes('PRIVATE_MODEL_HTTP_')); assert.ok(!result.text.includes('synthetic-fixture-key'));
    const current=await send(f.privateTransport,'/me/private-work/'+f.workId+'/results/current',f);
    assert.equal(current.status,200,current.text); assert.equal(current.data!.text,'PRIVATE_MODEL_HTTP_RESULT'); assert.equal(current.data!.provenance,'model');
    const outsider=await member(),resultId=current.data!.resultId as string;
    for(const route of ['/me/private-work/'+f.workId+'/results/current','/me/private-work/'+f.workId+'/results/'+resultId,'/me/private-work/'+f.workId+'/results'])
      for(const method of ['GET','HEAD']) {const r=await send(f.privateTransport,route,outsider,{method,headers:{Range:'bytes=0-8','If-None-Match':'*'}});failure(r,404);assert.ok(!r.text.includes('PRIVATE_MODEL_HTTP_RESULT'));}
    const gets=f.store.gets;
    await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1 WHERE scope_id=$1',[f.context.scope.scope_id]);
    failure(await send(f.privateTransport,'/me/private-work/'+f.workId+'/results/current',f),403,503);assert.equal(f.store.gets,gets);
    await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=true,revision=revision+1 WHERE scope_id=$1',[f.context.scope.scope_id]);
    const replay=await send(f.transport,path,f,{body:{},headers:{'Idempotency-Key':key}}); failure(replay,409);
    assert.equal(f.provider.requests.length,1); assert.equal(f.store.puts,1);
    await completedHuman(f,'PRIVATE_MODEL_HTTP_HUMAN','2');
    const history=await send(f.privateTransport,'/me/private-work/'+f.workId+'/results',f); assert.equal(history.status,200,history.text);
    const items=history.data!.items as {revision:string;provenance:string}[];
    assert.deepEqual(items.map(i=>[i.revision,i.provenance]),[['2','human'],['1','model']]);
    const journals=JSON.stringify((await scopedRows(f,'scoped_outbox')).concat(await scopedRows(f,'scoped_transition_journal')));
    assert.ok(!journals.includes('PRIVATE_MODEL_HTTP_RESULT')); assert.ok(!journals.includes('PRIVATE_MODEL_HTTP_HUMAN'));
  } finally {await f.provider.close();}
});

test('MODEL-HTTP-ADV owner discovery excludes outsider and admin; hostile origin/session/credentials/body do not write',async()=>{
  const f=await httpFixture();
  try {
    const s=await activateHttp(f), outsider=await member();
    await owner.query("INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,'Synthetic admin')",[randomUUID(),outsider.actor.community_id,outsider.actor.email]);
    for(const human of [outsider,undefined]) for(const route of [paths.approvals+'/'+s.approval.approvalId,paths.steps+'/'+s.step.stepId])
      await rejected(f,()=>send(f.transport,route,human),human?404:401);
    await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit) VALUES($1,$2,'work.private-draft',1,true,1048576)`,[outsider.context.scope.scope_id,outsider.context.subject_principal.principal_id]);
    const overview=await send(f.transport,paths.overview,outsider); assert.equal(overview.status,200,overview.text);
    assert.ok(!overview.text.includes(f.workId)); assert.ok(!overview.text.includes(s.step.stepId));
    const mine=await send(f.transport,paths.overview,f); assert.equal(mine.status,200,mine.text); assert.ok(mine.text.includes(f.workId));
    const path=paths.steps+'/'+s.step.stepId+':execute';
    for(const headers of [{Origin:undefined},{Origin:'https://attacker.example.invalid'},{'X-CSRF-Token':undefined},
      {Authorization:'DPoP '+f.initial.accessToken},{DPoP:f.enrollmentProof},{'X-Freedom-Connection':f.initial.connectionId},
      {'Sec-Fetch-Site':'cross-site'},{Host:'attacker.example.invalid'}])
      await rejected(f,()=>send(f.transport,path,f,{body:{},headers}),403);
    for(const body of [{modelReady:true},{operational_authority:true},{host:{origin:f.provider.origin}},{result:'PRIVATE_MODEL_HTTP_FORGED'},
      {credential:'synthetic-fixture-key'},{capability:{}},{expectedVersion:'1'},{key:randomUUID()},{tools:[]}])
      await rejected(f,()=>send(f.transport,path,f,{body}),400,422);
    for(const raw of ['{"x":1,"x":2}',String.raw`{"\u006bey":"a","key":"b"}`,'{"__proto__":{}}','[]','{"x":NaN}'])
      await rejected(f,()=>send(f.transport,path,f,{raw}),400,422);
    assert.equal(f.provider.requests.length,0); assert.equal(f.store.puts,0);
    await owner.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[f.actor.session_hash]);
    await rejected(f,()=>send(f.transport,path,f,{body:{}}),401);
  } finally {await f.provider.close();}
});

test('MODEL-HTTP-ADV strict versions, idempotency, methods, Range and conditional reads cannot dispatch',async()=>{
  const f=await httpFixture();
  try {
    const s=await activateHttp(f), path=paths.steps+'/'+s.step.stepId, execute=path+':execute';
    for(const method of ['HEAD','OPTIONS','PUT','DELETE']) {const r=await rejected(f,()=>send(f.transport,path,f,{method}),405); if(method==='HEAD')assert.equal(r.text,'');}
    for(const headers of [{Range:'bytes=0-5'},{'If-None-Match':'"1"'},{'If-Range':'"1"'}])
      await rejected(f,()=>send(f.transport,path,f,{headers}),400);
    await rejected(f,()=>send(f.transport,execute,f,{body:{},headers:{'If-Match':undefined}}),428);
    for(const value of ['1','*','W/"1"','"01"','"0"','"1", "2"','"9223372036854775808"'])
      await rejected(f,()=>send(f.transport,execute,f,{body:{},headers:{'If-Match':value}}),400);
    await rejected(f,()=>send(f.transport,execute,f,{body:{},headers:{'If-Match':'"2"'}}),412);
    for(const value of [undefined,'short','bad key','x'.repeat(129)])
      await rejected(f,()=>send(f.transport,execute,f,{body:{},headers:{'Idempotency-Key':value}}),400);
    for(const route of [origin.replace('4310','4311')+path,path+'?modelReady=true',path+'#private',path.replace('/me/','/%6de/')])
      await rejected(f,()=>send(f.transport,route,f),403);
    assert.equal(f.provider.requests.length,0); assert.equal(f.store.puts,0);
  } finally {await f.provider.close();}
});

test('MODEL-HTTP-ADV forged injected Actor and hostile unread stream cannot bypass cookie/current CSRF',async()=>{
  const f=await httpFixture();
  try {
    const s=await activateHttp(f), path=paths.steps+'/'+s.step.stepId+':execute', wrapped=new Hono<PlatformEnv>();
    wrapped.use('*',async(c,next)=>{c.set('actor',f.actor);await next();});wrapped.route('/',f.transport);
    await rejected(f,()=>send(wrapped,path,undefined,{body:{}}),401);
    for(const human of [undefined,f]) {
      let pulled=0; const raw=new ReadableStream<Uint8Array>({pull(){pulled++;throw Error('PRIVATE_MODEL_HTTP_STREAM');}},{highWaterMark:0});
      await rejected(f,()=>send(f.transport,path,human,{raw,...(human?{headers:{'X-CSRF-Token':undefined}}:{})}),human?403:401);
      assert.equal(pulled,0);
    }
  } finally {await f.provider.close();}
});

test('MODEL-HTTP-ADV stop, approval revoke, Grant/family and policy revocation before execute send zero model POST',async()=>{
  for(const kind of ['stop','pause','approval','grant','family','export','persistence','scope'] as const) {
    const f=await httpFixture();
    try {
      const s=await activateHttp(f), path=paths.steps+'/'+s.step.stepId;
      if(kind==='stop'||kind==='pause') {const r=await send(f.transport,path+':'+kind,f,{body:{}});assert.equal(r.status,200,r.text);}
      if(kind==='approval') {const r=await send(f.transport,paths.approvals+'/'+s.approval.approvalId+':revoke',f,{body:{}});assert.equal(r.status,200,r.text);}
      if(kind==='grant')await api.grants.revoke(f.actor,{key:randomUUID(),grantId:f.grant.grantId,expectedVersion:'1'});
      if(kind==='family'){await sessions.refresh(await refreshInput(f));await assert.rejects(sessions.refresh(await refreshInput(f)),status(401));}
      if(kind==='export')await owner.query('UPDATE model_inference_export_policy SET revision=revision+1 WHERE policy_id=$1',[f.policyId]);
      if(kind==='persistence')await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1 WHERE scope_id=$1',[f.context.scope.scope_id]);
      if(kind==='scope')await owner.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1",[f.context.scope.scope_id]);
      const r=await send(f.transport,path+':execute',f,{body:{},headers:{'If-Match':kind==='stop'||kind==='pause'?'"2"':'"1"'}});
      failure(r,403,404,409,503); assert.equal(f.provider.requests.length,0,kind);assert.equal(f.store.puts,0,kind);
    } finally {await f.provider.close();}
  }
});

test('MODEL-HTTP-ADV concurrent execution commits one model POST and missing ACK cannot resend',async()=>{
  const entered=barrier(),release=barrier(),f=await httpFixture(async response=>{entered.release();await release.promise;response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(syntheticResponse()));});
  try {
    const s=await activateHttp(f),path=paths.steps+'/'+s.step.stepId+':execute',key=randomUUID();
    const first=send(f.transport,path,f,{body:{},headers:{'Idempotency-Key':key}});await entered.promise;
    const second=await send(f.transport,path,f,{body:{},headers:{'Idempotency-Key':key}});
    assert.equal(second.status,200,second.text);assert.equal(second.data!.state,'dispatched');assert.equal(f.provider.requests.length,1);
    const different=await send(f.transport,path,f,{body:{}});failure(different,412);
    release.release();const completed=await first;assert.equal(completed.status,200,completed.text);assert.equal(f.provider.requests.length,1);assert.equal(f.store.puts,1);
  } finally {release.release();await f.provider.close();}
  const lost=await httpFixture(async response=>{response.destroy();});
  try {
    const s=await activateHttp(lost),path=paths.steps+'/'+s.step.stepId+':execute',key=randomUUID();
    const first=await send(lost.transport,path,lost,{body:{},headers:{'Idempotency-Key':key}});failure(first,409,503,500);
    const replay=await send(lost.transport,path,lost,{body:{},headers:{'Idempotency-Key':key}});failure(replay,409);
    const read=await send(lost.transport,paths.steps+'/'+s.step.stepId,lost);assert.equal(read.status,200,read.text);assert.equal(read.data!.state,'outcome_unknown');assert.equal(lost.provider.requests.length,1);assert.equal(lost.store.puts,0);
    failure(await send(lost.transport,path,lost,{body:{},headers:{'If-Match':'"3"'}}),409,412);assert.equal(lost.provider.requests.length,1);
  } finally {await lost.provider.close();}
});


test('MODEL-HTTP-ADV durable rate bucket ignores spoofed network headers and rejects before reading a body',async()=>{
  const f=await httpFixture();
  try {
    const before=await snapshot(f),path=paths.steps+'/'+randomUUID();
    for(let i=0;i<60;i++)failure(await send(f.transport,path,f,{headers:{'CF-Connecting-IP':'203.0.113.'+(i+1),'X-Forwarded-For':randomUUID()}}),404);
    const capped=await send(f.transport,path,f,{headers:{'CF-Connecting-IP':'198.51.100.8'}});failure(capped,429);
    assert.equal(capped.response.headers.get('Retry-After'),'60');
    let pulled=0;const raw=new ReadableStream<Uint8Array>({pull(){pulled++;throw Error('PRIVATE_MODEL_HTTP_LIMIT');}},{highWaterMark:0});
    failure(await send(f.transport,paths.approvals,f,{raw}),429);assert.equal(pulled,0);
    assert.deepEqual(await snapshot(f),before);assert.equal(f.provider.requests.length,0);
  } finally {await f.provider.close();}
});

test('MODEL-HTTP-ADV historical owner metadata retains controls while current session/scope/onboarding govern every read',async()=>{
  for(const kind of ['policy','onboarding','scope','session'] as const) {
    const f=await httpFixture();
    try {
      const s=await activateHttp(f);
      if(kind==='policy')await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1 WHERE scope_id=$1',[f.context.scope.scope_id]);
      if(kind==='onboarding')await owner.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[f.actor.user_id]);
      if(kind==='scope')await owner.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1",[f.context.scope.scope_id]);
      if(kind==='session')await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
      for(const path of [paths.overview,paths.steps+'/'+s.step.stepId,paths.approvals+'/'+s.approval.approvalId]) {
        if(kind==='policy') {
          const r=await send(f.transport,path,f);assert.equal(r.status,200,r.text);
          if(path===paths.overview){assert.equal(r.data!.persistenceAvailable,false);assert.deepEqual(r.data!.works,[]);assert.deepEqual(r.data!.allowedSelections,[]);}
          assert.ok(!r.text.includes('PRIVATE_MODEL_HTTP_OBJECTIVE'));assert.ok(!r.text.includes('PRIVATE_MODEL_HTTP_RESULT'));
        } else await rejected(f,()=>send(f.transport,path,f),401,403,404,409,503);
      }
      if(kind==='policy') {
        const stopped=await send(f.transport,paths.steps+'/'+s.step.stepId+':stop',f,{body:{}});assert.equal(stopped.status,200,stopped.text);assert.equal(stopped.data!.state,'cancelled');
        failure(await send(f.privateTransport,'/me/private-work/'+f.workId+'/results/current',f),403,503);
      }
      assert.equal(f.provider.requests.length,0);assert.equal(f.store.puts,0);
    } finally {await f.provider.close();}
  }
});


test('MODEL-HTTP-ADV actual createApp composes original HTTP consent/execution/private Result and default remains unavailable',async()=>{
  const f=await httpFixture();
  try {
    const port=await createPrivateAiProductTransport(app,{origin,...hostOptions,host:f.modelHost,store:f.store,sourceNetwork:()=>f.network});
    const product=createApp(app,origin,'local',{privateAiProduct:port});
    assert.throws(()=>createApp(app,origin,'local',{privateAiProduct:{} as never}),/invalid_private_ai_product_binding/);
    assert.throws(()=>createApp(owner,origin,'local',{privateAiProduct:port}),/invalid_private_ai_product_binding/);
    assert.throws(()=>createApp(app,'http://127.0.0.1:4311','local',{privateAiProduct:port}),/invalid_private_ai_product_binding/);
    const unconfigured=createApp(app,origin,'local');
    for(const path of [paths.overview,paths.approvals,paths.steps]) {
      const denied=await send(unconfigured,path,f,path===paths.overview?{}:{body:{}});failure(denied,503);
      assert.equal(denied.data!.code,'private_ai_product_unavailable');
    }
    const adapted={...f,transport:product as typeof f.transport},s=await activateHttp(adapted);
    const legacy=await send(product,base+'/execution-runs/'+f.run.runId,f);failure(legacy,409);assert.equal(legacy.data!.code,'execution_run_profile_required');assert.equal(legacy.data!.aggregateVersion,undefined);
    await rejected(f,()=>send(product,paths.steps+'/'+s.step.stepId+':execute',f,{raw:String.raw`{"host":"private","\u0068ost":"override"}`}),400);
    const executed=await send(product,paths.steps+'/'+s.step.stepId+':execute',f,{body:{}});assert.equal(executed.status,200,executed.text);
    assert.equal(executed.data!.state,'succeeded');assert.equal(f.provider.requests.length,1);assert.equal(f.store.puts,1);
    const current=await send(product,base+'/private-work/'+f.workId+'/results/current',f);assert.equal(current.status,200,current.text);
    assert.equal(current.data!.text,'PRIVATE_MODEL_HTTP_RESULT');assert.equal(current.data!.provenance,'model');
    const other=await member();
    const adminOnly=await send(product,base+'/private-work/'+f.workId+'/results/current',undefined,{headers:{'Cf-Access-Jwt-Assertion':'synthetic-admin-access'}});failure(adminOnly,401);
    const notOwner=await send(product,base+'/private-work/'+f.workId+'/results/current',other);failure(notOwner,404);
    const health=await product.request(new Request(origin+'/api/v1/health'));assert.equal(health.status,200);
    const games=await product.request(new Request(origin+base+'/game-console',{headers:{Cookie:f.cookie}}));
    assert.ok(!(await games.text()).includes('PRIVATE_MODEL_HTTP_RESULT'));
    const logs=JSON.stringify((await scopedRows(f,'scoped_outbox')).concat(await scopedRows(f,'scoped_transition_journal')));
    assert.ok(!logs.includes('PRIVATE_MODEL_HTTP_RESULT'));assert.ok(!logs.includes('synthetic-fixture-key'));
  } finally {await f.provider.close();}
});

test('MODEL-HTTP-ADV in-flight Stop/family reuse/policy revision fences late provider output and retains spent reservation',async()=>{
  for(const kind of ['stop','family','export'] as const) {
    const entered=barrier(),release=barrier(),f=await httpFixture(async response=>{entered.release();await release.promise;response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(syntheticResponse()));});
    try {
      const s=await activateHttp(f),path=paths.steps+'/'+s.step.stepId,key=randomUUID();
      const pending=send(f.transport,path+':execute',f,{body:{},headers:{'Idempotency-Key':key}});await entered.promise;
      if(kind==='stop') {
        const stopped=await send(f.transport,path+':stop',f,{body:{},headers:{'If-Match':'"2"'}});assert.equal(stopped.status,200,stopped.text);assert.equal(stopped.data!.state,'outcome_unknown');
      }
      if(kind==='family'){await sessions.refresh(await refreshInput(f));await assert.rejects(sessions.refresh(await refreshInput(f)),status(401));}
      if(kind==='export')await owner.query('UPDATE model_inference_export_policy SET revision=revision+1 WHERE policy_id=$1',[f.policyId]);
      release.release();failure(await pending,503);
      assert.equal(f.provider.requests.length,1);assert.equal(f.store.puts,0);assert.equal((await scopedRows(f,'private_model_work_results')).length,0);
      assert.equal((await owner.query('SELECT reservation_held FROM model_text_steps WHERE step_id=$1',[s.step.stepId])).rows[0].reservation_held,true);
      failure(await send(f.transport,path+':execute',f,{body:{},headers:{'Idempotency-Key':key}}),409);assert.equal(f.provider.requests.length,1);
    } finally {release.release();await f.provider.close();}
  }
});

test('MODEL-HTTP-ADV approval requires explicit consent and rejects caller authority before host/provider work',async()=>{
  const f=await httpFixture();
  try {
    for(const body of [{...approvalBody(f),consent:false},{...approvalBody(f),consent:undefined},{...approvalBody(f),maxOutputTokens:21},
      {...approvalBody(f),modelReady:true},{...approvalBody(f),policyRevision:'1'},{...approvalBody(f),hostOrigin:f.provider.origin},
      {...approvalBody(f),selection},{...approvalBody(f),expectedRunVersion:'1'},{...approvalBody(f),operational_authority:true}])
      await rejected(f,()=>send(f.transport,paths.approvals,f,{body}),400,403,422);
    assert.equal(f.provider.requests.length,0);assert.equal(f.provider.probes.length,0);assert.equal(f.store.puts,0);
  } finally {await f.provider.close();}
});


test('MODEL-HTTP-ADV real createApp private Work envelope rejects foreign reads, credential mixing and duplicate bodies',async()=>{
  const f=await httpFixture();
  try {
    const port=await createPrivateAiProductTransport(app,{origin,...hostOptions,host:f.modelHost,store:f.store,sourceNetwork:()=>f.network});
    const product=createApp(app,origin,'local',{privateAiProduct:port}),path=base+'/private-work/'+f.workId;
    for(const url of ['http://localhost:4310'+path,'http://127.0.0.1:4311'+path,'https://127.0.0.1:4310'+path])
      await rejected(f,()=>send(product,url,f),403);
    for(const headers of [{Origin:'https://attacker.example.invalid'},{Origin:'null'},{Host:'127.0.0.1:4311'},
      {Authorization:'Bearer synthetic-fixture-key'},{Authorization:'DPoP '+f.initial.accessToken},{DPoP:f.enrollmentProof},
      {'X-Freedom-Connection':f.initial.connectionId},{'Sec-Fetch-Site':'same-site'}])
      await rejected(f,()=>send(product,path,f,{headers}),403);
    await rejected(f,()=>send(product,path+'/edit',f,{raw:String.raw`{"title":"safe","\u0074itle":"PRIVATE_MODEL_HTTP_FORGED","objective":"injected"}`}),400);
    await rejected(f,()=>send(product,base+'/private-work',f,{raw:String.raw`{"title":"safe","objective":"one","\u006fbjective":"PRIVATE_MODEL_HTTP_FORGED"}`,headers:{'If-Match':undefined}}),400);
    let pulled=0;const stream=new ReadableStream<Uint8Array>({pull(){pulled++;throw Error('PRIVATE_MODEL_HTTP_ENVELOPE');}},{highWaterMark:0});
    await rejected(f,()=>send(product,path+'/edit',f,{raw:stream,headers:{Origin:'https://attacker.example.invalid'}}),403);assert.equal(pulled,0);
    const read=await send(product,path,f);assert.equal(read.status,200,read.text);assert.equal(read.data!.aggregate_version,1);
    const health=await product.request(new Request(origin+'/api/v1/health'));assert.equal(health.status,200);
    assert.equal(f.provider.requests.length,0);assert.equal(f.store.puts,0);
  } finally {await f.provider.close();}
});

test('MODEL-HTTP-ADV actual private Work streams enforce byte/chunk/declared-length bounds, abort, and a real five-second deadline',async()=>{
  const f=await httpFixture();
  try {
    const port=await createPrivateAiProductTransport(app,{origin,...hostOptions,host:f.modelHost,store:f.store,sourceNetwork:()=>f.network});
    const product=createApp(app,origin,'local',{privateAiProduct:port}),path=base+'/private-work/'+f.workId+'/edit';
    await rejected(f,()=>send(product,path,f,{raw:' '.repeat(32769)}),413);
    await rejected(f,()=>send(product,path,f,{raw:'{}',headers:{'Content-Length':'3'}}),400);
    let chunks=0;const endless=new ReadableStream<Uint8Array>({pull(c){chunks++;c.enqueue(new Uint8Array());}},{highWaterMark:0});
    await rejected(f,()=>send(product,path,f,{raw:endless}),413);assert.equal(chunks,129);
    const entered=barrier(),controller=new AbortController();let abortedCancel=false;
    const aborted=new ReadableStream<Uint8Array>({pull(){entered.release();return new Promise<void>(()=>{});},cancel(){abortedCancel=true;return new Promise<void>(()=>{});}},{highWaterMark:0});
    const pending=send(product,path,f,{raw:aborted,signal:controller.signal});await entered.promise;controller.abort();
    await rejected(f,()=>pending,400);assert.equal(abortedCancel,true);
    let timedCancel=false;const hanging=new ReadableStream<Uint8Array>({pull(){return new Promise<void>(()=>{});},cancel(){timedCancel=true;return new Promise<void>(()=>{});}},{highWaterMark:0});
    const started=performance.now();const timed=await rejected(f,()=>send(product,path,f,{raw:hanging}),408);
    const elapsed=performance.now()-started;assert.equal(timed.data!.code,'body_timeout');assert.ok(elapsed>=4900&&elapsed<8000,`Actual bounded timer took ${elapsed} ms`);assert.equal(timedCancel,true);
    assert.equal(await workVersion(f.workId),'1');assert.equal(f.provider.requests.length,0);assert.equal(f.store.puts,0);
  } finally {await f.provider.close();}
});
