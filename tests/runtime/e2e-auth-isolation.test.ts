import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { e2eSchema, resetE2eAuthState } from '../../packages/testing/e2e-auth-isolation.js';
import { authRateLimit } from '../../modules/identity-membership/members.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal } from '../../packages/testing/seed.js';

const schema = `fp_e2e_${randomUUID().replaceAll('-', '')}`;
const otherSchema = `fp_auth_protected_${randomUUID().replaceAll('-', '')}`;
const url = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const admin = createPool(url);
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const otherPool = new Pool({ connectionString: url, options: `-c search_path=${otherSchema}` });
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE SCHEMA ${otherSchema}`);
  await migrate(pool);
  await seedLocal(pool);
  await otherPool.query(`CREATE TABLE auth_rate_limits (bucket text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT now())`);
});
after(async () => {
  await pool.end(); await otherPool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.query(`DROP SCHEMA ${otherSchema} CASCADE`);
  await admin.end();
});

test('schema guard rejects ordinary databases, malformed names and non-local modes', () => {
  assert.equal(e2eSchema(schema, {}), schema);
  for (const value of [undefined, 'public', 'fp_e2e_', 'fp_e2e_existing', schema + '; DROP SCHEMA public']) {
    assert.throws(() => e2eSchema(value, {}), /run-specific/);
  }
  assert.throws(() => e2eSchema(schema, { NODE_ENV: 'production' }), /local-only/);
  for (const mode of ['staging', 'public']) assert.throws(() => e2eSchema(schema, { FREEDOM_ENV: mode }), /local-only/);
});

test('rate budgets stay effective inside a case and renew only when the isolated fixture resets', async () => {
  await authRateLimit(pool, 'case-network', '127.0.0.1', 2);
  await authRateLimit(pool, 'case-network', '127.0.0.1', 2);
  await assert.rejects(authRateLimit(pool, 'case-network', '127.0.0.1', 2), { status: 429 });
  await pool.query("INSERT INTO login_attempts VALUES('failed-login',10,now())");
  await authRateLimit(otherPool, 'protected-network', '127.0.0.1', 1);
  const membersBefore = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;

  await resetE2eAuthState(pool, schema);

  assert.equal((await pool.query('SELECT count(*)::int AS n FROM login_attempts')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, membersBefore);
  await authRateLimit(pool, 'case-network', '127.0.0.1', 2);
  await authRateLimit(pool, 'case-network', '127.0.0.1', 2);
  await assert.rejects(authRateLimit(pool, 'case-network', '127.0.0.1', 2), { status: 429 });
  await assert.rejects(authRateLimit(otherPool, 'protected-network', '127.0.0.1', 1), { status: 429 });
});

test('a pool connected to a different schema cannot reset auth state', async () => {
  await assert.rejects(resetE2eAuthState(otherPool, schema), /outside the Playwright schema/);
  await assert.rejects(resetE2eAuthState(otherPool, otherSchema), /run-specific/);
});
