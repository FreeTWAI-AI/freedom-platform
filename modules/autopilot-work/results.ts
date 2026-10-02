import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { objectKey, preparePrivateText, readVerifiedObject, requirePersistence, PRIVATE_TEXT_MAX_BYTES,
  type ObjectMetadata } from '../../packages/asset-storage/index.js';
import { assetCommandKey, assetVersion, createAssetLifecycle, type LifecycleDependencies, type LifecyclePolicy,
  type LifecycleTarget } from '../assets/engine.js';

const purpose = 'work.private-draft';
const prepareInput = z.object({ key: assetCommandKey, targetWorkId: z.uuid(), expectedVersion: assetVersion,
  contentType: z.enum(['text/plain', 'text/markdown']), byteSize: z.number().int().min(1).max(PRIVATE_TEXT_MAX_BYTES),
  sha256: z.string().length(64).regex(/^[0-9a-f]+$/) }).strict();
const readInput = z.object({ workId: z.uuid() }).strict();
const historyInput = readInput.extend({ resultId: z.uuid() });
const listInput = readInput.extend({ limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).max(10000).default(0) });
export type PrivateResultPrepareInput = z.infer<typeof prepareInput>;
export interface PrivateResultDependencies extends LifecycleDependencies {
  /** Trusted same-transaction DB-only resolver for work.private-draft. It must
   * hold mutable policy rows FOR SHARE until commit, after all Asset locks.
   * No policy/quota default and no caller-supplied policy are permitted. */
  readonly resolvePolicy: (q: PoolClient, context: MemberScopeContext, workId: string) => Promise<LifecyclePolicy>;
}
export interface PrivateResultPublished {
  readonly intentId: string; readonly resultId: string; readonly workId: string; readonly assetId: string;
  readonly revision: string; readonly aggregateVersion: string; readonly provenance: 'human';
}
export interface PrivateResultMetadata {
  readonly resultId: string; readonly workId: string; readonly revision: string; readonly workVersion: string;
  readonly contentType: 'text/plain' | 'text/markdown'; readonly byteSize: number; readonly sha256: string;
  readonly createdAt: string; readonly provenance: 'human';
}
export interface PrivateResultText extends PrivateResultMetadata { readonly aggregateVersion: string; readonly text: string }
interface ResultRow {
  result_id: string; work_item_id: string; revision: string; work_version: string; created_at: Date;
  asset_id: string; scope_id: string; representation_id: string; policy_revision: string;
  content_type: 'text/plain' | 'text/markdown'; byte_size: number; content_sha256: string;
}
const missing = (value: unknown) => requireCondition(value, 404, 'not_found', '找不到這個私人成果。');
const resultFields = `r.result_id,r.work_item_id,r.revision::text,r.work_version::text,r.created_at,
  r.asset_id,r.scope_id,r.representation_id,r.policy_revision,o.content_type,o.byte_size,o.content_sha256`;
function publicMetadata(row: ResultRow): PrivateResultMetadata {
  return Object.freeze({ resultId: row.result_id, workId: row.work_item_id, revision: row.revision, workVersion: row.work_version,
    contentType: row.content_type, byteSize: row.byte_size, sha256: row.content_sha256, createdAt: row.created_at.toISOString(), provenance: 'human' });
}

/** Closed human-only domain adapter. No HTTP registration, provider/model
 * connection, fake Grant, publication, community facts or automatic GC. */
export function createPrivateResultService(pool: Pool, dependencies: PrivateResultDependencies) {
  const { resolvePolicy, store } = dependencies;
  requireCondition(typeof resolvePolicy === 'function', 500, 'private_result_policy_required', '私人成果政策尚未設定。');
  async function policy(q: PoolClient, context: MemberScopeContext, workId: string): Promise<LifecyclePolicy> {
    const value = await resolvePolicy(q, context, workId);
    const current = Object.freeze({ revision: value?.revision, platformPersistenceAllowed: value?.platformPersistenceAllowed,
      retainedByteLimit: value?.retainedByteLimit });
    requirePersistence(current);
    requireCondition(typeof current.retainedByteLimit === 'string' && /^[1-9][0-9]{0,18}$/.test(current.retainedByteLimit)
      && !/[\r\n]/.test(current.retainedByteLimit) && BigInt(current.retainedByteLimit) >= BigInt(PRIVATE_TEXT_MAX_BYTES)
      && BigInt(current.retainedByteLimit) <= 9223372036854775807n, 503, 'private_result_unavailable', '私人成果暫時無法使用。');
    return current;
  }
  async function work(q: PoolClient, context: MemberScopeContext, actor: Actor, id: string, write: boolean) {
    requireCondition(context.scope.kind === 'personal', 403, 'personal_scope_required', '需要本人的私人範圍。');
    requireCondition((await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id])).rowCount === 1,
      403, 'onboarding_required', '請先完成加入。');
    const row = (await q.query<{ aggregate_version: string }>(`SELECT aggregate_version FROM work_items WHERE work_item_id=$1
      AND work_mode='personal_execution' AND state='draft' AND owner_ref=$2 AND owner_principal_id=$3 AND scope_id=$4 FOR ${write ? 'UPDATE' : 'SHARE'}`,
    [id, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id])).rows[0];
    missing(row); return row;
  }
  async function lockTarget(q: PoolClient, context: MemberScopeContext, actor: Actor, id: string): Promise<LifecycleTarget> {
    const row = await work(q, context, actor, id, true);
    const pointer = (await q.query(`SELECT asset_id FROM private_work_result_targets WHERE work_item_id=$1
      AND scope_id=$2 AND owner_principal_id=$3 AND owner_user_id=$4 FOR UPDATE`,
    [id, context.scope.scope_id, context.subject_principal.principal_id, actor.user_id])).rows[0];
    return { targetId: id, aggregateVersion: row.aggregate_version, assetId: pointer?.asset_id ?? null };
  }
  const engine = createAssetLifecycle<PrivateResultPrepareInput, PrivateResultPublished>(pool, dependencies, {
    purpose, targetKind: 'work.private-result', variant: 'draft', inputMaxBytes: PRIVATE_TEXT_MAX_BYTES,
    outputMaxBytes: PRIVATE_TEXT_MAX_BYTES, retireReplacedAsset: false,
    parsePrepare: raw => prepareInput.parse(raw), targetId: input => input.targetWorkId, lockTarget, resolvePolicy: policy,
    async requireCapacity(q, context, actor, _target, current, reserve) {
      // Engine holds per(scope,purpose) advisory lock, not just one Work row.
      // All retained/expired/retired/orphaned Assets stay charged. Missing SQL
      // metadata reserves the profile maximum, even if an intent is absent.
      const row = (await q.query(`SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,$5)::bigint),0)::text used
        FROM assets a LEFT JOIN asset_objects o ON o.asset_id=a.asset_id
        LEFT JOIN asset_upload_intents i ON i.asset_id=a.asset_id
        WHERE a.owner_user_id=$1 AND a.owner_principal_id=$2 AND a.scope_id=$3 AND a.purpose=$4`,
      [actor.user_id, context.subject_principal.principal_id, context.scope.scope_id, purpose, PRIVATE_TEXT_MAX_BYTES])).rows[0];
      requireCondition(BigInt(row.used) + BigInt(reserve) <= BigInt(current.retainedByteLimit), 409, 'asset_retained_quota', '私人成果儲存容量已達上限。');
    },
    prepareRepresentation: preparePrivateText,
    lockPublication: async () => undefined,
    async publish(q, _context, _actor, intent) {
      let row: { result_id: string; work_item_id: string; asset_id: string; revision: string; work_version: string };
      try {
        row = (await q.query(`INSERT INTO private_work_results(result_id,intent_id) VALUES($1,$2)
          RETURNING result_id,work_item_id,asset_id,revision::text,work_version::text`, [randomUUID(), intent.intent_id])).rows[0];
      } catch (error) {
        if ((error as { code?: string })?.code === 'P0412') requireCondition(false, 412, 'version_conflict', '工作版本已改變。');
        throw error;
      }
      const result: PrivateResultPublished = { intentId: intent.intent_id, resultId: row.result_id, workId: row.work_item_id,
        assetId: row.asset_id, revision: row.revision, aggregateVersion: row.work_version, provenance: 'human' };
      return { aggregateVersion: row.work_version, result, fact: { aggregateType: 'private_work', id: row.work_item_id,
        data: { result_id: row.result_id, asset_id: row.asset_id, revision: row.revision, provenance: 'human' }, eventType: 'freedom.work.private.result.created.v1' } };
    },
  });

  async function snapshot(actor: Actor, workId: string, resultId?: string) {
    return withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (q, context) => {
      const target = await work(q, context, actor, workId, false);
      const row = (await q.query<ResultRow>(`SELECT ${resultFields} FROM private_work_results r
        JOIN assets a ON a.asset_id=r.asset_id JOIN asset_objects o ON o.asset_id=r.asset_id
        ${resultId ? '' : 'JOIN private_work_result_targets t ON t.work_item_id=r.work_item_id AND t.result_id=r.result_id'}
        WHERE r.work_item_id=$1 AND r.scope_id=$2 AND r.owner_principal_id=$3 AND r.owner_user_id=$4
        AND a.purpose='work.private-draft' AND a.state IN ('ready','retired') AND a.deletion_fence=0
        ${resultId ? 'AND r.result_id=$5' : ''} FOR SHARE OF a`,
      [workId, context.scope.scope_id, context.subject_principal.principal_id, actor.user_id, ...(resultId ? [resultId] : [])])).rows[0];
      if (resultId) missing(row);
      const currentPolicy = await policy(q, context, workId);
      await assertCurrentSessionClock(q, actor);
      return { row: row ? Object.freeze({ ...row }) : null, aggregateVersion: target.aggregate_version, policy: currentPolicy };
    });
  }
  async function read(actor: Actor, workId: string, resultId?: string): Promise<PrivateResultText | null> {
    const initial = await snapshot(actor, workId, resultId);
    if (!initial.row) return null;
    const row = initial.row, metadata: ObjectMetadata = { contentType: row.content_type, byteSize: row.byte_size,
      sha256: row.content_sha256, transformVersion: 'private-text.utf8.v1', policyRevision: row.policy_revision };
    // No DB transaction remains open while storage returns/streams private text.
    const verified = await readVerifiedObject(store, objectKey({ scopeId: row.scope_id, assetId: row.asset_id,
      representationId: row.representation_id }), metadata);
    // Reuse the same bounded fatal-UTF8/control validator, including synthetic
    // or restored object rows. This does not rewrite the stored representation.
    await preparePrivateText(new ReadableStream({ start(c) { c.enqueue(verified.bytes); c.close(); } }), row.content_type, initial.policy);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(verified.bytes);
    const current = await snapshot(actor, workId, resultId);
    requireCondition(current.row?.result_id === row.result_id && current.aggregateVersion === initial.aggregateVersion,
      412, 'version_conflict', '工作版本已改變，請重新讀取。');
    requireCondition(current.policy.revision === initial.policy.revision, 409, 'asset_policy_changed', '內容政策已變更，請重新讀取。');
    return Object.freeze({ ...publicMetadata(row), aggregateVersion: current.aggregateVersion, text });
  }
  async function readCurrent(actor: Actor, raw: { workId: string }) {
    actor = Object.freeze({ ...actor }); const input = readInput.parse(raw); return read(actor, input.workId);
  }
  async function readResult(actor: Actor, raw: { workId: string; resultId: string }) {
    actor = Object.freeze({ ...actor }); const input = historyInput.parse(raw);
    return (await read(actor, input.workId, input.resultId))!;
  }
  async function list(actor: Actor, raw: { workId: string; limit?: number; offset?: number }) {
    actor = Object.freeze({ ...actor }); const input = listInput.parse(raw);
    return withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (q, context) => {
      const target = await work(q, context, actor, input.workId, false);
      const rows = (await q.query<ResultRow>(`SELECT ${resultFields} FROM private_work_results r
        JOIN assets a ON a.asset_id=r.asset_id JOIN asset_objects o ON o.asset_id=r.asset_id
        WHERE r.work_item_id=$1 AND r.scope_id=$2 AND r.owner_principal_id=$3 AND r.owner_user_id=$4
          AND a.purpose='work.private-draft' AND a.state IN ('ready','retired') AND a.deletion_fence=0
        ORDER BY r.revision DESC LIMIT $5 OFFSET $6`,
      [input.workId, context.scope.scope_id, context.subject_principal.principal_id, actor.user_id, input.limit, input.offset])).rows;
      await policy(q, context, input.workId); await assertCurrentSessionClock(q, actor);
      return Object.freeze({ workId: input.workId, aggregateVersion: target.aggregate_version, limit: input.limit,
        offset: input.offset, items: Object.freeze(rows.map(publicMetadata)) });
    });
  }
  const { prepare, claim, write, finalize, resumeUpload } = engine;
  return Object.freeze({ prepare, claim, write, finalize, resumeUpload, readCurrent, readResult, list });
}
