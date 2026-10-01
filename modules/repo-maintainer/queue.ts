import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export function reconcileDedupeKey(repositoryId: string, number: number): string {
  return `reconcile_pull:${repositoryId}:${number}`;
}

/** Insert a queued reconcile. A queued job with the same key is left untouched. */
export async function enqueueReconcilePull(db: Queryable, repositoryId: string, number: number, runAfter: Date): Promise<boolean> {
  const inserted = await db.query(
    `INSERT INTO maintainer_jobs (job_id, repository_id, kind, dedupe_key, payload, state, attempts, max_attempts, run_after)
     VALUES ($1, $2, 'reconcile_pull', $3, $4::jsonb, 'queued', 0, 5, $5)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), repositoryId, reconcileDedupeKey(repositoryId, number), JSON.stringify({ number }), runAfter],
  );
  return inserted.rowCount === 1;
}
