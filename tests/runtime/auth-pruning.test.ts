import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS } from '../../packages/testing/seed.js';
import { pruneExpiredAuthRecords, SESSION_CASCADES, SESSION_REFERENCES } from '../../modules/identity-membership/auth-pruning.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_auth_pruning_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities, sessions, login_attempts, auth_rate_limits, password_reset_tokens CASCADE');
  await seedLocal(pool);
});

test('auth_rate_limits and login_attempts prune by window_start', async () => {
  await pool.query(`INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES('old-arl','5',now()-interval '2 days')`);
  await pool.query(`INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES('live-arl','1',now()-interval '1 hour')`);
  await pool.query(`INSERT INTO login_attempts(attempt_key,failures,window_start) VALUES('old-la@example.com','3',now()-interval '2 days')`);
  await pool.query(`INSERT INTO login_attempts(attempt_key,failures,window_start) VALUES('live-la@example.com','1',now()-interval '1 hour')`);
  const result = await pruneExpiredAuthRecords(pool);
  assert.equal(result.auth_rate_limits, 1);
  assert.equal(result.login_attempts, 1);
  const arl = (await pool.query('SELECT bucket FROM auth_rate_limits ORDER BY bucket')).rows.map(r => r.bucket);
  const la = (await pool.query('SELECT attempt_key FROM login_attempts ORDER BY attempt_key')).rows.map(r => r.attempt_key);
  assert.deepEqual(arl, ['live-arl']);
  assert.deepEqual(la, ['live-la@example.com']);
});

test('password_reset_tokens prune by expires_at', async () => {
  const oldHash = 'a'.repeat(64);
  const liveHash = 'b'.repeat(64);
  await pool.query(`INSERT INTO password_reset_tokens(token_hash,user_id,created_at,expires_at)
    VALUES($1,$2,now()-interval '3 days',now()-interval '2 days')`,[oldHash, DEMO_USERS[0].user_id]);
  await pool.query(`INSERT INTO password_reset_tokens(token_hash,user_id,created_at,expires_at)
    VALUES($1,$2,now(),now()+interval '1 hour')`,[liveHash, DEMO_USERS[0].user_id]);
  const result = await pruneExpiredAuthRecords(pool);
  assert.equal(result.password_reset_tokens, 1);
  const hashes = (await pool.query('SELECT token_hash FROM password_reset_tokens')).rows.map(r => r.token_hash);
  assert.deepEqual(hashes, [liveHash]);
});

test('sessions keep the newest per user but prune older expired/revoked rows', async () => {
  const u1 = DEMO_USERS[0].user_id;
  const u2 = DEMO_USERS[1].user_id;
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,revoked_at,last_seen_at,created_at) VALUES
    ('old-u1',$1,'c',now()-interval '40 days',NULL,now()-interval '40 days',now()-interval '40 days'),
    ('revoked-u1',$1,'c',now()+interval '10 days',now()-interval '2 days',now()-interval '3 days',now()-interval '3 days'),
    ('live-u1',$1,'c',now()+interval '10 days',NULL,now(),now())`,[u1]);
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,revoked_at,last_seen_at,created_at) VALUES
    ('only-u2',$1,'c',now()-interval '40 days',NULL,now()-interval '40 days',now()-interval '40 days')`,[u2]);
  const result = await pruneExpiredAuthRecords(pool);
  assert.equal(result.sessions, 2);
  const remaining = (await pool.query('SELECT token_hash FROM sessions ORDER BY token_hash')).rows.map(r => r.token_hash);
  assert.deepEqual(remaining, ['live-u1', 'only-u2']);
});

test('batch limit bounds a per-run delete and second call clears the remainder', async () => {
  for (let i = 0; i < 5; i += 1) {
    await pool.query(`INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES($1,'1',now()-interval '2 days')`,[`stale-${i}`]);
  }
  const first = await pruneExpiredAuthRecords(pool, {batch: 2});
  assert.equal(first.auth_rate_limits, 2);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM auth_rate_limits WHERE window_start < now() - interval '1 day'`)).rows[0].n, 3);
  const second = await pruneExpiredAuthRecords(pool, {batch: 2});
  assert.equal(second.auth_rate_limits, 2);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM auth_rate_limits WHERE window_start < now() - interval '1 day'`)).rows[0].n, 1);
});

test('a run with nothing stale returns all four counts as zero', async () => {
  const result = await pruneExpiredAuthRecords(pool);
  assert.deepEqual(result, {sessions: 0, login_attempts: 0, auth_rate_limits: 0, password_reset_tokens: 0});
});

test('sessions with equal or missing timestamps still keep exactly one row per user', async () => {
  const u = DEMO_USERS[2].user_id;
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,revoked_at,last_seen_at,created_at) VALUES
    ('tie-a',$1,'c',now()-interval '40 days',NULL,now()-interval '41 days',now()-interval '41 days'),
    ('tie-b',$1,'c',now()-interval '40 days',NULL,now()-interval '41 days',now()-interval '41 days'),
    ('null-a',$1,'c',now()-interval '40 days',NULL,NULL,NULL)`,[u]);
  assert.equal((await pruneExpiredAuthRecords(pool)).sessions, 2);
  assert.deepEqual((await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1',[u])).rows.map(r => r.token_hash), ['tie-b']);
});

test('a stale session still referenced by a non-cascading foreign key is kept instead of failing the batch', async () => {
  const u = DEMO_USERS[0].user_id;
  await pool.query('CREATE TABLE prune_reference_probe(session_hash text NOT NULL REFERENCES sessions(token_hash))');
  try {
    await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES
      ('ref-old',$1,'c',now()-interval '40 days',now()-interval '40 days'),
      ('free-old',$1,'c',now()-interval '40 days',now()-interval '41 days'),
      ('live',$1,'c',now()+interval '10 days',now())`,[u]);
    await pool.query(`INSERT INTO prune_reference_probe VALUES('ref-old')`);
    // Without the exclusion PostgreSQL rejects the whole session batch.
    await assert.rejects(pruneExpiredAuthRecords(pool), (error: {code?: string}) => error.code === '23503');
    const references = [...SESSION_REFERENCES, ['prune_reference_probe', 'session_hash'] as const];
    assert.equal((await pruneExpiredAuthRecords(pool, {sessionReferences: references})).sessions, 1);
    assert.deepEqual((await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY token_hash',[u])).rows.map(r => r.token_hash), ['live', 'ref-old']);
  } finally { await pool.query('DROP TABLE prune_reference_probe'); }
});

test('every foreign key to sessions is either excluded from pruning or an intended cascade', async () => {
  // A new reference to sessions fails here until auth-pruning.ts classifies it; a non-cascading one would make every session batch fail.
  const rows = (await pool.query(`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype='c' AS cascade FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    WHERE c.contype='f' AND c.confrelid='sessions'::regclass ORDER BY 1,2`)).rows;
  assert.deepEqual(rows.filter(r => !r.cascade).map(r => [r.tbl, r.col]), SESSION_REFERENCES.map(([t, c]) => [t, c]));
  assert.deepEqual(rows.filter(r => r.cascade).map(r => [r.tbl, r.col]), SESSION_CASCADES.map(([t, c]) => [t, c]));
});

