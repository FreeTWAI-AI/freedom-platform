import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Policy grant tests require explicit isolated TEST_DATABASE_URL.');
const prefix = `fp_policy_acl_${process.pid}_${Date.now()}`;
const schema = prefix, migrator = `${prefix}_migrator`, runtime = `${prefix}_app`, inherited = `${prefix}_parent`;
const admin = new Pool({ connectionString });
const owner = new Pool({ connectionString, options: `-c role=${migrator} -c search_path=${schema} -c statement_timeout=10000` });
let created = false;
let grantQuery: string, checkQuery: string;
before(async () => {
  // Execute the real template's SQL generator, with only fixture identifiers
  // substituted. This is not a psql interpreter or proof of the private helper.
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  grantQuery = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const check = await readFile(new URL('../../deploy/cloudflare/sql/30-verify-readonly.psql', import.meta.url), 'utf8');
  checkQuery = check.split("-- BEGIN PRIVATE POLICY READBACK\n")[1].split("\n-- END PRIVATE POLICY READBACK")[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  await admin.query(`CREATE ROLE ${migrator} NOLOGIN; CREATE ROLE ${runtime} NOLOGIN; CREATE ROLE ${inherited} NOLOGIN;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime},${inherited}`);
  created = true;
  await migrate(owner);
});
after(async () => {
  await owner.end();
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${inherited},${migrator}`);
  await admin.end();
});
async function grant(q: PoolClient) {
  const statements = await q.query(grantQuery);
  assert.equal(statements.rowCount, 2);
  for (const row of statements.rows) await q.query(Object.values(row)[0] as string);
}
async function transaction(run: (q: PoolClient) => Promise<void>) {
  const q = await owner.connect();
  try { await q.query('BEGIN'); await run(q); } finally { await q.query('ROLLBACK'); q.release(); }
}
const denied = (error: unknown) => (error as { code?: string }).code === '42501';
const unsafe = (error: unknown) => (error as Error).message === 'Unsafe runtime private policy privileges';

test('POLICY-ACL-01 real template clears old table/column ACLs and allows row locking, not policy changes', async () => {
  await transaction(async q => {
    await q.query(`GRANT ALL PRIVILEGES ON private_work_persistence_policy TO ${runtime};
      GRANT UPDATE(revision),INSERT(purpose),SELECT(scope_id) ON private_work_persistence_policy TO ${runtime} WITH GRANT OPTION`);
    await grant(q); await grant(q); // Reapplying the post-restore fence is safe.
    assert.deepEqual((await q.query(checkQuery)).rows, [{ private_policy_read: true, private_policy_lock: true, private_policy_unsafe: false }, { private_policy_read: true, private_policy_lock: true, private_policy_unsafe: false }]);
    await q.query(`SET LOCAL ROLE ${runtime}`);
    await q.query('SELECT revision,persistence_allowed FROM private_work_persistence_policy FOR SHARE');
    for (const sql of ['UPDATE private_work_persistence_policy SET persistence_allowed=true',
      'UPDATE private_work_persistence_policy SET scope_kind=DEFAULT,revision=2',
      'INSERT INTO private_work_persistence_policy DEFAULT VALUES', 'DELETE FROM private_work_persistence_policy',
      'TRUNCATE private_work_persistence_policy']) {
      await q.query('SAVEPOINT denied_write');
      await assert.rejects(q.query(sql), denied);
      await q.query('ROLLBACK TO SAVEPOINT denied_write');
    }
  });
});
test('POLICY-ACL-02 absent pre-085 table emits no grant, and is not reported safe', async () => {
  await transaction(async q => {
    await q.query('ALTER TABLE private_work_persistence_policy RENAME TO policy_not_yet_present; ALTER TABLE model_inference_export_policy RENAME TO export_not_yet_present');
    assert.equal((await q.query(grantQuery)).rowCount, 0);
    assert.equal((await q.query(checkQuery)).rowCount, 0);
  });
});
for (const [name, privilege] of [['table update', 'UPDATE'], ['column revision update', 'UPDATE(revision)'],
  ['column insert', 'INSERT(purpose)'], ['delegable read', 'SELECT WITH GRANT OPTION']] as const) {
  test(`POLICY-ACL inherited ${name} aborts the migrator transaction`, async () => {
    // Role membership is fixture administration, not part of application grants.
    await admin.query(`GRANT ${inherited} TO ${runtime}`);
    try {
      await transaction(async q => {
        const clause = privilege.endsWith(' WITH GRANT OPTION') ? 'SELECT' : privilege;
        await q.query(`GRANT ${clause} ON private_work_persistence_policy TO ${inherited}${privilege.endsWith(' WITH GRANT OPTION') ? ' WITH GRANT OPTION' : ''}`);
        await assert.rejects(grant(q), unsafe);
      });
    } finally { await admin.query(`REVOKE ${inherited} FROM ${runtime}`); }
  });
}
test('POLICY-ACL-07 PUBLIC write privilege cannot be hidden by revoking direct app grants', async () => {
  await transaction(async q => {
    await q.query('GRANT UPDATE ON private_work_persistence_policy TO PUBLIC');
    await assert.rejects(grant(q), unsafe);
  });
});
test('POLICY-ACL-08 lock column must remain a generated personal constant', async () => {
  await transaction(async q => {
    await q.query('ALTER TABLE private_work_persistence_policy ALTER COLUMN scope_kind DROP EXPRESSION');
    assert.equal((await q.query(checkQuery)).rows[0].private_policy_unsafe, true);
    await assert.rejects(grant(q), unsafe);
  });
});
for (const [label, options] of [['SET-only', 'INHERIT FALSE, SET TRUE'], ['ADMIN-only', 'INHERIT FALSE, SET FALSE, ADMIN TRUE']] as const) {
  test(`POLICY-ACL ${label} membership cannot bypass dedicated runtime role restriction`, async () => {
    await admin.query(`GRANT ${inherited} TO ${runtime} WITH ${options}`);
    try {
      await transaction(async q => {
        await q.query(`GRANT UPDATE ON private_work_persistence_policy TO ${inherited}`);
        assert.equal((await q.query(`SELECT has_table_privilege('${runtime}','private_work_persistence_policy','UPDATE') AS direct`)).rows[0].direct, false);
        assert.equal((await q.query(checkQuery)).rows[0].private_policy_unsafe, true);
        await assert.rejects(grant(q), unsafe);
      });
    } finally { await admin.query(`REVOKE ${inherited} FROM ${runtime}`); }
  });
}
test('POLICY-ACL role administration capability is not a policy reader', async () => {
  await admin.query(`ALTER ROLE ${runtime} CREATEROLE`);
  try {
    await transaction(async q => {
      assert.equal((await q.query(checkQuery)).rows[0].private_policy_unsafe, true);
      await assert.rejects(grant(q), unsafe);
    });
  } finally { await admin.query(`ALTER ROLE ${runtime} NOCREATEROLE`); }
});
