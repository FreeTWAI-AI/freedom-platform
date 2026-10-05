import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { hashPassword, login } from '../../modules/identity-membership/service.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { type DeviceAuthorizationHost } from '../../contracts/execution/v1/device-pairing.js';
import { createBootstrapHttpTransport } from '../../apps/platform-api/src/routes/bootstrap-http.js';
// @ts-expect-error Dependency-free machine SDK is exported as native JavaScript.
import { createMachineDeviceClient, MachineDeviceError } from '../../packages/sdk/machine-device-client.mjs';
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_machine_sdk_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({connectionString});
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({connectionString:roleUrl(migrator),options:`-c search_path=${schema} -c statement_timeout=10000`});
const app = new Pool({connectionString:roleUrl(runtime),options:`-c search_path=${schema} -c statement_timeout=10000`,max:12});
let created = false;
let transport: Awaited<ReturnType<typeof createBootstrapHttpTransport>>, signingKey: CryptoKey;
const origin = 'https://platform.example.invalid';
const paths = {begin:'/execution-api/v1/auth/device-authorizations',token:'/execution-api/v1/auth/token',nonce:'/execution-api/v1/auth/nonce',
  status:'/execution-api/v1/bootstrap',inspect:'/api/v1/me/device-authorizations/inspect',decide:'/api/v1/me/device-authorizations/decide',list:'/api/v1/me/agent-connections'};
const issuer = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const host: DeviceAuthorizationHost = {environment:'local',clientId:'machine-sdk-synthetic',issuer:'https://issuer.example.invalid/',audience:origin+'/',
  bootstrapUri:origin+paths.status,beginUri:origin+paths.begin,pollUri:origin+paths.token,verificationUri:origin+'/device',clientDisplayName:'Synthetic client',
  issuerKid:'synthetic-issuer',keys:[{kid:'synthetic-issuer',purpose:'bootstrap_access',environment:'local',publicJwk:parseRuntimePublicJwk(issuer.publicKey.export({format:'jwk'})),
    notBeforeMs:0,notAfterMs:Number.MAX_SAFE_INTEGER,revoked:false}]};
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
  const q = await owner.connect();
  try { await q.query(prefix); const rows=await q.query(grants); assert.equal(rows.rowCount,2);
    for (const row of rows.rows) await q.query(Object.values(row)[0] as string); await q.query('COMMIT'); }
  catch(error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  signingKey = await crypto.subtle.importKey('jwk',issuer.privateKey.export({format:'jwk'}),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  // Only this synthetic host supplies a network port using an explicit test header.
  transport = await createBootstrapHttpTransport(app,{host,signingKey,sourceNetwork:()=>randomUUID()});
});
after(async () => { await app.end(); await owner.end();
  try { if(created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); } });

type Hook = (request: Request, send: () => Promise<Response>) => Promise<Response>;
const secrets = new Set<string>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function collect(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['deviceCode','userCode','enrollmentProof','accessToken','handle','refreshHandle'].includes(key) && typeof item === 'string') secrets.add(item);
    else collect(item);
  }
}
async function machine(hook?: Hook, options: Record<string, unknown> = {}) {
  let calls = 0;
  const client = await createMachineDeviceClient({ origin, environment: host.environment, clientId: host.clientId, ...options,
    fetch: async (url: string, init: RequestInit) => {
      calls++; assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
      const request = new Request(url, init);
      for (const header of ['Cookie','X-CSRF-Token','Origin']) assert.equal(request.headers.has(header), false);
      if ([paths.begin, paths.token].includes(new URL(url).pathname)) assert.equal(request.headers.has('Authorization'), false);
      secrets.add(request.headers.get('DPoP')!);
      if (request.method === 'POST') collect(await request.clone().json());
      const send = async () => {
        const response = await transport.fetch(request);
        if (response.ok) collect(await response.clone().json());
        return response;
      };
      return hook ? hook(request, send) : send();
    } });
  return { client, calls: () => calls };
}
// A separate genuine member login/HTTP boundary approves the device. The
// machine never receives this session, CSRF or member Actor.
async function approve(userCode: string, decision = 'approve') {
  const user = randomUUID(), community = randomUUID(), password = 'synthetic-member-password';
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic device SDK community')", [community]);
  await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic device SDK member',$4,$5)`, [user, community, user+'@example.invalid', hashPassword(password), randomUUID()]);
  const { token, actor } = await login(app, user+'@example.invalid', password);
  await withMemberScope(app, { actor, scope: 'personal' }, async()=>{}, async()=>{});
  const headers = { Cookie: 'freedom_local_session='+token, 'X-CSRF-Token': actor.csrf_token, Origin: origin,
    'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
  const reviewResponse = await transport.request(origin+paths.inspect, { method:'POST', headers, body: JSON.stringify({ userCode }) });
  assert.equal(reviewResponse.status, 200);
  const review = await reviewResponse.json();
  assert.equal(review.scope, 'bootstrap.status.read'); assert.equal(review.operational_authority, false);
  const response = await transport.request(origin+paths.decide, { method:'POST', headers,
    body: JSON.stringify({ userCode, authorizationId: review.authorizationId, requestDigest: review.requestDigest, decision }) });
  assert.equal(response.status, 200);
  return { actor, headers, authorizationId: review.authorizationId };
}
async function ready(hook?: Hook) {
  const device = await machine(hook), begun = await device.client.begin(), member = await approve(begun.userCode);
  const session = await device.client.pair();
  assert.equal(session.refreshGeneration, '1'); assert.equal(session.operational_authority, false);
  return { ...device, ...member, session };
}
const rejects = async (action: Promise<unknown>, code: string) => assert.rejects(action, (error: unknown) =>
  error instanceof MachineDeviceError && (error as {code:string}).code === code);

test('machine SDK uses genuine HTTP/PG pairing, independent member approval, refresh and repeated sessionless status', async () => {
  for (const [pool, name] of [[owner, migrator], [app, runtime]] as const) assert.deepEqual((await pool.query(
    'SELECT current_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
  { current_user: name, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  assert.equal(signingKey.extractable, false);
  const f = await ready();
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  const next = await f.client.refresh(); assert.equal(next.refreshGeneration, '2');
  for (let i = 0; i < 2; i++) {
    const status = await f.client.readStatus();
    assert.equal(status.connectionId, f.session.connectionId); assert.equal(status.operation, 'bootstrap.status.read');
    assert.equal(status.operational_authority, false); assert.equal(status.state, 'active');
  }
  const serialized = JSON.stringify([f.session, next, f.client]);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, 'public SDK output leaked sensitive material');
  f.client.close();
  await rejects(f.client.refresh(), 'client_unavailable');
});

test('member deny, wrong environment and foreign device key cannot establish a session', async () => {
  const denied = await machine(), begun = await denied.client.begin(); await approve(begun.userCode, 'deny');
  assert.equal((await denied.client.pair()).status, 'access_denied');
  await rejects(denied.client.refresh(), 'client_unavailable');
  const wrong = await machine(undefined, { environment: 'next' }); await rejects(wrong.client.begin(), 'http_rejected');
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const foreign = await machine(async (request) => {
    const parts = request.headers.get('DPoP')!.split('.');
    const data = parts[0]+'.'+parts[1];
    request.headers.set('DPoP', data+'.'+sign('sha256', Buffer.from(data), { key: other.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'));
    return transport.fetch(request);
  });
  await rejects(foreign.client.begin(), 'http_rejected');
});

test('member revoke immediately denies machine status and refresh without model or member login', async () => {
  const f = await ready();
  const response = await transport.request(origin+paths.list+'/'+f.session.connectionId+':revoke', { method: 'POST',
    headers: { ...f.headers, 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, body: '{}' });
  assert.equal(response.status, 200);
  await rejects(f.client.readStatus(), 'http_rejected');
  await rejects(f.client.refresh(), 'refresh_outcome_unknown');
  const calls = f.calls(); await rejects(f.client.refresh(), 'client_unavailable'); assert.equal(f.calls(), calls);
});

test('genuine expired proof is rejected by the server verifier', async () => {
  // Signing time is deliberately old in this isolated serial test. Server time
  // remains the real DB clock; no SQL deadline or proof verifier is replaced.
  const current = Date.now;
  Date.now = () => current() - 120000;
  try { const f = await machine(); await rejects(f.client.begin(), 'http_rejected'); }
  finally { Date.now = current; }
});

test('lost committed enrollment response is terminal and process restart has no importable secret', async () => {
  let exchanges = 0;
  const f = await machine(async (request, send) => {
    const body = request.method === 'POST' ? await request.clone().json() : {};
    const response = await send();
    if (body.enrollmentProof) { exchanges++; assert.equal(response.status, 200); throw Error('sensitive upstream diagnostic'); }
    return response;
  });
  const begun = await f.client.begin(), member = await approve(begun.userCode);
  await rejects(f.client.pair(), 'exchange_outcome_unknown');
  assert.equal((await owner.query('SELECT state FROM device_authorizations WHERE authorization_id=$1', [member.authorizationId])).rows[0].state, 'consumed');
  await rejects(f.client.poll(), 'client_unavailable'); await rejects(f.client.pair(), 'client_unavailable'); assert.equal(exchanges, 1);
  const restarted = await machine(); await rejects(restarted.client.refresh(), 'session_required'); assert.equal(restarted.calls(), 0);
});

for (const field of ['refreshSupported', 'operational_authority'] as const)
test('malformed issued '+field+' quarantines committed enrollment', async () => {
  let exchanges = 0;
  const f = await machine(async (request, send) => {
    const response = await send(), value = await response.json();
    if (value.status === 'issued') { exchanges++; value[field] = field === 'operational_authority'; }
    return json(value, response.status);
  });
  const begun = await f.client.begin(); await approve(begun.userCode);
  await rejects(f.client.pair(), 'exchange_outcome_unknown');
  await rejects(f.client.poll(), 'client_unavailable'); assert.equal(exchanges, 1);
});

for (const kind of ['unknown_status', 'foreign_challenge', 'payload_substitution'] as const)
test('poll rejects '+kind+' before signing enrollment', async () => {
  let exchanges = 0;
  const f = await machine(async (request, send) => {
    if (request.method === 'POST' && (await request.clone().json()).enrollmentProof) exchanges++;
    const response = await send(), value = await response.json();
    if (value.status === 'proof_required') {
      if (kind === 'unknown_status') value.status = 'new_server_variant';
      if (kind === 'foreign_challenge') value.challenge.key_thumbprint = 'A'.repeat(43);
      if (kind === 'payload_substitution') value.challenge.payload = '{"scope":"execute"}';
    }
    return json(value, response.status);
  });
  const begun = await f.client.begin(); await approve(begun.userCode);
  await rejects(f.client.pair(), 'response_invalid'); assert.equal(exchanges, 0);
});

for (const outcome of ['drop', 'malformed', '503', 'abort'] as const) test('uncertain refresh '+outcome+' quarantines the spent handle', async () => {
  const abort = new AbortController(); let refreshes = 0;
  const f = await ready(async (request, send) => {
    const body = request.method === 'POST' ? await request.clone().json() : {};
    const response = await send();
    if (body.grantType !== 'refresh_token') return response;
    refreshes++; assert.equal(response.status, 200);
    if (outcome === 'drop') throw Error('private diagnostic must not escape');
    if (outcome === '503') return json({ code: 'bootstrap_unavailable' }, 503);
    if (outcome === 'abort') { abort.abort(); return response; }
    const result = await response.json(); result.operational_authority = true; return json(result);
  });
  await rejects(f.client.refresh({ signal: abort.signal }), 'refresh_outcome_unknown');
  await rejects(f.client.refresh(), 'client_unavailable'); await rejects(f.client.readStatus(), 'client_unavailable');
  assert.equal(refreshes, 1);
  const row = (await owner.query('SELECT state,current_generation FROM bootstrap_refresh_families WHERE connection_id=$1', [f.session.connectionId])).rows[0];
  assert.equal(row.state, 'active'); assert.equal(String(row.current_generation), '2');
});

test('abort while waiting to poll leaves enrollment unconsumed and sends no retry', async () => {
  const f = await machine(), begun = await f.client.begin(), member = await approve(begun.userCode);
  assert.equal((await f.client.poll()).status, 'proof_required');
  const calls = f.calls(), abort = new AbortController();
  const pending = f.client.pair({ signal: abort.signal }); abort.abort(); await rejects(pending, 'aborted');
  assert.equal(f.calls(), calls);
  assert.equal((await owner.query('SELECT state FROM device_authorizations WHERE authorization_id=$1', [member.authorizationId])).rows[0].state, 'approved');
  f.client.close();
});

for (const kind of ['unknown', 'extra', 'duplicate', 'redirect', 'bytes', 'chunks', 'length', 'utf8', 'hang', 'encoding', 'content_coding'] as const)
test('response boundary rejects '+kind+' without retaining secret output', async () => {
  const f = await machine(async (_request, send) => {
    const response = await send(), value = await response.json();
    if (kind === 'unknown') return json({ status: 'invented', operational_authority: false }, 201);
    if (kind === 'extra') return json({ ...value, unexpected: 'secret diagnostic' }, 201);
    if (kind === 'duplicate') return new Response(JSON.stringify(value).replace('"operational_authority":false', '"operational_authority":true,"operational_authority":false'), { status: 201, headers: { 'Content-Type': 'application/json' } });
    if (kind === 'redirect') return new Response(null, { status: 302, headers: { Location: origin+'/other' } });
    if (kind === 'bytes') return new Response(' '.repeat(32769), { status: 201, headers: { 'Content-Type':'application/json' } });
    if (kind === 'length') return new Response(JSON.stringify(value), { status: 201, headers: { 'Content-Type':'application/json', 'Content-Length':'1' } });
    if (kind === 'utf8') return new Response(new Uint8Array([0xff]), { status: 201, headers: { 'Content-Type':'application/json' } });
    if (kind === 'encoding') return new Response(JSON.stringify(value), { status: 201, headers: { 'Content-Type':'text/html' } });
    if (kind === 'content_coding') return new Response(JSON.stringify(value), { status: 201, headers: { 'Content-Type':'application/json', 'Content-Encoding':'unsupported' } });
    if (kind === 'hang') return new Response(new ReadableStream({ start() {} }), { status: 201, headers: { 'Content-Type':'application/json' } });
    return new Response(new ReadableStream({ start(controller) { for (let i=0;i<129;i++) controller.enqueue(new Uint8Array([32])); controller.close(); } }),
      { status: 201, headers: { 'Content-Type':'application/json' } });
  }, { requestTimeoutMs: 250 });
  await rejects(f.client.begin(), kind === 'hang' ? 'aborted' : 'response_invalid');
  const calls = f.calls(); await rejects(f.client.begin(), 'client_unavailable'); assert.equal(f.calls(), calls);
});

test('simultaneous operations fail locally and close cannot resurrect an in-flight begin', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void; const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const f = await machine(async (_request, send) => { const response = await send(); arrived(); await barrier; return response; });
  const begun = f.client.begin(); await arrival;
  await rejects(f.client.begin(), 'operation_in_progress'); f.client.close(); release();
  await assert.rejects(begun); await rejects(f.client.begin(), 'client_unavailable');
});

test('all machine durable tables and scoped facts exclude raw codes, proofs, tokens and handles', async () => {
  const stored: unknown[] = [];
  for (const table of ['device_authorizations','device_poll_proofs','runtime_registration_challenges','runtime_registrations',
    'agent_connections','bootstrap_nonces','bootstrap_refresh_families','bootstrap_refresh_generations','bootstrap_session_proofs',
    'scoped_command_receipts','scoped_outbox','scoped_transition_journal'])
    stored.push((await owner.query(`SELECT jsonb_agg(to_jsonb(t)) rows FROM ${table} t`)).rows[0]);
  const serialized = JSON.stringify(stored);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, 'durable data contained raw machine secret');
});

test('invalid host/environment and pre-aborted request never reach the transport', async () => {
  for (const origin of ['http://127.0.0.1', 'https://user:pass@example.invalid', 'https://example.invalid/', 'https://example.invalid?x=1'])
    await rejects(createMachineDeviceClient({ origin, environment:'local', clientId:'synthetic' }), 'configuration_invalid');
  await rejects(createMachineDeviceClient({ origin, environment:'staging', clientId:'synthetic' }), 'configuration_invalid');
  const f = await machine(); await rejects(f.client.begin({ signal: AbortSignal.abort() }), 'aborted'); assert.equal(f.calls(), 0); f.client.close();
});

test('native Fetch compressed responses preserve genuine pairing/rotation/status and bound decoded bytes', async () => {
  let coding = 'gzip', oversized = false, decodedLengthDiffers = false;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (name !== 'host' && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      // This owned loopback bridge supplies the synthetic canonical origin to
      // the genuine handler. It proves Fetch decoding, not deployed TLS/proxy.
      const result = await transport.fetch(new Request(origin+request.url, { method: request.method, headers,
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }));
      const raw = Buffer.from(await result.arrayBuffer());
      const body = oversized ? Buffer.concat([raw, Buffer.alloc(32769, 32)]) : raw;
      const encoded = coding === 'br' ? brotliCompressSync(body) : coding === 'deflate' ? deflateSync(body) : gzipSync(body);
      response.writeHead(result.status, { 'Content-Type':'application/json', 'Content-Encoding':coding, 'Content-Length':encoded.length });
      response.end(encoded);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const socketOrigin = 'http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const make = () => createMachineDeviceClient({ origin, environment:host.environment, clientId:host.clientId,
    fetch: async (url: string, init: RequestInit) => {
      const response = await fetch(socketOrigin+new URL(url).pathname, init);
      assert.equal(response.headers.get('Content-Encoding'), coding);
      const decoded = await response.clone().arrayBuffer();
      decodedLengthDiffers ||= decoded.byteLength !== Number(response.headers.get('Content-Length'));
      // The injected transport maps only this owned fixture origin; retain the
      // real native Fetch decoded stream and encoded headers without redecoding.
      return new Response(response.body, { status:response.status, headers:response.headers });
    } });
  try {
    const client = await make(), begun = await client.begin(); await approve(begun.userCode);
    assert.equal((await client.pair()).refreshGeneration, '1');
    coding = 'br'; assert.equal((await client.refresh()).refreshGeneration, '2');
    coding = 'deflate'; assert.equal((await client.readStatus()).operation, 'bootstrap.status.read');
    client.close(); assert.equal(decodedLengthDiffers, true);
    coding = 'gzip'; oversized = true;
    const excessive = await make(); await rejects(excessive.begin(), 'response_invalid');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve())); }
});
