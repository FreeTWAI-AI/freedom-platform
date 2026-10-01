import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import sharp from 'sharp';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {inspectCanonicalWebp} from '../../packages/shared/image-webp.js';
import {youtubeVideoId, youtubeThumbnailUrl} from '../../packages/shared/youtube-video-id.js';
import {createUnavailableImageProcessor, runWithImageProcessor} from '../../packages/shared/image-runtime.js';
import {normalizeHighlightLink} from '../../modules/community/event-highlights.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_highlights_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8});
const app = createApp(pool, origin);
const MAKER = DEMO_USERS[0].user_id, REVIEWER = DEMO_USERS[1].user_id, CLIENT = DEMO_USERS[2].user_id;
const LOCATION = '地點密語hl-location-9f3a';
const MEETING_TOKEN = 'room-9f3a';
const MEETING = `https://secret-meet.example/${MEETING_TOKEN}`;
const GUEST = 'hidden-guest-9f3a@mail.test';
const SHARE = 'hlsharecode9f3axx';
const RECAP_TOKEN = 'test-only-recap';
const LIVE = 'https://freetwai.com';
type Session = {cookie: string; csrf: string; user: any};
let jpeg: Buffer, png: Buffer, webp: Buffer, animated: Buffer;

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  jpeg = await sharp({create: {width: 64, height: 32, channels: 3, background: '#3044ff'}}).jpeg().toBuffer();
  png = await sharp({create: {width: 24, height: 48, channels: 3, background: '#c4ff20'}}).png().toBuffer();
  webp = await sharp({create: {width: 40, height: 20, channels: 3, background: '#ff8800'}}).webp().toBuffer();
  animated = withActl(png);
});
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE'); await seedLocal(pool); });

function withActl(source: Buffer) {
  const at = source.lastIndexOf(Buffer.from('IEND')) - 4;
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  chunk.write('acTL', 4);
  chunk.writeUInt32BE(2, 8);
  return Buffer.concat([source.subarray(0, at), chunk, source.subarray(at)]);
}
function past(daysAgo: number) {
  const ends = new Date(Date.UTC(2024, 5, 1) - daysAgo * 86400000);
  return {starts: new Date(ends.getTime() - 2 * 3600000), ends};
}
async function login(email = DEMO_USERS[0].email): Promise<Session> {
  const response = await app.request(origin + '/api/v1/auth/login', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({email, password: DEMO_PASSWORD})});
  const data = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(data));
  return {cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token, user: data.user};
}
async function call(path: string, session?: Session, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Origin', origin);
  if (session) {
    headers.set('Cookie', session.cookie);
    if ((init.method ?? 'GET') !== 'GET') headers.set('X-CSRF-Token', session.csrf);
  }
  const response = await app.request(origin + path, {...init, headers});
  const text = await response.text();
  let data: any = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return {status: response.status, data, text, headers: response.headers};
}
function post(path: string, session: Session, body: unknown, key = randomUUID()) {
  return call(path, session, {method: 'POST', headers: {'Content-Type': 'application/json', 'Idempotency-Key': key}, body: JSON.stringify(body)});
}
function upload(path: string, session: Session, bytes: Buffer, mime: string, orientation: string, title?: string, key = randomUUID()) {
  const headers: Record<string, string> = {'Content-Type': mime, 'Idempotency-Key': key, 'X-Photo-Orientation': orientation};
  if (title) headers['X-Media-Title'] = encodeURIComponent(title);
  return call(path, session, {method: 'POST', headers, body: new Uint8Array(bytes)});
}
async function insertEvent(fields: {id?: string; organizer?: string; community?: string; title?: string; description?: string; starts: Date; ends: Date; mode?: string; location?: string; online?: string | null; state?: string; visibility?: string; kind?: string; guild?: string | null; topic?: string | null}) {
  const id = fields.id ?? randomUUID();
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,online_url,state,visibility,event_kind,guild_key,topic)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [
    id, fields.community ?? DEMO_COMMUNITY, fields.organizer ?? MAKER, fields.title ?? '回顧活動', fields.description ?? '一起回顧這場活動。',
    fields.starts, fields.ends, fields.mode ?? 'online', fields.location ?? LOCATION, fields.online ?? null,
    fields.state ?? 'published', fields.visibility ?? 'open', fields.kind ?? 'other', fields.guild ?? null, fields.topic ?? null,
  ]);
  return id;
}
async function addUser(email: string, name: string, community = DEMO_COMMUNITY) {
  const id = randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id=$6`, [id, community, email, name, randomUUID(), MAKER]);
  return id;
}
function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, found);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { found.add(key); keysOf(child, found); }
  return found;
}
function assertPrivate(payload: unknown, text = JSON.stringify(payload)) {
  for (const key of ['location', 'online_url', 'email', 'share_code', 'bytes', 'image_bytes', 'rsvps']) assert.equal(keysOf(payload).has(key), false, key);
  assert.equal(text.includes(LOCATION), false);
  assert.equal(text.includes(MEETING_TOKEN), false);
  assert.equal(text.includes(GUEST), false);
  assert.equal(text.includes(SHARE), false);
  assert.equal(text.includes('RIFF'), false);
  assert.equal(text.includes('UklGR'), false);
}
async function ended(extra: Partial<Parameters<typeof insertEvent>[0]> = {}) {
  const when = past(3);
  return insertEvent({...when, ...extra, starts: extra.starts ?? when.starts, ends: extra.ends ?? when.ends});
}

test('youtube ids come from watch, short, live, embed and youtu.be links only', () => {
  const id = 'abcdefghijk';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://m.youtube.com/watch?v=${id}&feature=share`,
    `https://youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
  ]) assert.equal(youtubeVideoId(url), id, url);
  assert.equal(youtubeThumbnailUrl(`https://m.youtube.com/watch?v=${id}`), `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
  for (const url of ['http://www.youtube.com/watch?v=' + id, 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/@channel', 'https://example.com/watch?v=' + id]) assert.equal(youtubeVideoId(url), null, url);
});

test('link normalization drops the fragment and campaign params and classifies the host', () => {
  const id = 'abcdefghijk';
  const normalized = normalizeHighlightLink({url: `https://WWW.YouTube.com/watch?v=${id}&utm_source=news&fbclid=a&igshid=b&si=c&list=PLabs#t=10`});
  assert.equal(normalized.url, `https://www.youtube.com/watch?v=${id}&list=PLabs`);
  assert.equal(normalized.platform, 'youtube');
  assert.equal(normalized.title, 'YouTube 影片');
  const cases: [string, string, string][] = [
    ['https://m.youtube.com/watch?v=' + id, 'youtube', 'YouTube 影片'],
    ['https://youtu.be/' + id, 'youtube', 'YouTube 影片'],
    ['https://m.facebook.com/watch/1', 'facebook', 'Facebook 影片'],
    ['https://fb.watch/abc', 'facebook', 'Facebook 影片'],
    ['https://www.instagram.com/p/abc', 'instagram', 'Instagram 貼文'],
    ['https://www.threads.net/@someone', 'threads', 'Threads 貼文'],
    ['https://www.threads.com/@someone', 'threads', 'Threads 貼文'],
    ['https://vm.tiktok.com/abc', 'tiktok', 'TikTok 影片'],
    ['https://twitter.com/someone/status/1', 'x', 'X 貼文'],
    ['https://x.com/someone/status/1', 'x', 'X 貼文'],
    ['https://vimeo.com/1', 'vimeo', 'Vimeo 影片'],
    ['https://drive.google.com/file/d/abc', 'google_drive', '雲端硬碟影片'],
    ['https://photos.google.com/share/abc', 'google_photos', 'Google 相簿'],
    ['https://photos.app.goo.gl/abc', 'google_photos', 'Google 相簿'],
    ['https://docs.google.com/document/d/abc', 'other', '相關連結'],
    ['https://example.com/recap', 'other', '相關連結'],
  ];
  for (const [url, platform, title] of cases) {
    const link = normalizeHighlightLink({url});
    assert.equal(link.platform, platform, url);
    assert.equal(link.title, title, url);
  }
  const titled = normalizeHighlightLink({url: 'https://example.com/recap', title: '  回顧文章  '});
  assert.equal(titled.title, '回顧文章');
});

test('ended events of every visibility are listed newest first and private fields stay out', async () => {
  const maker = await login();
  const {starts, ends} = past(1);
  const online = await insertEvent({starts, ends, mode: 'online', visibility: 'open', title: '線上已結束', online: MEETING, location: LOCATION});
  const room = await insertEvent({...past(4), mode: 'in_person', visibility: 'workshop', title: '實體已結束'});
  const hybrid = await insertEvent({...past(2), mode: 'hybrid', visibility: 'referral', title: '混合已結束', online: 'https://meet.example/hybrid'});
  const guild = await insertEvent({...past(6), mode: 'in_person', visibility: 'guild', kind: 'guild_skill_exchange', guild: 'guild_event_space', title: '公會已結束'});
  const reading = await insertEvent({...past(3), kind: 'reading_group', topic: '公開回顧', visibility: 'open', title: '讀書會已結束'});
  await insertEvent({starts: new Date(Date.now() + 86400000), ends: new Date(Date.now() + 2 * 86400000), title: '尚未開始'});
  await insertEvent({starts: new Date(Date.now() - 3600000), ends: new Date(Date.now() + 3600000), title: '進行中'});
  await insertEvent({...past(1), state: 'pending', title: '待審核'});
  await insertEvent({...past(1), state: 'cancelled', title: '已取消'});
  await insertEvent({...past(1), state: 'rejected', title: '已拒絕'});
  await pool.query(`INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state) VALUES ($1,$2,$3,'going')`, [randomUUID(), online, REVIEWER]);
  await pool.query(`INSERT INTO community_event_guest_rsvps(event_id,email,name,email_sent_at) VALUES ($1,$2,'來賓',now())`, [online, GUEST]);
  await pool.query(`INSERT INTO community_event_share_codes(event_id,user_id,code) VALUES ($1,$2,$3)`, [online, MAKER, SHARE]);
  const listed = await call('/api/v1/event-highlights', maker);
  assert.equal(listed.status, 200, listed.text);
  assertPrivate(listed.data);
  const titles = listed.data.items.map((item: any) => item.title);
  for (const hidden of ['尚未開始', '進行中', '待審核', '已取消', '已拒絕']) assert.equal(titles.includes(hidden), false, hidden);
  assert.deepEqual(titles.slice(0, 4), ['線上已結束', '混合已結束', '讀書會已結束', '實體已結束']);
  assert.ok(titles.includes('公會已結束'));
  const card = listed.data.items[0];
  assert.equal(card.event_id, online);
  assert.equal(card.attending_count, 2);
  assert.equal(card.mode, 'online');
  assert.equal(card.public_path, `/highlights/${online}`);
  assert.equal(card.cover, null);
  assert.equal('description' in card, false);
  assert.deepEqual(card.counts, {links: 0, photos: 0, posters: 0});
  const onlineOnly = await call('/api/v1/event-highlights?mode=online', maker);
  assert.deepEqual(onlineOnly.data.items.map((item: any) => item.event_id).sort(), [online, hybrid, reading].sort());
  const roomOnly = await call('/api/v1/event-highlights?mode=in_person', maker);
  assert.ok(roomOnly.data.items.some((item: any) => item.event_id === room));
  assert.ok(roomOnly.data.items.some((item: any) => item.event_id === hybrid));
  assert.ok(roomOnly.data.items.every((item: any) => item.mode !== 'online'));
  assert.equal((await call('/api/v1/event-highlights?mode=nope', maker)).status, 422);
  assert.equal((await call('/api/v1/event-highlights?cursor=%%%', maker)).data.code, 'highlight_cursor_invalid');
  const detail = await call('/api/v1/event-highlights/' + online, maker);
  assert.equal(detail.status, 200, detail.text);
  assertPrivate(detail.data);
  assert.equal(detail.data.can_upload, true);
  assert.equal(detail.data.quota.links.remaining_for_me, 10);
  assert.equal((await call('/api/v1/event-highlights/' + guild, maker)).data.title, '公會已結束');
  const future = await insertEvent({starts: new Date('2027-01-01'), ends: new Date('2027-01-02'), title: '未來'});
  assert.equal((await call('/api/v1/event-highlights/' + future, maker)).status, 404);
  const cancelled = await insertEvent({...past(1), state: 'cancelled'});
  assert.equal((await call('/api/v1/event-highlights/' + cancelled, maker)).status, 404);
});

test('other communities and verification-test hosts stay out of everyone else\'s list', async () => {
  const maker = await login();
  const otherCommunity = randomUUID();
  await pool.query('INSERT INTO communities(community_id,name) VALUES ($1,$2)', [otherCommunity, '另一個社群']);
  const outsider = await addUser(`outsider-${randomUUID()}@member.test`, '外社群', otherCommunity);
  const foreign = await insertEvent({...past(1), community: otherCommunity, organizer: outsider, title: '別的社群'});
  const host = await addUser(`host-${randomUUID()}@example.invalid`, '驗收主辦');
  const hidden = await insertEvent({...past(0), organizer: host, title: '驗收主辦的活動'});
  const visible = await ended({title: '一般已結束'});
  const list = await call('/api/v1/event-highlights', maker);
  const ids = list.data.items.map((item: any) => item.event_id);
  assert.deepEqual(ids, [visible]);
  assert.equal((await call('/api/v1/event-highlights/' + foreign, maker)).status, 404);
  assert.equal((await call('/api/v1/event-highlights/' + hidden, maker)).status, 404);
  const self = await login((await pool.query('SELECT email FROM users WHERE user_id=$1', [host])).rows[0].email);
  const own = await call('/api/v1/event-highlights', self);
  assert.deepEqual(own.data.items.map((item: any) => item.event_id), [hidden, visible]);
  const page = await call('/highlights');
  assert.equal(page.text.includes('驗收主辦的活動'), false);
  assert.equal(page.text.includes('別的社群'), true);
});

test('keyset pages stay stable when two events end at the same time', async () => {
  const maker = await login();
  const tie = new Date('2024-01-15T00:00:00.123456Z');
  for (let index = 0; index < 11; index += 1) await insertEvent({...past(index), title: `較新 ${index}`});
  await insertEvent({starts: new Date(tie.getTime() - 3600000), ends: tie, title: '同時間甲', id: '00000000-0000-4000-8000-00000000aaa1'});
  await insertEvent({starts: new Date(tie.getTime() - 3600000), ends: tie, title: '同時間乙', id: '00000000-0000-4000-8000-00000000aaa2'});
  const expected = (await pool.query(`SELECT event_id::text FROM community_events WHERE state='published' AND ends_at<=now() AND community_id=$1 ORDER BY ends_at DESC, event_id DESC`, [DEMO_COMMUNITY])).rows.map(row => row.event_id);
  assert.equal(expected.length, 13);
  const first = await call('/api/v1/event-highlights', maker);
  const again = await call('/api/v1/event-highlights', maker);
  assert.deepEqual(again.data.items.map((item: any) => item.event_id), first.data.items.map((item: any) => item.event_id));
  assert.equal(first.data.items.length, 12);
  assert.ok(first.data.next_cursor);
  const second = await call('/api/v1/event-highlights?cursor=' + encodeURIComponent(first.data.next_cursor), maker);
  assert.equal(second.data.next_cursor, null);
  assert.deepEqual([...first.data.items, ...second.data.items].map((item: any) => item.event_id), expected);
});

test('cover priority is banner, poster, photo thumb, then the newest youtube thumbnail', async () => {
  const maker = await login();
  const banner = await sharp({create: {width: 8, height: 8, channels: 3, background: '#111111'}}).webp().toBuffer();
  const withBanner = await ended({title: '有海報'});
  await pool.query('INSERT INTO community_event_banners(event_id,image_bytes,orientation) VALUES ($1,$2,\'landscape\')', [withBanner, banner]);
  await pool.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,title,orientation,byte_size,state,created_at)
    VALUES ($1,$2,$3,$4,'poster','新海報','landscape',10,'active',now())`, [randomUUID(), withBanner, DEMO_COMMUNITY, MAKER]);
  const posterEvent = await ended({title: '海報優先'});
  const posterId = randomUUID(), photoId = randomUUID();
  await pool.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,title,orientation,byte_size,state,created_at)
    VALUES ($1,$2,$3,$4,'photo',null,'landscape',10,'active',now()-interval '1 hour'),($5,$2,$3,$4,'poster','海報','portrait',10,'active',now())`,
    [photoId, posterEvent, DEMO_COMMUNITY, MAKER, posterId]);
  const photoEvent = await ended({title: '照片優先'});
  const thumbPhoto = randomUUID();
  await pool.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,title,url,platform,state,created_at)
    VALUES ($1,$2,$3,$4,'link','舊片',$5,'youtube','active',now()-interval '1 hour')`, [randomUUID(), photoEvent, DEMO_COMMUNITY, MAKER, 'https://youtu.be/abcdefghijk']);
  await pool.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,orientation,byte_size,state,created_at)
    VALUES ($1,$2,$3,$4,'photo','landscape',10,'active',now())`, [thumbPhoto, photoEvent, DEMO_COMMUNITY, MAKER]);
  const videoEvent = await ended({title: '只有影片'});
  await pool.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,title,url,platform,state)
    VALUES ($1,$2,$3,$4,'link','YouTube 影片',$5,'youtube','active')`, [randomUUID(), videoEvent, DEMO_COMMUNITY, MAKER, 'https://www.youtube.com/watch?v=abcdefghijk']);
  const bare = await ended({title: '還沒有'});
  const list = await call('/api/v1/event-highlights', maker);
  const cover = (title: string) => list.data.items.find((item: any) => item.title === title).cover;
  assert.deepEqual(cover('有海報'), {kind: 'banner', url: `/api/v1/public/event-highlights/${withBanner}/banner`});
  assert.deepEqual(cover('海報優先'), {kind: 'poster', url: `/api/v1/public/event-highlights/media/${posterId}/image`});
  assert.deepEqual(cover('照片優先'), {kind: 'photo', url: `/api/v1/public/event-highlights/media/${thumbPhoto}/thumb`});
  assert.deepEqual(cover('只有影片'), {kind: 'youtube', url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'});
  assert.equal(cover('還沒有'), null);
  assert.deepEqual(list.data.items.find((item: any) => item.title === '照片優先').counts, {links: 1, photos: 1, posters: 0});
  assert.equal(bare.length > 0, true);
});

test('rejected links do not burn the rate limit, and accepted links normalize, dedupe and replay', async () => {
  const maker = await login(DEMO_USERS[0].email);
  const eventId = await ended();
  const rejected = [
    'http://youtube.com/watch?v=abcdefghijk',
    'https://user:pass@youtube.com/watch?v=abcdefghijk',
    'https://youtube.com:8443/watch?v=abcdefghijk',
    'https://localhost/watch',
    'https://127.0.0.1/a',
    'https://10.1.1.1/a',
    'https://192.168.1.1/a',
    'https://172.16.0.1/a',
    'https://169.254.1.1/a',
    'https://[::1]/a',
    'https://[::ffff:127.0.0.1]/a',
    'https://[::ffff:7f00:1]/a',
    'https://printer.local/a',
    'https://db.internal/a',
    'https://nas.lan/a',
    'https://box.home/a',
    'https://singlelabel/a',
  ];
  const before = Number((await pool.query('SELECT coalesce(sum(attempts),0)::int AS n FROM auth_rate_limits')).rows[0].n);
  for (const url of rejected) {
    const response = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url});
    assert.equal(response.status, 422, url + response.text);
    assert.equal(response.data.code, 'highlight_url_invalid', url);
  }
  const after = Number((await pool.query('SELECT coalesce(sum(attempts),0)::int AS n FROM auth_rate_limits')).rows[0].n);
  assert.equal(after, before);
  const key = randomUUID();
  const created = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://WWW.YouTube.com/watch?v=abcdefghijk&utm_source=x#t=1'}, key);
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(created.data.platform, 'youtube');
  assert.equal(created.data.thumbnail_url, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  assert.equal(created.data.uploaded_by_organizer, true);
  assert.equal(created.data.can_remove, true);
  const replay = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://www.youtube.com/watch?v=abcdefghijk'}, key);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.data, created.data);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM community_event_highlights WHERE event_id=$1', [eventId])).rows[0].n, 1);
  const conflict = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://example.com/other'}, key);
  assert.equal(conflict.data.code, 'idempotency_conflict');
  const duplicate = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://www.youtube.com/watch?v=abcdefghijk&si=zzz'});
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'highlight_link_exists');
  assert.equal(duplicate.data.detail, '這個連結已經在活動集錦裡了。');
  const channel = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://www.youtube.com/@channel'});
  assert.equal(channel.status, 201, channel.text);
  assert.equal('thumbnail_url' in channel.data, false);
  const journal = await pool.query(`SELECT aggregate_version::int AS version, command FROM transition_journal WHERE aggregate_id=$1`, [created.data.media_id]);
  assert.deepEqual(journal.rows, [{version: 1, command: 'create'}]);
});

test('per-member and per-event caps name the limit', async () => {
  const maker = await login();
  const eventId = await ended();
  async function fill(kind: string, user: string, count: number, extra = '') {
    await pool.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,title,url,platform,orientation,byte_size,state)
      SELECT gen_random_uuid(),$1,$2,$3,$4,null,
        CASE WHEN $4='link' THEN 'https://example.com/'||gen_random_uuid()::text ELSE null END,
        CASE WHEN $4='link' THEN 'other' ELSE null END,
        CASE WHEN $4='link' THEN null ELSE 'landscape' END,
        CASE WHEN $4='link' THEN null ELSE 10 END,
        'active' FROM generate_series(1,$5::int)`, [eventId, DEMO_COMMUNITY, user, kind, count]);
  }
  await fill('link', MAKER, 10);
  const mine = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://example.com/over-mine'});
  assert.equal(mine.status, 409);
  assert.equal(mine.data.detail, '每位夥伴在同一場活動最多新增 10 則連結。');
  await pool.query(`DELETE FROM community_event_highlights WHERE event_id=$1`, [eventId]);
  await fill('link', REVIEWER, 60);
  const full = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://example.com/over-event'});
  assert.equal(full.data.detail, '一場活動最多 60 則連結。');
  await pool.query(`DELETE FROM community_event_highlights WHERE event_id=$1`, [eventId]);
  await fill('photo', MAKER, 30);
  const photos = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, jpeg, 'image/jpeg', 'landscape');
  assert.equal(photos.data.detail, '每位夥伴在同一場活動最多新增 30 張照片。');
  await pool.query(`DELETE FROM community_event_highlights WHERE event_id=$1`, [eventId]);
  await fill('photo', REVIEWER, 120);
  const photoEvent = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, jpeg, 'image/jpeg', 'landscape');
  assert.equal(photoEvent.data.detail, '一場活動最多 120 張照片。');
  await pool.query(`DELETE FROM community_event_highlights WHERE event_id=$1`, [eventId]);
  await fill('poster', MAKER, 3);
  const posters = await upload(`/api/v1/event-highlights/${eventId}/posters`, maker, jpeg, 'image/jpeg', 'landscape');
  assert.equal(posters.data.detail, '每位夥伴在同一場活動最多新增 3 張海報。');
  await pool.query(`DELETE FROM community_event_highlights WHERE event_id=$1`, [eventId]);
  await fill('poster', REVIEWER, 10);
  const posterEvent = await upload(`/api/v1/event-highlights/${eventId}/posters`, maker, jpeg, 'image/jpeg', 'landscape');
  assert.equal(posterEvent.data.detail, '一場活動最多 10 張海報。');
});

test('photos and posters become exact webp variants and bad images are refused', async () => {
  const maker = await login();
  const eventId = await ended();
  const landscape = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, jpeg, 'image/jpeg', 'landscape', '現場');
  assert.equal(landscape.status, 201, landscape.text);
  const portrait = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, png, 'image/png', 'portrait');
  assert.equal(portrait.status, 201, portrait.text);
  const poster = await upload(`/api/v1/event-highlights/${eventId}/posters`, maker, webp, 'image/webp', 'landscape', '主視覺');
  assert.equal(poster.status, 201, poster.text);
  assert.equal(poster.data.title, '主視覺');
  const stored = async (mediaId: string, variant: 'image' | 'thumb') => (await pool.query('SELECT bytes FROM community_event_highlight_images WHERE media_id=$1 AND variant=$2', [mediaId, variant])).rows[0].bytes as Buffer;
  const wide = inspectCanonicalWebp(await stored(landscape.data.media_id, 'image'));
  const tall = inspectCanonicalWebp(await stored(portrait.data.media_id, 'image'));
  const thumb = inspectCanonicalWebp(await stored(landscape.data.media_id, 'thumb'));
  const posterImage = inspectCanonicalWebp(await stored(poster.data.media_id, 'image'));
  assert.deepEqual([wide.width, wide.height], [1600, 1200]);
  assert.deepEqual([tall.width, tall.height], [1200, 1600]);
  assert.deepEqual([thumb.width, thumb.height], [480, 360]);
  assert.deepEqual([posterImage.width, posterImage.height], [1600, 1200]);
  const fetched = await call(landscape.data.image_url);
  assert.equal(fetched.headers.get('cache-control'), 'public, max-age=300');
  assert.match(fetched.headers.get('content-type') ?? '', /image\/webp/);
  const detail = await call('/api/v1/event-highlights/' + eventId, maker);
  assertPrivate(detail.data);
  assert.equal(detail.text.includes('bytes'), false);
  const missingOrientation = await call(`/api/v1/event-highlights/${eventId}/photos`, maker, {method: 'POST', headers: {'Content-Type': 'image/jpeg', 'Idempotency-Key': randomUUID()}, body: new Uint8Array(jpeg)});
  assert.equal(missingOrientation.data.code, 'invalid_orientation');
  const gif = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, Buffer.from('GIF89a'), 'image/gif', 'landscape');
  assert.equal(gif.status, 415);
  assert.equal(gif.data.code, 'highlight_image_format');
  const svg = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', 'landscape');
  assert.equal(svg.status, 415);
  const moving = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, animated, 'image/png', 'landscape');
  assert.equal(moving.status, 422, moving.text);
  assert.equal(moving.data.code, 'highlight_image_animated');
  const huge = Buffer.alloc(10 * 1024 * 1024 + 1);
  const tooBig = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, huge, 'image/jpeg', 'landscape');
  assert.equal(tooBig.status, 413, tooBig.text);
  assert.equal(tooBig.data.code, 'media_too_large');
  const declared = await call(`/api/v1/event-highlights/${eventId}/photos`, maker, {method: 'POST', headers: {'Content-Type': 'image/jpeg', 'Idempotency-Key': randomUUID(), 'X-Photo-Orientation': 'landscape', 'Content-Length': String(10 * 1024 * 1024 + 1)}, body: new Uint8Array(jpeg)});
  assert.equal(declared.status, 413, declared.text);
  assert.equal(declared.data.code, 'highlight_image_too_large');
  const beforeRows = Number((await pool.query('SELECT count(*)::int AS n FROM community_event_highlights')).rows[0].n);
  const unavailable = await runWithImageProcessor(createUnavailableImageProcessor(), () => upload(`/api/v1/event-highlights/${eventId}/photos`, maker, jpeg, 'image/jpeg', 'landscape'));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.data.code, 'image_processing_unavailable');
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM community_event_highlights')).rows[0].n), beforeRows);
});

test('uploader, organizer and admin can remove an item and the image bytes go away', async () => {
  const maker = await login();
  const client = await login(DEMO_USERS[2].email);
  const reviewer = await login(DEMO_USERS[1].email);
  const eventId = await ended({organizer: MAKER});
  const photo = await upload(`/api/v1/event-highlights/${eventId}/photos`, client, jpeg, 'image/jpeg', 'landscape', '客戶的照片');
  assert.equal(photo.status, 201, photo.text);
  const forbidden = await post(`/api/v1/event-highlights/media/${photo.data.media_id}/remove`, reviewer, {});
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.code, 'highlight_remove_forbidden');
  const byUploader = await post(`/api/v1/event-highlights/media/${photo.data.media_id}/remove`, client, {});
  assert.equal(byUploader.status, 200, byUploader.text);
  assert.deepEqual(byUploader.data, {media_id: photo.data.media_id, state: 'removed'});
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM community_event_highlight_images WHERE media_id=$1', [photo.data.media_id])).rows[0].n), 0);
  assert.equal((await call(`/api/v1/public/event-highlights/media/${photo.data.media_id}/image`)).status, 404);
  const again = await upload(`/api/v1/event-highlights/${eventId}/photos`, client, png, 'image/png', 'portrait');
  const byOrganizer = await post(`/api/v1/event-highlights/media/${again.data.media_id}/remove`, maker, {});
  assert.equal(byOrganizer.data.state, 'removed');
  const third = await upload(`/api/v1/event-highlights/${eventId}/posters`, client, webp, 'image/webp', 'landscape');
  await pool.query('UPDATE users SET email_verified_at=now() WHERE user_id=$1', [REVIEWER]);
  await pool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name,active) VALUES ($1,$2,$3,$4,true)`, [randomUUID(), DEMO_COMMUNITY, 'reviewer@local.test', '示範需求者']);
  const byAdmin = await post(`/api/v1/event-highlights/media/${third.data.media_id}/remove`, reviewer, {});
  assert.equal(byAdmin.status, 200, byAdmin.text);
  const versions = (await pool.query(`SELECT aggregate_version::int AS version, command FROM transition_journal WHERE aggregate_id=$1 ORDER BY aggregate_version`, [third.data.media_id])).rows;
  assert.deepEqual(versions, [{version: 1, command: 'create'}, {version: 2, command: 'remove'}]);
});

test('verification-test uploads stay off public pages and other members lists', async () => {
  const maker = await login();
  const eventId = await ended({title: '大家的活動'});
  const host = await addUser(`uploader-${randomUUID()}@example.invalid`, '驗收上傳');
  const email = (await pool.query('SELECT email FROM users WHERE user_id=$1', [host])).rows[0].email as string;
  const tester = await login(email);
  const secret = await post(`/api/v1/event-highlights/${eventId}/links`, tester, {url: `https://example.com/${RECAP_TOKEN}`, title: '驗收帳號的影片'});
  assert.equal(secret.status, 201, secret.text);
  const mine = await call('/api/v1/event-highlights/' + eventId, tester);
  assert.ok(mine.data.items.some((item: any) => item.title === '驗收帳號的影片'));
  const others = await call('/api/v1/event-highlights/' + eventId, maker);
  assert.equal(others.data.items.some((item: any) => item.title === '驗收帳號的影片'), false);
  const page = await call('/highlights/' + eventId);
  assert.equal(page.text.includes('驗收帳號的影片'), false);
  assert.equal(page.text.includes(RECAP_TOKEN), false);
});

test('public html escapes member text, pages with a cursor, and chooses the og image', async () => {
  const maker = await login();
  const nasty = '<script>alert("x")</script>';
  const eventId = await insertEvent({...past(1), title: nasty, description: `${nasty}\n第二段 "引號"`});
  await pool.query(`INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state) VALUES ($1,$2,$3,'going')`, [randomUUID(), eventId, REVIEWER]);
  const list = await call('/highlights');
  assert.equal(list.status, 200);
  assert.match(list.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(list.text.includes('<script'), false);
  assert.equal(list.text.includes('noindex'), false);
  assert.match(list.text, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(list.text, new RegExp(`<link rel="canonical" href="${LIVE}/highlights">`));
  assert.match(list.text, /property="og:image" content="https:\/\/freetwai\.com\/brand\/freedom-workshop\.webp"/);
  assert.match(list.text, /property="og:title" content="活動集錦｜自由工坊"/);
  assert.match(list.text, /name="twitter:card" content="summary_large_image"/);
  const detail = await call('/highlights/' + eventId);
  assert.equal(detail.status, 200);
  assert.equal(detail.text.includes('<script'), false);
  assert.match(detail.text, new RegExp(`<link rel="canonical" href="${LIVE}/highlights/${eventId}">`));
  assert.match(detail.text, /property="og:image" content="https:\/\/freetwai\.com\/brand\/freedom-workshop\.webp"/);
  assert.match(detail.text, /加入自由工坊/);
  assert.match(detail.text, new RegExp(`/#highlights/${eventId}`));
  assert.equal(detail.text.includes(LOCATION), false);
  const missing = await call('/highlights/not-a-uuid');
  assert.equal(missing.status, 404);
  assert.match(missing.text, /回到活動集錦/);
  assert.equal((await call('/highlights/' + randomUUID())).status, 404);
  const link = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://www.youtube.com/watch?v=abcdefghijk', title: nasty});
  assert.equal(link.status, 201, link.text);
  const withVideo = await call('/highlights/' + eventId);
  assert.equal(withVideo.text.includes('<script'), false);
  assert.match(withVideo.text, /property="og:image" content="https:\/\/i\.ytimg\.com\/vi\/abcdefghijk\/hqdefault\.jpg"/);
  assert.match(withVideo.text, /rel="noopener noreferrer"/);
  const photo = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, jpeg, 'image/jpeg', 'landscape');
  const withPhoto = await call('/highlights/' + eventId);
  assert.match(withPhoto.text, new RegExp(`og:image" content="${LIVE}${photo.data.image_url}"`));
  const poster = await upload(`/api/v1/event-highlights/${eventId}/posters`, maker, png, 'image/png', 'portrait');
  const withPoster = await call('/highlights/' + eventId);
  assert.match(withPoster.text, new RegExp(`og:image" content="${LIVE}${poster.data.image_url}"`));
  const banner = await sharp({create: {width: 16, height: 16, channels: 3, background: '#222222'}}).webp().toBuffer();
  await pool.query('INSERT INTO community_event_banners(event_id,image_bytes,orientation) VALUES ($1,$2,\'landscape\')', [eventId, banner]);
  const withBanner = await call('/highlights/' + eventId);
  assert.match(withBanner.text, new RegExp(`og:image" content="${LIVE}/api/v1/public/event-highlights/${eventId}/banner"`));
  assert.match(withBanner.text, /property="og:image:width" content="1200"/);
  assert.match(withBanner.text, /property="og:image:height" content="675"/);
  assert.match(detail.text, /property="og:image:width" content="1280"/);
  assert.match(detail.text, /property="og:image:height" content="720"/);
  assert.match(withVideo.text, /property="og:image:width" content="480"/);
  assert.match(withVideo.text, /property="og:image:height" content="360"/);
  assert.match(withPhoto.text, /property="og:image:width" content="1600"/);
  assert.match(withPhoto.text, /property="og:image:height" content="1200"/);
  assert.match(withPoster.text, /property="og:image:width" content="1200"/);
  assert.match(withPoster.text, /property="og:image:height" content="1600"/);
  const bannerBytes = await call(`/api/v1/public/event-highlights/${eventId}/banner`);
  assert.equal(bannerBytes.status, 200);
  assert.equal(bannerBytes.headers.get('cache-control'), 'public, max-age=300');
  for (let index = 0; index < 12; index += 1) await insertEvent({...past(10 + index), title: `較早 ${index}`});
  const first = await call('/highlights');
  assert.match(first.text, /較早的活動/);
  const cursor = /before=([^"]+)/.exec(first.text)![1];
  const older = await call('/highlights?before=' + cursor);
  assert.equal(older.status, 200);
  assert.match(older.text, new RegExp(`canonical" href="${LIVE}/highlights\\?before=`));
  const invalid = await call('/highlights?before=not-a-cursor&mode=sideways');
  assert.equal(invalid.status, 200);
  assert.equal(invalid.text.includes('<script'), false);
  assert.match(invalid.text, /&lt;script&gt;/);
  assert.match(invalid.text, new RegExp(`canonical" href="${LIVE}/highlights"`));
});

test('a public detail with no media omits empty section headings', async () => {
  const eventId = await ended({title: '還沒有集錦'});
  const page = await call('/highlights/' + eventId);
  assert.equal(page.status, 200, page.text);
  assert.equal(page.text.includes('<h2>海報</h2>'), false);
  assert.equal(page.text.includes('錄影與影片'), false);
  assert.equal(page.text.includes('活動照片'), false);
  assert.match(page.text, /<p class="hl-empty">還沒有人補上內容。參加過的夥伴可以上傳照片、海報或貼上影片連結。<\/p>/);
});

test('a public detail with one link omits the empty photo section', async () => {
  const maker = await login();
  const eventId = await ended({title: '只有影片'});
  const link = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://www.youtube.com/watch?v=abcdefghijk', title: '回顧影片'});
  assert.equal(link.status, 201, link.text);
  const page = await call('/highlights/' + eventId);
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /<h2>錄影與影片<\/h2>/);
  assert.match(page.text, /回顧影片/);
  assert.equal(page.text.includes('<h2>海報</h2>'), false);
  assert.equal(page.text.includes('活動照片'), false);
  assert.equal(page.text.includes('還沒有人補上內容'), false);
});

test('descriptions are public for every visibility while meeting links stay hidden', async () => {
  const marker = (visibility: string) => `<script>hl-${visibility}-secret</script>`;
  const hiddenNotice = '這是一場會員活動，活動說明只提供給會員。';
  const visibilities = ['open', 'referral', 'workshop', 'guild'] as const;
  const ids: Record<string, string> = {};
  for (const visibility of visibilities) {
    ids[visibility] = await insertEvent({
      ...past(2), title: `說明權限 ${visibility}`, description: `開頭 ${marker(visibility)} 結尾`,
      visibility, mode: 'online', online: MEETING, kind: visibility === 'guild' ? 'guild_skill_exchange' : 'other',
      guild: visibility === 'guild' ? 'guild_event_space' : null,
    });
  }
  const member = await login(DEMO_USERS[1].email);
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES ($1,$2,$3,'guild_event_space','active')`, [randomUUID(), DEMO_COMMUNITY, member.user.user_id]);
  const outsider = await login(DEMO_USERS[2].email);
  const organizer = await login();
  const leftId = await addUser(`left-${randomUUID()}@member.test`, '已離開公會');
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES ($1,$2,$3,'guild_event_space','left')`, [randomUUID(), DEMO_COMMUNITY, leftId]);
  const leftEmail = (await pool.query('SELECT email FROM users WHERE user_id=$1', [leftId])).rows[0].email as string;
  const left = await login(leftEmail);
  const viewers = [
    ['guild member', member],
    ['organizer', organizer],
    ['non-member', outsider],
    ['former member', left],
  ] as const;
  for (const visibility of visibilities) {
    const token = `hl-${visibility}-secret`;
    const page = await call('/highlights/' + ids[visibility]);
    assert.equal(page.status, 200, page.text);
    assert.equal(page.text.includes('<script'), false, visibility);
    assert.equal(page.text.includes(token), true, `public html ${visibility}`);
    assert.equal(page.text.includes(hiddenNotice), false, visibility);
    assert.equal(page.text.includes(MEETING_TOKEN), false, `public meeting ${visibility}`);
    assert.equal(page.text.includes(LOCATION), false, `public location ${visibility}`);
    for (const name of ['name="description"', 'property="og:description"', 'name="twitter:description"']) {
      const meta = new RegExp(`<meta ${name} content="([^"]*)"`).exec(page.text);
      assert.ok(meta, `${visibility} ${name}`);
      assert.equal(meta[1].includes(token), true, `${visibility} ${name}`);
      assert.equal(meta[1].includes(MEETING_TOKEN), false, `${visibility} ${name}`);
    }
    for (const [label, session] of viewers) {
      const detail = await call('/api/v1/event-highlights/' + ids[visibility], session);
      assert.equal(detail.status, 200, `${label} ${visibility} ${detail.text}`);
      assert.equal(detail.data.description.includes(token), true, `${label} ${visibility}`);
      assertPrivate(detail.data, detail.text);
    }
    const anon = await call('/api/v1/event-highlights/' + ids[visibility]);
    assert.notEqual(anon.status, 200, visibility);
    assert.equal(anon.text.includes(token), false, `signed-out api ${visibility}`);
    assert.equal(anon.text.includes(MEETING_TOKEN), false, `signed-out meeting ${visibility}`);
  }
  const listed = await call('/api/v1/event-highlights', outsider);
  assert.equal(JSON.stringify(listed.data).includes('hl-'), false);
  assert.equal(listed.data.items.every((item: {description?: unknown}) => !('description' in item)), true);
  assert.equal(JSON.stringify(listed.data).includes(MEETING_TOKEN), false);
  const htmlList = await call('/highlights');
  for (const visibility of visibilities) assert.equal(htmlList.text.includes(`hl-${visibility}-secret`), false, visibility);
  assert.equal(htmlList.text.includes(MEETING_TOKEN), false);
});

test('one public detail render does not select highlight or banner image bytes', async () => {
  const maker = await login();
  const eventId = await ended({title: '預覽不讀位元組'});
  const photo = await upload(`/api/v1/event-highlights/${eventId}/photos`, maker, jpeg, 'image/jpeg', 'landscape', '現場');
  assert.equal(photo.status, 201, photo.text);
  const poster = await upload(`/api/v1/event-highlights/${eventId}/posters`, maker, png, 'image/png', 'portrait', '海報');
  assert.equal(poster.status, 201, poster.text);
  await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://www.youtube.com/watch?v=abcdefghijk'});
  const banner = await sharp({create: {width: 16, height: 16, channels: 3, background: '#222222'}}).webp().toBuffer();
  await pool.query(`INSERT INTO community_event_banners(event_id,image_bytes,orientation) VALUES ($1,$2,'landscape')`, [eventId, banner]);
  const seen: string[] = [];
  const original = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    const first = args[0];
    seen.push(typeof first === 'string' ? first : first && typeof first === 'object' && 'text' in first ? String((first as {text: unknown}).text) : '');
    return (original as (...inner: unknown[]) => Promise<unknown>)(...args);
  }) as typeof pool.query;
  try {
    const page = await call('/highlights/' + eventId);
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /property="og:image:width" content="1200"/);
    assert.match(page.text, /property="og:image:height" content="675"/);
    assert.match(page.text, new RegExp(`og:image" content="${LIVE}/api/v1/public/event-highlights/${eventId}/banner"`));
  } finally {
    pool.query = original;
  }
  const bytes = seen.filter(sql => /community_event_highlight_images/i.test(sql) || (/community_event_banners/i.test(sql) && /image_bytes/i.test(sql)));
  assert.deepEqual(bytes, []);
});

test('twenty link adds are allowed and the next one is rate limited', async () => {
  const maker = await login();
  for (let batch = 0; batch < 2; batch += 1) {
    const eventId = await ended({title: `頻率 ${batch}`});
    for (let index = 0; index < 10; index += 1) {
      const response = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: `https://example.com/rate-${batch}-${index}`});
      assert.equal(response.status, 201, `${batch}-${index} ${response.text}`);
    }
  }
  const eventId = await ended({title: '頻率已滿'});
  const blocked = await post(`/api/v1/event-highlights/${eventId}/links`, maker, {url: 'https://example.com/rate-over'});
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, 'auth_rate_limited');
});
