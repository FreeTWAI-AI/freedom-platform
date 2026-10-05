import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const origin = 'http://127.0.0.1:4310';
const schema = `fp_svccur_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const app = createApp(pool, origin, 'local');
const CONTACTS = '[{"label":"網站","url":"https://example.com/page"}]';
const BASE = '2026-10-04 12:00:00+00';

type Session = { cookie: string; userId: string };

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
});

function decodeCursor(raw: string) {
  const [updatedAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('\n');
  assert.equal(typeof updatedAt, 'string');
  assert.match(id ?? '', /^[0-9a-f-]{36}$/);
  return { updatedAt: updatedAt!, id: id! };
}

async function signIn(): Promise<Session> {
  const response = await app.request(origin + '/api/v1/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEMO_USERS[0].email, password: DEMO_PASSWORD }),
  });
  const data = await response.json() as { csrf_token: string; user: { user_id: string } };
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], userId: data.user.user_id };
}

async function insertMicrosecondServices(ownerId: string, count: number) {
  const ids = Array.from({ length: count }, () => randomUUID());
  const titles = Array.from({ length: count }, (_, index) => `P${String(index + 1).padStart(2, '0')}`);
  const usec = titles.map((_, index) => (index + 1) * 15);
  await pool.query(`INSERT INTO member_services(
      service_id,community_id,owner_user_id,title,category,summary,description,price_text,area_text,service_mode,contacts,state,updated_at)
    SELECT u.id,$1,$2,u.title,'design','微秒分頁',NULL,NULL,NULL,'online',$3::jsonb,'active',
      timestamptz '${BASE}' + (u.usec || ' microseconds')::interval
    FROM unnest($4::uuid[], $5::text[], $6::int[]) AS u(id, title, usec)`,
  [DEMO_COMMUNITY, ownerId, CONTACTS, ids, titles, usec]);
  const stored = await pool.query(`SELECT service_id::text, title, to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM member_services ORDER BY updated_at DESC, service_id DESC`);
  const newest = stored.rows[0].cursor_at as string;
  assert.match(newest, /\.000\d{3}Z$/, `fixture lost microseconds: ${newest}`);
  assert.notEqual(newest.slice(-5), '000Z');
  return stored.rows as { service_id: string; title: string; cursor_at: string }[];
}

function titlesIn(html: string) {
  return [...html.matchAll(/<h2>(P\d{2})<\/h2>/g)].map(match => match[1]!);
}

async function publicHtml(path: string) {
  const response = await app.request(origin + path);
  assert.equal(response.status, 200);
  return response.text();
}

test('public service pages keep every microsecond row across keyset cursors', async () => {
  const session = await signIn();
  const stored = await insertMicrosecondServices(session.userId, 25);
  const expected = stored.map(row => row.title);
  const seen: string[] = [];
  let path = '/services';
  for (let page = 0; page < 4 && path; page += 1) {
    const html = await publicHtml(path);
    const titles = titlesIn(html);
    assert.ok(titles.length > 0, `public page ${page + 1} dropped the remaining services`);
    seen.push(...titles);
    const href = html.match(/href="(\/services\?before=[^"]+)"/)?.[1];
    if (!href) {
      path = '';
      continue;
    }
    const before = new URL(href.replaceAll('&amp;', '&'), origin).searchParams.get('before');
    assert.ok(before);
    const boundary = stored[seen.length - 1]!;
    const decoded = decodeCursor(before);
    assert.equal(decoded.updatedAt, boundary.cursor_at);
    assert.equal(decoded.id, boundary.service_id);
    path = href.replaceAll('&amp;', '&');
  }
  assert.deepEqual(seen, expected);
});

test('member service list keeps the next microsecond row and leaves display timestamps in milliseconds', async () => {
  const session = await signIn();
  const stored = await insertMicrosecondServices(session.userId, 25);
  const seen: string[] = [];
  let cursor = '';
  for (let page = 0; page < 4; page += 1) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const response = await app.request(origin + '/api/v1/member-services' + query, { headers: { Cookie: session.cookie } });
    const body = await response.json() as { items: { title: string; service_id: string; updated_at: string }[]; next_cursor: string | null };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(body.items.length > 0, `member page ${page + 1} dropped the remaining services`);
    for (const item of body.items) assert.match(item.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    seen.push(...body.items.map(item => item.title));
    if (!body.next_cursor) break;
    const decoded = decodeCursor(body.next_cursor);
    const boundary = stored[seen.length - 1]!;
    assert.equal(decoded.updatedAt, boundary.cursor_at);
    assert.equal(decoded.id, boundary.service_id);
    cursor = body.next_cursor;
  }
  assert.deepEqual(seen, stored.map(row => row.title));
  assert.equal(seen.filter(title => title === 'P01').length, 1);
  assert.equal(seen.filter(title => title === 'P02').length, 1);
});

test('a millisecond cursor still opens the next service when timestamps have no extra precision', async () => {
  const session = await signIn();
  const older = randomUUID();
  const newer = randomUUID();
  await pool.query(`INSERT INTO member_services(
      service_id,community_id,owner_user_id,title,category,summary,service_mode,contacts,state,updated_at)
    VALUES
      ($1,$2,$3,'較舊服務','design','毫秒分頁','online',$4::jsonb,'active',timestamptz '2026-10-04 11:00:00+00'),
      ($5,$2,$3,'較新服務','design','毫秒分頁','online',$4::jsonb,'active',timestamptz '2026-10-04 12:00:00+00')`,
  [older, DEMO_COMMUNITY, session.userId, CONTACTS, newer]);
  const cursor = Buffer.from(`2026-10-04T12:00:00.000Z\n${newer}`).toString('base64url');
  const member = await app.request(origin + '/api/v1/member-services?cursor=' + encodeURIComponent(cursor), { headers: { Cookie: session.cookie } });
  const body = await member.json() as { items: { title: string; updated_at: string }[]; next_cursor: string | null };
  assert.equal(member.status, 200, JSON.stringify(body));
  assert.deepEqual(body.items.map(item => item.title), ['較舊服務']);
  assert.equal(body.next_cursor, null);
  assert.equal(body.items[0]?.updated_at, '2026-10-04T11:00:00.000Z');
  const html = await publicHtml(`/services?before=${encodeURIComponent(cursor)}`);
  assert.match(html, /較舊服務/);
  assert.equal(html.includes('較新服務'), false);
});
