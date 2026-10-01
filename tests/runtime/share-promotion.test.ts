import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { tokenHash } from '../../modules/identity-membership/service.js';
import { communityCatalog } from '../../modules/community/catalog.js';
import { getSkillShareContent } from '../../modules/community/skill-share-content.js';
import { PREVIEW_BOT_MARKERS, isPreviewBot } from '../../packages/shared/promotion-bots.js';
import { promotionLeaderboardSql, taipeiDate, type PromotionKind } from '../../modules/community/promotion.js';
import type { PreviewFetch } from '../../modules/community/link-preview.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_promo_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const REAL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const LINE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.15.0';
const FBIAB = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/500.0.0.0]';
const FBAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.0]';
const IG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0';
let clock = new Date('2026-10-04T16:30:00.000Z');
let previewFetches = 0;

const previewFetch: PreviewFetch = async input => {
  previewFetches += 1;
  const url = String(input);
  if (url.startsWith('https://boom.example/')) throw new Error('preview down');
  if (url.startsWith('https://www.youtube.com/oembed')) return new Response(JSON.stringify({ title: '預覽標題' }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://i.ytimg.com/') || url === 'https://cdn.example/thumb.png') return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } });
  if (url.startsWith('https://bad-image.example/')) return new Response('<meta property="og:title" content="壞圖"><meta property="og:image" content="https://cdn.example/bad.png">', { status: 200, headers: { 'content-type': 'text/html' } });
  if (url === 'https://cdn.example/bad.png') return new Response(new Uint8Array(Buffer.from('not-a-png')), { status: 200, headers: { 'content-type': 'image/png' } });
  if (url.startsWith('https://no-title.example/')) return new Response('<!doctype html><p>none</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (url.startsWith('https://')) return new Response('<meta property="og:title" content="頁面標題"><meta property="og:image" content="https://cdn.example/thumb.png">', { status: 200, headers: { 'content-type': 'text/html' } });
  return new Response('missing', { status: 404 });
};
const app = createApp(pool, origin, 'local', { now: () => clock, linkPreviewFetch: previewFetch });

type Session = { cookie: string; csrf: string; user: { user_id: string; display_name: string } };
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  previewFetches = 0;
  clock = new Date('2026-10-04T16:30:00.000Z');
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await pool.query('TRUNCATE promotion_click_salts');
  await seedLocal(pool);
});

async function request(path: string, session?: Session, body?: unknown, method?: string, key = randomUUID()) {
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = key; }
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
async function click(code: string, ua = REAL, cookie?: string) {
  const headers: Record<string, string> = { Origin: origin, 'Content-Type': 'application/json', 'User-Agent': ua };
  if (cookie) headers.Cookie = cookie;
  const response = await app.request(origin + '/api/v1/promotion/clicks', { method: 'POST', headers, body: JSON.stringify({ code }) });
  return { status: response.status, data: await response.json() as any };
}
async function pointsOf(code: string) {
  return (await pool.query('SELECT count(*)::int AS n FROM promotion_clicks c JOIN promotion_links l ON l.link_id=c.link_id WHERE l.code=$1', [code])).rows[0].n as number;
}
async function platformLink(session: Session) {
  const created = await request('/promotion/links', session, { kind: 'platform', target: 'workshop' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  return created.data as { code: string; path: string; points: { week: number; all: number } };
}
async function addUser(email: string, name: string, options: { id?: string; active?: boolean; onboarding?: boolean; community?: string } = {}) {
  const id = options.id ?? randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,COALESCE($2,community_id),$3,$4,password_hash,$5,$6,$7 FROM users WHERE user_id=$8`,
  [id, options.community ?? null, email, name, randomUUID(), options.active !== false, options.onboarding === true, DEMO_USERS[0].user_id]);
  return id;
}
async function eventRow(id: string, organizer: string, visibility: 'open' | 'workshop' | 'referral', title: string, description: string, state = 'published') {
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    VALUES($1,$2,$3,$4,$5,now()+interval '2 days',now()+interval '3 days','online','線上',$6,$7,'other')`, [id, DEMO_COMMUNITY, organizer, title, description, state, visibility]);
}
async function bulkClicks(linkId: string, userId: string, kind: string, count: number, at: Date) {
  if (!count) return;
  const day = taipeiDate(at), values: unknown[] = [], rows: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = values.length;
    values.push(linkId, day, `v:${createHash('sha256').update(`${linkId}:${i}:${at.toISOString()}`).digest('hex')}`, 'c'.repeat(64), DEMO_COMMUNITY, userId, kind, at);
    rows.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`);
  }
  await pool.query(`INSERT INTO promotion_clicks(link_id,click_day,visitor_key,network_key,community_id,user_id,kind,created_at) VALUES ${rows.join(',')}`, values);
}
async function ownLink(userId: string, kind: PromotionKind, target: string) {
  const code = randomBytes(7).toString('base64url');
  const row = (await pool.query(`INSERT INTO promotion_links(community_id,user_id,kind,target_key,code,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING link_id`, [DEMO_COMMUNITY, userId, kind, target, code, clock])).rows[0];
  return { linkId: row.link_id as string, code };
}
async function facts() {
  return (await pool.query(`SELECT (SELECT count(*)::int FROM contributions) AS contributions,
    (SELECT count(*)::int FROM work_decisions) AS work_decisions,
    (SELECT count(*)::int FROM outbox) AS outbox,
    (SELECT count(*)::int FROM transition_journal) AS journal`)).rows[0];
}

test('preview bots are not credited and in-app browsers are', async () => {
  assert.equal(isPreviewBot(''), true);
  assert.equal(isPreviewBot('   '), true);
  assert.equal(isPreviewBot(LINE), false);
  assert.equal(isPreviewBot(FBAN), false);
  assert.equal(isPreviewBot(FBIAB), false);
  assert.equal(isPreviewBot(IG), false);
  assert.equal(isPreviewBot('Mozilla/5.0 javascript Chrome/128.0.0.0 Safari/537.36'), false);
  assert.equal(isPreviewBot('Java/11.0.2'), true);
  const maker = await signIn(), link = await platformLink(maker);
  for (const marker of PREVIEW_BOT_MARKERS) {
    const result = await click(link.code, `Mozilla/5.0 (${marker}) Chrome/128.0.0.0`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { ok: true });
  }
  assert.equal(await pointsOf(link.code), 0);
  for (const ua of ['', '   ']) assert.deepEqual((await click(link.code, ua)).data, { ok: true });
  assert.equal(await pointsOf(link.code), 0);
  for (const ua of [REAL, LINE, FBAN, FBIAB, IG, 'Mozilla/5.0 javascript Chrome/128.0.0.0 Safari/537.36']) {
    assert.equal((await click(link.code, ua)).status, 200);
  }
  assert.equal(await pointsOf(link.code), 6);
  assert.deepEqual((await click('no-such-code', REAL)).data, { ok: true });
  assert.equal(await pointsOf(link.code), 6);
});

test('self clicks, the Taipei day and a signed-in member each count at most once', async () => {
  const maker = await signIn(), other = await signIn(DEMO_USERS[1].email), link = await platformLink(maker);
  clock = new Date('2026-10-04T15:00:00.000Z');
  await click(link.code, REAL, maker.cookie);
  await click(link.code, REAL);
  await click(link.code, REAL.replace('128.0.0.0', '128.0.0.9'));
  assert.equal(await pointsOf(link.code), 2);
  clock = new Date('2026-10-04T15:30:00.000Z');
  await click(link.code, REAL);
  assert.equal(await pointsOf(link.code), 2);
  clock = new Date('2026-10-04T16:30:00.000Z');
  await click(link.code, REAL);
  assert.equal(await pointsOf(link.code), 3);
  await click(link.code, 'Mozilla/5.0 Chrome/129.0.0.0 Safari/537.36', other.cookie);
  await click(link.code, 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', other.cookie);
  await click(link.code, 'Mozilla/5.0 (HeadlessChrome) Chrome/128.0.0.0', other.cookie);
  assert.equal(await pointsOf(link.code), 4);
  const replay = await request('/promotion/links', maker, { kind: 'platform', target: 'workshop' });
  assert.equal(replay.data.code, link.code);
  assert.equal(replay.data.points.week, 2);
  assert.equal(replay.data.points.all, 4);
});

test('a visitor stops at 20 credited clicks and a network stops at 60', async () => {
  const maker = await signIn();
  const books = communityCatalog.skill_books.slice(0, 21);
  assert.ok(books.length === 21);
  const codes: string[] = [];
  for (const book of books) {
    const created = await request('/promotion/links', maker, { kind: 'skill_book', target: `book:${book.id}` });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    codes.push(created.data.code);
  }
  for (let i = 0; i < 20; i++) assert.equal((await click(codes[i], REAL)).status, 200);
  await click(codes[20], REAL);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM promotion_clicks')).rows[0].n, 20);
  await pool.query('TRUNCATE promotion_clicks, promotion_links, auth_rate_limits');
  const again = await platformLink(maker);
  for (let i = 0; i < 60; i++) assert.equal((await click(again.code, `Mozilla/5.0 Chrome/128.0.${i}.1 Safari/537.36`)).status, 200);
  await click(again.code, 'Mozilla/5.0 Chrome/128.0.60.1 Safari/537.36');
  assert.equal(await pointsOf(again.code), 60);
});

test('revoked links, disabled owners and unshareable targets do not score and redirect home', async () => {
  const maker = await signIn();
  const revoked = await platformLink(maker);
  await pool.query('UPDATE promotion_links SET revoked_at=now() WHERE code=$1', [revoked.code]);
  await click(revoked.code, REAL);
  assert.equal(await pointsOf(revoked.code), 0);
  const disabled = await platformLink(await signIn(DEMO_USERS[1].email));
  await pool.query('UPDATE users SET active=false WHERE user_id=$1', [DEMO_USERS[1].user_id]);
  await click(disabled.code, REAL);
  assert.equal(await pointsOf(disabled.code), 0);

  const post = await request('/social-posts', maker, { url: 'https://example.com/gone', title: '會消失' });
  assert.equal(post.status, 201, JSON.stringify(post.data));
  const postLink = await request('/promotion/links', maker, { kind: 'social_post', target: post.data.post_id });
  await request(`/social-posts/${post.data.post_id}`, maker, {}, 'DELETE');
  await click(postLink.data.code, REAL);
  assert.equal(await pointsOf(postLink.data.code), 0);

  const hiddenPost = await request('/social-posts', await signIn(DEMO_USERS[2].email), { url: 'https://example.com/hidden', title: '會隱藏' });
  await pool.query('UPDATE users SET email_verified_at=now() WHERE user_id=$1', [maker.user.user_id]);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [randomUUID(), DEMO_COMMUNITY, 'maker@local.test', '平台管理員']);
  const hiddenLink = await request('/promotion/links', maker, { kind: 'social_post', target: hiddenPost.data.post_id });
  assert.equal((await request(`/social-posts/${hiddenPost.data.post_id}/hide`, maker, {})).status, 200);
  await click(hiddenLink.data.code, REAL);
  assert.equal(await pointsOf(hiddenLink.data.code), 0);

  const eventId = randomUUID();
  await eventRow(eventId, maker.user.user_id, 'open', '會取消的活動', '說明');
  const eventLink = await request('/promotion/links', maker, { kind: 'event', target: eventId });
  await pool.query(`UPDATE community_events SET state='cancelled' WHERE event_id=$1`, [eventId]);
  await click(eventLink.data.code, REAL);
  assert.equal(await pointsOf(eventLink.data.code), 0);
  for (const code of [revoked.code, disabled.code, postLink.data.code, hiddenLink.data.code, eventLink.data.code, 'short']) {
    const response = await app.request(`${origin}/go/${code}?next=https://evil.example`);
    assert.equal(response.status, 302, code);
    assert.ok(!(response.headers.get('location') ?? '').includes('evil.example'), code);
    assert.ok((response.headers.get('location') ?? '').endsWith('/'), code);
  }
});

test('concurrent duplicate clicks award exactly one point', async () => {
  const maker = await signIn(), link = await platformLink(maker);
  const results = await Promise.all(Array.from({ length: 8 }, () => click(link.code, REAL)));
  assert.ok(results.every(result => result.status === 200 && result.data.ok === true));
  assert.equal(await pointsOf(link.code), 1);
});

test('clicks store no raw address or user agent, and salts older than three days are removed', async () => {
  const maker = await signIn(), link = await platformLink(maker);
  const salt = randomBytes(32);
  await pool.query('INSERT INTO promotion_click_salts(click_day,salt) VALUES($1,$2),($3,$2)', ['2026-10-01', salt, '2026-10-02']);
  const ua = 'Mozilla/5.0 SentinelBrowser/9.9 Chrome/128.0.0.0 Safari/537.36 198.51.100.23';
  await click(link.code, ua);
  assert.equal(await pointsOf(link.code), 1);
  const stored = JSON.stringify((await pool.query(`SELECT l.code,l.kind,l.target_key,c.visitor_key,c.network_key,c.kind AS click_kind,encode(s.salt,'hex') AS salt
    FROM promotion_links l LEFT JOIN promotion_clicks c ON c.link_id=l.link_id LEFT JOIN promotion_click_salts s ON true`)).rows);
  assert.ok(!stored.includes('SentinelBrowser') && !stored.includes('198.51.100.23') && !stored.includes(ua));
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name LIKE 'promotion%'`, [schema])).rows.map(row => row.column_name as string);
  assert.ok(columns.every(name => !/user_agent|ip_address|^ip$/.test(name)));
  const days = (await pool.query('SELECT click_day::text AS day FROM promotion_click_salts ORDER BY 1')).rows.map(row => row.day);
  assert.deepEqual(days, ['2026-10-02', '2026-10-05']);
  assert.equal((await pool.query('SELECT octet_length(salt)::int AS n FROM promotion_click_salts')).rows.every(row => row.n === 32), true);
});

test('the click route rate limit answers 429 and does not reveal a miss', async () => {
  const maker = await signIn(), link = await platformLink(maker);
  await pool.query('INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES($1,300,now())', [tokenHash('promotion-click-network/shared-server')]);
  const limited = await click(link.code, REAL);
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, 'auth_rate_limited');
  assert.equal(await pointsOf(link.code), 0);
  const bad = await app.request(origin + '/api/v1/promotion/clicks', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
});

test('the interstitial escapes text, sets open-graph tags and ignores extra query parameters', async () => {
  const maker = await signIn();
  const platform = await platformLink(maker);
  const skill = await request('/promotion/links', maker, { kind: 'skill_book', target: 'book:social-post' });
  assert.equal(skill.status, 200, JSON.stringify(skill.data));
  const nasty = await request('/social-posts', maker, { url: 'https://example.com/escape-me', title: '<script>alert("x")</script>' });
  assert.equal(nasty.status, 201, JSON.stringify(nasty.data));
  const social = await request('/promotion/links', maker, { kind: 'social_post', target: nasty.data.post_id });
  const openId = randomUUID(), closedId = randomUUID(), referralId = randomUUID();
  const secret = '機密活動標題ZZZ';
  await eventRow(openId, maker.user.user_id, 'open', '公開活動標題', '公'.repeat(180));
  await pool.query('INSERT INTO community_event_banners(event_id,image_bytes) VALUES($1,$2)', [openId, Buffer.from([1])]);
  await eventRow(closedId, maker.user.user_id, 'workshop', secret, '機密說明YYY');
  await pool.query('INSERT INTO community_event_banners(event_id,image_bytes) VALUES($1,$2)', [closedId, Buffer.from([1])]);
  await eventRow(referralId, maker.user.user_id, 'referral', '推薦活動標題', '推薦說明');
  const openLink = await request('/promotion/links', maker, { kind: 'event', target: openId });
  const closedLink = await request('/promotion/links', maker, { kind: 'event', target: closedId });
  const referralLink = await request('/promotion/links', maker, { kind: 'event', target: referralId });
  const shareCode = (await pool.query('SELECT code FROM community_event_share_codes WHERE event_id=$1 AND user_id=$2', [openId, maker.user.user_id])).rows[0].code as string;
  async function page(path: string) {
    const response = await app.request(origin + path);
    const html = await response.text();
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.match(html, /noindex,nofollow/);
    assert.match(html, /<script src="\/go\.js" defer><\/script>/);
    return html;
  }
  const home = await page(`/go/${platform.code}?utm_source=x&ref=evil`);
  assert.match(home, /<title>正在開啟：自由工坊｜自由工坊<\/title>/);
  assert.match(home, /property="og:type" content="website"/);
  assert.match(home, new RegExp(`property="og:url" content="https://freetwai.com/go/${platform.code}"`));
  assert.ok(!home.includes('property="og:url" content="https://freetwai.com/"'));
  assert.match(home, /property="og:title" content="自由工坊"/);
  assert.match(home, /加入公會、領取 Repo 技能書/);
  assert.match(home, /property="og:image" content="https:\/\/freetwai\.com\/brand\/freedom-workshop\.webp"/);
  assert.match(home, /property="og:image:width" content="1280"/);
  assert.match(home, /data-target="\/"/);
  assert.ok(!home.includes('utm_source') && !home.includes('evil'));
  const content = getSkillShareContent('social-post')!;
  const book = await page(`/go/${skill.data.code}?intro=2&evil=1`);
  assert.match(book, /property="og:type" content="website"/);
  assert.match(book, new RegExp(`property="og:url" content="https://freetwai.com/go/${skill.data.code}\\?intro=2"`));
  assert.ok(!book.includes('property="og:url" content="https://freetwai.com/development/'));
  assert.match(book, new RegExp(`data-target="/development/skills/social-post\\?intro=2"`));
  assert.ok(book.includes(`content="${content.introductions[1]}"`) || book.includes(`content="${content.introductions[1].replaceAll('"', '&quot;')}"`));
  assert.match(book, /property="og:image" content="https:\/\/freetwai\.com\/brand\/skill-illustrations\/social-post\.webp"/);
  assert.ok(!book.includes('evil=1'));
  const overflow = await page(`/go/${skill.data.code}?intro=999`);
  assert.match(overflow, /data-target="\/development\/skills\/social-post\?intro=999"/);
  const summary = communityCatalog.skill_books.find(item => item.id === 'social-post')!.description;
  assert.match(overflow, new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(!overflow.includes(content.introductions[0]));
  const ignored = await page(`/go/${skill.data.code}?intro=01`);
  assert.match(ignored, /data-target="\/development\/skills\/social-post"/);
  assert.match(ignored, new RegExp(`property="og:url" content="https://freetwai.com/go/${skill.data.code}"`));
  assert.ok(!ignored.includes('intro=01'));
  const socialHtml = await page(`/go/${social.data.code}?intro=1`);
  assert.match(socialHtml, new RegExp(`property="og:url" content="https://freetwai.com/go/${social.data.code}"`));
  assert.ok(!socialHtml.includes('property="og:url" content="https://example.com/escape-me"'));
  assert.match(socialHtml, /data-target="https:\/\/example\.com\/escape-me"/);
  assert.ok(socialHtml.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(!socialHtml.includes('<script>alert'));
  assert.match(socialHtml, /自由工坊社群分享的 其他 貼文/);
  const openHtml = await page(`/go/${openLink.data.code}?ref=evil&intro=4`);
  assert.match(openHtml, new RegExp(`data-target="/events/${openId}\\?ref=${shareCode}"`));
  assert.ok(!openHtml.includes('ref=evil'));
  assert.match(openHtml, /content="公開活動標題"/);
  assert.match(openHtml, new RegExp(`content="${'公'.repeat(160)}"`));
  assert.match(openHtml, new RegExp(`https://freetwai\\.com/api/v1/public/events/${openId}/banner`));
  const closedHtml = await page(`/go/${closedLink.data.code}`);
  assert.match(closedHtml, /content="機密活動標題ZZZ"/);
  assert.match(closedHtml, /content="機密說明YYY"/);
  assert.match(closedHtml, /property="og:image" content="https:\/\/freetwai\.com\/brand\/freedom-workshop\.webp"/);
  assert.match(closedHtml, /property="og:image:width" content="1280"/);
  assert.match(closedHtml, /property="og:image:height" content="720"/);
  assert.ok(closedHtml.includes(secret) && closedHtml.includes('機密說明YYY') && !closedHtml.includes('/banner'));
  assert.match(closedHtml, new RegExp(`data-target="/events/${closedId}\\?ref=`));
  const referralHtml = await page(`/go/${referralLink.data.code}`);
  assert.match(referralHtml, /content="推薦活動標題"/);
  const before = await facts();
  await click(platform.code, REAL);
  const after = await facts();
  assert.deepEqual(after, before);
});

test('guild and workshop previews use the brand image, and an ended event opens its highlight', async () => {
  const maker = await signIn();
  const guildId = randomUUID();
  const endedId = randomUUID();
  const hiddenId = randomUUID();
  const upcoming = new Date(Date.now() + 3 * 86400000);
  const upcomingStart = new Date(Date.now() + 2 * 86400000);
  const endedAt = new Date('2026-08-02T00:00:00.000Z');
  const endedStart = new Date('2026-08-01T00:00:00.000Z');
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind,guild_key)
    VALUES($1,$2,$3,'公會預覽標題','公會預覽說明',$4,$5,'in_person','線上','published','guild','guild_skill_exchange','guild_event_space')`,
  [guildId, DEMO_COMMUNITY, maker.user.user_id, upcomingStart, upcoming]);
  await pool.query('INSERT INTO community_event_banners(event_id,image_bytes) VALUES($1,$2)', [guildId, Buffer.from([1])]);
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    VALUES($1,$2,$3,'已結束的公開活動','結束後的說明',$4,$5,'online','線上','published','open','other')`,
  [endedId, DEMO_COMMUNITY, maker.user.user_id, endedStart, endedAt]);
  await pool.query(`INSERT INTO community_event_banners(event_id,image_bytes,orientation) VALUES($1,$2,'landscape')`, [endedId, Buffer.from([2])]);
  const testerEmail = `ended-host-${randomUUID()}@example.invalid`;
  const testerId = await addUser(testerEmail, '驗收主辦');
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    VALUES($1,$2,$3,'測試帳號已結束','不該進公開集錦',$4,$5,'online','線上','published','open','other')`,
  [hiddenId, DEMO_COMMUNITY, testerId, endedStart, endedAt]);
  const guildLink = await request('/promotion/links', maker, { kind: 'event', target: guildId });
  const endedLink = await request('/promotion/links', maker, { kind: 'event', target: endedId });
  assert.equal(guildLink.status, 200, JSON.stringify(guildLink.data));
  assert.equal(endedLink.status, 200, JSON.stringify(endedLink.data));
  const tester = await signIn(testerEmail);
  const hiddenLink = await request('/promotion/links', tester, { kind: 'event', target: hiddenId });
  assert.equal(hiddenLink.status, 200, JSON.stringify(hiddenLink.data));
  async function htmlOf(code: string) {
    const response = await app.request(`${origin}/go/${code}`);
    assert.equal(response.status, 200, code);
    return response.text();
  }
  const guildHtml = await htmlOf(guildLink.data.code);
  assert.match(guildHtml, /content="公會預覽標題"/);
  assert.match(guildHtml, /content="公會預覽說明"/);
  assert.match(guildHtml, /property="og:image" content="https:\/\/freetwai\.com\/brand\/freedom-workshop\.webp"/);
  assert.match(guildHtml, /property="og:image:width" content="1280"/);
  assert.match(guildHtml, /property="og:image:height" content="720"/);
  assert.ok(!guildHtml.includes('/banner'));
  assert.match(guildHtml, new RegExp(`data-target="/events/${guildId}\\?ref=`));
  const seen: string[] = [];
  const original = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    const first = args[0];
    seen.push(typeof first === 'string' ? first : first && typeof first === 'object' && 'text' in first ? String((first as { text: unknown }).text) : '');
    return (original as (...inner: unknown[]) => Promise<unknown>)(...args);
  }) as typeof pool.query;
  let endedHtml = '';
  try { endedHtml = await htmlOf(endedLink.data.code); }
  finally { pool.query = original; }
  assert.match(endedHtml, new RegExp(`data-target="/highlights/${endedId}"`));
  assert.ok(!endedHtml.includes(`/events/${endedId}`));
  assert.match(endedHtml, /content="已結束的公開活動"/);
  assert.match(endedHtml, /content="結束後的說明"/);
  assert.match(endedHtml, new RegExp(`property="og:image" content="https://freetwai\\.com/api/v1/public/event-highlights/${endedId}/banner"`));
  assert.match(endedHtml, /property="og:image:width" content="1200"/);
  assert.match(endedHtml, /property="og:image:height" content="675"/);
  const bytes = seen.filter(sql => /community_event_highlight_images/i.test(sql) || (/community_event_banners/i.test(sql) && /image_bytes/i.test(sql)));
  assert.deepEqual(bytes, []);
  const hiddenHtml = await htmlOf(hiddenLink.data.code);
  assert.match(hiddenHtml, new RegExp(`data-target="/events/${hiddenId}\\?ref=`));
  assert.ok(!hiddenHtml.includes(`/highlights/${hiddenId}`));
  await click(endedLink.data.code, REAL);
  assert.equal(await pointsOf(endedLink.data.code), 1);
});

test('link creation validates each kind, stays idempotent and keeps member cards closed', async () => {
  const maker = await signIn();
  assert.equal((await request('/promotion/links', maker, { kind: 'member_card', target: maker.user.user_id })).data.code, 'promotion_kind_unavailable');
  const missingService = await request('/promotion/links', maker, { kind: 'member_service', target: randomUUID() });
  assert.equal(missingService.status, 404);
  assert.equal(missingService.data.code, 'not_found');
  assert.equal((await request('/promotion/links', maker, { kind: 'platform', target: 'home' })).status, 422);
  assert.equal((await request('/promotion/links', maker, { kind: 'skill_book', target: 'book:missing-book' })).status, 404);
  assert.equal((await request('/promotion/links', maker, { kind: 'skill_book', target: 'nope' })).status, 422);
  const project = randomUUID(), version = randomUUID(), submission = randomUUID(), sha = 'a'.repeat(64);
  await pool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship)
    VALUES($1,$2,$3,'社群技能','說明','用法','8801001','example/promo-skill','https://github.com/example/promo-skill','author')`, [project, DEMO_COMMUNITY, maker.user.user_id]);
  await pool.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,repository_full_name,repository_url,readme_url,license_spdx,is_fork,archived,source_snapshot,source_sha256,facts_sha256,inspected_at)
    VALUES($1,$2,'8801001',$3,'main','example/promo-skill','https://github.com/example/promo-skill','https://github.com/example/promo-skill#readme','MIT',false,false,'{}',$4,$4,now())`, [version, project, 'b'.repeat(40), sha]);
  await pool.query('UPDATE oss_projects SET current_version_id=$2 WHERE project_id=$1', [project, version]);
  await pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,status,payload,payload_sha256,consent_to_share,project_id,project_version_id,published_at,grant_consumed_at)
    VALUES($1,$2,$3,'published',$4,$5,true,$6,$7,now(),now())`, [submission, DEMO_COMMUNITY, maker.user.user_id, JSON.stringify({ title: '已公開技能', description: '技能說明', relationship: 'author', share_introductions: ['第一句介紹'], use_notes: '用法' }), sha, project, version]);
  const published = await request('/promotion/links', maker, { kind: 'skill_book', target: `submission:${submission}` });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.title, '已公開技能');
  const submissionPage = await (await app.request(`${origin}/go/${published.data.code}?intro=1`)).text();
  assert.match(submissionPage, new RegExp(`data-target="/development/submissions/${submission}\\?intro=1"`));
  assert.match(submissionPage, /第一句介紹/);
  const eventId = randomUUID();
  await eventRow(eventId, maker.user.user_id, 'open', '可分享活動', '活動說明');
  const pending = randomUUID();
  await eventRow(pending, maker.user.user_id, 'open', '未公開', '說明', 'pending');
  assert.equal((await request('/promotion/links', maker, { kind: 'event', target: pending })).status, 404);
  const eventLink = await request('/promotion/links', maker, { kind: 'event', target: eventId });
  assert.equal(eventLink.status, 200, JSON.stringify(eventLink.data));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM community_event_share_codes WHERE event_id=$1 AND user_id=$2', [eventId, maker.user.user_id])).rows[0].n, 1);
  await click(eventLink.data.code, REAL);
  const report = await request(`/events/${eventId}/referrals`, maker);
  assert.equal(report.status, 200, JSON.stringify(report.data));
  assert.equal(report.data.items[0].clicks, 1);
  assert.equal(report.data.items[0].registrations, 0);
  assert.equal((await request(`/events/${eventId}/referrals`, await signIn(DEMO_USERS[1].email))).status, 403);
  const missingPost = await request('/promotion/links', maker, { kind: 'social_post', target: randomUUID() });
  assert.equal(missingPost.status, 404);
  const first = await platformLink(maker);
  const second = await platformLink(maker);
  assert.equal(second.code, first.code);
  for (let i = 0; i < 199; i++) await pool.query(`INSERT INTO promotion_links(community_id,user_id,kind,target_key,code,created_at) VALUES($1,$2,'skill_book',$3,$4,$5)`, [DEMO_COMMUNITY, maker.user.user_id, `extra:${i}`, randomBytes(7).toString('base64url'), clock]);
  assert.equal((await request('/promotion/links', maker, { kind: 'platform', target: 'workshop' })).data.code, first.code);
  const limited = await request('/promotion/links', maker, { kind: 'skill_book', target: 'book:typo-studio' });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, 'promotion_link_limit');
});

test('leaderboards use Taipei periods, competition ranks and the same member visibility as the directory', async () => {
  const maker = await signIn();
  clock = new Date('2026-10-04T15:59:00.000Z');
  assert.equal((await request('/promotion/leaderboards?period=week', maker)).data.since, '2026-09-27T16:00:00.000Z');
  clock = new Date('2026-09-30T15:59:00.000Z');
  assert.equal((await request('/promotion/leaderboards?period=month', maker)).data.since, '2026-08-31T16:00:00.000Z');
  clock = new Date('2026-09-30T16:00:00.000Z');
  assert.equal((await request('/promotion/leaderboards?period=month', maker)).data.since, '2026-09-30T16:00:00.000Z');
  clock = new Date('2026-10-04T16:30:00.000Z');
  const empty = await request('/promotion/leaderboards', maker);
  assert.equal(empty.data.period, 'week');
  assert.equal(empty.data.since, '2026-10-04T16:00:00.000Z');
  assert.deepEqual(empty.data.boards.map((board: { kind: string }) => board.kind), ['member_card', 'platform', 'skill_book', 'social_post', 'member_service', 'event']);
  assert.ok(empty.data.boards.every((board: { items: unknown[]; me: unknown }) => board.items.length === 0 && board.me === null));
  assert.equal((await request('/promotion/leaderboards?period=all', maker)).data.since, null);

  const names = [['Ada', 5], ['Bea', 3], ['Cara', 3], ['Dan', 1]] as const;
  for (const [name, score] of names) {
    const id = await addUser(`${name}@member.test`, name);
    const link = await ownLink(id, 'platform', 'workshop');
    await bulkClicks(link.linkId, id, 'platform', score, clock);
  }
  const tiedLow = 'c0000000-0000-4000-8000-000000000001', tiedHigh = 'c0000000-0000-4000-8000-000000000002';
  for (const id of [tiedLow, tiedHigh]) {
    await addUser(`${id}@member.test`, '同名', { id });
    const link = await ownLink(id, 'platform', 'workshop');
    await bulkClicks(link.linkId, id, 'platform', 2, clock);
  }
  const board = (await request('/promotion/leaderboards?period=week', maker)).data.boards[1];
  assert.deepEqual(board.items.map((item: { display_name: string; rank: number; points: number }) => [item.display_name, item.rank, item.points]), [
    ['Ada', 1, 5], ['Bea', 2, 3], ['Cara', 2, 3], ['同名', 4, 2], ['同名', 4, 2], ['Dan', 6, 1],
  ]);
  assert.deepEqual(board.items.filter((item: { display_name: string }) => item.display_name === '同名').map((item: { user_id: string }) => item.user_id), [tiedLow, tiedHigh]);
  assert.equal(board.me, null);

  await pool.query('TRUNCATE promotion_clicks, promotion_links');
  const mine = await ownLink(maker.user.user_id, 'skill_book', 'book:social-post');
  await bulkClicks(mine.linkId, maker.user.user_id, 'skill_book', 1, clock);
  await bulkClicks(mine.linkId, maker.user.user_id, 'skill_book', 1, new Date('2026-10-04T15:59:00.000Z'));
  await bulkClicks(mine.linkId, maker.user.user_id, 'skill_book', 1, new Date('2026-09-30T15:59:00.000Z'));
  const ids: string[] = [];
  for (let i = 0; i < 11; i++) {
    const id = await addUser(`rank${i}@member.test`, `N${String(i).padStart(2, '0')}`);
    ids.push(id);
    const link = await ownLink(id, 'skill_book', 'book:social-post');
    await bulkClicks(link.linkId, id, 'skill_book', 5, clock);
  }
  await pool.query('INSERT INTO member_avatars(user_id,community_id,image_bytes,aggregate_version) VALUES($1,$2,$3,4)', [ids[0], DEMO_COMMUNITY, Buffer.from([1])]);
  const hidden = await addUser('rank-hidden@example.invalid', '驗收帳號');
  const hiddenLink = await ownLink(hidden, 'skill_book', 'book:social-post');
  await bulkClicks(hiddenLink.linkId, hidden, 'skill_book', 9, clock);
  await pool.query('INSERT INTO member_avatars(user_id,community_id,image_bytes,aggregate_version) VALUES($1,$2,$3,2)', [hidden, DEMO_COMMUNITY, Buffer.from([1])]);
  const inactive = await addUser('inactive@member.test', '停用', { active: false });
  const inactiveLink = await ownLink(inactive, 'skill_book', 'book:social-post');
  await bulkClicks(inactiveLink.linkId, inactive, 'skill_book', 9, clock);
  const pending = await addUser('pending@member.test', '未完成', { onboarding: true });
  const pendingLink = await ownLink(pending, 'skill_book', 'book:social-post');
  await bulkClicks(pendingLink.linkId, pending, 'skill_book', 9, clock);
  const otherCommunity = randomUUID();
  await pool.query('INSERT INTO communities(community_id,name) VALUES($1,$2)', [otherCommunity, '其他社群']);
  const outsider = await addUser('outsider@member.test', '其他社群的人', { community: otherCommunity });
  const outsiderCode = randomBytes(7).toString('base64url');
  const outsiderLink = (await pool.query(`INSERT INTO promotion_links(community_id,user_id,kind,target_key,code,created_at) VALUES($1,$2,'skill_book','book:social-post',$3,$4) RETURNING link_id`, [otherCommunity, outsider, outsiderCode, clock])).rows[0].link_id as string;
  await pool.query(`INSERT INTO promotion_clicks(link_id,click_day,visitor_key,network_key,community_id,user_id,kind,created_at) VALUES($1,$2,$3,$4,$5,$6,'skill_book',$7)`, [outsiderLink, '2026-10-05', 'v:' + 'd'.repeat(64), 'e'.repeat(64), otherCommunity, outsider, clock]);
  const week = (await request('/promotion/leaderboards?period=week', maker)).data.boards.find((board: { kind: string }) => board.kind === 'skill_book');
  assert.equal(week.items.length, 10);
  assert.equal(week.items[0].display_name, 'N00');
  assert.equal(week.items[0].avatar_url, `/api/v1/members/${ids[0]}/avatar?v=4`);
  assert.equal(week.items[1].avatar_url, null);
  assert.ok(week.items.every((item: { user_id: string; rank: number; points: number }) => item.rank === 1 && item.points === 5));
  assert.equal(week.me.rank, 12);
  assert.equal(week.me.points, 1);
  assert.ok(!JSON.stringify(week).includes(hidden) && !JSON.stringify(week).includes('驗收帳號') && !JSON.stringify(week).includes('停用') && !JSON.stringify(week).includes('未完成') && !JSON.stringify(week).includes('其他社群的人'));
  const month = (await request('/promotion/leaderboards?period=month', maker)).data.boards.find((board: { kind: string }) => board.kind === 'skill_book');
  assert.equal(month.me.points, 2);
  const all = (await request('/promotion/leaderboards?period=all', maker)).data.boards.find((board: { kind: string }) => board.kind === 'skill_book');
  assert.equal(all.me.points, 3);
  const self = await signIn('rank-hidden@example.invalid');
  const own = (await request('/promotion/leaderboards?period=week', self)).data.boards.find((board: { kind: string }) => board.kind === 'skill_book');
  assert.equal(own.me.points, 9);
  assert.equal(own.items.find((item: { user_id: string }) => item.user_id === hidden).avatar_url, `/api/v1/members/${hidden}/avatar?v=2`);
  const mineList = await request('/promotion/links/mine?period=all', maker);
  assert.equal(mineList.data.items[0].period_points, 3);
  assert.equal(mineList.data.items[0].points.week, 1);
  assert.equal(mineList.data.items[0].points.month, 2);
  assert.equal(mineList.data.items[0].points.all, 3);
  assert.equal(mineList.data.items[0].title, 'Hao 社群貼文技能書');
  assert.equal(mineList.data.items[0].available, true);
  const plan = (await pool.query('EXPLAIN ' + promotionLeaderboardSql, [DEMO_COMMUNITY, clock, maker.user.user_id])).rows.map(row => row['QUERY PLAN']).join('\n');
  assert.match(plan, /Group Key:.*kind.*user_id/);
  assert.equal(/Group Key:.*image_bytes/.test(plan), false);
});

test('social posts normalize urls, classify hosts, paginate and enforce author and admin actions', async () => {
  const maker = await signIn(), reviewer = await signIn(DEMO_USERS[1].email);
  for (const raw of ['http://example.com/a', 'https://user:pass@example.com/a', 'https://127.0.0.1/a', 'https://[::1]/', 'https://localhost/a', 'https://intranet/a', 'https://printer.local/a', 'https://svc.internal/a', 'https://nas.lan/a', 'https://example.com:8443/a', 'https://192.168.0.8/a']) {
    const rejected = await request('/social-posts', maker, { url: raw, title: '不行' });
    assert.equal(rejected.status, 422, raw);
    assert.equal(rejected.data.code, 'social_post_url');
    assert.equal(rejected.data.detail, '這個網址不能分享。');
  }
  const samples: [string, string][] = [
    ['https://WWW.YouTube.COM/watch?v=abcdefghijk&utm_source=z&fbclid=1#t=1', 'youtube'],
    ['https://youtu.be/bcdefghijkl', 'youtube'],
    ['https://www.instagram.com/p/E2E0001/', 'instagram'],
    ['https://www.facebook.com/watch/?v=1', 'facebook'],
    ['https://fb.watch/e2eDemo/', 'facebook'],
    ['https://m.facebook.com/story.php?id=1', 'facebook'],
    ['https://www.threads.net/@demo/post/1', 'threads'],
    ['https://www.threads.com/@demo/post/1', 'threads'],
    ['https://www.tiktok.com/@demo/video/1', 'tiktok'],
    ['https://x.com/demo/status/1', 'x'],
    ['https://twitter.com/demo/status/1', 'x'],
    ['https://example.com/article', 'other'],
  ];
  const created = [];
  for (const [url, platform] of samples) {
    const result = await request('/social-posts', maker, { url, title: platform });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.platform, platform, url);
    created.push(result.data);
  }
  assert.equal(created[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
  const duplicate = await request('/social-posts', reviewer, { url: 'https://www.youtube.com/watch?v=abcdefghijk&utm_campaign=again' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'social_post_exists');
  assert.equal(duplicate.data.detail, '這則貼文已經有人分享過了。');
  assert.equal(duplicate.data.post_id, created[0].post_id);
  const youtube = await request('/social-posts?platform=youtube', maker);
  assert.ok(youtube.data.items.every((item: { platform: string }) => item.platform === 'youtube'));
  const other = await request('/social-posts?platform=other', maker);
  assert.ok(other.data.items.every((item: { platform: string }) => ['threads', 'tiktok', 'x', 'other'].includes(item.platform)));
  assert.equal((await request('/social-posts?cursor=%%%', maker)).status, 422);
  const fallback = await request('/social-posts', maker, { url: 'https://no-title.example/page' });
  assert.equal(fallback.status, 201, JSON.stringify(fallback.data));
  assert.equal(fallback.data.title, 'no-title.example');
  assert.equal(fallback.data.thumbnail_url, null);
  const broken = await request('/social-posts', maker, { url: 'https://bad-image.example/item' });
  assert.equal(broken.data.title, '壞圖');
  assert.equal(broken.data.thumbnail_url, null);
  const down = await request('/social-posts', maker, { url: 'https://boom.example/x', title: '預覽掛了' });
  assert.equal(down.status, 201, JSON.stringify(down.data));
  assert.equal(down.data.thumbnail_url, null);
  const article = created.find(item => item.platform === 'other')!;
  assert.ok(article.thumbnail_url);
  const image = await app.request(origin + '/api/v1/public/social-posts/' + article.post_id + '/thumbnail');
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type') ?? '', /image\/webp/);
  assert.equal((await request(`/social-posts/${article.post_id}`, reviewer, {}, 'DELETE')).status, 403);
  assert.equal((await request(`/social-posts/${article.post_id}/hide`, reviewer, {})).data.code, 'social_post_admin_required');
  await pool.query('UPDATE users SET email_verified_at=now() WHERE user_id=$1', [maker.user.user_id]);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [randomUUID(), DEMO_COMMUNITY, 'maker@local.test', '平台管理員']);
  const hideTarget = await request('/social-posts', reviewer, { url: 'https://example.com/hide-me', title: '待隱藏' });
  const hideLink = await request('/promotion/links', maker, { kind: 'social_post', target: hideTarget.data.post_id });
  assert.equal((await app.request(origin + '/api/v1/public/social-posts/' + hideTarget.data.post_id + '/thumbnail')).status, 200);
  assert.equal((await request(`/social-posts/${hideTarget.data.post_id}/hide`, maker, {})).status, 200);
  assert.equal((await app.request(origin + '/api/v1/public/social-posts/' + hideTarget.data.post_id + '/thumbnail')).status, 404);
  assert.equal((await app.request(origin + '/go/' + hideLink.data.code)).status, 302);
  assert.ok(!(await request('/social-posts', maker)).data.items.some((item: { post_id: string }) => item.post_id === hideTarget.data.post_id));
  const removed = await request(`/social-posts/${article.post_id}`, maker, {}, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await app.request(origin + '/api/v1/public/social-posts/' + article.post_id + '/thumbnail')).status, 404);
  const upload = await request('/social-posts', maker, { url: 'https://no-title.example/upload', title: '手上傳' });
  const put = await app.request(origin + `/api/v1/social-posts/${upload.data.post_id}/thumbnail`, { method: 'PUT', headers: { Origin: origin, Cookie: maker.cookie, 'X-CSRF-Token': maker.csrf, 'Content-Type': 'image/png', 'Content-Length': String(PNG.length), 'Idempotency-Key': randomUUID() }, body: new Uint8Array(PNG) });
  assert.equal(put.status, 200, await put.clone().text());
  const stored = await app.request(origin + `/api/v1/social-posts/${upload.data.post_id}/thumbnail`, { headers: { Cookie: maker.cookie } });
  assert.equal(stored.status, 200);
  assert.match(stored.headers.get('content-type') ?? '', /image\/webp/);
  assert.ok((await stored.arrayBuffer()).byteLength > 16);
  for (let i = 0; i < 25; i++) {
    await pool.query(`INSERT INTO community_social_posts(community_id,author_user_id,url,platform,title,state,created_at,updated_at)
      VALUES($1,$2,$3,'other',$4,'active',$5,$5)`, [DEMO_COMMUNITY, maker.user.user_id, `https://example.com/paged/${i}`, `分頁 ${i}`, new Date(clock.getTime() - i * 1000)]);
  }
  const first = await request('/social-posts?platform=other', maker);
  assert.equal(first.data.items.length, 24);
  assert.ok(first.data.next_cursor);
  const second = await request('/social-posts?platform=other&cursor=' + encodeURIComponent(first.data.next_cursor), maker);
  assert.equal(second.data.next_cursor, null);
  assert.ok(second.data.items.length >= 1);
  const client = await signIn(DEMO_USERS[2].email);
  for (let i = 0; i < 20; i++) assert.equal((await request('/social-posts', client, { url: `https://no-title.example/cap/${i}` })).status, 201);
  const limited = await request('/social-posts', client, { url: 'https://no-title.example/cap/20' });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, 'social_post_limit');
  const before = await facts();
  await click((await platformLink(maker)).code, LINE);
  assert.deepEqual(await facts(), before);
});

test('promotion links are indexed by kind and target', async () => {
  const row = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='promotion_links_target'`)).rows[0];
  assert.match(String(row?.indexdef), /\(kind, target_key\)/);
});

test('a click reuses the shared session check and still ignores the owner', async () => {
  const maker = await signIn();
  const link = await platformLink(maker);
  const token = maker.cookie.slice(maker.cookie.indexOf('=') + 1);
  await pool.query(`UPDATE sessions SET last_seen_at=now()-interval '5 minutes' WHERE token_hash=$1`, [tokenHash(token)]);
  const before = new Date((await pool.query('SELECT last_seen_at FROM sessions WHERE token_hash=$1', [tokenHash(token)])).rows[0].last_seen_at);
  const own = await click(link.code, REAL, maker.cookie);
  assert.equal(own.status, 200);
  assert.equal(await pointsOf(link.code), 0);
  const after = new Date((await pool.query('SELECT last_seen_at FROM sessions WHERE token_hash=$1', [tokenHash(token)])).rows[0].last_seen_at);
  assert.ok(after.getTime() > before.getTime());
  const stranger = await click(link.code, REAL, `freedom_local_session=${'a'.repeat(43)}`);
  assert.equal(stranger.status, 200);
  assert.equal(stranger.data.ok, true);
  assert.equal(await pointsOf(link.code), 1);
});

test('listing my links writes nothing and marks targets that can no longer be opened', async () => {
  const maker = await signIn();
  const eventId = randomUUID();
  await eventRow(eventId, maker.user.user_id, 'open', '仍可開啟的活動', '說明');
  const created = await request('/promotion/links', maker, { kind: 'event', target: eventId });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  await pool.query('DELETE FROM community_event_share_codes WHERE user_id=$1', [maker.user.user_id]);
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM community_event_share_codes) AS codes,
    (SELECT count(*)::int FROM promotion_links) AS links`)).rows[0] as { codes: number; links: number };
  const before = await counts();
  const listed = await request('/promotion/links/mine?period=all', maker);
  assert.deepEqual(await counts(), before);
  const open = listed.data.items.find((row: { code: string }) => row.code === created.data.code);
  assert.equal(open.available, true);
  assert.equal(open.title, '仍可開啟的活動');
  assert.equal(open.points.all, 0);
  await click(created.data.code, REAL);
  await pool.query(`UPDATE community_events SET state='cancelled' WHERE event_id=$1`, [eventId]);
  const closed = await request('/promotion/links/mine?period=week', maker);
  assert.deepEqual(await counts(), before);
  const muted = closed.data.items.find((row: { code: string }) => row.code === created.data.code);
  assert.equal(muted.available, false);
  assert.equal(muted.period_points, 1);
  assert.equal(muted.points.week, 1);
  const post = await request('/social-posts', maker, { url: 'https://no-title.example/mine-open', title: '還在' });
  const postLink = await request('/promotion/links', maker, { kind: 'social_post', target: post.data.post_id });
  await pool.query(`UPDATE community_social_posts SET state='deleted' WHERE post_id=$1`, [post.data.post_id]);
  await pool.query(`INSERT INTO promotion_links(community_id,user_id,kind,target_key,code,created_at) VALUES($1,$2,'skill_book','book:missing-book',$3,$4)`, [DEMO_COMMUNITY, maker.user.user_id, randomBytes(7).toString('base64url'), clock]);
  const again = await request('/promotion/links/mine?period=all', maker);
  assert.equal(again.data.items.find((row: { code: string }) => row.code === postLink.data.code).available, false);
  assert.equal(again.data.items.find((row: { target: string }) => row.target === 'book:missing-book').available, false);
  const book = await request('/promotion/links', maker, { kind: 'skill_book', target: 'book:social-post' });
  const books = await request('/promotion/links/mine?period=week', maker);
  assert.equal(books.data.items.find((row: { code: string }) => row.code === book.data.code).available, true);
});

test('a published skill link closes when its owner is deactivated', async () => {
  const maker = await signIn();
  const owner = await addUser('shelf-owner@member.test', '技能書主人');
  const project = randomUUID(), version = randomUUID(), submission = randomUUID(), sha = 'c'.repeat(64);
  await pool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship)
    VALUES($1,$2,$3,'社群技能','說明','用法','8801065','example/shelf-skill','https://github.com/example/shelf-skill','author')`, [project, DEMO_COMMUNITY, owner]);
  await pool.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,repository_full_name,repository_url,readme_url,license_spdx,is_fork,archived,source_snapshot,source_sha256,facts_sha256,inspected_at)
    VALUES($1,$2,'8801065',$3,'main','example/shelf-skill','https://github.com/example/shelf-skill','https://github.com/example/shelf-skill#readme','MIT',false,false,'{}',$4,$4,now())`, [version, project, 'd'.repeat(40), sha]);
  await pool.query('UPDATE oss_projects SET current_version_id=$2 WHERE project_id=$1', [project, version]);
  await pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,status,payload,payload_sha256,consent_to_share,project_id,project_version_id,published_at,grant_consumed_at)
    VALUES($1,$2,$3,'published',$4,$5,true,$6,$7,now(),now())`, [submission, DEMO_COMMUNITY, owner, JSON.stringify({ title: '主人還在的技能', description: '技能說明', relationship: 'author', share_introductions: ['第一句介紹'], use_notes: '用法' }), sha, project, version]);
  const linked = await request('/promotion/links', maker, { kind: 'skill_book', target: `submission:${submission}` });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  const open = (await request('/promotion/links/mine', maker)).data.items.find((row: { code: string }) => row.code === linked.data.code);
  assert.equal(open.available, true);
  assert.equal(open.title, '主人還在的技能');
  await pool.query('UPDATE users SET active=false WHERE user_id=$1', [owner]);
  const closed = (await request('/promotion/links/mine', maker)).data.items.find((row: { code: string }) => row.code === linked.data.code);
  assert.equal(closed.available, false);
  assert.equal(closed.title, '已無法開啟');
});

test('a duplicate social post is not fetched, own-site urls are refused, and the 31st preview is limited', async () => {
  const maker = await signIn();
  const seen = previewFetches;
  const created = await request('/social-posts', maker, { url: 'https://no-title.example/already', title: '已有' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(previewFetches, seen + 1);
  const afterCreate = previewFetches;
  const duplicate = await request('/social-posts', maker, { url: 'https://no-title.example/already?utm_source=x' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'social_post_exists');
  assert.equal(duplicate.data.post_id, created.data.post_id);
  assert.equal(previewFetches, afterCreate);
  const sameKey = randomUUID();
  const first = await request('/social-posts', maker, { url: 'https://no-title.example/replay', title: '重送' }, 'POST', sameKey);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const afterFirst = previewFetches;
  const replay = await request('/social-posts', maker, { url: 'https://no-title.example/replay', title: '重送' }, 'POST', sameKey);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.post_id, first.data.post_id);
  assert.equal(previewFetches, afterFirst);
  const beforeOwn = previewFetches;
  for (const url of ['https://freetwai.com/go/abcdefghij', 'https://www.freetwai.com/post/1', 'https://share.freetwai.com/a']) {
    const rejected = await request('/social-posts', maker, { url, title: '站內' });
    assert.equal(rejected.status, 422, url);
    assert.equal(rejected.data.code, 'social_post_url');
    assert.equal(rejected.data.detail, '請分享社群平台上的貼文。');
  }
  assert.equal(previewFetches, beforeOwn);
  const outside = await request('/social-posts', maker, { url: 'https://notfreetwai.com/a', title: '外部' });
  assert.equal(outside.status, 201, JSON.stringify(outside.data));
  await addUser('preview-cap@member.test', '預覽上限');
  const capped = await signIn('preview-cap@member.test');
  for (let i = 0; i < 30; i++) {
    const result = await request('/social-posts', capped, { url: `https://no-title.example/hour/${i}` });
    if (i < 20) assert.equal(result.status, 201, `${i} ${JSON.stringify(result.data)}`);
    else { assert.equal(result.status, 429, `${i} ${JSON.stringify(result.data)}`); assert.equal(result.data.code, 'social_post_limit'); }
  }
  const beforeLast = previewFetches;
  const blocked = await request('/social-posts', capped, { url: 'https://no-title.example/hour/30' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, 'auth_rate_limited');
  assert.equal(previewFetches, beforeLast);
});

// The first shareable() read still sees the target. The pause runs before openTarget reads it again.
async function vanishBetweenReads(match: (sql: string) => boolean, pause: string, id: string, code: string) {
  const live = await app.request(`${origin}/go/${code}`);
  assert.equal(live.status, 200, await live.clone().text());
  await live.text();
  const original = pool.query.bind(pool) as (text: unknown, values?: unknown) => Promise<unknown>;
  let seen = false;
  pool.query = (async (text: unknown, values?: unknown) => {
    const sql = typeof text === 'string' ? text : String((text as { text?: string } | undefined)?.text ?? '');
    const result = await original(text, values);
    if (!seen && match(sql)) {
      seen = true;
      await original(pause, [id]);
    }
    return result;
  }) as typeof pool.query;
  try {
    const gone = await app.request(`${origin}/go/${code}`);
    const body = await gone.text();
    assert.equal(gone.status, 302, body.slice(0, 240));
    assert.ok((gone.headers.get('location') ?? '').endsWith('/'));
    assert.equal(body.includes('internal_error'), false);
    assert.equal(seen, true);
  } finally {
    pool.query = original as typeof pool.query;
  }
}

test('/go falls back home when a service or event disappears between the two reads', async () => {
  const maker = await signIn();
  const serviceId = randomUUID();
  await pool.query(`INSERT INTO member_services(service_id,community_id,owner_user_id,title,category,summary,service_mode,contacts,state)
    VALUES($1,$2,$3,'會中途暫停的服務','language','簡介','online','[{"label":"網站","url":"https://example.com/vanish"}]'::jsonb,'active')`,
  [serviceId, DEMO_COMMUNITY, maker.user.user_id]);
  const serviceLink = await ownLink(maker.user.user_id, 'member_service', serviceId);
  await vanishBetweenReads(sql => sql.includes('AS has_cover') && sql.includes('member_services'), `UPDATE member_services SET state='paused' WHERE service_id=$1`, serviceId, serviceLink.code);
  assert.equal((await pool.query(`SELECT state FROM member_services WHERE service_id=$1`, [serviceId])).rows[0].state, 'paused');

  const eventId = randomUUID();
  await eventRow(eventId, maker.user.user_id, 'open', '會中途取消的活動', '說明');
  const eventLink = await ownLink(maker.user.user_id, 'event', eventId);
  await vanishBetweenReads(sql => sql.includes('AS has_banner') && sql.includes('community_events'), `UPDATE community_events SET state='cancelled' WHERE event_id=$1`, eventId, eventLink.code);
  assert.equal((await pool.query(`SELECT state FROM community_events WHERE event_id=$1`, [eventId])).rows[0].state, 'cancelled');
});
