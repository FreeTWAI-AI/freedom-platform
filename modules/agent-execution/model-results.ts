import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedMemberCommand } from '../../packages/scoped-commands/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { checkVersion, digest } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { preparePrivateText, requirePersistence, PRIVATE_TEXT_MAX_BYTES } from '../../packages/asset-storage/index.js';
import { assetCommandKey, assetVersion, createAssetLifecycle, type LifecycleTarget } from '../assets/engine.js';
import type { PrivateResultDependencies } from '../autopilot-work/results.js';
import type { createModelStepService } from './model-step-service.js';
import { readBoundModelObservation, assertModelObservationCurrent, assertModelObservationHost, type OpaqueModelObservation, type ModelStepHost } from './model-step-host.js';

const inputSchema = z.object({ key: assetCommandKey, stepId: OpaqueId, expectedVersion: assetVersion }).strict();
const prepareSchema = z.object({ key: assetCommandKey, targetWorkId: OpaqueId, expectedVersion: assetVersion,
  contentType: z.literal('text/plain'), byteSize: z.number().int().min(1).max(16384), sha256: z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/),
}).strict();
type Prepare = z.infer<typeof prepareSchema>;
type StepService = ReturnType<typeof createModelStepService>;
export interface PrivateModelResultDependencies extends PrivateResultDependencies { readonly steps: StepService; readonly host: ModelStepHost }
export interface PrivateModelResultPublished {
  readonly intentId: string; readonly resultId: string; readonly workId: string; readonly assetId: string;
  readonly revision: string; readonly aggregateVersion: string; readonly provenance: 'model';
  readonly stepId: string; readonly attemptId: string; readonly dispatchIntentId: string;
  readonly evidenceOrigin: 'provider_https' | 'synthetic_local_fixture'; readonly costStatus: 'unknown'; readonly operational_authority: false;
}
/** Server-only finalizer. Its third argument is a genuine in-process host
 * observation; JSON text, public receipts and caller provenance cannot replace
 * it. Bytes use the established bounded Asset lifecycle, quota and Work CAS. */
export function createPrivateModelResultService(pool: Pool, dependencies: PrivateModelResultDependencies) {
  requireCondition(typeof dependencies.steps?.lockResult === 'function' && typeof dependencies.steps?.markResult === 'function'
    && typeof dependencies.host?.dispatch === 'function' && typeof dependencies.resolvePolicy === 'function',
  500, 'model_result_ports_required', '模型成果服務尚未設定。');
  async function finalize(actor: Actor, raw: z.infer<typeof inputSchema>, observation: OpaqueModelObservation): Promise<PrivateModelResultPublished> {
    actor = Object.freeze({ ...actor }); const input = inputSchema.parse(raw), operation = 'execution.model.result.finalize';
    const command = { actor, scope: 'personal' as const, operation, key: input.key, target: { kind: 'model_text_step', id: input.stepId },
      expected: input.expectedVersion, body: { stepId: input.stepId } };
    // An authenticated replay returns metadata only. A miss rolls back without
    // writing a receipt; it must still possess current backing before effects.
    const miss = Object.freeze({});
    try {
      return await scopedMemberCommand<PrivateModelResultPublished>(pool, command, async (q, context) => {
        requireCondition((await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id])).rowCount === 1,
          403, 'onboarding_required', '請先完成加入。');
        const row = await q.query(`SELECT step_id,work_item_id FROM model_text_steps WHERE step_id=$1 AND owner_user_id=$2
          AND owner_principal_id=$3 AND scope_id=$4`, [input.stepId, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id]);
        requireCondition(row.rowCount === 1, 404, 'not_found', '找不到這項執行紀錄。');
        requirePersistence(await dependencies.resolvePolicy(q, context, row.rows[0].work_item_id));
      }, async () => { throw miss; });
    } catch (error) { if (error !== miss) throw error; }
    assertModelObservationHost(observation, dependencies.host);
    await assertModelObservationCurrent(observation);
    const initial = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (q, context) => {
      const step = await dependencies.steps.lockResult(q, context, actor, input.stepId);
      checkVersion(step.aggregateVersion, input.expectedVersion); await assertCurrentSessionClock(q, actor); return step;
    });
    const observed = readBoundModelObservation(observation, initial.binding);
    requireCondition(observed.binding.selection.artifactCustody === 'platform_asset', 409, 'model_result_custody_mismatch', '模型成果保存位置不符合這個流程。');
    const { text: _text, binding: _binding, ...observedMetadata } = observed;
    requireCondition(digest(observedMetadata) === digest(initial.observation), 409, 'model_result_observation_mismatch', '模型成果不是已接受的派送結果。');
    requireCondition(observed.outputSha256 === initial.outputSha256 && observed.outputByteSize === initial.outputByteSize
      && observed.evidenceOrigin === initial.evidenceOrigin, 409, 'model_result_observation_mismatch', '模型成果與派送紀錄不同。');
    const bytes = new TextEncoder().encode(observed.text);
    requireCondition(bytes.byteLength === observed.outputByteSize && bytes.byteLength > 0 && bytes.byteLength <= 16384,
      409, 'model_result_observation_mismatch', '模型成果不符合大小限制。');
    async function lockTarget(q: PoolClient, context: MemberScopeContext, currentActor: Actor, workId: string): Promise<LifecycleTarget> {
      const step = await dependencies.steps.lockResult(q, context, currentActor, input.stepId);
      checkVersion(step.aggregateVersion, input.expectedVersion);
      requireCondition(step.workId === workId && step.outputSha256 === observed.outputSha256 && step.outputByteSize === observed.outputByteSize,
        409, 'model_result_observation_mismatch', '模型成果與派送紀錄不同。');
      const pointer = (await q.query('SELECT asset_id FROM private_work_result_targets WHERE work_item_id=$1 FOR UPDATE', [workId])).rows[0];
      return { targetId: workId, aggregateVersion: step.inputWorkVersion, assetId: pointer?.asset_id ?? null };
    }
    const engine = createAssetLifecycle<Prepare, PrivateModelResultPublished>(pool, dependencies, {
      purpose: 'work.private-draft', targetKind: 'work.model-result', variant: 'draft', inputMaxBytes: 16384,
      outputMaxBytes: 16384, retireReplacedAsset: false, parsePrepare: value => prepareSchema.parse(value),
      targetId: value => value.targetWorkId, lockTarget, resolvePolicy: dependencies.resolvePolicy,
      async requireCapacity(q, context, currentActor, _target, policy, reserve) {
        const row = (await q.query(`SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,$5)::bigint),0)::text used
          FROM assets a LEFT JOIN asset_objects o ON o.asset_id=a.asset_id LEFT JOIN asset_upload_intents i ON i.asset_id=a.asset_id
          WHERE a.owner_user_id=$1 AND a.owner_principal_id=$2 AND a.scope_id=$3 AND a.purpose=$4`,
        [currentActor.user_id, context.subject_principal.principal_id, context.scope.scope_id, 'work.private-draft', PRIVATE_TEXT_MAX_BYTES])).rows[0];
        requireCondition(BigInt(row.used) + BigInt(reserve) <= BigInt(policy.retainedByteLimit), 409, 'asset_retained_quota', '私人成果儲存容量已達上限。');
      },
      prepareRepresentation: preparePrivateText, lockPublication: async () => undefined,
      async publish(q, context, currentActor, intent) {
        const row = (await q.query(`INSERT INTO private_model_work_results(result_id,intent_id,step_id) VALUES($1,$2,$3)
          RETURNING result_id,work_item_id,asset_id,revision::text,work_version::text,attempt_id,dispatch_intent_id,evidence_origin`,
        [randomUUID(), intent.intent_id, input.stepId])).rows[0];
        await dependencies.steps.markResult(q, context, currentActor, input.stepId, row.result_id);
        await assertCurrentSessionClock(q, currentActor);
        const result: PrivateModelResultPublished = { intentId: intent.intent_id, resultId: row.result_id, workId: row.work_item_id,
          assetId: row.asset_id, revision: row.revision, aggregateVersion: row.work_version, provenance: 'model', stepId: input.stepId,
          attemptId: row.attempt_id, dispatchIntentId: row.dispatch_intent_id, evidenceOrigin: row.evidence_origin, costStatus: 'unknown', operational_authority: false };
        return { aggregateVersion: row.work_version, result, fact: { aggregateType: 'private_work', id: row.work_item_id,
          data: { result_id: row.result_id, asset_id: row.asset_id, revision: row.revision, provenance: 'model', step_id: input.stepId,
            attempt_id: row.attempt_id, evidence_origin: row.evidence_origin }, eventType: 'freedom.work.private.model_result.created.v1' } };
      },
    });
    const phaseKey = (phase: string) => digest({ profile: 'private-model-result/v1', key: input.key, stepId: input.stepId, phase });
    try {
      const prepared = await engine.prepare(actor, { key: phaseKey('prepare'), targetWorkId: initial.workId,
        expectedVersion: initial.inputWorkVersion, contentType: 'text/plain', byteSize: bytes.byteLength, sha256: observed.outputSha256 });
      await assertModelObservationCurrent(observation);
      const lease = await engine.claim(actor, { key: phaseKey('claim'), intentId: prepared.intentId });
      await assertModelObservationCurrent(observation);
      await engine.write(actor, { key: phaseKey('write'), intentId: prepared.intentId, fence: lease.fence, leaseToken: lease.leaseToken },
        new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
      await assertModelObservationCurrent(observation);
      let resultId: string | undefined;
      return await engine.finalizeVia(actor, { key: phaseKey('finalize'), intentId: prepared.intentId, fence: lease.fence, leaseToken: lease.leaseToken }, {
        operation, beforeCommit: () => assertModelObservationCurrent(observation),
        execute: run => scopedMemberCommand(pool, command, async (q, context) => { await lockTarget(q, context, actor, initial.workId); await assertModelObservationCurrent(observation); },
          run, async q => {
            await assertModelObservationCurrent(observation);
            if (resultId) await q.query('SELECT check_private_model_result_commit_current(current_schema(),$1::uuid)', [resultId]);
          }),
        validateIntent(intent) { requireCondition(intent.target_kind === 'work.model-result' && intent.target_work_id === initial.workId
          && intent.source_sha256 === observed.outputSha256 && intent.source_byte_size === observed.outputByteSize,
        409, 'model_result_observation_mismatch', '模型成果與上傳紀錄不同。'); },
        result(value) { resultId = value.resultId; return value; },
      });
    } finally { bytes.fill(0); }
  }
  return Object.freeze({ finalize });
}
