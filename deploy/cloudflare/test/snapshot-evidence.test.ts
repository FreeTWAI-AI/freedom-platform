import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { collectSnapshotEvidence } from '../../../packages/db/snapshot-evidence.js';

// Explicit isolated PostgreSQL only; no fallback to platform credentials.
const url = process.env.FREEDOM_SNAPSHOT_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/grok_snapshot_evidence_test') {
  throw new Error('Set FREEDOM_SNAPSHOT_TEST_DATABASE_URL to the isolated localhost grok_snapshot_evidence_test database.');
}

test('Grok snapshot evidence preserves complete row multiset and sequence facts on PostgreSQL', async t => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const tables = [{ schema: 'fixture', table: 'records' }];
  async function snapshot(selected = tables, settings = '') {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      if (settings) await client.query(settings);
      return await collectSnapshotEvidence(client, selected);
    } finally { await client.query('ROLLBACK'); }
  }
  try {
    await client.query('CREATE SCHEMA fixture');
    await client.query(`CREATE TABLE fixture.records (id bigint GENERATED ALWAYS AS IDENTITY, body text, bytes bytea, stamp timestamptz, value numeric, extra jsonb)`);
    await client.query(`INSERT INTO fixture.records(body,bytes,stamp,value,extra) VALUES ('秘密 sentinel',decode('00ff','hex'),'2026-10-04T12:00:00Z',12345678901234567890.0123,'{"a":null}'),(NULL,NULL,NULL,NULL,NULL)`);
    await client.query('CREATE TABLE fixture.empty (name text)');
    await client.query('CREATE TABLE fixture.dupes (value text)');
    await client.query(`INSERT INTO fixture.dupes VALUES ('same'),('same'),(NULL),('')`);
    await client.query('CREATE TABLE fixture."odd""; name" ("column""name" text)');
    await client.query(`INSERT INTO fixture."odd""; name" VALUES ('still secret')`);

    await t.test('stable across text format settings, raw rows absent, sequence captured', async () => {
      const first = await snapshot();
      const second = await snapshot(tables, `SET LOCAL TimeZone='Asia/Tokyo'; SET LOCAL DateStyle='SQL, DMY'; SET LOCAL bytea_output='escape'`);
      assert.deepEqual(first, second);
      assert.equal(first.tables[0].count, '2');
      assert.match(first.tables[0].fingerprint, /^[a-f0-9]{64}$/);
      assert.deepEqual(first.tables[0].sequences, [{ schema: 'fixture', name: 'records_id_seq', lastValue: '2', isCalled: true }]);
      assert(!JSON.stringify(first).includes('sentinel'));
      await client.query(`UPDATE fixture.records SET bytes=decode('00fe','hex') WHERE id=1`);
      assert.notEqual((await snapshot()).tables[0].fingerprint, first.tables[0].fingerprint);
    });
    await t.test('duplicates and null versus empty contribute to fingerprints', async () => {
      const selected = [{ schema: 'fixture', table: 'dupes' }];
      const first = await snapshot(selected);
      await client.query(`DELETE FROM fixture.dupes WHERE ctid IN (SELECT ctid FROM fixture.dupes WHERE value='same' LIMIT 1)`);
      await client.query(`INSERT INTO fixture.dupes VALUES ('')`);
      const second = await snapshot(selected);
      assert.equal(first.tables[0].count, second.tables[0].count);
      assert.notEqual(first.tables[0].fingerprint, second.tables[0].fingerprint);
    });
    await t.test('empty tables, quoted identifiers and canonical table ordering', async () => {
      const selected = [{ schema: 'fixture', table: 'odd"; name' }, { schema: 'fixture', table: 'empty' }];
      const first = await snapshot(selected);
      assert.deepEqual(first, await snapshot([...selected].reverse()));
      assert.equal(first.tables[0].count, '0');
      assert.equal(first.tables[1].columns[0].name, 'column"name');
    });
    await t.test('alias-named column cannot hide changes in other row columns', async () => {
      await client.query('CREATE TABLE fixture.alias_collision (t text, bytes bytea)');
      await client.query(`INSERT INTO fixture.alias_collision VALUES ('unchanged scalar',decode('00ff','hex'))`);
      const selected = [{ schema: 'fixture', table: 'alias_collision' }];
      const first = await snapshot(selected);
      await client.query(`UPDATE fixture.alias_collision SET bytes=decode('00fe','hex')`);
      const second = await snapshot(selected);
      assert.equal(first.tables[0].count, second.tables[0].count);
      assert.notEqual(first.tables[0].fingerprint, second.tables[0].fingerprint);
    });
    await t.test('sequence changes remain independently visible', async () => {
      const first = await snapshot();
      await client.query(`SELECT setval('fixture.records_id_seq',900,false)`);
      const second = await snapshot();
      assert.equal(first.tables[0].fingerprint, second.tables[0].fingerprint);
      assert.deepEqual(second.tables[0].sequences[0], { schema: 'fixture', name: 'records_id_seq', lastValue: '900', isCalled: false });
    });
    await t.test('requires explicit snapshot and sanitizes relation errors', async () => {
      await assert.rejects(collectSnapshotEvidence(client, tables), /^Error: snapshot_evidence_unavailable$/);
      await client.query('BEGIN READ ONLY');
      try { await assert.rejects(collectSnapshotEvidence(client, tables), /^Error: snapshot_evidence_unavailable$/); }
      finally { await client.query('ROLLBACK'); }
      await assert.rejects(snapshot([{ schema: 'fixture', table: 'missing-secret-name' }]), /^Error: snapshot_evidence_unavailable$/);
      await assert.rejects(snapshot([...tables, ...tables]), /^Error: snapshot_evidence_unavailable$/);
      await client.query("SET default_transaction_isolation='repeatable read'; SET default_transaction_read_only='on'");
      try { await assert.rejects(collectSnapshotEvidence(client, tables), /^Error: snapshot_evidence_unavailable$/); }
      finally { await client.query("SET default_transaction_read_only='off'; SET default_transaction_isolation='read committed'"); }
    });
    await t.test('row cap fails closed', async () => {
      await client.query('CREATE TABLE fixture.large AS SELECT generate_series(1,250001) AS id');
      await assert.rejects(snapshot([{ schema: 'fixture', table: 'large' }]), /^Error: snapshot_evidence_unavailable$/);
    });
  } finally {
    await client.query('DROP SCHEMA IF EXISTS fixture CASCADE');
    client.release();
    await pool.end();
  }
});
