import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import sharp from 'sharp';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { authenticate } from '../../modules/identity-membership/service.js';
import { guildDirectory } from '../../modules/positioning/onboarding.js';

const origin = 'http://127.0.0.1:4310', databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_avatar_test_${process.pid}_${Date.now()}`, admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const app = createApp(pool, origin);
type Session = { cookie: string; csrf: string; userId: string };
let png: Buffer;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  png = await sharp({ create: { width: 480, height: 320, channels: 3, background: '#c4ff20' } }).withMetadata({ exif: { IFD0: { Artist: 'synthetic fixture' } } }).png().toBuffer();
});
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); });
async function json(path: string, session?: Session, body?: unknown, version?: number, key = randomUUID()) {
  const response = await app.request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}), ...(version ? { 'If-Match': `"${version}"` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as any, response };
}
async function login(email = DEMO_USERS[0].email): Promise<Session> {
  const result = await json('/auth/login', undefined, { email, password: DEMO_PASSWORD });
  assert.equal(result.status, 200);
  return { cookie: result.response.headers.get('set-cookie')!.split(';')[0], csrf: result.data.csrf_token, userId: result.data.user.user_id };
}
async function upload(session: Session, bytes = png, version = 1, key = randomUUID(), mime = 'image/png', extra: Record<string, string> = {}) {
  const response = await app.request(origin + '/api/v1/me/avatar', { method: 'POST', headers: { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': mime, 'Idempotency-Key': key, 'If-Match': `"${version}"`, ...extra }, body: new Uint8Array(bytes) });
  return { status: response.status, data: await response.json() as any, response };
}
async function image(url: string, session?: Session, targetApp = app) { return targetApp.request(origin + url, { headers: session ? { Cookie: session.cookie } : {} }); }

test('avatar upload persists normalized pixels, strips metadata and leaves account drafts/version independent', async () => {
  const owner = await login(), viewer = await login(DEMO_USERS[1].email), account = await json('/me/account', owner);
  assert.deepEqual(account.data.avatar, { avatar_url: null, aggregate_version: 1 });
  const saved = await upload(owner); assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.aggregate_version, 2);
  const card = await json(`/members/${owner.userId}`, viewer); assert.equal(card.data.avatar_url, saved.data.avatar_url);
  assert.equal((await json('/members', viewer)).data.items.find((item: any) => item.user_id === owner.userId).avatar_url, saved.data.avatar_url);
  const accountAfter = await json('/me/account', owner); assert.equal(accountAfter.data.aggregate_version, account.data.aggregate_version); assert.deepEqual(accountAfter.data.avatar, saved.data);
  const response = await image(saved.data.avatar_url, viewer, createApp(pool, origin)); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp'); assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('vary'), 'Cookie'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await response.arrayBuffer()), metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, 256); assert.equal(metadata.height, 256); assert.equal(metadata.format, 'webp'); assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined); assert.ok(bytes.length <= 131072);
  assert.deepEqual((await json('/me/avatar', owner)).data, saved.data);
  const receipt = (await pool.query("SELECT response FROM command_receipts WHERE operation='POST /api/v1/me/avatar'")).rows[0].response;
  assert.deepEqual(receipt, { ...saved.data, aggregate_version: '2' });
  assert.equal((await pool.query("SELECT data FROM transition_journal WHERE aggregate_type='member_avatar'")).rows.length, 1);
});

test('JPEG and WebP inputs are decoded to WebP with a new revision', async () => {
  const owner = await login(); let version = 1;
  for (const format of ['jpeg', 'webp'] as const) {
    const bytes = await sharp(png).toFormat(format).toBuffer(), result = await upload(owner, bytes, version, randomUUID(), `image/${format}`);
    assert.equal(result.status, 200, JSON.stringify(result.data)); version = result.data.aggregate_version;
    assert.equal((await sharp(Buffer.from(await (await image(result.data.avatar_url, owner)).arrayBuffer())).metadata()).format, 'webp');
  }
});

test('invalid, mislabeled, corrupt, oversized, huge and animated files never save an avatar', async () => {
  const owner = await login();
  assert.equal((await upload(owner, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 1, randomUUID(), 'image/svg+xml')).status, 415);
  assert.equal((await upload(owner, Buffer.from('<svg/>'))).status, 422);
  assert.equal((await upload(owner, png, 1, randomUUID(), 'image/jpeg')).status, 422);
  assert.equal((await upload(owner, png.subarray(0, 40))).status, 422);
  assert.equal((await upload(owner, png, 1, randomUUID(), 'image/png', { 'Content-Length': String(2 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await upload(owner, Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);
  const huge = await sharp({ create: { width: 4097, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  assert.equal((await upload(owner, huge)).status, 422);
  const frames = await Promise.all(['red', 'blue'].map(background => sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer()));
  const animated = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2); assert.equal((await upload(owner, animated, 1, randomUUID(), 'image/webp')).status, 422);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_avatars WHERE image_bytes IS NOT NULL')).rows[0].n, 0);
});

test('chunked or misleading-length upload is bounded and cancelled before decoding', async () => {
  const owner = await login(); let cancelled = false, sent = 0;
  const stream = new ReadableStream({ pull(controller) { sent++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  const request = new Request(origin + '/api/v1/me/avatar', { method: 'POST', duplex: 'half', headers: { Origin: origin, Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'image/png', 'Content-Length': '1', 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, body: stream } as RequestInit);
  const response = await app.request(request); assert.equal(response.status, 413); assert.ok(cancelled); assert.ok(sent <= 4);
});

test('image reads require active same-community completed members; writes always target self and check CSRF', async () => {
  const owner = await login(), viewer = await login(DEMO_USERS[1].email), saved = await upload(owner);
  assert.equal((await image(saved.data.avatar_url)).status, 401);
  assert.equal((await upload(owner, png, 2, randomUUID(), 'image/png', { 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await upload(owner, png, 2, randomUUID(), 'image/png', { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await json(`/members/${owner.userId}/avatar/remove`, viewer, {}, 2)).status, 404);
  assert.equal((await json('/me/avatar/remove', viewer, { user_id: owner.userId }, 1)).status, 422);
  assert.equal((await image(saved.data.avatar_url, viewer)).status, 200);
  const community = randomUUID(), outsiderId = randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Other avatar test community']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'avatar-outsider@local.test','Outsider',password_hash,$3 FROM users WHERE user_id=$4`, [outsiderId, community, randomUUID(), owner.userId]);
  const outsider = await login('avatar-outsider@local.test'); assert.equal((await image(saved.data.avatar_url, outsider)).status, 404);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [viewer.userId]);
  assert.equal((await image(saved.data.avatar_url, viewer)).status, 403); assert.equal((await upload(viewer)).status, 403);
  await pool.query('UPDATE users SET active=false WHERE user_id=$1', [owner.userId]);
  assert.equal((await image(saved.data.avatar_url, owner)).status, 401);
  await pool.query('UPDATE users SET onboarding_required=false WHERE user_id=$1', [viewer.userId]);
  assert.equal((await image(saved.data.avatar_url, viewer)).status, 404);
});

test('version and idempotency protect replacement, removal, stale replays and simultaneous owner writes', async () => {
  const owner = await login(), key = randomUUID();
  const saved = await upload(owner, png, 1, key); assert.equal(saved.status, 200);
  const replay = await upload(owner, png, 1, key); assert.deepEqual(replay.data, saved.data);
  const changed = await sharp(png).negate().png().toBuffer(); assert.equal((await upload(owner, changed, 1, key)).status, 409);
  const concurrent = await Promise.all([upload(owner, changed, 2), upload(owner, png, 2)]); assert.deepEqual(concurrent.map(value => value.status).sort(), [200, 412]);
  const winner = concurrent.find(value => value.status === 200)!; assert.equal(winner.data.aggregate_version, 3);
  assert.equal((await image(saved.data.avatar_url, owner)).status, 404);
  assert.equal((await json('/me/avatar/remove', owner, {}, 2)).status, 412);
  const removeKey = randomUUID(), removed = await json('/me/avatar/remove', owner, {}, 3, removeKey); assert.equal(removed.status, 200); assert.equal(removed.data.avatar_url, null); assert.equal(removed.data.aggregate_version, 4);
  assert.deepEqual((await json('/me/avatar/remove', owner, {}, 3, removeKey)).data, removed.data);
  assert.equal((await image(winner.data.avatar_url, owner)).status, 404); assert.equal((await image(`/api/v1/members/${owner.userId}/avatar`, owner)).status, 404);
  assert.deepEqual((await upload(owner, png, 1, key)).data, saved.data); // Receipt replay must not restore deleted pixels.
  assert.deepEqual((await json('/me/avatar', owner)).data, removed.data);
  assert.equal((await pool.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1', [owner.userId])).rows[0].image_bytes, null);
  assert.equal((await json(`/members/${owner.userId}`, owner)).data.avatar_url, null);
  assert.equal((await upload(owner, png, 4)).data.aggregate_version, 5);
});

test('missing version/key and revoked sessions cannot mutate avatar bytes', async () => {
  const owner = await login();
  assert.equal((await upload(owner, png, 1, randomUUID(), 'image/png', { 'If-Match': '' })).status, 428);
  assert.equal((await upload(owner, png, 1, randomUUID(), 'image/png', { 'Idempotency-Key': '' })).status, 400);
  assert.equal((await json('/me/avatar/remove', owner, {})).status, 428);
  await json('/auth/logout', owner, {});
  assert.equal((await upload(owner)).status, 401);
});


const avatarGuild = 'guild_event_space';
async function appointAvatarRoles(master: Session, expert: Session) {
 const adminId = randomUUID();
 await pool.query("INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,'avatar-role-admin@example.invalid','頭像測試管理員')", [adminId, DEMO_COMMUNITY]);
 for (const member of [master, expert]) await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active')", [randomUUID(), DEMO_COMMUNITY, member.userId, avatarGuild]);
 await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)', [DEMO_COMMUNITY, avatarGuild, master.userId]);
 await pool.query('INSERT INTO positioning_guild_experts(community_id,guild_key,user_id,appointed_by) VALUES($1,$2,$3,$4)', [DEMO_COMMUNITY, avatarGuild, expert.userId, adminId]);
}
async function visibleAvatarRoles(viewer: Session) {
 const response = await json('/guilds/directory', viewer); assert.equal(response.status, 200);
 return response.data.items.find((item: any) => item.guild_key === avatarGuild);
}

test('guild master and expert projections use uploaded versioned avatars, change on replacement and clear on removal', async () => {
 const master = await login(), expert = await login(DEMO_USERS[1].email), viewer = await login(DEMO_USERS[2].email);
 await appointAvatarRoles(master, expert);
 const empty = await visibleAvatarRoles(viewer); assert.equal(empty.guild_master.avatar_url, null); assert.equal(empty.guild_experts[0].avatar_url, null);
 const first = await upload(master), expertPhoto = await upload(expert); assert.equal(first.status, 200); assert.equal(expertPhoto.status, 200);
 let directory = await visibleAvatarRoles(viewer);
 assert.deepEqual(directory.guild_master, { user_id: master.userId, display_name: DEMO_USERS[0].display_name, avatar_url: first.data.avatar_url });
 assert.deepEqual(directory.guild_experts, [{ user_id: expert.userId, display_name: DEMO_USERS[1].display_name, avatar_url: expertPhoto.data.avatar_url }]);
 for (const person of [directory.guild_master, ...directory.guild_experts]) { assert.deepEqual(Object.keys(person).sort(), ['avatar_url', 'display_name', 'user_id']); assert.equal((await image(person.avatar_url, viewer)).status, 200); }
 const replacement = await upload(master, await sharp(png).negate().png().toBuffer(), 2); assert.equal(replacement.status, 200); directory = await visibleAvatarRoles(viewer);
 assert.equal(directory.guild_master.avatar_url, `/api/v1/members/${master.userId}/avatar?v=3`); assert.equal((await image(first.data.avatar_url, viewer)).status, 404);
 assert.equal((await json('/me/avatar/remove', master, {}, 3)).status, 200); assert.equal((await json('/me/avatar/remove', expert, {}, 2)).status, 200);
 directory = await visibleAvatarRoles(viewer); assert.equal(directory.guild_master.avatar_url, null); assert.equal(directory.guild_experts[0].avatar_url, null);
 assert.equal((await image(replacement.data.avatar_url, viewer)).status, 404); assert.equal((await image(expertPhoto.data.avatar_url, viewer)).status, 404);
});

test('guild role avatar metadata respects completed owner and viewer visibility without changing role visibility', async () => {
 const master = await login(), expert = await login(DEMO_USERS[1].email), viewer = await login(DEMO_USERS[2].email);
 await appointAvatarRoles(master, expert); const masterPhoto = await upload(master), expertPhoto = await upload(expert);
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=ANY($1::uuid[])', [[master.userId, expert.userId]]);
 let directory = await visibleAvatarRoles(viewer); assert.equal(directory.guild_master.user_id, master.userId); assert.equal(directory.guild_experts[0].user_id, expert.userId); assert.equal(directory.guild_master.avatar_url, null); assert.equal(directory.guild_experts[0].avatar_url, null);
 assert.equal((await image(masterPhoto.data.avatar_url, viewer)).status, 404); assert.equal((await image(expertPhoto.data.avatar_url, viewer)).status, 404);
 await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=ANY($1::uuid[])', [[master.userId, expert.userId]]);
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [viewer.userId]);
 directory = await visibleAvatarRoles(viewer); assert.equal(directory.guild_master.avatar_url, null); assert.equal(directory.guild_experts[0].avatar_url, null); assert.equal((await image(masterPhoto.data.avatar_url, viewer)).status, 403);
 await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=$1', [viewer.userId]); directory = await visibleAvatarRoles(viewer); assert.equal(directory.guild_master.avatar_url, masterPhoto.data.avatar_url); assert.equal(directory.guild_experts[0].avatar_url, expertPhoto.data.avatar_url);
 await pool.query('UPDATE users SET active=false WHERE user_id=ANY($1::uuid[])', [[master.userId, expert.userId]]); directory = await visibleAvatarRoles(viewer); assert.equal(directory.guild_master, null); assert.deepEqual(directory.guild_experts, []); assert.equal((await image(masterPhoto.data.avatar_url, viewer)).status, 404);
});

test('guild role avatars are batched and do not cross communities or survive viewer session revocation', async () => {
 const master = await login(), expert = await login(DEMO_USERS[1].email), viewer = await login(DEMO_USERS[2].email);
 await appointAvatarRoles(master, expert); const masterPhoto = await upload(master); await upload(expert);
 const actor = await authenticate(pool, viewer.cookie.split('=')[1]); const queries: string[] = [];
 const observed = { query: async (text: string, values: unknown[]) => { queries.push(text); return pool.query(text, values); } } as unknown as Pool;
 let directory = (await guildDirectory(observed, actor)).find(item => item.guild_key === avatarGuild)!;
 assert.equal(directory.guild_master.avatar_url, masterPhoto.data.avatar_url); assert.equal(queries.filter(query => query.includes('member_avatars')).length, 1);
 // The only other reads load guild skill books; no role triggers an avatar query.
 assert.ok(queries.every(query => query.includes('member_avatars') || query.includes('guild_skill_book_bindings')));
 const community = randomUUID(), outsiderId = randomUUID(); await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Guild avatar outsider']);
 await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'guild-avatar-outsider@local.test','外部會員',password_hash,$3 FROM users WHERE user_id=$4`, [outsiderId, community, randomUUID(), master.userId]);
 const outsider = await login('guild-avatar-outsider@local.test'), outsideRoles = await visibleAvatarRoles(outsider); assert.equal(outsideRoles.guild_master, null); assert.deepEqual(outsideRoles.guild_experts, []); assert.equal((await image(masterPhoto.data.avatar_url, outsider)).status, 404);
 await json('/auth/logout', viewer, {}); assert.equal((await json('/guilds/directory', viewer)).status, 401);
 directory = (await guildDirectory(pool, actor)).find(item => item.guild_key === avatarGuild)!; assert.equal(directory.guild_master.avatar_url, null); assert.equal(directory.guild_experts[0].avatar_url, null);
 const currentViewer = await login(DEMO_USERS[2].email), inactiveActor = await authenticate(pool, currentViewer.cookie.split('=')[1]); await pool.query('UPDATE users SET active=false WHERE user_id=$1', [viewer.userId]);
 assert.equal((await json('/guilds/directory', currentViewer)).status, 401); directory = (await guildDirectory(pool, inactiveActor)).find(item => item.guild_key === avatarGuild)!; assert.equal(directory.guild_master.avatar_url, null); assert.equal(directory.guild_experts[0].avatar_url, null);
});
