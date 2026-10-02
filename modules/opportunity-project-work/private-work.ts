import { z } from 'zod';
import type { Pool } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { requireCondition } from '../../packages/shared/problem.js';

const pageNumber = (maximum: number, fallback: number) => z.string().regex(/^(0|[1-9][0-9]*)$/)
  .transform(Number).pipe(z.number().int().min(fallback === 0 ? 0 : 1).max(maximum)).default(fallback);
export const privateWorkQuery = z.object({
  q: z.string().trim().max(120).default(''),
  limit: pageNumber(50, 20), offset: pageNumber(10000, 0),
}).strict();
// PostgreSQL jsonb numeric would otherwise coerce bigint into a lossy JS number.
const fields = 'work_item_id,title,objective,state,aggregate_version::text AS aggregate_version,created_at';

/** Read-only projection. The trusted scope and principal are always resolved
 * from the current session, never accepted from a request or cached receipt. */
export async function listPrivateWork(pool: Pool, actor: Actor, query: unknown) {
  const page = privateWorkQuery.parse(query);
  return withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (q, context) => {
    await q.query("SET LOCAL statement_timeout='5s'");
    // One statement keeps page and count on the same snapshot. Search is a
    // literal substring, not caller-provided LIKE syntax or a SQL expression.
    const result = (await q.query(`WITH visible AS MATERIALIZED (
      SELECT ${fields} FROM work_items WHERE work_mode='personal_execution'
        AND owner_ref=$1 AND owner_principal_id=$2 AND scope_id=$3
        AND strpos(lower(title),lower($4))>0
    ), page AS (SELECT * FROM visible ORDER BY created_at DESC,work_item_id DESC LIMIT $5 OFFSET $6)
    SELECT (SELECT count(*)::int FROM visible) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,work_item_id DESC) FROM page),'[]'::jsonb) AS items`,
    [actor.user_id, context.subject_principal.principal_id, context.scope.scope_id, page.q, page.limit, page.offset])).rows[0];
    return { ...result, limit: page.limit, offset: page.offset };
  });
}

export async function readPrivateWork(pool: Pool, actor: Actor, id: string) {
  id = z.uuid().parse(id);
  // Authorization and row lock are in the same transaction as current
  // session/principal/scope locks. No admin/guild privilege is consulted.
  let work: Record<string, unknown> | undefined;
  return withMemberScope(pool, { actor, scope: 'personal' }, async (q, context) => {
    work = (await q.query(`SELECT ${fields} FROM work_items WHERE work_item_id=$1
      AND work_mode='personal_execution' AND owner_ref=$2 AND owner_principal_id=$3 AND scope_id=$4 FOR SHARE`,
    [id, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id])).rows[0];
    requireCondition(work, 404, 'not_found', '找不到這個工作。');
  }, async () => work!);
}
