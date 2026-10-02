import type { Pool, PoolClient } from 'pg';

// Preserve the existing transaction/release semantics for all legacy callers.
export async function transaction<T>(pool: Pool, run: (q: PoolClient) => Promise<T>): Promise<T> {
  const q = await pool.connect();
  try { await q.query('BEGIN'); const result = await run(q); await q.query('COMMIT'); return result; }
  catch (error) { await q.query('ROLLBACK'); throw error; }
  finally { q.release(); }
}
