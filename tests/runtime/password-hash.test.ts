import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { Problem } from '../../packages/shared/problem.js';
import { hashPassword, hashPasswordAsync, login } from '../../modules/identity-membership/service.js';

// Synthetic vector; cross-checked with Python hashlib.scrypt(n=16384, r=8, p=1, dklen=64)
// using the 32-hex salt string itself as the salt bytes.
const FIXED_PASSWORD = 'synthetic-fixed-password';
const FIXED_HASH = '5f1c0e7a9b2d4c6e8f0a1b3c5d7e9f10:4764fec91d9377892f9c83850e50ba6be6ac61dca24ba3bb2e3960dae4eb71e4cbec533464b115bcaab88d12f36f0ede0f984cfed99e07e7651a3052dfac5091';
const FORMAT = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_password_hash_test_${process.pid}_${Date.now()}`, admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); });
const refused = (status: number) => (error: unknown) => error instanceof Problem && error.status === status;

test('sync and async hashes keep the salt:hex scrypt format and default parameters', async () => {
  for (const saved of [hashPassword(FIXED_PASSWORD), await hashPasswordAsync(FIXED_PASSWORD)]) {
    assert.match(saved, FORMAT);
    const [salt, key] = saved.split(':');
    assert.equal(scryptSync(FIXED_PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'), key);
  }
  const [salt, key] = FIXED_HASH.split(':');
  assert.equal(scryptSync(FIXED_PASSWORD, salt, 64).toString('hex'), key);
  assert.notEqual(hashPassword(FIXED_PASSWORD), hashPassword(FIXED_PASSWORD));
});

test('login accepts an existing stored hash and sync/async hashes, and rejects wrong or unknown credentials', async () => {
  const email = DEMO_USERS[0].email;
  for (const saved of [FIXED_HASH, hashPassword(FIXED_PASSWORD), await hashPasswordAsync(FIXED_PASSWORD)]) {
    await pool.query('UPDATE users SET password_hash=$2 WHERE email=$1', [email, saved]);
    assert.equal((await login(pool, email, FIXED_PASSWORD)).actor.email, email);
    await assert.rejects(login(pool, email, FIXED_PASSWORD + 'x'), refused(401));
    await assert.rejects(login(pool, email, DEMO_PASSWORD), refused(401));
  }
  // Unknown emails run the lazy dummy comparison and never authenticate.
  for (const password of [FIXED_PASSWORD, DEMO_PASSWORD, '']) await assert.rejects(login(pool, 'nobody@local.test', password), refused(401));
  assert.equal((await login(pool, DEMO_USERS[1].email, DEMO_PASSWORD)).actor.email, DEMO_USERS[1].email);
});
