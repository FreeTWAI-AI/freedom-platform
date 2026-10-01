import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { inspectCanonicalWebp } from '../../packages/shared/image-webp.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_svc_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const REAL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const app = createApp(pool, origin, 'local');

type Session = { cookie: string; csrf: string; user: { user_id: string; display_name: string } };
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
});

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
const APNG = Buffer.concat([PNG.subarray(0, 33), chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])), PNG.subarray(33)]);

function draft(overrides: Record<string, unknown> = {}) {
  return {
    title: '假髮造型', category: 'hair_beauty', summary: '客製假髮與造型調整', description: '到府或線上討論。',
    price_text: '每堂 NT$800 起', area_text: '台北・線上', service_mode: 'online',
    contacts: [{ label: '官方網站', url: 'https://Example.com/path?utm_source=a&id=1#frag' }],
    ...overrides,
  };
}
async function request(path: string, session?: Session, body?: unknown, method?: string, extra: Record<string, string> = {}, key = randomUUID()) {
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { Origin: origin, ...extra, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (verb !== 'GET') { headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'; headers['Idempotency-Key'] = key; }
  const response = await app.request(origin + '/api/v1' + path, { method: verb, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, text, response };
}
async function signIn(email = DEMO_USERS[0].email): Promise<Session> {
  const result = await request('/auth/login', undefined, { email, password: DEMO_PASSWORD });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return { cookie: result.response.headers.get('set-cookie')!.split(';')[0], csrf: result.data.csrf_token, user: result.data.user };
}
async function html(path: string) {
  const response = await app.request(origin + path);
  return { status: response.status, html: await response.text(), cache: response.headers.get('cache-control'), type: response.headers.get('content-type') };
}
async function go(code: string) {
  return app.request(`${origin}/go/${code}`);
}
async function click(code: string, ua = REAL) {
  const response = await app.request(origin + '/api/v1/promotion/clicks', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify({ code }) });
  return { status: response.status, data: await response.json() as { ok: boolean } };
}
async function addUser(email: string, name: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active)
    SELECT $1,community_id,$2,$3,password_hash,$4,true FROM users WHERE user_id=$5`,
  [id, email, name, randomUUID(), DEMO_USERS[0].user_id]);
  return id;
}
async function counts() {
  return (await pool.query(`SELECT (SELECT count(*)::int FROM contributions) AS contributions,
    (SELECT count(*)::int FROM outbox) AS outbox, (SELECT count(*)::int FROM transition_journal) AS journal`)).rows[0] as { contributions: number; outbox: number; journal: number };
}
function board(data: { boards: { kind: string; items: { user_id: string; display_name: string; points: number }[] }[] }, kind = 'member_service') {
  return data.boards.find(item => item.kind === kind)!;
}
function assertLogo(html: string) {
  assert.match(html, /<header class="service-top"><a href="\/"><img class="service-logo" src="\/brand\/freedom-workshop\.webp" alt="自由工坊" width="1280" height="720"><\/a><a href="\/services">社員服務<\/a><\/header>/);
}

test('owners edit with one version, outsiders are refused, and the five-service cap holds', async () => {
  const maker = await signIn(), reviewer = await signIn(DEMO_USERS[1].email);
  const before = await counts();
  const key = randomUUID();
  const created = await request('/member-services', maker, draft(), 'POST', {}, key);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.response.headers.get('etag'), '"1"');
  assert.equal(created.data.aggregate_version, 1);
  assert.equal(created.data.contacts[0].url, 'https://example.com/path?id=1');
  assert.equal(created.data.public_path, `/services/${created.data.service_id}`);
  assert.equal(created.data.mine, true);
  assert.equal(created.data.can_hide, false);
  const replay = await request('/member-services', maker, draft(), 'POST', {}, key);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.service_id, created.data.service_id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_services')).rows[0].n, 1);
  const clash = await request('/member-services', maker, draft({ title: '另一項' }), 'POST', {}, key);
  assert.equal(clash.status, 409);
  assert.equal(clash.data.code, 'idempotency_conflict');
  const after = await counts();
  assert.equal(after.journal, before.journal);
  assert.equal(after.outbox, before.outbox);
  assert.equal(after.contributions, before.contributions);

  const id = created.data.service_id as string;
  const missingVersion = await request(`/member-services/${id}`, maker, draft({ title: '改名' }), 'PUT');
  assert.equal(missingVersion.status, 428);
  assert.equal(missingVersion.data.code, 'version_required');
  const editKey = randomUUID();
  const edited = await request(`/member-services/${id}`, maker, draft({ title: '改名後的假髮' }), 'PUT', { 'If-Match': '"1"' }, editKey);
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.title, '改名後的假髮');
  assert.equal(edited.data.aggregate_version, 2);
  assert.equal(edited.response.headers.get('etag'), '"2"');
  const editReplay = await request(`/member-services/${id}`, maker, draft({ title: '改名後的假髮' }), 'PUT', { 'If-Match': '"1"' }, editKey);
  assert.equal(editReplay.data.aggregate_version, 2);
  assert.equal((await pool.query('SELECT aggregate_version::int AS v FROM member_services WHERE service_id=$1', [id])).rows[0].v, 2);
  const conflict = await request(`/member-services/${id}`, maker, draft({ title: '再改' }), 'PUT', { 'If-Match': '"1"' });
  assert.equal(conflict.status, 412);
  assert.equal(conflict.data.code, 'version_conflict');
  const outsider = await request(`/member-services/${id}`, reviewer, draft({ title: '搶改' }), 'PUT', { 'If-Match': '"2"' });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.data.code, 'owner_required');
  assert.equal((await request(`/member-services/${id}/pause`, reviewer, {}, 'POST', { 'If-Match': '"2"' })).status, 403);
  assert.equal((await request(`/member-services/${randomUUID()}/pause`, reviewer, {}, 'POST', { 'If-Match': '"1"' })).status, 404);

  const paused = await request(`/member-services/${id}/pause`, maker, {}, 'POST', { 'If-Match': '"2"' });
  assert.equal(paused.status, 200, JSON.stringify(paused.data));
  assert.equal(paused.data.state, 'paused');
  const pauseAgain = await request(`/member-services/${id}/pause`, maker, {}, 'POST', { 'If-Match': `"${paused.data.aggregate_version}"` });
  assert.equal(pauseAgain.status, 409);
  assert.equal(pauseAgain.data.code, 'member_service_state');
  const resumed = await request(`/member-services/${id}/resume`, maker, {}, 'POST', { 'If-Match': `"${paused.data.aggregate_version}"` });
  assert.equal(resumed.data.state, 'active');
  const resumeAgain = await request(`/member-services/${id}/resume`, maker, {}, 'POST', { 'If-Match': `"${resumed.data.aggregate_version}"` });
  assert.equal(resumeAgain.status, 409);

  for (let n = 0; n < 4; n++) assert.equal((await request('/member-services', maker, draft({ title: `服務 ${n}` }))).status, 201);
  const sixth = await request('/member-services', maker, draft({ title: '第六項' }));
  assert.equal(sixth.status, 409);
  assert.equal(sixth.data.code, 'member_service_limit');
  const held = await request(`/member-services/${id}/pause`, maker, {}, 'POST', { 'If-Match': `"${resumed.data.aggregate_version}"` });
  assert.equal(held.data.state, 'paused');
  assert.equal((await request('/member-services', maker, draft({ title: '暫停仍佔名額' }))).status, 409);
  const removed = await request(`/member-services/${id}`, maker, {}, 'DELETE', { 'If-Match': `"${held.data.aggregate_version}"` });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.state, 'deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_service_covers WHERE service_id=$1', [id])).rows[0].n, 0);
  const freed = await request('/member-services', maker, draft({ title: '空出名額' }));
  assert.equal(freed.status, 201, JSON.stringify(freed.data));
  const mine = await request('/member-services/mine', maker);
  assert.equal(mine.data.limit, 5);
  assert.equal(mine.data.items.some((item: { service_id: string }) => item.service_id === id), false);
  assert.equal(mine.data.items.length, 5);
});

test('field checks reject every unsafe contact URL and keep the normalized one', async () => {
  const maker = await signIn();
  const cases: unknown[] = [
    draft({ title: '' }),
    draft({ title: '名'.repeat(81) }),
    draft({ category: 'nope' }),
    draft({ service_mode: 'remote' }),
    draft({ contacts: [] }),
    draft({ contacts: [1, 2, 3, 4].map(n => ({ label: `站${n}`, url: 'https://example.com/' })) }),
    draft({ extra: true }),
    draft({ description: '有\u0000控制字元' }),
    draft({ price_text: '一行\n兩行' }),
    draft({ contacts: [{ label: '站', url: 'http://example.com/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://user:pass@example.com/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://example.com:8443/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://127.0.0.1/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://2130706433/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://[::1]/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://localhost/path' }] }),
    draft({ contacts: [{ label: '站', url: 'https://app.localhost/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://printer.local/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://svc.internal/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://nas.lan/' }] }),
    draft({ contacts: [{ label: '站', url: 'https://single' }] }),
    draft({ contacts: [{ label: '站', url: 'javascript:alert(1)' }] }),
    draft({ contacts: [{ label: '站', url: `https://example.com/${'a'.repeat(2100)}` }] }),
    draft({ contacts: [{ label: '站', url: 'https://example.com/\u0001' }] }),
    draft({ contacts: [{ label: '站', url: 'x'.repeat(4097) }] }),
  ];
  for (const body of cases) {
    const result = await request('/member-services', maker, body);
    assert.equal(result.status, 422, JSON.stringify(body));
    assert.ok(result.data.code === 'validation_failed' || result.data.code === 'member_service_contact', JSON.stringify(result.data));
  }
  const contact = await request('/member-services', maker, draft({ contacts: [{ label: '站', url: 'http://example.com/' }] }));
  assert.equal(contact.data.code, 'member_service_contact');
  const stored = await request('/member-services', maker, draft({ title: '可<script>用', summary: '簡介"引號', description: '第一段\r\n\r\n第二段' }));
  assert.equal(stored.status, 201, JSON.stringify(stored.data));
  assert.equal(stored.data.title, '可<script>用');
  assert.equal(stored.data.description, '第一段\n\n第二段');
  assert.equal(stored.data.contacts[0].url, 'https://example.com/path?id=1');
  const badFilter = await request('/member-services?category=nope', maker);
  assert.equal(badFilter.status, 422);
  assert.equal(badFilter.data.code, 'validation_failed');
  const badCursor = await request('/member-services?cursor=%%%', maker);
  assert.equal(badCursor.status, 422);
  assert.equal(badCursor.data.code, 'invalid_cursor');
});

test('covers normalize to 1200x675 and reject the wrong bytes', async () => {
  const maker = await signIn(), reviewer = await signIn(DEMO_USERS[1].email);
  const created = await request('/member-services', maker, draft());
  const id = created.data.service_id as string;
  async function upload(bytes: Uint8Array | Buffer, headers: Record<string, string>, key = randomUUID()) {
    const response = await app.request(`${origin}/api/v1/member-services/${id}/cover`, {
      method: 'PUT', body: new Uint8Array(bytes),
      headers: { Origin: origin, Cookie: maker.cookie, 'X-CSRF-Token': maker.csrf, 'Idempotency-Key': key, 'If-Match': '"1"', ...headers },
    });
    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, data, response };
  }
  const gif = await upload(PNG, { 'Content-Type': 'image/gif', 'Content-Length': String(PNG.length) });
  assert.equal(gif.status, 415);
  assert.equal(gif.data.code, 'service_cover_format');
  const declared = await upload(PNG, { 'Content-Type': 'image/png', 'Content-Length': String(4 * 1024 * 1024 + 1) });
  assert.equal(declared.status, 413);
  assert.equal(declared.data.code, 'service_cover_too_large');
  const huge = new Uint8Array(4 * 1024 * 1024 + 1);
  const oversized = await app.request(`${origin}/api/v1/member-services/${id}/cover`, {
    method: 'PUT', body: huge,
    headers: { Origin: origin, Cookie: maker.cookie, 'X-CSRF-Token': maker.csrf, 'Content-Type': 'image/png', 'Idempotency-Key': randomUUID(), 'If-Match': '"1"', 'Content-Length': String(huge.byteLength) },
  });
  assert.equal(oversized.status, 413);
  const stream = new ReadableStream({ start(controller) {
    for (let n = 0; n < 4; n++) controller.enqueue(new Uint8Array(1024 * 1024));
    controller.enqueue(new Uint8Array(1));
    controller.close();
  } });
  const streamed = await app.request(`${origin}/api/v1/member-services/${id}/cover`, {
    method: 'PUT', body: stream, duplex: 'half',
    headers: { Origin: origin, Cookie: maker.cookie, 'X-CSRF-Token': maker.csrf, 'Content-Type': 'image/png', 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  } as RequestInit);
  assert.equal(streamed.status, 413);
  const mismatch = await upload(PNG, { 'Content-Type': 'image/jpeg', 'Content-Length': String(PNG.length) });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.data.code, 'invalid_service_cover');
  const animated = await upload(APNG, { 'Content-Type': 'image/png', 'Content-Length': String(APNG.length) });
  assert.equal(animated.status, 422);
  assert.equal(animated.data.code, 'invalid_service_cover');
  assert.match(animated.data.detail, /封面無法使用/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_service_covers')).rows[0].n, 0);

  const key = randomUUID();
  const saved = await upload(PNG, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) }, key);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.aggregate_version, 2);
  assert.equal(saved.response.headers.get('etag'), '"2"');
  assert.match(saved.data.cover_url, /\/cover\?v=2$/);
  const again = await upload(PNG, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) }, key);
  assert.equal(again.data.aggregate_version, 2);
  const row = (await pool.query('SELECT image_bytes FROM member_service_covers WHERE service_id=$1', [id])).rows[0];
  const image = inspectCanonicalWebp(row.image_bytes);
  assert.equal(image.width, 1200);
  assert.equal(image.height, 675);
  assert.equal(image.chunks.includes('ANIM'), false);
  const memberCover = await app.request(`${origin}/api/v1/member-services/${id}/cover`, { headers: { Cookie: maker.cookie } });
  assert.equal(memberCover.status, 200);
  assert.equal(memberCover.headers.get('content-type'), 'image/webp');
  assert.equal(memberCover.headers.get('cache-control'), 'private, no-store');
  assert.equal(memberCover.headers.get('cross-origin-resource-policy'), 'same-origin');
  const publicCover = await app.request(`${origin}/api/v1/public/member-services/${id}/cover`);
  assert.equal(publicCover.status, 200);
  assert.equal(publicCover.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(publicCover.headers.get('content-type'), 'image/webp');
  const stranger = await app.request(`${origin}/api/v1/member-services/${id}/cover`, { headers: { Cookie: reviewer.cookie } });
  assert.equal(stranger.status, 200);

  const removed = await request(`/member-services/${id}/cover/remove`, maker, {}, 'POST', { 'If-Match': '"2"' });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.cover_url, null);
  assert.equal((await app.request(`${origin}/api/v1/public/member-services/${id}/cover`)).status, 404);
  const paused = await request(`/member-services/${id}/pause`, maker, {}, 'POST', { 'If-Match': `"${removed.data.aggregate_version}"` });
  const replaced = await app.request(`${origin}/api/v1/member-services/${id}/cover`, {
    method: 'PUT', body: new Uint8Array(PNG),
    headers: { Origin: origin, Cookie: maker.cookie, 'X-CSRF-Token': maker.csrf, 'Content-Type': 'image/png', 'Content-Length': String(PNG.length), 'Idempotency-Key': randomUUID(), 'If-Match': `"${paused.data.aggregate_version}"` },
  });
  assert.equal(replaced.status, 200, await replaced.clone().text());
  assert.equal((await app.request(`${origin}/api/v1/member-services/${id}/cover`, { headers: { Cookie: maker.cookie } })).status, 200);
  assert.equal((await app.request(`${origin}/api/v1/member-services/${id}/cover`, { headers: { Cookie: reviewer.cookie } })).status, 404);
  assert.equal((await app.request(`${origin}/api/v1/public/member-services/${id}/cover`)).status, 404);
  const version = (await replaced.json() as { aggregate_version: number }).aggregate_version;
  const deleted = await request(`/member-services/${id}`, maker, {}, 'DELETE', { 'If-Match': `"${version}"` });
  assert.equal(deleted.data.state, 'deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_service_covers WHERE service_id=$1', [id])).rows[0].n, 0);
});

test('paused, hidden, deleted and ineligible owners leave the public pages', async () => {
  const maker = await signIn(), reviewer = await signIn(DEMO_USERS[1].email);
  const created = await request('/member-services', maker, draft({ title: '公開假髮' }));
  const id = created.data.service_id as string;
  assert.equal((await html('/services.css')).html.includes('找不到這項服務'), false);
  const open = await html(`/services/${id}`);
  assert.equal(open.status, 200);
  assertLogo(open.html);
  assert.match(open.type ?? '', /text\/html/);
  assert.equal(open.cache, 'public, max-age=60');
  assert.match(open.html, /公開假髮/);
  assert.equal(open.html.includes('noindex'), false);
  assert.equal((await request('/member-services', reviewer)).data.items.some((item: { service_id: string }) => item.service_id === id), true);

  const paused = await request(`/member-services/${id}/pause`, maker, {}, 'POST', { 'If-Match': '"1"' });
  assert.equal((await html(`/services/${id}`)).status, 404);
  assert.equal((await request('/member-services', reviewer)).data.items.some((item: { service_id: string }) => item.service_id === id), false);
  const mine = await request('/member-services/mine', maker);
  assert.equal(mine.data.items[0].state, 'paused');
  assert.equal((await request('/promotion/links', reviewer, { kind: 'member_service', target: id })).status, 404);
  const code = randomBytes(7).toString('base64url');
  await pool.query(`INSERT INTO promotion_links(community_id,user_id,kind,target_key,code) VALUES($1,$2,'member_service',$3,$4)`, [DEMO_COMMUNITY, reviewer.user.user_id, id, code]);
  assert.equal((await go(code)).status, 302);
  assert.ok(((await go(code)).headers.get('location') ?? '').endsWith('/'));
  const resumed = await request(`/member-services/${id}/resume`, maker, {}, 'POST', { 'If-Match': `"${paused.data.aggregate_version}"` });
  assert.equal((await html(`/services/${id}`)).status, 200);
  assert.equal((await request('/promotion/links', reviewer, { kind: 'member_service', target: id })).status, 200);

  const hideDenied = await request(`/member-services/${id}/hide`, reviewer, {}, 'POST', { 'If-Match': `"${resumed.data.aggregate_version}"` });
  assert.equal(hideDenied.status, 403);
  assert.equal(hideDenied.data.code, 'member_service_admin_required');
  await pool.query('UPDATE users SET email_verified_at=now() WHERE user_id=$1', [maker.user.user_id]);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [randomUUID(), DEMO_COMMUNITY, 'maker@local.test', '平台管理員']);
  const hidden = await request(`/member-services/${id}/hide`, maker, {}, 'POST', { 'If-Match': `"${resumed.data.aggregate_version}"` });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.data));
  assert.equal(hidden.data.state, 'hidden');
  const hiddenAgain = await request(`/member-services/${id}/hide`, maker, {}, 'POST', { 'If-Match': `"${hidden.data.aggregate_version}"` });
  assert.equal(hiddenAgain.data.aggregate_version, hidden.data.aggregate_version);
  assert.equal((await request('/member-services', maker)).data.items.length, 0);
  assert.equal((await request('/member-services/mine', maker)).data.items.length, 0);
  const missing = await html(`/services/${id}`);
  assert.equal(missing.status, 404);
  assertLogo(missing.html);
  assert.match(missing.html, /找不到這項服務/);
  assert.match(missing.html, /noindex/);
  assert.equal(missing.html.includes('rel="canonical"'), false);
  assert.equal((await go(code)).status, 302);
  assert.equal((await request(`/member-services/${id}/pause`, maker, {}, 'POST', { 'If-Match': `"${hidden.data.aggregate_version}"` })).status, 404);

  const fresh = await request('/member-services', maker, draft({ title: '即將刪除' }));
  const deleted = await request(`/member-services/${fresh.data.service_id}`, maker, {}, 'DELETE', { 'If-Match': '"1"' });
  assert.equal(deleted.data.state, 'deleted');
  assert.equal((await html(`/services/${fresh.data.service_id}`)).status, 404);
  assert.equal((await request(`/member-services/${fresh.data.service_id}/hide`, maker, {}, 'POST', { 'If-Match': `"${deleted.data.aggregate_version}"` })).status, 404);

  const testerEmail = `wig-${randomUUID()}@example.invalid`;
  await addUser(testerEmail, '測試帳號');
  const tester = await signIn(testerEmail);
  const secret = await request('/member-services', tester, draft({ title: '測試帳號的服務' }));
  assert.equal(secret.status, 201, JSON.stringify(secret.data));
  assert.equal((await request('/member-services', tester)).data.items.some((item: { title: string }) => item.title === '測試帳號的服務'), true);
  assert.equal((await request('/member-services', reviewer)).data.items.some((item: { title: string }) => item.title === '測試帳號的服務'), false);
  assert.equal((await html(`/services/${secret.data.service_id}`)).status, 404);
  assert.equal((await request('/promotion/links', reviewer, { kind: 'member_service', target: secret.data.service_id })).status, 404);

  const quiet = await request('/member-services', reviewer, draft({ title: '停用後消失', category: 'language' }));
  await pool.query('UPDATE users SET active=false WHERE user_id=$1', [reviewer.user.user_id]);
  assert.equal((await request('/member-services', maker)).data.items.some((item: { title: string }) => item.title === '停用後消失'), false);
  assert.equal((await html(`/services/${quiet.data.service_id}`)).status, 404);
  const quietCode = randomBytes(7).toString('base64url');
  await pool.query(`INSERT INTO promotion_links(community_id,user_id,kind,target_key,code) VALUES($1,$2,'member_service',$3,$4)`, [DEMO_COMMUNITY, maker.user.user_id, quiet.data.service_id, quietCode]);
  assert.equal((await go(quietCode)).status, 302);
});

test('public pages escape member text, page, and filter without echoing a bad query', async () => {
  const maker = await signIn();
  await pool.query(`UPDATE users SET display_name=$2 WHERE user_id=$1`, [maker.user.user_id, `主人<script>"'`]);
  const nasty = await request('/member-services', maker, draft({
    title: `假髮<script>"'`, summary: `簡介<b>"'`, description: `第一段<script>\n\n第二段"引號'`,
    price_text: `NT$1<script>`, area_text: `台北"區'`, contacts: [{ label: `官網<script>`, url: 'https://example.com/wig?id=1' }],
  }));
  assert.equal(nasty.status, 201, JSON.stringify(nasty.data));
  const page = await html(`/services/${nasty.data.service_id}`);
  assert.equal(page.status, 200);
  assert.equal(page.html.includes('<script'), false);
  assert.match(page.html, /假髮&lt;script&gt;&quot;&#39;/);
  assert.match(page.html, /簡介&lt;b&gt;&quot;&#39;/);
  assert.match(page.html, /<p>第一段&lt;script&gt;<\/p><p>第二段&quot;引號&#39;<\/p>/);
  assert.match(page.html, /NT\$1&lt;script&gt;/);
  assert.match(page.html, /台北&quot;區&#39;/);
  assert.match(page.html, /主人&lt;script&gt;&quot;&#39;/);
  assert.match(page.html, /rel="noopener noreferrer nofollow"/);
  assert.match(page.html, /href="https:\/\/example\.com\/wig\?id=1"/);
  assert.match(page.html, new RegExp(`property="og:title" content="假髮&lt;script&gt;&quot;&#39;｜主人&lt;script&gt;&quot;&#39; 的服務｜自由工坊"`));
  assert.match(page.html, /property="og:description" content="簡介&lt;b&gt;&quot;&#39;"/);
  assert.match(page.html, /class="service-placeholder"/);
  assert.equal(page.html.includes('service-cover'), false);
  assertLogo(page.html);
  assert.match(page.html, /property="og:image" content="https:\/\/freetwai\.com\/brand\/freedom-workshop\.webp"/);
  assert.match(page.html, /property="og:image:width" content="1280"/);
  assert.match(page.html, /rel="canonical" href="https:\/\/freetwai\.com\/services\//);
  assert.equal(page.html.includes('maker@local.test'), false);
  assert.equal(page.html.includes('/api/v1/members/'), false);
  assert.match(page.html, /加入自由工坊/);
  assert.match(page.html, /在自由工坊看更多社員服務/);
  assert.match(page.html, />線上</);
  const covered = await app.request(`${origin}/api/v1/member-services/${nasty.data.service_id}/cover`, {
    method: 'PUT', body: new Uint8Array(PNG),
    headers: { Origin: origin, Cookie: maker.cookie, 'X-CSRF-Token': maker.csrf, 'Content-Type': 'image/png', 'Content-Length': String(PNG.length), 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  });
  assert.equal(covered.status, 200, await covered.clone().text());
  const withCover = await html(`/services/${nasty.data.service_id}`);
  assert.match(withCover.html, new RegExp(`<img class="service-cover" src="/api/v1/public/member-services/${nasty.data.service_id}/cover" alt="" width="1200" height="675">`));
  assert.match(withCover.html, new RegExp(`property="og:image" content="https://freetwai.com/api/v1/public/member-services/${nasty.data.service_id}/cover"`));
  assert.match(withCover.html, /property="og:image:width" content="1200"/);
  assert.match(withCover.html, /property="og:image:height" content="675"/);
  await pool.query(`UPDATE member_services SET updated_at='2020-01-01' WHERE service_id=$1`, [nasty.data.service_id]);

  for (let n = 1; n <= 13; n++) {
    const serviceId = randomUUID();
    const category = n <= 2 ? 'language' : 'design';
    await pool.query(`INSERT INTO member_services(service_id,community_id,owner_user_id,title,category,summary,description,price_text,area_text,service_mode,contacts,state,updated_at)
      VALUES($1,$2,$3,$4,$5,'分頁簡介',NULL,NULL,NULL,'online','[{"label":"網站","url":"https://example.com/page"}]'::jsonb,'active',$6)`,
    [serviceId, DEMO_COMMUNITY, maker.user.user_id, `S${String(n).padStart(2, '0')}`, category, new Date(Date.UTC(2026, 9, 1, 0, n))]);
  }
  const first = await html('/services');
  assert.equal(first.status, 200);
  assertLogo(first.html);
  assert.match(first.html, /S13/);
  assert.match(first.html, /S02/);
  assert.equal(first.html.includes('S01'), false);
  const nextHref = first.html.match(/href="(\/services\?before=[^"]+)"/)?.[1];
  assert.ok(nextHref);
  const second = await html(nextHref!.replaceAll('&amp;', '&'));
  assert.match(second.html, /S01/);
  assert.equal(second.html.includes('S13'), false);
  const language = await html('/services?category=language');
  assert.match(language.html, /aria-current="page"/);
  assert.match(language.html, /S02/);
  assert.match(language.html, /S01/);
  assert.equal(language.html.includes('S13'), false);
  const junk = await html('/services?category=nope%3Cscript%3E&before=not-a-cursor');
  assert.match(junk.html, /S13/);
  assert.equal(junk.html.includes('nope'), false);
  assert.equal(junk.html.includes('<script'), false);
  const unknown = await html(`/services/${randomUUID()}`);
  assert.equal(unknown.status, 404);
  assertLogo(unknown.html);
  assert.match(unknown.html, /這項服務目前沒有公開。/);
});

test('a member_service link scores the sharer, including the owner, and a non-uuid member card is rejected', async () => {
  const maker = await signIn(), reviewer = await signIn(DEMO_USERS[1].email);
  const created = await request('/member-services', maker, draft({ title: '可分享的課', summary: '一對一語言課', category: 'language' }));
  const id = created.data.service_id as string;
  const badTarget = await request('/promotion/links', reviewer, { kind: 'member_service', target: 'not-a-uuid' });
  assert.equal(badTarget.status, 422);
  assert.match(badTarget.data.detail, /服務目標不正確/);
  const missing = await request('/promotion/links', reviewer, { kind: 'member_service', target: randomUUID() });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'not_found');
  const badCard = await request('/promotion/links', reviewer, { kind: 'member_card', target: 'self' });
  assert.equal(badCard.status, 422);
  assert.equal(badCard.data.code, 'validation_failed');

  const shared = await request('/promotion/links', reviewer, { kind: 'member_service', target: id });
  assert.equal(shared.status, 200, JSON.stringify(shared.data));
  assert.match(shared.data.path, /^\/go\/[A-Za-z0-9_-]{10}$/);
  const interstitial = await go(shared.data.code);
  const body = await interstitial.text();
  assert.equal(interstitial.status, 200);
  assert.match(body, /property="og:title" content="可分享的課"/);
  assert.match(body, /property="og:description" content="一對一語言課"/);
  assert.match(body, /property="og:image" content="https:\/\/freetwai\.com\/brand\/freedom-workshop\.webp"/);
  assert.match(body, /property="og:image:width" content="1280"/);
  assert.match(body, /property="og:image:height" content="720"/);
  assert.match(body, new RegExp(`data-target="/services/${id}"`));
  assert.match(body, /noindex,nofollow/);
  await click(shared.data.code);
  const own = await request('/promotion/links', maker, { kind: 'member_service', target: id });
  await click(own.data.code, REAL.replace('128.0.0.0', '128.0.0.9'));
  const week = await request('/promotion/leaderboards?period=week', maker);
  const serviceBoard = board(week.data);
  assert.equal(serviceBoard.items.find((item: { user_id: string }) => item.user_id === reviewer.user.user_id)?.points, 1);
  assert.equal(serviceBoard.items.find((item: { user_id: string }) => item.user_id === maker.user.user_id)?.points, 1);
  const listed = await request('/member-services', maker);
  const card = listed.data.items.find((item: { service_id: string }) => item.service_id === id);
  assert.equal(card.total_points, 2);
  assert.equal(card.my_points, 1);
  const reviewerCard = (await request('/member-services', reviewer)).data.items.find((item: { service_id: string }) => item.service_id === id);
  assert.equal(reviewerCard.my_points, 1);
  const mine = await request('/promotion/links/mine', reviewer);
  const link = mine.data.items.find((item: { code: string }) => item.code === shared.data.code);
  assert.equal(link.available, true);
  assert.equal(link.title, '可分享的課');

  const covered = await app.request(`${origin}/api/v1/member-services/${id}/cover`, {
    method: 'PUT', body: new Uint8Array(PNG),
    headers: { Origin: origin, Cookie: maker.cookie, 'X-CSRF-Token': maker.csrf, 'Content-Type': 'image/png', 'Content-Length': String(PNG.length), 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  });
  assert.equal(covered.status, 200, await covered.clone().text());
  const preview = await go(shared.data.code);
  const previewHtml = await preview.text();
  assert.match(previewHtml, new RegExp(`property="og:image" content="https://freetwai.com/api/v1/public/member-services/${id}/cover"`));
  assert.match(previewHtml, /property="og:image:width" content="1200"/);
  assert.match(previewHtml, /property="og:image:height" content="675"/);

  await pool.query('UPDATE users SET active=false WHERE user_id=$1', [maker.user.user_id]);
  const closedMine = await request('/promotion/links/mine', reviewer);
  const unavailable = closedMine.data.items.find((item: { code: string }) => item.code === shared.data.code);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.title, '可分享的課');
});
