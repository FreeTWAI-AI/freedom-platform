// Transaction-port unit evidence only: these tests never connect to a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { readMigrationSources } from '../../packages/db/migration-files.mjs';
import { legacyMigrationProfile, resolveMigrationPlan } from '../../packages/db/migration-plan.mjs';

const root = new URL('../../', import.meta.url);
const sources = readMigrationSources(fileURLToPath(new URL('migrations/', root)));
const profile = legacyMigrationProfile(JSON.parse(readFileSync(new URL('deploy/cloudflare/environments.json', root), 'utf8')).database_defaults.migrations);
const expected = resolveMigrationPlan(sources, profile);
function fakePool(applied: { name: string; sha256: string }[], failSql?: string) {
  const ledger = structuredClone(applied);
  const calls: { text: string; values?: unknown[] }[] = []; let released = false;
  const q = { async query(text: string, values?: unknown[]) {
    calls.push({ text, values });
    if (text === failSql) throw new Error('synthetic SQL failure');
    if (text.startsWith('INSERT INTO schema_migrations')) ledger.push({name:values![0] as string,sha256:values![1] as string});
    return { rows: text === 'SELECT name,sha256 FROM schema_migrations ORDER BY name LIMIT 4097' ? structuredClone(ledger).sort((a,b)=>a.name<b.name?-1:1) : [] };
  }, release() { released = true; } };
  return { pool: { connect: async () => q } as unknown as Pool, calls, released: () => released };
}
test('repo runner observes the entire applied ledger and retains transaction/lock/SQL/digest order', async () => {
  const prior = expected.ledger.slice(0, 2).map(e => ({ ...e })), f = fakePool(prior);
  await migrate(f.pool);
  assert.equal(f.calls[0].text, 'BEGIN'); assert.equal(f.calls[1].text, 'SELECT pg_advisory_xact_lock(2026092000)');
  assert.equal(f.calls.at(-1)?.text, 'COMMIT'); assert.equal(f.released(), true);
  assert.equal(f.calls.filter(c => c.text.startsWith('SELECT name,sha256')).length, 2);
  assert.equal(f.calls.filter(c => c.text.startsWith('SELECT sha256 WHERE')).length, 0);
  const inserts = f.calls.filter(c => c.text.startsWith('INSERT INTO schema_migrations'));
  assert.deepEqual(inserts.map(c => c.values), expected.ledger.slice(2).map(e => [e.name, e.sha256]));
  for (const c of inserts) assert.equal(f.calls[f.calls.indexOf(c) - 1].text, expected.sql[c.values![0] as string]);
});
test('unknown and missing-dependency restored ledger fail closed before any migration SQL', async () => {
  for (const rows of [[{ name: '999_unknown.sql', sha256: 'f'.repeat(64) }], [{ ...expected.ledger[1] }], [{ ...expected.ledger[0], sha256: 'f'.repeat(64) }]]) {
    const f = fakePool(rows); await assert.rejects(migrate(f.pool));
    assert.equal(f.calls.at(-1)?.text, 'ROLLBACK'); assert.equal(f.released(), true);
    assert.equal(f.calls.some(c => c.text.startsWith('INSERT INTO schema_migrations')), false);
    assert.equal(f.calls.some(c => Object.values(expected.sql).includes(c.text)), false);
  }
});
test('complete legacy ledger is a no-op and SQL failure rolls back before ledger insertion', async () => {
  const done = fakePool(expected.ledger.map(e => ({ ...e }))); await migrate(done.pool);
  assert.equal(done.calls.some(c => c.text.startsWith('INSERT INTO schema_migrations')), false);
  const failed = fakePool([], expected.sql[expected.pending[0]]); await assert.rejects(migrate(failed.pool), /synthetic SQL failure/);
  assert.equal(failed.calls.at(-1)?.text, 'ROLLBACK'); assert.equal(failed.calls.some(c => c.text.startsWith('INSERT INTO schema_migrations')), false);
});
