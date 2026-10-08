import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { tokenHash } from '../../modules/identity-membership/service.js';

const origin = 'http://127.0.0.1:4310', databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_event_quota_${process.pid}_${Date.now()}`, admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const app = createApp(pool, origin);
type Session = { cookie: string; csrf: string };
let sessions: Session[];
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE'); await seedLocal(pool);
  await pool.query('UPDATE users SET email_verified_at=now() WHERE user_id=$1', [DEMO_USERS[1].user_id]);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',
    [randomUUID(), DEMO_COMMUNITY, DEMO_USERS[1].email, '合成審查員']);
  sessions = [];
  for (const user of DEMO_USERS) {
    const response = await app.request(origin + '/api/v1/auth/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: DEMO_PASSWORD }),
    });
    assert.equal(response.status, 200);
    sessions.push({ cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: z.object({ csrf_token: z.string() }).parse(await response.json()).csrf_token });
  }
});
function details() {
  return { title: '合成待審活動', description: '隔離配額驗證', starts_at: new Date(Date.now() + 86400000).toISOString(),
    ends_at: new Date(Date.now() + 90000000).toISOString(), mode: 'online', location: '線上教室', capacity: null };
}
async function create(session = sessions[0], key = randomUUID(), body = details()) {
  const response = await app.request(origin + '/api/v1/events', {
    method: 'POST', headers: { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body),
  });
  return { status: response.status, data: z.object({ event_id: z.uuid().optional(), code: z.string().optional() }).parse(await response.json()) };
}
async function effects() {
  return (await pool.query(`SELECT (SELECT count(*)::int FROM community_events) AS events,
    (SELECT count(*)::int FROM community_event_bulletins) AS bulletins,
    (SELECT count(*)::int FROM member_notifications) AS notifications,
    (SELECT count(*)::int FROM command_receipts WHERE operation='POST /api/v1/events') AS receipts`)).rows[0];
}

test('new event submissions are capped per member; rejection has no effects and exact replay remains usable', async () => {
  const key = randomUUID(), body = details(), first = await create(sessions[0], key, body);
  assert.equal(first.status, 201);
  for (let i = 1; i < 5; i++) assert.equal((await create()).status, 201);
  const before = await effects();
  assert.deepEqual(before, { events: 5, bulletins: 5, notifications: 10, receipts: 5 });
  const denied = await create();
  assert.equal(denied.status, 429); assert.equal(denied.data.code, 'auth_rate_limited');
  assert.deepEqual(await effects(), before);
  const replay = await create(sessions[0], key, body);
  assert.equal(replay.status, 201); assert.equal(replay.data.event_id, first.data.event_id);
  assert.deepEqual(await effects(), before);
  assert.equal((await create(sessions[2])).status, 201, 'another member retains an independent budget');
  await pool.query("UPDATE auth_rate_limits SET window_start=now()-interval '61 minutes' WHERE bucket=$1",
    [tokenHash(`event-create-member/${DEMO_USERS[0].user_id}`)]);
  assert.equal((await create()).status, 201, 'the budget reopens after its window');
});

test('concurrent last-slot submissions cannot exceed the member budget', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await create()).status, 201);
  const results = await Promise.all([create(), create()]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 429]);
  assert.deepEqual(await effects(), { events: 5, bulletins: 5, notifications: 10, receipts: 5 });
});

test('a failed command rolls back quota consumption along with events and notifications', async () => {
  await pool.query(`CREATE FUNCTION fail_event_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.operation='POST /api/v1/events' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_event_receipt BEFORE INSERT ON command_receipts FOR EACH ROW EXECUTE FUNCTION fail_event_receipt()`);
  try { assert.equal((await create()).status, 500); }
  finally { await pool.query('DROP TRIGGER fail_event_receipt ON command_receipts; DROP FUNCTION fail_event_receipt()'); }
  assert.deepEqual(await effects(), { events: 0, bulletins: 0, notifications: 0, receipts: 0 });
  for (let i = 0; i < 5; i++) assert.equal((await create()).status, 201);
  assert.equal((await create()).status, 429);
});
