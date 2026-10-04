// Native local workerd coverage for a decodable MP4 and highlight link/photo/poster.
// Fixtures are synthetic files in this repo. They are not live R2 acceptance.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { after, before, test } from 'node:test';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Pool } from 'pg';
import sharp from 'sharp';
import { tokenHash } from '../../modules/identity-membership/service.js';
import { migrate } from '../../scripts/database.js';
import { loadAcceptedMediaFixtures } from '../../scripts/media-format-fixtures.js';

const raw = process.env.TEST_DATABASE_URL;
assert(raw, 'Owned fp_* TEST_DATABASE_URL required');
const adminUrl = new URL(raw);
assert.match(adminUrl.pathname, /^\/fp_[a-z0-9_]+$/);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname));
const socket = adminUrl.searchParams.get('host');
if (socket) assert(socket.startsWith('/'));
const database = `fp_worker_mediafmt_${process.pid}_${Date.now()}`;
const migrator = database + '_owner';
const runtimeRole = database + '_app';
const password = randomBytes(24).toString('hex');
function roleUrl(role: string) {
  const url = new URL(raw!);
  url.pathname = '/' + database;
  url.username = role;
  url.password = password;
  return url.href;
}
const admin = new Pool({ connectionString: raw });
const owner = new Pool({ connectionString: roleUrl(migrator) });
const app = new Pool({ connectionString: roleUrl(runtimeRole) });
const sockets = new Set<Socket>();
const proxy = socket ? createServer(client => {
  const upstream = createConnection(join(socket, '.s.PGSQL.5432'));
  for (const channel of [client, upstream]) {
    sockets.add(channel);
    channel.on('close', () => sockets.delete(channel));
    channel.on('error', () => { client.destroy(); upstream.destroy(); });
  }
  client.pipe(upstream).pipe(client);
}) : undefined;
const origin = 'http://127.0.0.1:8787';
const community = randomUUID();
const instances: Miniflare[] = [];
let directory: string, tcp: string, created = false, outboundCalls = 0;
const fixtures = await loadAcceptedMediaFixtures();
assert.equal(fixtures.manifest.liveAcceptance, false);

before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${migrator}`);
  created = true;
  await migrate(owner);
  const source = (await readFile('deploy/cloudflare/sql/20-runtime-grants.psql', 'utf8')).replace(/^\\set .*$/mg, '').replaceAll(':"runtime"', '"' + runtimeRole + '"').replaceAll(":'runtime'", "'" + runtimeRole + "'");
  const q = await owner.connect();
  try {
    const parts = source.split('\\gexec');
    for (let index = 0; index < parts.length; index++) {
      const result = await q.query(parts[index]);
      if (index < parts.length - 1) {
        const last = Array.isArray(result) ? result.at(-1)! : result;
        for (const row of last.rows) await q.query(Object.values(row)[0] as string);
      }
    }
  } catch (error) {
    await q.query('ROLLBACK');
    throw error;
  } finally { q.release(); }
  const connection = new URL(roleUrl(runtimeRole));
  if (proxy) {
    await new Promise<void>(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen));
    const address = proxy.address();
    assert(address && typeof address === 'object');
    connection.hostname = '127.0.0.1';
    connection.port = String(address.port);
    connection.searchParams.delete('host');
  }
  tcp = connection.href;
  await owner.query('INSERT INTO communities VALUES($1,$2)', [community, 'Synthetic native format community']);
  await owner.query("UPDATE domain_media_storage_policy SET mode='bridge', persistence_allowed=true, policy_revision='synthetic-format-video-v1', retained_byte_limit=41943040 WHERE purpose='community.event-video'");
  await owner.query("UPDATE domain_media_storage_policy SET mode='bridge', persistence_allowed=true, policy_revision='synthetic-format-highlight-v1', retained_byte_limit=10485760 WHERE purpose='community.event-highlight'");
  directory = await mkdtemp(resolve('.wrangler/native-media-format-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'assets/index.html'), '<!doctype html><title>Native format fixture</title>');
});
after(async () => {
  for (const instance of instances) await instance.dispose();
  for (const channel of sockets) channel.destroy();
  if (proxy?.listening) await new Promise<void>(resolveClose => proxy.close(() => resolveClose()));
  await Promise.all([owner.end(), app.end()]);
  try {
    if (created) {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.query(`DROP ROLE ${migrator},${runtimeRole}`);
    }
  } finally { await admin.end(); }
  if (directory) await rm(directory, { recursive: true, force: true });
  assert.equal(outboundCalls, 0);
});

function worker(options: { video?: boolean; highlight?: boolean; media?: boolean; images?: boolean } = {}) {
  const instance = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'native-format-' + randomUUID(), modules: true,
    scriptPath: resolve(process.env.FREEDOM_WORKERD_BUNDLE_DIR ?? '.wrangler/dry-run/local', 'worker.js'),
    compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
    bindings: {
      FREEDOM_ENV: 'local', APP_ORIGIN: origin, FREEDOM_REGISTRATION_COMMUNITY_ID: community,
      ...(options.video ? { FREEDOM_EVENT_VIDEO_ENABLED: 'true' } : {}),
      ...(options.highlight ? { FREEDOM_EVENT_HIGHLIGHT_ENABLED: 'true' } : {}),
    },
    hyperdrives: { HYPERDRIVE: tcp },
    ...(options.media === false ? {} : { r2Buckets: ['MEDIA'] }),
    ...(options.images === false ? {} : { images: { binding: 'IMAGES' } }),
    assets: { directory: join(directory, 'assets'), binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }, assetConfig: { not_found_handling: 'none' } },
    outboundService: async () => { outboundCalls++; return new Response(null, { status: 503 }); },
  }] }));
  instances.push(instance);
  return instance.ready.then(() => instance);
}
type Member = { id: string; cookie: string; csrf: string };
async function member(label: string) {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const csrf = randomUUID();
  await owner.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,'not-a-login',$5)", [id, community, id + '@native-media-format.test', label, randomUUID()]);
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [tokenHash(token), id, csrf]);
  return { id, cookie: 'freedom_local_session=' + token, csrf };
}
const call = (instance: Miniflare, path: string, init?: RequestInit) => instance.dispatchFetch(origin + path, init as never) as unknown as Promise<Response>;
function headers(human: Member, extra: Record<string, string> = {}) {
  return { Origin: origin, Cookie: human.cookie, 'X-CSRF-Token': human.csrf, ...extra };
}
async function expectProblem(response: Response, status: number, code: string) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  assert.equal(JSON.parse(text).code, code);
}
async function videoCount() {
  return (await owner.query('SELECT count(*)::int AS n FROM community_event_videos')).rows[0].n as number;
}
async function createFutureEvent(instance: Miniflare, human: Member) {
  const response = await call(instance, '/api/v1/events', {
    method: 'POST', headers: headers(human, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({
      title: 'Synthetic native MP4 event', description: 'Owned fixture only',
      starts_at: new Date(Date.now() + 86400000).toISOString(), ends_at: new Date(Date.now() + 90000000).toISOString(),
      mode: 'online', location: 'Synthetic', online_url: 'https://example.invalid/event', event_kind: 'other', visibility: 'open', capacity: null,
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json() as { event_id: string }).event_id;
}
function uploadVideo(instance: Miniflare, human: Member, id: string, body: Uint8Array, contentType: string, version = '1', extra: Record<string, string> = {}) {
  return call(instance, '/api/v1/events/' + id + '/video', {
    method: 'POST', body: new Uint8Array(body), headers: headers(human, { 'Content-Type': contentType, 'Idempotency-Key': extra['Idempotency-Key'] ?? randomUUID(), 'If-Match': '"' + version + '"', ...extra }),
  });
}
async function endedEvent(organizer: Member) {
  const id = randomUUID();
  await owner.query("INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind) VALUES($1,$2,$3,'Synthetic format highlight','Owned fixture',clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day','online','Synthetic','published','open','other')", [id, community, organizer.id]);
  return id;
}
function uploadHighlight(instance: Miniflare, human: Member, id: string, kind: 'photos' | 'posters', body: Uint8Array, contentType: string, extra: Record<string, string> = {}) {
  return call(instance, '/api/v1/event-highlights/' + id + '/' + kind, {
    method: 'POST', body: new Uint8Array(body), headers: headers(human, { 'Content-Type': contentType, 'Idempotency-Key': extra['Idempotency-Key'] ?? randomUUID(), 'X-Photo-Orientation': 'landscape', ...extra }),
  });
}
function addLink(instance: Miniflare, human: Member, id: string, url: string) {
  return call(instance, '/api/v1/event-highlights/' + id + '/links', {
    method: 'POST', headers: headers(human, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({ url }),
  });
}
async function highlightRows() {
  return (await owner.query('SELECT count(*)::int AS n FROM community_event_highlights')).rows[0].n as number;
}

test('native Worker accepts a decodable MP4, rejects mismatched MIME and content, and serves ranges by permission', { timeout: 120_000 }, async () => {
  const installed = await worker({ video: true, highlight: true });
  const disabled = await worker({ media: true, images: true });
  const organizer = await member('Synthetic video organizer');
  const peer = await member('Synthetic video peer');
  const sampler = await member('Synthetic video sampler');
  const id = await createFutureEvent(installed, organizer);
  assert.equal((await uploadVideo(disabled, organizer, id, fixtures.video, 'video/mp4')).status, 503);
  assert.equal(await videoCount(), 0);
  await expectProblem(await uploadVideo(installed, sampler, id, fixtures.video, 'video/ogg'), 415, 'video_format');
  await expectProblem(await uploadVideo(installed, sampler, id, fixtures.video, 'video/mp4; codecs=avc1'), 415, 'video_format');
  await expectProblem(await uploadVideo(installed, sampler, id, fixtures.photo, 'video/mp4'), 422, 'invalid_event_video');
  await expectProblem(await uploadVideo(installed, sampler, id, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]), 'video/mp4'), 422, 'invalid_event_video');
  await expectProblem(await uploadVideo(installed, sampler, id, fixtures.video, 'video/webm'), 422, 'invalid_event_video');
  await expectProblem(await uploadVideo(installed, sampler, id, fixtures.video.subarray(0, 8), 'video/mp4'), 422, 'invalid_event_video');
  await expectProblem(await uploadVideo(installed, peer, id, fixtures.video, 'video/mp4'), 403, 'organizer_required');
  await expectProblem(await uploadVideo(installed, organizer, id, fixtures.video, 'video/mp4', '1', { 'X-CSRF-Token': 'wrong-token' }), 403, 'csrf_rejected');
  assert.equal(await videoCount(), 0);

  const key = randomUUID();
  const saved = await uploadVideo(installed, organizer, id, fixtures.video, 'video/mp4', '1', { 'Idempotency-Key': key });
  assert.equal(saved.status, 200, await saved.clone().text());
  const dto = await saved.json() as { video_url: string; video_mime: string; aggregate_version: number };
  assert.equal(dto.video_mime, 'video/mp4');
  assert.equal(dto.aggregate_version, 2);
  assert.equal(dto.video_url, '/api/v1/events/' + id + '/video?v=2');
  const replay = await uploadVideo(installed, organizer, id, fixtures.video, 'video/mp4', '1', { 'Idempotency-Key': key });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), dto);
  const row = (await owner.query("SELECT v.mime_type,v.storage_source,octet_length(v.media_bytes) AS legacy_bytes,o.content_type,o.byte_size,o.content_sha256,o.profile_id FROM community_event_videos v JOIN community_event_video_asset_targets t USING(event_id) JOIN asset_objects o ON o.asset_id=t.asset_id WHERE v.event_id=$1", [id])).rows[0];
  assert.equal(row.mime_type, 'video/mp4');
  assert.equal(row.storage_source, 'asset');
  assert.equal(row.legacy_bytes, null);
  assert.equal(row.content_type, 'video/mp4');
  assert.equal(row.profile_id, 'community.event-video');
  assert.equal(Number(row.byte_size), fixtures.video.length);
  assert.equal(row.content_sha256, createHash('sha256').update(fixtures.video).digest('hex'));

  const path = '/api/v1/events/' + id + '/video';
  const read = await call(installed, path, { headers: headers(organizer) });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'video/mp4');
  assert.equal(read.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), fixtures.video);
  const etag = read.headers.get('etag');
  assert(etag);
  const size = fixtures.video.length;
  const ranged = await call(installed, path, { headers: headers(organizer, { Range: 'bytes=32-63', 'If-Range': etag }) });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-type'), 'video/mp4');
  assert.equal(ranged.headers.get('content-range'), `bytes 32-63/${size}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), fixtures.video.subarray(32, 64));
  const suffix = await call(installed, path, { headers: headers(organizer, { Range: 'bytes=-8' }) });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), `bytes ${size - 8}-${size - 1}/${size}`);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), fixtures.video.subarray(size - 8));
  const beyond = await call(installed, path, { headers: headers(organizer, { Range: `bytes=${size}-${size}` }) });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), `bytes */${size}`);
  assert.equal((await beyond.arrayBuffer()).byteLength, 0);
  const stale = await call(installed, path, { headers: headers(organizer, { Range: 'bytes=32-63', 'If-Range': '"stale"' }) });
  assert.equal(stale.status, 200);
  assert.deepEqual(Buffer.from(await stale.arrayBuffer()), fixtures.video);
  const head = await call(installed, path, { method: 'HEAD', headers: headers(organizer, { Range: 'bytes=0-3' }) });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(size));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const publicPath = '/api/v1/public/events/' + id + '/video';
  assert.equal((await call(installed, path, { headers: headers(peer) })).status, 404);
  assert.equal((await call(installed, publicPath)).status, 404);

  // Synthetic published state checks the public read ACL. It is not a guild-master review.
  await owner.query("UPDATE community_events SET state='published' WHERE event_id=$1", [id]);
  const listed = await call(installed, '/api/v1/public/events/' + id);
  assert.equal(listed.status, 200);
  const listedBody = await listed.json() as { video_mime: string; video_url: string };
  assert.equal(listedBody.video_mime, 'video/mp4');
  assert.equal(listedBody.video_url, publicPath);
  const publicRange = await call(installed, publicPath, { headers: { Range: 'bytes=32-63' } });
  assert.equal(publicRange.status, 206);
  assert.equal(publicRange.headers.get('content-type'), 'video/mp4');
  assert.equal(publicRange.headers.get('cache-control'), 'public, max-age=300');
  assert.deepEqual(Buffer.from(await publicRange.arrayBuffer()), fixtures.video.subarray(32, 64));
  assert.equal((await call(installed, path, { headers: headers(peer) })).status, 200);
  await expectProblem(await uploadVideo(installed, organizer, id, fixtures.video, 'video/mp4', '2'), 409, 'event_closed');
  await owner.query("UPDATE community_events SET state='pending' WHERE event_id=$1", [id]);
  assert.equal((await call(installed, publicPath)).status, 404);
  const removed = await call(installed, path + '/remove', { method: 'POST', headers: headers(organizer, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'If-Match': '"2"' }), body: '{}' });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal((await call(installed, path, { headers: headers(organizer) })).status, 404);
  assert.equal(await videoCount(), 0);
  assert.equal((await (await installed.getR2Bucket('MEDIA')).list()).objects.length, 1);
  await assert.rejects(app.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='community.event-video'"), error => (error as { code: string }).code === '42501');
});

test('native Worker stores photo, poster, and link highlights and rejects the other MIME and lifecycle cases', { timeout: 120_000 }, async () => {
  const installed = await worker({ video: true, highlight: true });
  const videoOnly = await worker({ video: true, images: false });
  const organizer = await member('Synthetic highlight organizer');
  const author = await member('Synthetic highlight author');
  const stranger = await member('Synthetic highlight stranger');
  const id = await endedEvent(organizer);
  const future = randomUUID();
  await owner.query("INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind) VALUES($1,$2,$3,'Synthetic future highlight','Owned fixture',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days','online','Synthetic','published','open','other')", [future, community, organizer.id]);
  await expectProblem(await uploadHighlight(installed, author, future, 'photos', fixtures.photo, 'image/png'), 404, 'not_found');
  assert.equal((await uploadHighlight(videoOnly, author, id, 'photos', fixtures.photo, 'image/png')).status, 503);
  assert.equal(await highlightRows(), 0);
  await expectProblem(await uploadHighlight(installed, author, id, 'photos', Buffer.from('GIF89a'), 'image/gif'), 415, 'highlight_image_format');
  await expectProblem(await uploadHighlight(installed, author, id, 'photos', fixtures.photo, 'image/jpeg'), 415, 'highlight_image_format');
  await expectProblem(await uploadHighlight(installed, author, id, 'posters', fixtures.video, 'image/png'), 415, 'highlight_image_format');
  await expectProblem(await uploadHighlight(installed, author, id, 'photos', fixtures.photo, 'image/png', { 'X-CSRF-Token': 'wrong-token' }), 403, 'csrf_rejected');
  await expectProblem(await addLink(installed, author, id, 'http://example.com/highlight-fixture'), 422, 'highlight_url_invalid');
  await expectProblem(await addLink(installed, author, id, 'https://user:pass@example.com/highlight-fixture'), 422, 'highlight_url_invalid');
  await expectProblem(await addLink(installed, author, id, 'https://127.0.0.1/highlight-fixture'), 422, 'highlight_url_invalid');
  await expectProblem(await addLink(installed, author, id, 'https://example.com:8443/highlight-fixture'), 422, 'highlight_url_invalid');
  assert.equal(await highlightRows(), 0);

  const photoKey = randomUUID();
  const photo = await uploadHighlight(installed, author, id, 'photos', fixtures.photo, 'image/png', { 'Idempotency-Key': photoKey, 'X-Media-Title': encodeURIComponent('Synthetic photo') });
  assert.equal(photo.status, 201, await photo.clone().text());
  const photoDto = await photo.json() as { media_id: string; kind: string; image_url: string; thumb_url: string; title: string };
  assert.equal(photoDto.kind, 'photo');
  assert.equal(photoDto.title, 'Synthetic photo');
  const photoReplay = await uploadHighlight(installed, author, id, 'photos', fixtures.photo, 'image/png', { 'Idempotency-Key': photoKey, 'X-Media-Title': encodeURIComponent('Synthetic photo') });
  assert.equal(photoReplay.status, 201);
  assert.deepEqual(await photoReplay.json(), photoDto);
  const poster = await uploadHighlight(installed, author, id, 'posters', fixtures.poster, 'image/jpeg', { 'X-Media-Title': encodeURIComponent('Synthetic poster') });
  assert.equal(poster.status, 201, await poster.clone().text());
  const posterDto = await poster.json() as { media_id: string; kind: string; image_url: string; thumb_url: string };
  assert.equal(posterDto.kind, 'poster');
  assert.notEqual(posterDto.media_id, photoDto.media_id);
  const still = await uploadHighlight(installed, author, id, 'photos', fixtures.still, 'image/webp', { 'X-Media-Title': encodeURIComponent('Synthetic webp') });
  assert.equal(still.status, 201, await still.clone().text());
  const stillDto = await still.json() as { media_id: string; kind: string; image_url: string; thumb_url: string };
  assert.equal(stillDto.kind, 'photo');
  const beforeLinks = (await (await installed.getR2Bucket('MEDIA')).list()).objects.length;
  const youtube = await addLink(installed, author, id, fixtures.manifest.links.youtube.input);
  assert.equal(youtube.status, 201, await youtube.clone().text());
  const youtubeDto = await youtube.json() as { media_id: string; kind: string; url: string; platform: string; title: string; thumbnail_url?: string };
  assert.equal(youtubeDto.kind, 'link');
  assert.equal(youtubeDto.platform, 'youtube');
  assert.equal(youtubeDto.url, fixtures.manifest.links.youtube.url);
  assert.equal(youtubeDto.title, fixtures.manifest.links.youtube.title);
  assert.equal(youtubeDto.thumbnail_url, 'https://i.ytimg.com/vi/' + fixtures.manifest.links.youtube.videoId + '/hqdefault.jpg');
  const other = await addLink(installed, author, id, fixtures.manifest.links.other.input);
  assert.equal(other.status, 201, await other.clone().text());
  const otherDto = await other.json() as { kind: string; platform: string; url: string; thumbnail_url?: string };
  assert.equal(otherDto.kind, 'link');
  assert.equal(otherDto.platform, 'other');
  assert.equal(otherDto.url, fixtures.manifest.links.other.url);
  assert.equal(otherDto.thumbnail_url, undefined);
  await expectProblem(await addLink(installed, author, id, fixtures.manifest.links.youtube.url), 409, 'highlight_link_exists');
  assert.equal((await (await installed.getR2Bucket('MEDIA')).list()).objects.length, beforeLinks);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM community_event_highlight_images WHERE media_id=$1', [youtubeDto.media_id])).rows[0].n, 0);

  for (const dto of [photoDto, posterDto, stillDto]) {
    const stored = (await owner.query("SELECT h.kind,h.storage_source,count(i.variant)::int AS variants,count(i.bytes)::int AS legacy_rows FROM community_event_highlights h JOIN community_event_highlight_images i USING(media_id) WHERE h.media_id=$1 GROUP BY h.kind,h.storage_source", [dto.media_id])).rows[0];
    assert.equal(stored.kind, dto.kind);
    assert.equal(stored.storage_source, 'asset');
    assert.equal(stored.variants, 2);
    assert.equal(stored.legacy_rows, 0);
    for (const [variant, width, height] of [['image', 1600, 1200], ['thumb', 480, 360]] as const) {
      const read = await call(installed, '/api/v1/public/event-highlights/media/' + dto.media_id + '/' + variant);
      assert.equal(read.status, 200, await read.clone().text());
      assert.equal(read.headers.get('content-type'), 'image/webp');
      const metadata = await sharp(Buffer.from(await read.arrayBuffer())).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.width, width);
      assert.equal(metadata.height, height);
    }
  }
  const detail = await call(installed, '/api/v1/event-highlights/' + id, { headers: headers(author) });
  assert.equal(detail.status, 200, await detail.clone().text());
  const kinds = ((await detail.json() as { items: { kind: string }[] }).items).map(item => item.kind).sort();
  assert.deepEqual(kinds, ['link', 'link', 'photo', 'photo', 'poster']);
  const page = await call(installed, '/highlights/' + id);
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  assert.match(html, /<h2>海報<\/h2>/);
  assert.match(html, /<h2>錄影與影片<\/h2>/);
  assert.match(html, /<h2>活動照片<\/h2>/);
  assert.match(html, new RegExp(fixtures.manifest.links.youtube.url.replaceAll('?', '\\?')));
  assert.equal(html.includes('utm_source'), false);

  await expectProblem(await call(installed, '/api/v1/event-highlights/media/' + photoDto.media_id + '/remove', { method: 'POST', headers: headers(stranger, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), body: '{}' }), 403, 'highlight_remove_forbidden');
  const removedPoster = await call(installed, '/api/v1/event-highlights/media/' + posterDto.media_id + '/remove', { method: 'POST', headers: headers(organizer, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), body: '{}' });
  assert.equal(removedPoster.status, 200, await removedPoster.clone().text());
  assert.equal((await call(installed, posterDto.image_url)).status, 404);
  const removedLink = await call(installed, '/api/v1/event-highlights/media/' + youtubeDto.media_id + '/remove', { method: 'POST', headers: headers(author, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), body: '{}' });
  assert.equal(removedLink.status, 200, await removedLink.clone().text());
  const afterRemoval = await call(installed, '/api/v1/event-highlights/' + id, { headers: headers(author) });
  const remaining = await afterRemoval.json() as { items: { url?: string; kind: string }[] };
  assert.equal(remaining.items.some(item => item.url === fixtures.manifest.links.youtube.url), false);
  await owner.query("UPDATE community_events SET state='cancelled' WHERE event_id=$1", [id]);
  assert.equal((await call(installed, photoDto.image_url)).status, 404);
  assert.equal((await call(installed, photoDto.thumb_url)).status, 404);
  await expectProblem(await uploadHighlight(installed, author, id, 'photos', fixtures.photo, 'image/png'), 404, 'not_found');
  await assert.rejects(app.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='community.event-highlight'"), error => (error as { code: string }).code === '42501');
});
