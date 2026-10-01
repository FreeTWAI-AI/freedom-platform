import type { PoolClient } from 'pg';

export const MAX_ACTIVE_DRAFTS = 30;

export async function lockMemberDrafts(q: PoolClient, userId: string) {
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`skill-submissions/${userId}`]);
}
