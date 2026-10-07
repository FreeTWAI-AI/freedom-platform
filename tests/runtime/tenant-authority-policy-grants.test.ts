import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Explicit isolated TEST_DATABASE_URL required');
const schema = `fp_ta_${process.pid}_${Date.now()}`;
const migrator = `${schema}_owner`, runtime = `${schema}_app`, parent = `${schema}_parent`;
const admin = new Pool({ connectionString: url });
const owner = new Pool({ connectionString: url, options: `-c role=${migrator} -c search_path=${schema}` });
let created = false, query = '';
before(async () => {
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  query = template.split('-- BEGIN TENANT AUTHORITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replaceAll("n.nspname='public'", `n.nspname='${schema}'`);
  await admin.query(`CREATE ROLE ${migrator} NOLOGIN; CREATE ROLE ${runtime} NOLOGIN; CREATE ROLE ${parent} NOLOGIN; CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created = true;
  await migrate(owner);
});
after(async () => {
  await owner.end();
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime}, ${parent}, ${migrator}`);
  await admin.end();
});
async function grant(q: PoolClient) {
  await q.query('SET LOCAL statement_timeout = 10000');
  const rows = (await q.query(query)).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) await q.query(Object.values(row)[0] as string);
}
async function transaction(run: (q: PoolClient) => Promise<void>) {
  const q = await owner.connect();
  try { await q.query('BEGIN'); await run(q); } finally { await q.query('ROLLBACK'); q.release(); }
}
const denied = (error: unknown) => (error as { code?: string }).code === '42501';
const unsafe = (error: unknown) => (error as Error).message === 'Unsafe runtime tenant authority policy privileges';

test('runtime can read tenant authority rows and lock policy_lock, and cannot write either table', async () => {
  await transaction(async q => {
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime}`);
    await q.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
      VALUES (1,'active',600,86400,86400,1)`);
    await grant(q);
    await grant(q);
    await q.query(`SET LOCAL ROLE ${runtime}`);
    assert.equal((await q.query(`SELECT count(*)::int AS n FROM tenant_authority_policies`)).rows[0].n, 1);
    assert.equal((await q.query(`SELECT count(*)::int AS n FROM platform_admin_tenant_recovery_capabilities`)).rows[0].n, 0);
    await q.query('SELECT policy_id FROM tenant_authority_policies FOR SHARE');
    await q.query('UPDATE tenant_authority_policies SET policy_lock=DEFAULT');
    for (const sql of [
      `UPDATE tenant_authority_policies SET status='retired'`,
      `INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant) VALUES (2,'retired',600,86400,86400,1)`,
      `DELETE FROM tenant_authority_policies`,
      `INSERT INTO platform_admin_tenant_recovery_capabilities(admin_id,capability) VALUES ('00000000-0000-4000-8000-000000000001','tenant.recovery.read')`,
      `UPDATE platform_admin_tenant_recovery_capabilities SET revoked_at=now()`,
      `DELETE FROM platform_admin_tenant_recovery_capabilities`,
    ]) {
      await q.query('SAVEPOINT denied');
      await assert.rejects(q.query(sql), denied, sql);
      await q.query('ROLLBACK TO SAVEPOINT denied');
    }
  });
});

test('runtime can lock a recovery capability and still cannot write it', async () => {
  await transaction(async q => {
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime}`);
    const adminId = '00000000-0000-4000-8000-0000000000a1';
    await q.query(`INSERT INTO communities(community_id, name) VALUES ('00000000-0000-4000-8000-0000000000c1', '合成社區')`);
    await q.query(`INSERT INTO platform_admins(admin_id, community_id, email, display_name) VALUES ($1, '00000000-0000-4000-8000-0000000000c1', 'recovery-lock@example.test', '復原鎖')`, [adminId]);
    await q.query(`INSERT INTO platform_admin_tenant_recovery_capabilities(admin_id, capability) VALUES ($1, 'tenant.recovery.open')`, [adminId]);
    await grant(q);
    await grant(q);
    await q.query(`SET LOCAL ROLE ${runtime}`);
    const locked = await q.query(`SELECT capability_id FROM platform_admin_tenant_recovery_capabilities
      WHERE admin_id=$1 AND capability=$2 AND revoked_at IS NULL
      ORDER BY capability_id
      FOR SHARE`, [adminId, 'tenant.recovery.open']);
    assert.equal(locked.rowCount, 1);
    await q.query('UPDATE platform_admin_tenant_recovery_capabilities SET capability_lock=DEFAULT');
    for (const sql of [
      `INSERT INTO platform_admin_tenant_recovery_capabilities(admin_id,capability) VALUES ('00000000-0000-4000-8000-000000000001','tenant.recovery.read')`,
      `UPDATE platform_admin_tenant_recovery_capabilities SET revoked_at=now()`,
      `DELETE FROM platform_admin_tenant_recovery_capabilities`,
    ]) {
      await q.query('SAVEPOINT denied');
      await assert.rejects(q.query(sql), denied, sql);
      await q.query('ROLLBACK TO SAVEPOINT denied');
    }
  });
});

test('a public column grant on the authority policy is rejected', async () => {
  await transaction(async q => {
    await q.query('GRANT UPDATE(revision) ON tenant_authority_policies TO PUBLIC');
    await assert.rejects(grant(q), unsafe);
  });
});

test('a public column grant on the recovery capability is rejected', async () => {
  await transaction(async q => {
    await q.query('GRANT UPDATE(revoked_at) ON platform_admin_tenant_recovery_capabilities TO PUBLIC');
    await assert.rejects(grant(q), unsafe);
  });
});

test('runtime role membership is rejected before the authority fence is applied', async () => {
  await admin.query(`GRANT ${parent} TO ${runtime}`);
  try {
    await transaction(async q => { await assert.rejects(grant(q), unsafe); });
  } finally {
    await admin.query(`REVOKE ${parent} FROM ${runtime}`);
  }
});
