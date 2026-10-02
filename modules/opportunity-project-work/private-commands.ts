import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import type { MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { checkVersion } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';

const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(v => !/[\r\n]/.test(v));
const version = z.string().refine(v => /^[1-9][0-9]{0,18}$/.test(v) && !/[\r\n]/.test(v) && BigInt(v) <= 9223372036854775807n);
const plaintext = (maximumBytes: number) => z.string().refine(v => v.trim().length > 0 && Buffer.byteLength(v) <= maximumBytes
  && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uD800-\uDFFF]/u.test(v));
const title = plaintext(480).pipe(z.string().max(120));
const objective = plaintext(16 * 1024);
const createInput = z.object({ key, title, objective }).strict();
const archiveInput = z.object({ key, workId: OpaqueId, expectedVersion: version.optional() }).strict();
const updateInput = archiveInput.extend({ title, objective });
export type PrivateWorkCreateInput = z.infer<typeof createInput>;
export type PrivateWorkUpdateInput = z.infer<typeof updateInput>;
export type PrivateWorkArchiveInput = z.infer<typeof archiveInput>;
export interface PrivateWorkPolicy {
  readonly revision: string;
  readonly platformPersistenceAllowed: boolean;
}
export interface PrivateWorkDependencies {
  /** Trusted DB-only policy source, not caller JSON. Lock mutable policy rows
   * until commit, after the target Work lock; never invoke network I/O here. */
  readonly resolvePolicy: (q: PoolClient, context: MemberScopeContext) => Promise<PrivateWorkPolicy>;
}
interface Work { work_item_id: string; aggregate_version: string; state: 'draft' | 'archived' }
const receipt = (work: Work) => ({ workId: work.work_item_id, aggregateVersion: work.aggregate_version, state: work.state });

/** CLOSED server-only human draft commands. No HTTP registration, execution,
 * model/Grant, Result, share, restore, erase, or community fact production. */
export function createPrivateWorkCommands(pool: Pool, dependencies: PrivateWorkDependencies) {
  const resolvePolicy = dependencies.resolvePolicy;
  requireCondition(typeof resolvePolicy === 'function', 500, 'private_work_policy_required', '私人工作政策尚未設定。');
  async function eligible(q: PoolClient, actor: Actor) {
    const result = await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id]);
    requireCondition(result.rowCount === 1, 403, 'onboarding_required', '請先完成加入。');
  }
  async function persistence(q: PoolClient, context: MemberScopeContext) {
    const value = await resolvePolicy(q, context);
    requireCondition(value?.platformPersistenceAllowed === true && typeof value.revision === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.revision) && !/[\r\n]/.test(value.revision),
    403, 'private_work_persistence_denied', '目前政策不允許儲存私人工作內容。');
  }
  async function lockWork(q: PoolClient, context: MemberScopeContext, actor: Actor, id: string): Promise<Work> {
    await eligible(q, actor);
    const row = (await q.query<Work>(`SELECT work_item_id,aggregate_version,state FROM work_items
      WHERE work_item_id=$1 AND work_mode='personal_execution' AND owner_ref=$2 AND owner_principal_id=$3 AND scope_id=$4 FOR UPDATE`,
    [id, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id])).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這個工作。');
    return row;
  }
  async function record(q: PoolClient, context: MemberScopeContext, work: Work, operation: string) {
    await scopedJournal(q, context, { aggregate_type: 'private_work', id: work.work_item_id,
      version: work.aggregate_version, operation, data: { state: work.state }, eventType: 'freedom.work.private.changed.v1' });
    return receipt(work);
  }
  async function create(actor: Actor, raw: PrivateWorkCreateInput) {
    actor = Object.freeze({ ...actor });
    const input = createInput.parse(raw), operation = 'work.private.create';
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'private_work_collection', id: actor.user_id }, body: { title: input.title, objective: input.objective } },
    async (q, context) => { await eligible(q, actor); await persistence(q, context); }, async (q, context) => {
      const work = (await q.query<Work>(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
        VALUES($1,'personal_execution',$2,$3,$4,$5,$6,'draft',NULL) RETURNING work_item_id,aggregate_version,state`,
      [randomUUID(), context.scope.scope_id, context.subject_principal.principal_id, actor.user_id, input.title, input.objective])).rows[0];
      return record(q, context, work, operation);
    });
  }
  async function update(actor: Actor, raw: PrivateWorkUpdateInput) {
    actor = Object.freeze({ ...actor });
    const input = updateInput.parse(raw), operation = 'work.private.update'; let work!: Work;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key, expected: input.expectedVersion,
      target: { kind: 'private_work', id: input.workId }, body: { title: input.title, objective: input.objective } },
    async (q, context) => {
      work = await lockWork(q, context, actor, input.workId);
      requireCondition(work.state === 'draft', 409, 'private_work_archived', '這個工作已封存。');
      await persistence(q, context);
    }, async (q, context) => {
      checkVersion(work.aggregate_version, input.expectedVersion);
      const updated = (await q.query<Work>(`UPDATE work_items SET title=$2,objective=$3,aggregate_version=aggregate_version+1
        WHERE work_item_id=$1 AND state='draft' AND aggregate_version=$4 RETURNING work_item_id,aggregate_version,state`,
      [input.workId, input.title, input.objective, input.expectedVersion])).rows[0];
      requireCondition(updated, 412, 'version_conflict', '資料已更新，請重新整理後再操作。');
      return record(q, context, updated, operation);
    });
  }
  async function archive(actor: Actor, raw: PrivateWorkArchiveInput) {
    actor = Object.freeze({ ...actor });
    const input = archiveInput.parse(raw), operation = 'work.private.archive'; let work!: Work;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key, expected: input.expectedVersion,
      target: { kind: 'private_work', id: input.workId }, body: {} },
    async (q, context) => { work = await lockWork(q, context, actor, input.workId); }, async (q, context) => {
      checkVersion(work.aggregate_version, input.expectedVersion);
      requireCondition(work.state === 'draft', 409, 'private_work_archived', '這個工作已封存。');
      const archived = (await q.query<Work>(`UPDATE work_items SET state='archived',aggregate_version=aggregate_version+1
        WHERE work_item_id=$1 AND state='draft' AND aggregate_version=$2 RETURNING work_item_id,aggregate_version,state`, [input.workId, input.expectedVersion])).rows[0];
      requireCondition(archived, 412, 'version_conflict', '資料已更新，請重新整理後再操作。');
      return record(q, context, archived, operation);
    });
  }
  return Object.freeze({ create, update, archive });
}
