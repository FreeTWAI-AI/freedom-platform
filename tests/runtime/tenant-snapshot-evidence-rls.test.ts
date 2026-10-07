import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { collectSnapshotEvidence } from '../../packages/db/snapshot-evidence.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Snapshot evidence RLS requires explicit disposable fp_* TEST_DATABASE_URL.');
}
const stamp = `${process.pid}_${Date.now()}`;
const schema = `e1ev_${stamp}`;
const ownerRole = `e1eo_${stamp}`;
const readerRole = `e1er_${stamp}`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) {
  const url = new URL(connectionString!);
  url.username = role;
  url.password = '';
  return url.toString();
}
const owner = new Pool({ connectionString: roleUrl(ownerRole), options: `-c search_path=${schema}`, max: 1 });
const reader = new Pool({ connectionString: roleUrl(readerRole), options: `-c search_path=${schema}`, max: 1 });
let created = false;

async function snapshot(pool: Pool) {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      return await collectSnapshotEvidence(client, [{ schema, table: 'evidence_rows' }]);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}

before(async () => {
  assert.ok(ownerRole.length < 63 && readerRole.length < 63);
  await admin.query(`CREATE ROLE ${ownerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${readerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${ownerRole};
    GRANT USAGE ON SCHEMA ${schema} TO ${readerRole}`);
  created = true;
  await owner.query(`CREATE TABLE ${schema}.evidence_rows (id integer PRIMARY KEY)`);
  await owner.query(`INSERT INTO ${schema}.evidence_rows(id) VALUES (1),(2)`);
  await owner.query(`ALTER TABLE ${schema}.evidence_rows ENABLE ROW LEVEL SECURITY`);
  await owner.query(`CREATE POLICY evidence_rows_hide ON ${schema}.evidence_rows FOR SELECT TO PUBLIC USING (id = 1)`);
  await owner.query(`GRANT SELECT ON ${schema}.evidence_rows TO ${readerRole}`);
});

after(async () => {
  await reader.end();
  await owner.end();
  try {
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${readerRole}; DROP ROLE ${ownerRole}`);
  } finally {
    await admin.end();
  }
});

test('T-024 snapshot evidence fails closed for a non-owner and returns every row for the owner', async () => {
  await assert.rejects(snapshot(reader), /^Error: snapshot_evidence_unavailable$/);
  const evidence = await snapshot(owner);
  assert.equal(evidence.tables.length, 1);
  assert.equal(evidence.tables[0].count, '2');
  assert.equal(evidence.tables[0].table, 'evidence_rows');
});
