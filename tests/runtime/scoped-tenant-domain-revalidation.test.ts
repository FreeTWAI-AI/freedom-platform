import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createTenantLifecycleAuthority } from '../../modules/assets/tenant-lifecycle-authority.js';
import { scopedTenantCommand } from '../../packages/scoped-commands/index.js';
import type { TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { migrate } from '../../scripts/database.js';

const connectionString = process.env.TEST_DATABASE_URL;
assert(connectionString, 'TEST_DATABASE_URL is required for tenant domain revalidation tests');
assert.match(new URL(connectionString).pathname, /^\/fp_[a-z0-9_]+$/);
const schema = `fp_tenant_revalidate_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString, max: 2 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
const community = '10000000-0000-4000-8000-000000000011';
const target = '30000000-0000-4000-8000-000000000011';
const operation = 'fixture.tenant.revalidate';
const capabilitiesForRole = () => [] as readonly string[];
let created = false;

before(async () => {
  assert.match(schema, /^fp_tenant_revalidate_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await migrate(pool);
  await pool.query('CREATE TABLE fixture_domain_gate(id integer PRIMARY KEY)');
  await pool.query('INSERT INTO fixture_domain_gate VALUES(1)');
  await pool.query(`CREATE TABLE fixture_domain_effects(scope_id uuid PRIMARY KEY REFERENCES resource_scopes,
    version bigint NOT NULL DEFAULT 1)`);
});
after(async () => {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Synthetic tenant revalidation']);
});

async function tenantMember(): Promise<{ actor: Actor; tenantId: string; scopeId: string }> {
  const id = randomUUID();
  const email = `tenant-revalidate-${id}@example.test`;
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic','not-a-login-hash',$4) RETURNING *`,
  [id, community, email, randomUUID()])).rows[0];
  const session_hash = randomUUID();
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session_hash, id]);
  const actor: Actor = { ...row, session_hash, csrf_token: 'synthetic' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const principalId = (await client.query<{ principal_id: string }>('INSERT INTO principals(user_ref) VALUES($1) RETURNING principal_id', [id])).rows[0].principal_id;
    const tenantId = (await client.query<{ tenant_id: string }>(`INSERT INTO tenants(community_id,display_name,created_by_principal_id)
      VALUES($1,'Synthetic tenant',$2) RETURNING tenant_id`, [community, principalId])).rows[0].tenant_id;
    const scopeId = (await client.query<{ scope_id: string }>(`INSERT INTO resource_scopes(kind,tenant_ref) VALUES('tenant',$1) RETURNING scope_id`, [tenantId])).rows[0].scope_id;
    await client.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
      VALUES($1,$2,'owner','active',clock_timestamp())`, [tenantId, principalId]);
    await client.query('INSERT INTO fixture_domain_effects(scope_id) VALUES($1)', [scopeId]);
    await client.query('COMMIT');
    return { actor, tenantId, scopeId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function commandInput(actor: Actor, tenantId: string, key: string) {
  return {
    actor, tenantId, operation, key, body: { fixture: 'tenant-revalidate' },
    target: { kind: 'fixture_domain', id: target }, expected: '1', capabilitiesForRole,
  };
}

async function effects(scopeId: string) {
  return (await pool.query<{ version: number; receipts: number }>(`SELECT
    (SELECT version::int FROM fixture_domain_effects WHERE scope_id=$1) AS version,
    (SELECT count(*)::int FROM scoped_command_receipts WHERE scope_id=$1 AND operation=$2) AS receipts`,
  [scopeId, operation])).rows[0];
}

async function blockedBy(holder: number, waiter: number) {
  for (let count = 0; count < 150; count++) {
    const waiting = (await admin.query('SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS yes', [holder, waiter])).rows[0].yes;
    if (waiting) return;
    await delay(20);
  }
  assert.fail('Actual PostgreSQL receipt-step row lock wait was not observed');
}

test('a tenant command with no hooks still commits its domain write and success receipt', async () => {
  const { actor, tenantId, scopeId } = await tenantMember();
  const key = `plain-${randomUUID()}`;
  const input = commandInput(actor, tenantId, key);
  const first = await scopedTenantCommand(pool, input, async () => {}, async (q, context) => {
    const row = (await q.query('UPDATE fixture_domain_effects SET version=version+1 WHERE scope_id=$1 RETURNING version::text', [context.scope.scope_id])).rows[0];
    return { version: row.version as string };
  });
  assert.deepEqual(first, { version: '2' });
  assert.deepEqual(await effects(scopeId), { version: 2, receipts: 1 });
  let rerun = 0;
  const replay = await scopedTenantCommand(pool, input, async () => {}, async () => {
    rerun += 1;
    return { version: '9' };
  });
  assert.equal(rerun, 0);
  assert.deepEqual(replay, { version: '2' });
  assert.deepEqual(await effects(scopeId), { version: 2, receipts: 1 });
});

test('a non-function tenant hook is rejected before any command work', async () => {
  const input = commandInput({ user_id: target, community_id: community, email: 'synthetic@example.test', display_name: 'Synthetic',
    profession_membership_ref: target, session_hash: 'synthetic-session', csrf_token: 'synthetic' }, target, 'not-a-function');
  for (const hooks of [[ 'nope', undefined ], [ undefined, 'nope' ]] as const) {
    await assert.rejects(scopedTenantCommand(pool, input, async () => {}, async () => ({ version: '2' }),
      hooks[0] as never, hooks[1] as never),
    (error: unknown) => error instanceof Problem && error.status === 400 && error.code === 'invalid_scoped_command');
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scoped_command_receipts')).rows[0].n, 0);
});

async function waitCase(kind: 'revalidate' | 'clock') {
  const { actor, tenantId, scopeId } = await tenantMember();
  const blocker = await pool.connect();
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let reject = false;
  let current = true;
  let wrote = false;
  let waiter = 0;
  await blocker.query('BEGIN');
  try {
    const holder = Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await blocker.query('SELECT id FROM fixture_domain_gate WHERE id=1 FOR UPDATE');
    const revalidate = async (q: PoolClient, context: TenantScopeContext) => {
      assert.equal(context.tenant_id, tenantId);
      if (!wrote) return;
      waiter = Number((await q.query('SELECT pg_backend_pid() pid')).rows[0].pid);
      entered();
      await q.query('SELECT id FROM fixture_domain_gate WHERE id=1 FOR UPDATE');
      if (kind === 'revalidate') requireCondition(!reject, 403, 'fixture_domain_expired', 'Synthetic domain authority expired.');
    };
    const assertCurrentTime = () => requireCondition(current, 403, 'fixture_clock_expired', 'Synthetic domain authority expired.');
    const pending = createTenantLifecycleAuthority().command(pool, {
      actor: { ...actor, tenant_id: tenantId }, scope: 'personal', operation, key: `wait-${kind}-${randomUUID()}`,
      body: { fixture: kind }, target: { kind: 'fixture_domain', id: target }, expected: '1',
    }, async () => {}, async (q, context) => {
      const row = (await q.query('UPDATE fixture_domain_effects SET version=version+1 WHERE scope_id=$1 RETURNING version::text', [context.scope.scope_id])).rows[0];
      wrote = true;
      return { version: row.version as string };
    }, revalidate, kind === 'clock' ? assertCurrentTime : undefined);
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof Problem && error.status === 403
      && error.code === (kind === 'revalidate' ? 'fixture_domain_expired' : 'fixture_clock_expired'));
    void rejected.catch(() => {});
    await enteredPromise;
    await blockedBy(holder, waiter);
    if (kind === 'revalidate') reject = true;
    else current = false;
    await blocker.query('COMMIT');
    await rejected;
    assert.equal(wrote, true);
    assert.deepEqual(await effects(scopeId), { version: 1, receipts: 0 });
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
}

test('a profile revalidate that starts rejecting during the receipt-step wait rolls the tenant command back', { timeout: 30_000 }, async () => {
  await waitCase('revalidate');
});

test('assertCurrentTime that starts throwing during the receipt-step wait rolls the tenant command back', { timeout: 30_000 }, async () => {
  await waitCase('clock');
});
