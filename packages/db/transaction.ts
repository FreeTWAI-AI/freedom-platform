import type { Pool, PoolClient } from 'pg';

type RollbackWork = (q: PoolClient) => Promise<void>;
const open = new WeakMap<PoolClient, RollbackWork[]>();

/**
 * Registers work whose effect must survive this transaction rolling back, such
 * as an external-provider attempt budget or a token the provider already
 * rotated. It runs on the same connection only after ROLLBACK, in its own
 * transaction, so it neither needs a second pool connection nor waits on locks
 * the rolled-back transaction held. A commit discards it: the work already
 * happened inside the committed transaction.
 */
export function afterRollback(q: PoolClient, work: RollbackWork) {
  const pending = open.get(q);
  if (!pending) throw new Error('after_rollback_requires_transaction');
  pending.push(work);
}

// Preserve the existing transaction/release semantics for all legacy callers.
export async function transaction<T>(pool: Pool, run: (q: PoolClient) => Promise<T>): Promise<T> {
  const q = await pool.connect(), pending: RollbackWork[] = [];
  try {
    await q.query('BEGIN'); open.set(q, pending);
    const result = await run(q); await q.query('COMMIT'); return result;
  } catch (error) {
    await q.query('ROLLBACK'); open.delete(q);
    if (pending.length) {
      // The original failure stays the caller's result; a failed replay rolls
      // back on its own without masking it.
      try { await q.query('BEGIN'); for (const work of pending) await work(q); await q.query('COMMIT'); }
      catch { await q.query('ROLLBACK').catch(() => undefined); }
    }
    throw error;
  }
  finally { open.delete(q); q.release(); }
}
