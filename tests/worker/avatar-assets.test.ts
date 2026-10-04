// Actual local workerd + native ephemeral R2 + local Hyperdrive + Miniflare's
// low-fidelity IMAGES (Node sharp). No cloud bindings, credentials or deployment.
// Build the current platform Worker dry-run bundle first. TEST_DATABASE_URL is
// REQUIRED and must explicitly name a disposable loopback/socket fp_* database.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Pool } from 'pg';
import sharp from 'sharp';
import { migrate } from '../../scripts/database.js';
import { digest } from '../../packages/db/index.js';
import { tokenHash } from '../../modules/identity-membership/service.js';

const configured = process.env.TEST_DATABASE_URL;
assert(configured, 'Explicit disposable TEST_DATABASE_URL required for Worker media tests');
const serverUrl = new URL(configured);
assert(['postgres:', 'postgresql:'].includes(serverUrl.protocol));
assert(['localhost', '127.0.0.1', '[::1]'].includes(serverUrl.hostname));
assert.match(serverUrl.pathname, /^\/fp_[a-z0-9_]+$/);
assert(serverUrl.username && !serverUrl.hash);
assert([...serverUrl.searchParams.keys()].every(key => ['host', 'sslmode'].includes(key)));
assert(serverUrl.searchParams.getAll('host').length <= 1);
const socketDirectory = serverUrl.searchParams.get('host');
if (socketDirectory) assert(isAbsolute(socketDirectory) && resolve(socketDirectory) === socketDirectory);

const database = `fp_worker_avatar_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(serverUrl); databaseUrl.pathname = '/' + database;
const bundleDir = resolve(process.env.FREEDOM_WORKERD_BUNDLE_DIR ?? '.wrangler/dry-run/local');
const origin = 'http://127.0.0.1:8787', compatibilityDate = '2026-09-21';
const admin = new Pool({ connectionString: serverUrl.href, max: 2 });
const sockets = new Set<Socket>(), runtimes: Miniflare[] = [];
let db: Pool, proxy: Server | undefined, created = false, assetsDir: string | undefined;
let hyperdriveUrl: string, mf: Miniflare, png: Buffer, otherPng: Buffer;
let community: string, outboundCalls = 0;

before(async () => {
  const bundle = await readFile(resolve(bundleDir, 'worker.js'), 'utf8');
  assert(bundle.includes('// modules/assets/avatar-upload.ts'), 'Rebuild the current upload-facade Worker bundle');
  assert(bundle.includes('// packages/shared/sharp-unavailable.ts'));
  assert(!/node_modules\/sharp\/|@img\/sharp-/.test(bundle));
  assert.match(database, /^fp_worker_avatar_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE DATABASE ${database}`); created = true;
  db = new Pool({ connectionString: databaseUrl.href, max: 6 }); await migrate(db);
  assetsDir = await mkdtemp(join(tmpdir(), 'fp-worker-avatar-assets-'));
  await writeFile(join(assetsDir, 'index.html'), '<!doctype html><title>Synthetic media fixture</title>');
  const workerDatabase = new URL(databaseUrl);
  if (socketDirectory) {
    // Miniflare Hyperdrive supports TCP, not libpq's host=/socket query. This
    // test owns ONLY an ephemeral loopback forwarder to the explicit socket.
    const target = join(socketDirectory, '.s.PGSQL.' + (serverUrl.port || '5432'));
    proxy = createServer(client => {
      const upstream = createConnection({ path: target });
      sockets.add(client); sockets.add(upstream);
      const close = () => { client.destroy(); upstream.destroy(); };
      client.on('error', close); upstream.on('error', close);
      client.on('close', () => { sockets.delete(client); upstream.destroy(); });
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((done, reject) => { proxy!.once('error', reject); proxy!.listen(0, '127.0.0.1', done); });
    const address = proxy.address(); assert(address && typeof address !== 'string');
    workerDatabase.hostname = '127.0.0.1'; workerDatabase.port = String(address.port);
  }
  workerDatabase.search = '?sslmode=disable';
  // Required by Miniflare even when the isolated socket uses local trust auth.
  workerDatabase.password ||= 'synthetic-workerd-only';
  hyperdriveUrl = workerDatabase.href;
  png = await sharp({ create: { width: 35, height: 45, channels: 3, background: '#dd2233' } }).png().toBuffer();
  otherPng = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#2266dd' } }).png().toBuffer();
});

async function runtime(options: { media?: boolean; images?: boolean } = {}) {
  const instance = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'fp-avatar-media-' + randomUUID(), modules: true, scriptPath: resolve(bundleDir, 'worker.js'),
    compatibilityDate, compatibilityFlags: ['nodejs_compat'],
    bindings: { FREEDOM_ENV: 'local', APP_ORIGIN: origin },
    hyperdrives: { HYPERDRIVE: hyperdriveUrl },
    ...(options.media === false ? {} : { r2Buckets: ['MEDIA'] }),
    ...(options.images === false ? {} : { images: { binding: 'IMAGES' } }),
    assets: { directory: assetsDir!, binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' } },
    outboundService: async () => { outboundCalls++; return new Response(null, { status: 503 }); },
  }] } as any));
  runtimes.push(instance); await instance.ready; return instance;
}

beforeEach(async () => {
  // Only this test-created fp_* database: reset synthetic fixtures, not a live
  // rollback. Production policy downgrade/delete triggers remain untouched.
  await db.query('TRUNCATE communities,avatar_storage_policy,auth_rate_limits CASCADE');
  await db.query('INSERT INTO avatar_storage_policy DEFAULT VALUES');
  community = randomUUID(); outboundCalls = 0;
  await db.query('INSERT INTO communities VALUES($1,$2)', [community, 'Synthetic native Worker media']);
  mf = await runtime();
});
afterEach(async () => {
  for (const instance of runtimes.splice(0)) await instance.dispose();
  assert.equal(outboundCalls, 0, 'No external HTTP/provider calls are permitted');
});
after(async () => {
  // Also handles partial startup/test failure. Close every owned resource, never
  // the parent disposable PostgreSQL server or someone else's proxy.
  for (const instance of runtimes.splice(0)) await instance.dispose().catch(() => undefined);
  await db?.end().catch(() => undefined);
  try { if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); }
  finally {
    await admin.end();
    for (const socket of sockets) socket.destroy();
    if (proxy?.listening) await new Promise<void>((done, reject) => proxy!.close(error => error ? reject(error) : done()));
    if (assetsDir) await rm(assetsDir, { recursive: true, force: true });
  }
});

type Member = { id: string; cookie: string; csrf: string; sessionHash: string };
async function member(selectedCommunity = community): Promise<Member> {
  const id = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomUUID();
  await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic media member','not-a-login-hash',$4)`, [id, selectedCommunity, id + '@worker-media.test', randomUUID()]);
  const sessionHash = tokenHash(token);
  await db.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [sessionHash, id, csrf]);
  return { id, cookie: 'freedom_local_session=' + token, csrf, sessionHash };
}
const call = (path: string, init?: RequestInit, worker = mf) => worker.dispatchFetch(origin + path, init as any) as unknown as Promise<Response>;
async function enable(mode: 'bridge' | 'r2_only' = 'r2_only') {
  await db.query(`UPDATE avatar_storage_policy SET mode=$1,policy_revision='synthetic-worker-1',
    persistence_allowed=true,retained_byte_limit=10485760`, [mode]);
}
function upload(owner: Member, options: { bytes?: Buffer; key?: string; expected?: string; worker?: Miniflare; headers?: Record<string, string> } = {}) {
  return call('/api/v1/me/avatar', { method: 'POST', headers: { Origin: origin, Cookie: owner.cookie,
    'X-CSRF-Token': owner.csrf, 'Content-Type': 'image/png', 'If-Match': '"' + (options.expected ?? '1') + '"',
    'Idempotency-Key': options.key ?? randomUUID(), ...options.headers }, body: new Uint8Array(options.bytes ?? png) }, options.worker);
}
async function saved(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  // Existing public JSON middleware exposes safe version strings as numbers.
  const body = await response.json() as { avatar_url: string; aggregate_version: number };
  assert.deepEqual(Object.keys(body).sort(), ['aggregate_version', 'avatar_url']);
  return body;
}
function mutate(owner: Member, path: string, body: unknown, expected?: string) {
  return call(path, { method: 'POST', headers: { Origin: origin, Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf,
    'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...(expected ? { 'If-Match': '"' + expected + '"' } : {}) }, body: JSON.stringify(body) });
}
async function noPublishedEffects(owner: Member) {
  const row = (await db.query(`SELECT (SELECT count(*)::int FROM command_receipts WHERE user_id=$1 AND operation='POST /api/v1/me/avatar') receipts,
    (SELECT count(*)::int FROM assets WHERE owner_user_id=$1 AND state='ready') ready,
    (SELECT count(*)::int FROM member_avatars WHERE user_id=$1 AND image_bytes IS NOT NULL) bytes`, [owner.id])).rows[0];
  assert.deepEqual(row, { receipts: 0, ready: 0, bytes: 0 });
}

test('native Worker R2 upload stores verified WebP, exact old receipt and no new SQL image bytes', async () => {
  const owner = await member(); await enable(); const key = randomUUID();
  const result = await saved(await upload(owner, { key })); assert.equal(result.aggregate_version, 2);
  const sql = (await db.query(`SELECT a.image_bytes,a.storage_source,a.aggregate_version,t.linked_at_version,o.*
    FROM member_avatars a JOIN member_avatar_asset_targets t USING(user_id) JOIN asset_objects o USING(asset_id)
    WHERE a.user_id=$1`, [owner.id])).rows[0];
  assert.equal(sql.image_bytes, null); assert.equal(sql.storage_source, 'asset'); assert.equal(sql.linked_at_version, '2');
  const bucket = await mf.getR2Bucket('MEDIA'), object = await bucket.get(sql.object_key); assert(object);
  const bytes = Buffer.from(await object.arrayBuffer()), metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 256); assert.equal(metadata.height, 256);
  assert.notDeepEqual(bytes, png); assert.equal(createHash('sha256').update(bytes).digest('hex'), sql.content_sha256);
  assert.equal(bytes.length, sql.byte_size); assert.equal((await bucket.list()).objects.length, 1);
  const receipt = (await db.query("SELECT * FROM command_receipts WHERE operation='POST /api/v1/me/avatar'")).rows[0];
  assert.equal(receipt.idempotency_key, key);
  assert.equal(receipt.request_sha256, digest({ body: { content_type: 'image/png', sha256: createHash('sha256').update(png).digest('hex') }, expected: '1' }));
  assert.deepEqual(receipt.response, { ...result, aggregate_version: String(result.aggregate_version) });
  const facts = await db.query(`SELECT j.scope_kind,j.aggregate_version,j.operation,j.data,o.event_type,o.payload
    FROM scoped_transition_journal j JOIN scoped_outbox o USING(transition_id,scope_id,scope_kind)
    WHERE j.aggregate_type='member_avatar' AND j.aggregate_id=$1`, [owner.id]);
  assert.equal(facts.rowCount, 1);
  const fact = facts.rows[0];
  assert.equal(fact.scope_kind, 'personal'); assert.equal(fact.aggregate_version, '2');
  assert.equal(fact.operation, 'member.avatar.replace'); assert.equal(fact.event_type, 'freedom.member.avatar.replaced.v1');
  assert.deepEqual(Object.keys(fact.data).sort(), ['asset_id', 'intent_id']); assert.equal(fact.data.asset_id, sql.asset_id);
  assert.deepEqual(fact.payload.data, fact.data);
  assert.equal((await db.query('SELECT count(*)::int n FROM outbox')).rows[0].n, 0, 'No legacy community fanout');
  for (const method of ['GET', 'HEAD']) {
    const read = await call(result.avatar_url, { method, headers: { Cookie: owner.cookie, Range: 'bytes=0-1', 'If-None-Match': '"2"' } });
    assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'private, no-store');
    assert.equal(read.headers.get('content-type'), 'image/webp'); assert.equal(Number(read.headers.get('content-length')), bytes.length);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : bytes);
  }
  assert.equal((await call(result.avatar_url, { method: 'HEAD' })).status, 401);
});

test('legacy success replays without MEDIA/IMAGES after bridge and never reattaches the old image', async () => {
  const owner = await member(), key = randomUUID();
  const old = await saved(await upload(owner, { key }));
  const retained = (await db.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1', [owner.id])).rows[0].image_bytes;
  assert(retained); await enable('bridge');
  const unbound = await runtime({ media: false, images: false });
  assert.deepEqual(await saved(await upload(owner, { key, worker: unbound })), old);
  const next = await saved(await upload(owner, { bytes: otherPng, expected: '2' })); assert.equal(next.aggregate_version, 3);
  assert.deepEqual(await saved(await upload(owner, { key, worker: unbound })), old);
  assert.equal((await db.query('SELECT aggregate_version FROM member_avatars WHERE user_id=$1', [owner.id])).rows[0].aggregate_version, '3');
  assert.deepEqual((await db.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1', [owner.id])).rows[0].image_bytes, retained);
  const failed = await call(next.avatar_url, { headers: { Cookie: owner.cookie } }, unbound);
  assert.equal(failed.status, 503); assert.equal((await failed.json() as {code: string}).code, 'avatar_unavailable');
  assert.equal((await call('/api/v1/health', undefined, unbound)).status, 200);
  assert.equal((await call('/api/v1/session', { headers: { Cookie: owner.cookie } }, unbound)).status, 200);
  await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [owner.sessionHash]);
  assert.equal((await upload(owner, { key, worker: unbound })).status, 401, 'A historical success never bypasses current authentication');
});

test('missing explicit persistence permission or MEDIA fails closed; missing IMAGES never publishes', async () => {
  const owner = await member(); await db.query("UPDATE avatar_storage_policy SET mode='r2_only'");
  assert.equal((await upload(owner)).status, 503); await noPublishedEffects(owner);
  assert.equal((await mf.getR2Bucket('MEDIA').then(bucket => bucket.list())).objects.length, 0);
  await enable(); const unbound = await runtime({ media: false });
  assert.equal((await upload(owner, { worker: unbound })).status, 503); await noPublishedEffects(owner);
  const noImages = await runtime({ images: false });
  assert.equal((await upload(owner, { worker: noImages })).status, 503); await noPublishedEffects(owner);
  assert.equal((await noImages.getR2Bucket('MEDIA').then(bucket => bucket.list())).objects.length, 0);
});

test('concurrent same-key native uploads publish once; changed body and stale version preserve current pointer', async () => {
  const owner = await member(); await enable(); const key = randomUUID();
  const results = await Promise.all([upload(owner, { key }), upload(owner, { key })]);
  const [first, second] = await Promise.all(results.map(saved)); assert.deepEqual(first, second);
  assert.equal((await mf.getR2Bucket('MEDIA').then(bucket => bucket.list())).objects.length, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM command_receipts WHERE operation='POST /api/v1/me/avatar'")).rows[0].n, 1);
  assert.equal((await upload(owner, { key, bytes: otherPng })).status, 409);
  assert.equal((await upload(owner, { bytes: otherPng })).status, 412);
  assert.equal((await db.query('SELECT aggregate_version FROM member_avatars WHERE user_id=$1', [owner.id])).rows[0].aggregate_version, '2');
});

test('member/share GET and HEAD honor current ACL, opt-out, rotation and removal without object deletion', async () => {
  const owner = await member(), viewer = await member(); await enable();
  const avatar = await saved(await upload(owner));
  const shareResponse = await mutate(owner, '/api/v1/me/member-card-share', { enabled: true, include_avatar: true });
  assert.equal(shareResponse.status, 200, await shareResponse.clone().text());
  let share = await shareResponse.json() as { share_path: string; aggregate_version: number };
  const token = share.share_path.split('/').at(-1), sharedAvatar = '/api/v1/public/member-cards/' + token + '/avatar';
  for (const method of ['GET', 'HEAD']) {
    const response = await call(sharedAvatar, { method, headers: { 'If-None-Match': '"2"', Range: 'bytes=0-1' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.arrayBuffer()).byteLength === 0, method === 'HEAD');
  }
  const optout = await mutate(owner, '/api/v1/me/member-card-share', { enabled: true, include_avatar: false }, String(share.aggregate_version));
  assert.equal(optout.status, 200); share = await optout.json() as typeof share;
  assert.equal((await call(sharedAvatar, { method: 'HEAD', headers: { 'If-None-Match': '"2"' } })).status, 404);
  const rotated = await mutate(owner, '/api/v1/me/member-card-share', { enabled: true, include_avatar: true, rotate: true }, String(share.aggregate_version));
  assert.equal(rotated.status, 200); share = await rotated.json() as typeof share;
  assert.equal((await call(sharedAvatar)).status, 404);
  const currentShare = '/api/v1/public/member-cards/' + share.share_path.split('/').at(-1) + '/avatar';
  assert.equal((await call(currentShare)).status, 200);
  assert.equal((await call(avatar.avatar_url, { headers: { Cookie: viewer.cookie } })).status, 200);
  await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [viewer.sessionHash]);
  assert.equal((await call(avatar.avatar_url, { method: 'HEAD', headers: { Cookie: viewer.cookie } })).status, 401);
  const removed = await mutate(owner, '/api/v1/me/avatar/remove', {}, '2');
  assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { avatar_url: null, aggregate_version: 3 });
  assert.equal((await call(avatar.avatar_url, { headers: { Cookie: owner.cookie } })).status, 404);
  assert.equal((await call(currentShare, { method: 'HEAD' })).status, 404);
  assert.equal((await mf.getR2Bucket('MEDIA').then(bucket => bucket.list())).objects.length, 1, 'Removal is not unapproved GC');
});

test('asset reads reject cross-community viewer, inactive owner and disabled personal scope', async () => {
  const owner = await member(); await enable(); const avatar = await saved(await upload(owner));
  const foreignCommunity = randomUUID(); await db.query('INSERT INTO communities VALUES($1,$2)', [foreignCommunity, 'Foreign synthetic']);
  const stranger = await member(foreignCommunity);
  assert.equal((await call(avatar.avatar_url, { method: 'HEAD', headers: { Cookie: stranger.cookie } })).status, 404);
  await db.query('UPDATE users SET active=false WHERE user_id=$1', [owner.id]);
  const viewer = await member(); assert.equal((await call(avatar.avatar_url, { headers: { Cookie: viewer.cookie } })).status, 404);
  await db.query('UPDATE users SET active=true WHERE user_id=$1', [owner.id]);
  await db.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=(SELECT scope_id FROM member_avatar_asset_targets WHERE user_id=$1)", [owner.id]);
  assert.equal((await call(avatar.avatar_url, { method: 'HEAD', headers: { Cookie: viewer.cookie } })).status, 404);
});

test('missing or corrupted native R2 bytes remain unavailable, never retained-byte fallback', async () => {
  const owner = await member(); await saved(await upload(owner)); await enable('bridge');
  const avatar = await saved(await upload(owner, { bytes: otherPng, expected: '2' }));
  const row = (await db.query('SELECT object_key FROM asset_objects')).rows[0], bucket = await mf.getR2Bucket('MEDIA');
  const object = await bucket.get(row.object_key); assert(object);
  const bytes = await object.arrayBuffer();
  await bucket.put(row.object_key, new Uint8Array([1, 2, 3]), { httpMetadata: object.httpMetadata, customMetadata: object.customMetadata });
  assert.equal((await call(avatar.avatar_url, { headers: { Cookie: owner.cookie } })).status, 503);
  await bucket.put(row.object_key, bytes, { httpMetadata: object.httpMetadata, customMetadata: object.customMetadata });
  assert.equal((await call(avatar.avatar_url, { headers: { Cookie: owner.cookie } })).status, 200);
  await bucket.delete(row.object_key); // Synthetic corruption injection, not app GC.
  assert.equal((await call(avatar.avatar_url, { method: 'HEAD', headers: { Cookie: owner.cookie } })).status, 503);
  assert.equal((await db.query('SELECT image_bytes IS NOT NULL retained FROM member_avatars WHERE user_id=$1', [owner.id])).rows[0].retained, true);
});

test('cutover blocks the old SQL byte writer and downgrade while keeping allowed metadata/removal paths', async () => {
  const owner = await member(); await enable(); await saved(await upload(owner));
  await assert.rejects(db.query('UPDATE member_avatars SET image_bytes=$2 WHERE user_id=$1', [owner.id, png]), error => (error as {code?: string}).code === '23514');
  await assert.rejects(db.query("UPDATE avatar_storage_policy SET mode='legacy'"), error => (error as {code?: string}).code === '23514');
  await db.query('UPDATE member_avatars SET updated_at=clock_timestamp() WHERE user_id=$1', [owner.id]);
  assert.equal((await db.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1', [owner.id])).rows[0].image_bytes, null);
  const denied = await upload(owner, { expected: '2', headers: { 'X-CSRF-Token': 'wrong-synthetic' } });
  assert.equal(denied.status, 403);
});
