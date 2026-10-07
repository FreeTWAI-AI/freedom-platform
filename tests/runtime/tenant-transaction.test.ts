import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';

function fakePool(options: { failCommit?: boolean; failRollback?: boolean } = {}) {
  const queries: string[] = [];
  const releases: unknown[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const client = {
    on(event: string, fn: () => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
    },
    removeListener(event: string, fn: () => void) { listeners.get(event)?.delete(fn); },
    async query(sql: string) {
      queries.push(sql);
      if (sql === 'COMMIT' && options.failCommit) throw new Error('commit failed');
      if (sql === 'ROLLBACK' && options.failRollback) throw new Error('rollback failed');
      return { rows: [] };
    },
    release(error?: Error) { releases.push(error); },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries, releases, client: client as unknown as PoolClient };
}

test('isolatedTransaction commits and releases the client once', async () => {
  const fake = fakePool();
  const value = await isolatedTransaction(fake.pool, async () => 7);
  assert.equal(value, 7);
  assert.deepEqual(fake.queries, ['BEGIN', 'COMMIT']);
  assert.deepEqual(fake.releases, [undefined]);
});

test('isolatedTransaction rolls back a callback error and keeps that error', async () => {
  const fake = fakePool();
  const original = new Error('run failed');
  await assert.rejects(isolatedTransaction(fake.pool, async () => { throw original; }), (error) => error === original);
  assert.equal(original.cause, undefined);
  assert.deepEqual(fake.queries, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(fake.releases, [undefined]);
});

test('isolatedTransaction rolls back when COMMIT throws and keeps the commit error', async () => {
  const fake = fakePool({ failCommit: true });
  await assert.rejects(isolatedTransaction(fake.pool, async () => 'ok'), /commit failed/);
  assert.deepEqual(fake.queries, ['BEGIN', 'COMMIT', 'ROLLBACK']);
  assert.deepEqual(fake.releases, [undefined]);
});

test('isolatedTransaction destroys the client when ROLLBACK throws and preserves the original error', async () => {
  const fake = fakePool({ failRollback: true });
  const original = new Error('run failed');
  await assert.rejects(isolatedTransaction(fake.pool, async () => { throw original; }), (error) => error === original);
  assert.equal((original.cause as Error).message, 'rollback failed');
  assert.deepEqual(fake.queries, ['BEGIN', 'ROLLBACK']);
  assert.equal(fake.releases.length, 1);
  assert.equal((fake.releases[0] as Error).message, 'rollback failed');
});

test('isolatedTransaction does not replace an original cause when ROLLBACK throws', async () => {
  const fake = fakePool({ failRollback: true });
  const original = new Error('run failed');
  const already = new Error('already attached');
  original.cause = already;
  await assert.rejects(isolatedTransaction(fake.pool, async () => { throw original; }), (error) => error === original);
  assert.equal(original.cause, already);
  assert.equal((fake.releases[0] as Error).message, 'rollback failed');
});
