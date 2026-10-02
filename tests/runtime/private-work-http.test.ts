import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Pool } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { createPrivateResultService } from '../../modules/autopilot-work/results.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256 } from '../../packages/asset-storage/index.js';
import { createPrivateWorkTransport } from '../../apps/platform-api/src/routes/private-work-transport.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit disposable fp_* TEST_DATABASE_URL required.');
const schema = `fp_private_http_${process.pid}_${Date.now()}`, community = randomUUID();
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 10 });
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); await pool.query("INSERT INTO communities VALUES($1,'Synthetic HTTP')", [community]); });
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
const ORIGIN = 'http://127.0.0.1:4310';
const commands = createPrivateWorkCommands(pool, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
const input = () => ({ title: 'PRIVATE_HTTP_TITLE', objective: 'PRIVATE_HTTP_OBJECTIVE' });
const app = (store?: FakeObjectStore) => new Hono().route('/api/v1', createPrivateWorkTransport(pool, { origin: ORIGIN, freedomEnv: 'local', store }));
async function member(policy = true) {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic HTTP owner','not-a-password',$4) RETURNING *`, [userId, community, userId+'@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [tokenHash(token), userId, csrf]);
  const actor: Actor = { ...row, session_hash: tokenHash(token), csrf_token: csrf };
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
  if (policy) await pool.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,true,10485760)`, [context.scope.scope_id, context.subject_principal.principal_id]);
  return { actor, token, csrf, context };
}
type Member = Awaited<ReturnType<typeof member>>;
function headers(f?: Member, extra: Record<string, string> = {}) {
  return { Origin: ORIGIN, 'Content-Type': 'application/json', ...(f ? { Cookie: `freedom_local_session=${f.token}`, 'X-CSRF-Token': f.csrf } : {}), ...extra };
}
async function post(router: ReturnType<typeof app>, path: string, f: Member | undefined, value: unknown, extra: Record<string, string> = {}) {
  return router.request(ORIGIN+'/api/v1/me/private-work'+path, { method: 'POST', headers: headers(f, { 'Idempotency-Key': randomUUID(), ...extra }), body: JSON.stringify(value) });
}
async function work(f: Member) { return commands.create(f.actor, { key: randomUUID(), ...input() }); }
function safe(response: Response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Vary'), 'Cookie'); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
}
async function result(f: Member, workId: string, store: FakeObjectStore) {
  const api = createPrivateResultService(pool, { store, resolvePolicy: resolvePrivateWorkPersistencePolicy });
  const bytes = new TextEncoder().encode('PRIVATE_RESULT_😀_<script>never-render</script>');
  const prepared = await api.prepare(f.actor, { key: randomUUID(), targetWorkId: workId, expectedVersion: '1', contentType: 'text/markdown', byteSize: bytes.length, sha256: await sha256(bytes) });
  const lease = await api.claim(f.actor, { key: randomUUID(), intentId: prepared.intentId });
  const claim = { intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
  await api.write(f.actor, { ...claim, key: randomUUID() }, new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
  return api.finalize(f.actor, { ...claim, key: randomUUID() });
}

test('HTTP-01 real member create, replay, edit and archive preserve service receipts and existing GET wire', async () => {
  const f = await member(), router = app(), key = randomUUID();
  const created = await post(router, '', f, input(), { 'Idempotency-Key': key }); safe(created); assert.equal(created.status, 201);
  const first = await created.json(); assert.equal(first.aggregateVersion, '1'); assert.equal(created.headers.get('ETag'), '"1"');
  const replay = await post(router, '', f, input(), { 'Idempotency-Key': key }); assert.deepEqual(await replay.json(), first);
  const read = await router.request(ORIGIN+`/api/v1/me/private-work/${first.workId}`, { headers: headers(f) });
  assert.equal(read.status, 200); const dto = await read.json(); assert.equal(dto.aggregate_version, 1);
  assert.deepEqual(Object.keys(dto).sort(), ['work_item_id', 'title', 'objective', 'state', 'aggregate_version', 'created_at'].sort());
  const update = await post(router, `/${first.workId}/edit`, f, { ...input(), title: 'Revised human title' }, { 'If-Match': '"1"' });
  assert.equal(update.status, 200); assert.equal((await update.json()).aggregateVersion, '2');
  const archived = await post(router, `/${first.workId}/archive`, f, {}, { 'If-Match': '"2"' });
  assert.equal(archived.status, 200); assert.equal((await archived.json()).state, 'archived');
  assert.equal((await router.request(ORIGIN+`/api/v1/me/private-work/${first.workId}`, { headers: headers(f) })).status, 404);
});

test('HTTP-02 factory authenticates cookie itself and denies missing session/CSRF/Origin/onboarding', async () => {
  const f = await member(), router = app();
  for (const [extra, expected] of [[{ Cookie: '' }, 401], [{ 'X-CSRF-Token': '' }, 403], [{ Origin: 'https://evil.invalid' }, 403]] as const) {
    const response = await post(router, '', f, input(), extra); assert.equal(response.status, expected); safe(response);
  }
  const bearer = await post(router, '', undefined, input(), { Authorization: 'Bearer synthetic-not-member' }); assert.equal(bearer.status, 401); safe(bearer);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
  const denied = await post(router, '', f, input()); assert.equal(denied.status, 403); safe(denied);
  const get = await router.request(ORIGIN+'/api/v1/me/private-work', { headers: headers(f) }); assert.equal(get.status, 403); safe(get);
});

test('HTTP-03 policy cannot be supplied by body; current DB policy gates mutations/replays but not archive', async () => {
  const f = await member(false), router = app();
  assert.equal((await post(router, '', f, input())).status, 503);
  for (const name of ['owner', 'scope', 'policy', 'store', 'options', 'provenance', 'grant', 'runId']) {
    const response = await post(router, '', f, { ...input(), [name]: 'PRIVATE_HTTP_MARKER' });
    assert.ok([400, 422].includes(response.status)); safe(response); assert.doesNotMatch(await response.text(), /PRIVATE_HTTP_MARKER/);
  }
  const enabled = await member(), created = await work(enabled), key = randomUUID();
  assert.equal((await post(router, `/${created.workId}/edit`, enabled, input(), { 'If-Match': '"1"', 'Idempotency-Key': key })).status, 200);
  await pool.query('UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=false WHERE scope_id=$1', [enabled.context.scope.scope_id]);
  assert.equal((await post(router, `/${created.workId}/edit`, enabled, input(), { 'If-Match': '"1"', 'Idempotency-Key': key })).status, 503);
  assert.equal((await router.request(ORIGIN+`/api/v1/me/private-work/${created.workId}`, { headers: headers(enabled) })).status, 200);
  assert.equal((await post(router, `/${created.workId}/archive`, enabled, {}, { 'If-Match': '"2"' })).status, 200);
});

test('HTTP-04 strict command headers reject duplicates, weak/list/star/nondecimal versions and missing keys', async () => {
  const f = await member(), w = await work(f), router = app();
  for (const version of ['*', 'W/"1"', '"1","2"', '"01"', '"1.0"', '"9223372036854775808"']) {
    assert.equal((await post(router, `/${w.workId}/edit`, f, input(), { 'If-Match': version })).status, 400);
  }
  assert.equal((await post(router, `/${w.workId}/edit`, f, input())).status, 428);
  assert.equal((await post(router, '', f, input(), { 'If-Match': '"1"' })).status, 400);
  for (const key of ['', 'short', 'a'.repeat(129), 'abcdefgh,ijklmnop']) assert.equal((await post(router, '', f, input(), { 'Idempotency-Key': key })).status, 400);
  assert.equal((await post(router, `/${w.workId}/edit`, f, input(), { 'If-Match': '"2"' })).status, 412);
});

test('HTTP-05 duplicate escaped fields, malformed UTF8/JSON/nesting and error text are rejected without echo', async () => {
  const f = await member(), router = app();
  const raws: (string | Uint8Array)[] = ['{"title":"x","ti\\u0074le":"y","objective":"z"}', '{"title":"PRIVATE_HTTP_MARKER","objective":{}}', '{"title":"x",}', '[]', '{"__proto__":"x"}', '\ufeff'+JSON.stringify(input()), '{"title":"\\ud800","objective":"x"}', '{"title":"x","objective":"\\udfff"}', new Uint8Array([0xc0, 0xaf])];
  for (const raw of raws) {
    const response = await router.request(ORIGIN+'/api/v1/me/private-work', { method: 'POST', headers: headers(f, { 'Idempotency-Key': randomUUID() }), body: raw as BodyInit });
    assert.ok([400, 422].includes(response.status)); safe(response); assert.doesNotMatch(await response.text(), /PRIVATE_HTTP_MARKER|__proto__/);
  }
});

test('HTTP-06 actual streaming bound holds when Content-Length is absent or lies; stream errors sanitized', async () => {
  const f = await member(), router = app();
  for (const length of [undefined, '1']) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(20000)); }, cancel() { cancelled = true; } });
    const request = new Request(ORIGIN+'/api/v1/me/private-work', { method: 'POST', headers: headers(f, { 'Idempotency-Key': randomUUID(), ...(length ? { 'Content-Length': length } : {}) }), body: stream, duplex: 'half' } as RequestInit);
    const response = await router.request(request); assert.equal(response.status, 413); safe(response); assert.equal(cancelled, true);
  }
  const failed = new ReadableStream<Uint8Array>({ pull() { throw Error('PRIVATE_PROVIDER_MARKER'); } });
  const response = await router.request(new Request(ORIGIN+'/api/v1/me/private-work', { method: 'POST', headers: headers(f, { 'Idempotency-Key': randomUUID() }), body: failed, duplex: 'half' } as RequestInit));
  assert.equal(response.status, 400); assert.doesNotMatch(await response.text(), /PRIVATE_PROVIDER_MARKER/);
});

test('HTTP-07 strict JSON content headers and query keys reject unrecognized inputs', async () => {
  const f = await member(), router = app();
  const badHeaders: Record<string, string>[] = [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=latin1' }, { 'Content-Encoding': 'gzip' }];
  for (const extra of badHeaders) assert.equal((await post(router, '', f, input(), extra)).status, 415);
  for (const length of ['-1', '1, 1', '32769']) assert.equal((await post(router, '', f, input(), { 'Content-Length': length })).status, 413);
  for (const suffix of ['?owner=another', '?limit=1&limit=2', '?offset=10001']) {
    const response = await router.request(ORIGIN+'/api/v1/me/private-work'+suffix, { headers: headers(f) }); assert.equal(response.status, 422); safe(response);
  }
});

test('HTTP-08 same-community peer and random valid ID receive indistinguishable private failures', async () => {
  const a = await member(), b = await member(), w = await work(a), router = app();
  const known = await router.request(ORIGIN+`/api/v1/me/private-work/${w.workId}`, { headers: headers(b) });
  const random = await router.request(ORIGIN+`/api/v1/me/private-work/${randomUUID()}`, { headers: headers(b) });
  assert.equal(known.status, 404); assert.equal(random.status, 404); assert.deepEqual(await known.json(), await random.json());
  assert.equal((await post(router, `/${w.workId}/archive`, b, {}, { 'If-Match': '"1"' })).status, 404);
  const list = await router.request(ORIGIN+'/api/v1/me/private-work?q=PRIVATE_HTTP', { headers: headers(b) }); assert.equal((await list.json()).total, 0);
});

test('HTTP-09 private Result JSON reads preserve exact text, no raw keys, HEAD/current ACL and no conditional bypass', async () => {
  const f = await member(), w = await work(f), store = new FakeObjectStore(), published = await result(f, w.workId, store), router = app(store);
  const url = ORIGIN+`/api/v1/me/private-work/${w.workId}/results/${published.resultId}`;
  const response = await router.request(url, { headers: headers(f, { Range: 'bytes=0-1', 'If-None-Match': '*' }) });
  assert.equal(response.status, 200); safe(response); assert.match(response.headers.get('Content-Type')!, /application\/json/);
  const dto = await response.json(); assert.equal(dto.text, 'PRIVATE_RESULT_😀_<script>never-render</script>'); assert.equal(dto.provenance, 'human');
  assert.doesNotMatch(JSON.stringify(dto), /object_key|representationId|scopeId|assetId|v1\//);
  const head = await router.request(url, { method: 'HEAD', headers: headers(f) }); assert.equal(head.status, 200); assert.equal(await head.text(), ''); safe(head);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  const revoked = await router.request(url, { method: 'HEAD', headers: headers(f, { 'If-None-Match': '*' }) }); assert.equal(revoked.status, 401); safe(revoked);
});

test('HTTP-10 absent store permits metadata only and never weakens exact owner/Result checks', async () => {
  const f = await member(), other = await member(), w = await work(f), router = app();
  const currentUrl = ORIGIN+`/api/v1/me/private-work/${w.workId}/results/current`;
  assert.equal(await (await router.request(currentUrl, { headers: headers(f) })).json(), null);
  const published = await result(f, w.workId, new FakeObjectStore());
  assert.equal((await router.request(currentUrl, { headers: headers(f) })).status, 503);
  assert.equal((await router.request(currentUrl, { headers: headers(other) })).status, 404);
  assert.equal((await router.request(ORIGIN+`/api/v1/me/private-work/${w.workId}/results/${randomUUID()}`, { headers: headers(f) })).status, 404);
  const metadata = await router.request(ORIGIN+`/api/v1/me/private-work/${w.workId}/results`, { headers: headers(f) });
  assert.equal(metadata.status, 200); const value = await metadata.json(); assert.equal(value.items[0].resultId, published.resultId); assert.equal(value.items[0].text, undefined);
});

test('HTTP-11 existing production app has no new writes/Result transport mounted', async () => {
  const f = await member(), w = await work(f), production = createApp(pool);
  for (const path of ['', `/${w.workId}/edit`, `/${w.workId}/archive`]) {
    const response = await production.request(ORIGIN+'/api/v1/me/private-work'+path, { method: 'POST', headers: headers(f, { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' }), body: JSON.stringify(input()) });
    assert.equal(response.status, 404);
  }
  const response = await production.request(ORIGIN+`/api/v1/me/private-work/${w.workId}/results`, { headers: headers(f) }); assert.equal(response.status, 404);
  for (const suffix of ['', `/${w.workId}`]) {
    const get = await production.request(ORIGIN+`/api/v1/me/private-work${suffix}`, { headers: headers(f) });
    const closed = await app().request(ORIGIN+`/api/v1/me/private-work${suffix}`, { headers: headers(f) });
    assert.equal(get.status, 200); assert.equal(closed.status, 200); assert.deepEqual(await closed.json(), await get.json());
  }
});

test('HTTP-12 Work GET bigint overflow remains controlled while command receipt stays decimal', async () => {
  const f = await member(), w = await work(f), router = app();
  await pool.query("UPDATE work_items SET aggregate_version='9007199254740992' WHERE work_item_id=$1", [w.workId]);
  const read = await router.request(ORIGIN+`/api/v1/me/private-work/${w.workId}`, { headers: headers(f) }); assert.equal(read.status, 500); safe(read); assert.equal((await read.json()).code, 'version_overflow');
  const production = await createApp(pool).request(ORIGIN+`/api/v1/me/private-work/${w.workId}`, { headers: headers(f) });
  assert.equal(production.status, 500); assert.equal((await production.json()).code, 'version_overflow');
  const update = await post(router, `/${w.workId}/edit`, f, input(), { 'If-Match': '"9007199254740992"' }); assert.equal(update.status, 200); assert.equal((await update.json()).aggregateVersion, '9007199254740993');
});

test('HTTP-13 exact32KiB body, split Unicode bytes and escaped field names retain bounded flat grammar', async () => {
  const f = await member(), router = app();
  const value = JSON.stringify({ title: 'Human 😀 title', objective: '人類目的' }).replace('"title"', '"ti\\u0074le"');
  const bytes = new TextEncoder().encode(value+' '.repeat(32768-Buffer.byteLength(value)));
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { if (index < bytes.length) c.enqueue(bytes.slice(index, ++index)); else c.close(); } });
  const response = await router.request(new Request(ORIGIN+'/api/v1/me/private-work', { method: 'POST', headers: headers(f, { 'Idempotency-Key': randomUUID(), 'Content-Length': '32768' }), body: stream, duplex: 'half' } as RequestInit));
  assert.equal(response.status, 201);
  const id = (await response.json()).workId;
  const read = await router.request(ORIGIN+`/api/v1/me/private-work/${id}`, { headers: headers(f) }); assert.equal((await read.json()).title, 'Human 😀 title');
  const invalidPage = await router.request(ORIGIN+`/api/v1/me/private-work/${id}/results?limit=1%0A`, { headers: headers(f) });
  assert.equal(invalidPage.status, 422);
});
