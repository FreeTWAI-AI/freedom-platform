import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export function reconcileDedupeKey(repositoryId: string, number: number): string {
  return `reconcile_pull:${repositoryId}:${number}`;
}

/** Insert a queued reconcile, or pull an existing queued job's run_after forward. Attempts stay put. */
export async function enqueueReconcilePull(db: Queryable, repositoryId: string, number: number, runAfter: Date): Promise<boolean> {
  const inserted = await db.query(
    `INSERT INTO maintainer_jobs (job_id, repository_id, kind, dedupe_key, payload, state, attempts, max_attempts, run_after)
     VALUES ($1, $2, 'reconcile_pull', $3, $4::jsonb, 'queued', 0, 5, $5)
     ON CONFLICT (dedupe_key) WHERE state = 'queued'
     DO UPDATE SET run_after = EXCLUDED.run_after, updated_at = now()
     WHERE maintainer_jobs.run_after > EXCLUDED.run_after`,
    [randomUUID(), repositoryId, reconcileDedupeKey(repositoryId, number), JSON.stringify({ number }), runAfter],
  );
  return inserted.rowCount === 1;
}

export type MaintainerJobKind = 'request_reviewer' | 'remove_reviewer_request';

export function reviewerJobDedupeKey(kind: MaintainerJobKind, claimId: string): string {
  return `${kind}:${claimId}`;
}

/** Insert a queued claim job, or pull an existing queued job's run_after forward. Attempts stay put. */
export async function enqueueMaintainerJob(db: Queryable, repositoryId: string, kind: MaintainerJobKind, claimId: string, runAfter: Date): Promise<boolean> {
  const inserted = await db.query(
    `INSERT INTO maintainer_jobs (job_id, repository_id, kind, dedupe_key, payload, state, attempts, max_attempts, run_after)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', 0, 5, $6)
     ON CONFLICT (dedupe_key) WHERE state = 'queued'
     DO UPDATE SET run_after = EXCLUDED.run_after, updated_at = now()
     WHERE maintainer_jobs.run_after > EXCLUDED.run_after`,
    [randomUUID(), repositoryId, kind, reviewerJobDedupeKey(kind, claimId), JSON.stringify({ claim_id: claimId }), runAfter],
  );
  return inserted.rowCount === 1;
}
