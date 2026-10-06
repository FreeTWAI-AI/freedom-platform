import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import {
  FinalizeSchema, OperationSchema, ResultPageSchema, ResultSchema, UploadPrepareSchema, UploadSchema, UploadVerifiedSchema,
  type Operation, type ResultView, type UploadView,
} from '../../contracts/guild-launchpad/v1/tenant-work.js';
import { digest } from '../../packages/db/index.js';
import { checkVersion } from '../../packages/db/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import {
  AssetStorageError, objectKey, preparePrivateText, PRIVATE_TEXT_MAX_BYTES, readVerifiedObject, sha256,
  type ObjectMetadata, type ObjectStore,
} from '../../packages/asset-storage/index.js';
import { assetCommandKey, assetVersion, createAssetLifecycleWithAuthority, type LifecycleTarget } from '../assets/engine.js';
import { createTenantLifecycleAuthority, type TenantWorkActor } from '../assets/tenant-lifecycle-authority.js';
import { withTenantRead, type TenantScopeContext } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../identity-membership/service.js';
import { requireTenantCapability } from '../opportunity-project-work/tenant-capabilities.js';
import { lockCapacityPolicy, lockDimension, requirePolicy, retainedByteUsage } from '../opportunity-project-work/tenant-capacity.js';
import { rememberTenantCommand, stableOperationId } from '../opportunity-project-work/tenant-command.js';
import { loadWork, lockWritableInstance, tenantWorkReadInput } from '../opportunity-project-work/tenant-work.js';

const prepareInput = z.object({
  key: assetCommandKey, targetWorkId: OpaqueId, expectedVersion: assetVersion,
  contentType: z.enum(['text/plain', 'text/markdown']), byteSize: z.number().int().min(1).max(PRIVATE_TEXT_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), displayName: z.string().min(1).max(120),
}).strict();
type PrepareInput = z.infer<typeof prepareInput>;
interface Published { resultId: string; workId: string; assetId: string; revision: string; workVersion: string }

const missingStore: ObjectStore = Object.freeze({
  async get() { throw new AssetStorageError('object_unavailable'); },
  async head() { throw new AssetStorageError('object_unavailable'); },
  async putImmutable() { throw new AssetStorageError('object_unavailable'); },
  async delete() { throw new AssetStorageError('object_unavailable'); },
});

function actorOf(actor: Actor, tenantId: string): TenantWorkActor {
  return Object.freeze({ ...actor, tenant_id: tenantId });
}
function wire(tenantId: string, instanceId: string, type: 'work.upload' | 'work.result', id: string, key: string, operation: string): Operation {
  return OperationSchema.parse({
    operation_id: stableOperationId(tenantId, operation, key), state: 'succeeded', version: '1',
    resource_ref: { tenant_id: tenantId, instance_id: instanceId, resource_type: type, resource_id: id },
  });
}
function hide(error: unknown): never {
  if (error instanceof Problem && error.code === 'asset_intent_not_found') throw new Problem(404, 'not_found', '找不到這個上傳。');
  if (error instanceof Problem && error.code === 'asset_source_mismatch') throw new Problem(422, 'validation_failed', '上傳內容與準備紀錄不同。');
  throw error;
}
function uploadVersion(fence: string) { return String(BigInt(fence) + 1n); }

interface IntentRow {
  intent_id: string; target_work_id: string; asset_id: string; state: UploadView['phase']; expires_at: Date;
  fence: string; source_byte_size: number; source_sha256: string; source_content_type: 'text/plain' | 'text/markdown';
  display_name: string; expected_version: string; byte_size: number | null; content_sha256: string | null;
}

/** Human tenant Results. The closed engine owns upload state. Lease tokens never leave this module. */
export function createTenantResultService(pool: Pool, store: ObjectStore | undefined) {
  const authority = createTenantLifecycleAuthority();
  const requireStore = () => { if (!store) throw new AssetStorageError('object_unavailable'); return store; };
  async function resolvePolicy(q: PoolClient, context: TenantScopeContext) {
    const row = requirePolicy(await lockCapacityPolicy(q, context.tenant_id));
    requireCondition(BigInt(row.max_retained_bytes) >= BigInt(PRIVATE_TEXT_MAX_BYTES), 429, 'quota_exceeded', '已達到這個業務空間的容量上限。');
    return Object.freeze({ revision: row.revision, platformPersistenceAllowed: true as const, retainedByteLimit: row.max_retained_bytes });
  }
  const engine = createAssetLifecycleWithAuthority<PrepareInput, Published, TenantWorkActor, TenantScopeContext>(pool, { store: store ?? missingStore }, {
    purpose: 'work.tenant-result', targetKind: 'work.tenant-result', variant: 'draft',
    inputMaxBytes: PRIVATE_TEXT_MAX_BYTES, outputMaxBytes: PRIVATE_TEXT_MAX_BYTES, retireReplacedAsset: false,
    parsePrepare: raw => prepareInput.parse(raw),
    targetId: input => input.targetWorkId,
    async lockTarget(q, context, _actor, id, create): Promise<LifecycleTarget> {
      // Prepare (create) locks instance, then capacity policy, then Work.
      // Other phases lock the instance only; publication locks the intent, then policy, then Work.
      const preview = await loadWork(q, context.tenant_id, context.scope.scope_id, id, false);
      requireCondition(preview, 404, 'not_found', '找不到這個工作。');
      requireCondition(preview.state === 'draft', 409, 'work_archived', '這個工作已封存。');
      await lockWritableInstance(q, context.tenant_id, preview.instance_id);
      if (!create) return { targetId: id, aggregateVersion: preview.aggregate_version, assetId: null };
      requirePolicy(await lockCapacityPolicy(q, context.tenant_id));
      const row = await loadWork(q, context.tenant_id, context.scope.scope_id, id, true);
      requireCondition(row, 404, 'not_found', '找不到這個工作。');
      requireCondition(row.state === 'draft', 409, 'work_archived', '這個工作已封存。');
      return { targetId: id, aggregateVersion: row.aggregate_version, assetId: null };
    },
    resolvePolicy: (q, context) => resolvePolicy(q, context),
    async requireCapacity(q, context, _actor, _target, current, reserve) {
      await lockDimension(q, context.tenant_id, 'retained_bytes');
      const used = await retainedByteUsage(q, context.scope.scope_id, context.tenant_id);
      requireCondition(used + BigInt(reserve) <= BigInt(current.retainedByteLimit), 429, 'quota_exceeded', '已達到這個業務空間的容量上限。');
    },
    prepareRepresentation: preparePrivateText,
    // Runs inside the inserting command, including after the receipt wait.
    revalidate: async (_q, context) => { requireTenantCapability(context, 'work:result.write', true); },
    async lockPublication(q, context, _actor, row) {
      // Intent is already locked. The result trigger locks the Work row next, so this matches that order.
      const workId = row.target_work_id;
      requireCondition(workId, 404, 'not_found', '找不到這個工作。');
      const work = await loadWork(q, context.tenant_id, context.scope.scope_id, workId, true);
      requireCondition(work, 404, 'not_found', '找不到這個工作。');
      requireCondition(work.state === 'draft', 409, 'work_archived', '這個工作已封存。');
    },
    async publish(q, _context, actor, intent) {
      let row: { result_id: string; work_item_id: string; asset_id: string; revision: string; work_version: string };
      try {
        row = (await q.query(`INSERT INTO tenant_work_results(result_id, intent_id) VALUES($1,$2)
          RETURNING result_id, work_item_id, asset_id, revision::text, work_version::text`, [randomUUID(), intent.intent_id])).rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === 'P0412') throw new Problem(412, 'version_conflict', '工作版本已改變。');
        throw error;
      }
      await assertCurrentSessionClock(q, actor);
      const result: Published = { resultId: row.result_id, workId: row.work_item_id, assetId: row.asset_id, revision: row.revision, workVersion: row.work_version };
      return { aggregateVersion: row.work_version, result, fact: { aggregateType: 'tenant_work', id: row.work_item_id,
        data: { result_id: row.result_id, asset_id: row.asset_id, revision: row.revision, work_version: row.work_version, state: 'ready' } } };
    },
  }, authority);

  async function intent(q: PoolClient, context: TenantScopeContext, uploadId: string, workId: string): Promise<IntentRow> {
    const row = (await q.query<IntentRow>(`SELECT i.intent_id, i.target_work_id, i.asset_id, i.state, i.expires_at, i.fence::text AS fence,
        i.source_byte_size, i.source_sha256, i.source_content_type, i.display_name, i.expected_version::text AS expected_version,
        o.byte_size, o.content_sha256
      FROM asset_upload_intents i LEFT JOIN asset_objects o ON o.asset_id=i.asset_id
      WHERE i.intent_id=$1 AND i.target_tenant_id=$2 AND i.scope_id=$3 AND i.purpose='work.tenant-result' AND i.target_work_id=$4`,
    [uploadId, context.tenant_id, context.scope.scope_id, workId])).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這個上傳。');
    return row;
  }

  async function prepare(actor: Actor, tenantId: string, workId: string, body: unknown, key: string) {
    requireStore();
    const input = UploadPrepareSchema.parse(body);
    let instanceId = '';
    const engineKey = digest({ profile: 'freedom.tenant-upload/v1', httpKey: key, phase: 'prepare' });
    try {
      return await rememberTenantCommand(pool, {
        actor, tenantId, operation: 'work.tenant.prepare', key, target: { kind: 'tenant_work', id: workId },
        body: { work_id: workId, ...input },
      }, async (_q, context) => {
        requireTenantCapability(context, 'work:result.write', true);
      }, async journal => {
        const prepared = await engine.prepare(actorOf(actor, tenantId), {
          key: engineKey, targetWorkId: workId, expectedVersion: input.expected_work_version, contentType: input.content_type,
          byteSize: input.byte_size, sha256: input.sha256, displayName: input.display_name,
        });
        journal.id = prepared.intentId;
        journal.version = '1';
        return wire(tenantId, instanceId, 'work.upload', prepared.intentId, key, 'work.tenant.prepare');
      }, async (q, context) => {
        const row = await loadWork(q, tenantId, context.scope.scope_id, workId, false);
        requireCondition(row, 404, 'not_found', '找不到這個工作。');
        requireCondition(row.state === 'draft', 409, 'work_archived', '這個工作已封存。');
        checkVersion(row.aggregate_version, input.expected_work_version);
        instanceId = row.instance_id;
      });
    } catch (error) { hide(error); }
  }

  async function writeContent(actor: Actor, tenantId: string, workId: string, uploadId: string, bytes: Uint8Array, key: string, expected: string) {
    requireStore();
    const digestHex = await sha256(bytes);
    const resumeKey = digest({ profile: 'freedom.tenant-upload/v1', httpKey: key, phase: 'resume', intentId: uploadId });
    try {
      return await rememberTenantCommand(pool, {
        actor, tenantId, operation: 'work.tenant.write', key, target: { kind: 'tenant_upload', id: uploadId },
        body: { work_id: workId, upload_id: uploadId, byte_size: bytes.byteLength, sha256: digestHex },
      }, async (_q, context) => {
        requireTenantCapability(context, 'work:result.write', true);
      }, async journal => {
        const bound = actorOf(actor, tenantId);
        const lease = await engine.resumeUpload(bound, { key: resumeKey, intentId: uploadId });
        const fresh = lease.state === 'prepared' || lease.state === 'processing';
        if (fresh) {
          await engine.write(bound, {
            key: digest({ resumeKey, phase: 'write', fence: lease.fence }), intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken,
          }, new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
        }
        const version = uploadVersion(lease.fence);
        const verified = UploadVerifiedSchema.parse({ upload_id: uploadId, verified: true, version });
        journal.id = uploadId;
        journal.version = version;
        // The object commit releases the intent lock before this receipt. Two keys that both
        // saw a live lease would otherwise insert the same upload fact. Re-lock and skip when it exists.
        journal.record = false;
        journal.commit = async (q, context) => {
          const locked = await q.query(`SELECT intent_id FROM asset_upload_intents
            WHERE intent_id=$1 AND target_tenant_id=$2 AND scope_id=$3 AND purpose='work.tenant-result' FOR UPDATE`,
          [uploadId, context.tenant_id, context.scope.scope_id]);
          requireCondition(locked.rowCount === 1, 404, 'not_found', '找不到這個上傳。');
          if (fresh) {
            const prior = await q.query(`SELECT 1 FROM scoped_transition_journal
              WHERE scope_id=$1 AND aggregate_type='tenant_work' AND aggregate_id=$2 AND aggregate_version=$3::bigint`,
            [context.scope.scope_id, uploadId, version]);
            journal.record = prior.rows.length === 0;
          }
          return verified;
        };
      }, async (q, context) => {
        const row = await intent(q, context, uploadId, workId);
        if (bytes.byteLength !== row.source_byte_size || digestHex !== row.source_sha256) {
          throw new Problem(422, 'validation_failed', '上傳內容與準備紀錄不同。');
        }
        checkVersion(uploadVersion(row.fence), expected);
      });
    } catch (error) { hide(error); }
  }

  async function finalize(actor: Actor, tenantId: string, workId: string, uploadId: string, body: unknown, key: string, expected: string) {
    requireStore();
    const input = FinalizeSchema.parse(body);
    let instanceId = '';
    const resumeKey = digest({ profile: 'freedom.tenant-upload/v1', httpKey: key, phase: 'resume', intentId: uploadId });
    try {
      return await rememberTenantCommand<Operation>(pool, {
        actor, tenantId, operation: 'work.tenant.finalize', key, target: { kind: 'tenant_upload', id: uploadId },
        body: { work_id: workId, upload_id: uploadId, expected_work_version: input.expected_work_version },
      }, async (_q, context) => {
        requireTenantCapability(context, 'work:result.write', true);
      }, async (journal, commit) => {
        const bound = actorOf(actor, tenantId);
        const lease = await engine.resumeUpload(bound, { key: resumeKey, intentId: uploadId });
        if (lease.state === 'finalized') {
          const existing = (await pool.query<{ result_id: string; work_version: string }>(
            `SELECT result_id, work_version::text AS work_version FROM tenant_work_results WHERE intent_id=$1`, [uploadId])).rows[0];
          requireCondition(existing, 404, 'not_found', '找不到這個成果。');
          journal.record = false;
          return wire(tenantId, instanceId, 'work.result', existing.result_id, key, 'work.tenant.finalize');
        }
        const leaseInput = {
          key: digest({ resumeKey, phase: 'finalize', fence: lease.fence }), intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken,
        };
        // Verify while no receipt transaction is open. commit() is the one transaction that publishes.
        return engine.finalizeVia<Operation>(bound, leaseInput, {
          operation: 'work.tenant.finalize',
          execute: run => commit(async (q, context) => {
            const locked = await q.query<{ state: string; fence: string; lease_token: string }>(`SELECT state, fence::text AS fence, lease_token
              FROM asset_upload_intents
              WHERE intent_id=$1 AND target_tenant_id=$2 AND scope_id=$3 AND purpose='work.tenant-result' FOR UPDATE`,
            [uploadId, context.tenant_id, context.scope.scope_id]);
            requireCondition(locked.rowCount === 1, 404, 'not_found', '找不到這個上傳。');
            const current = locked.rows[0];
            if (current.state === 'finalized') {
              requireCondition(current.fence === lease.fence && current.lease_token === lease.leaseToken, 409, 'asset_lease_stale', '上傳租約已失效。');
              const existing = (await q.query<{ result_id: string }>(
                `SELECT result_id FROM tenant_work_results WHERE intent_id=$1`, [uploadId])).rows[0];
              requireCondition(existing, 404, 'not_found', '找不到這個成果。');
              journal.record = false;
              return wire(tenantId, instanceId, 'work.result', existing.result_id, key, 'work.tenant.finalize');
            }
            return run(q, context);
          }),
          validateIntent() { /* The tenant intent was bound in the probe and again by the engine lock. */ },
          result: value => {
            journal.id = value.resultId;
            journal.version = value.workVersion;
            return wire(tenantId, instanceId, 'work.result', value.resultId, key, 'work.tenant.finalize');
          },
        });
      }, async (q, context) => {
        const row = await intent(q, context, uploadId, workId);
        const work = await loadWork(q, tenantId, context.scope.scope_id, workId, false);
        requireCondition(work, 404, 'not_found', '找不到這個工作。');
        requireCondition(work.state === 'draft', 409, 'work_archived', '這個工作已封存。');
        checkVersion(uploadVersion(row.fence), expected);
        requireCondition(row.expected_version === input.expected_work_version, 412, 'version_conflict', '工作版本已改變。');
        instanceId = work.instance_id;
      });
    } catch (error) { hide(error); }
  }

  function uploadView(row: IntentRow): UploadView {
    return UploadSchema.parse({
      upload_id: row.intent_id, work_id: row.target_work_id, asset_id: row.asset_id, phase: row.state,
      expires_at: row.expires_at.toISOString(), version: uploadVersion(row.fence),
      byte_size: row.byte_size ?? row.source_byte_size, sha256: row.content_sha256 ?? row.source_sha256,
      content_type: row.source_content_type, display_name: row.display_name,
    });
  }

  async function readUpload(actor: Actor, tenantId: string, workId: string, uploadId: string) {
    return withTenantRead(pool, tenantWorkReadInput(actor, tenantId), async (q, context) => {
      requireTenantCapability(context, 'work:result.write', false);
      return uploadView(await intent(q, context, uploadId, workId));
    });
  }

  const resultFields = `r.result_id, r.work_item_id, r.asset_id, r.revision::text AS revision, r.work_version::text AS work_version,
    r.content_type, r.byte_size, r.content_sha256, r.created_at, r.display_name, r.scope_id, r.representation_id, r.policy_revision`;
  interface ResultRow {
    result_id: string; work_item_id: string; asset_id: string; revision: string; work_version: string;
    content_type: 'text/plain' | 'text/markdown'; byte_size: number; content_sha256: string; created_at: Date; display_name: string;
    scope_id: string; representation_id: string; policy_revision: string;
  }
  function resultView(row: ResultRow): ResultView {
    return ResultSchema.parse({
      result_id: row.result_id, work_id: row.work_item_id, asset_id: row.asset_id, revision: row.revision, work_version: row.work_version,
      provenance: 'human', content_type: row.content_type, byte_size: row.byte_size, sha256: row.content_sha256,
      created_at: row.created_at.toISOString(), display_name: row.display_name,
    });
  }
  async function list(actor: Actor, tenantId: string, workId: string, query: { limit?: number; cursor?: string }) {
    const limit = query.limit ?? 20;
    let cursor: string | null = null;
    if (query.cursor) {
      const text = Buffer.from(query.cursor, 'base64url').toString('utf8');
      if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
      cursor = text;
    }
    return withTenantRead(pool, tenantWorkReadInput(actor, tenantId), async (q, context) => {
      requireTenantCapability(context, 'work:read', false);
      const work = await loadWork(q, tenantId, context.scope.scope_id, workId, false);
      requireCondition(work && work.state === 'draft', 404, 'not_found', '找不到這個工作。');
      const rows = (await q.query<ResultRow>(`SELECT ${resultFields} FROM tenant_work_results r
        WHERE r.work_item_id=$1 AND r.tenant_id=$2 AND r.scope_id=$3 AND ($4::bigint IS NULL OR r.revision < $4::bigint)
        ORDER BY r.revision DESC LIMIT $5`, [workId, tenantId, context.scope.scope_id, cursor, limit + 1])).rows;
      const page = rows.slice(0, limit);
      return ResultPageSchema.parse({
        items: page.map(resultView),
        next_cursor: rows.length > limit ? Buffer.from(page[page.length - 1].revision).toString('base64url') : null,
        source_version: work.aggregate_version,
      });
    });
  }
  async function readResult(actor: Actor, tenantId: string, workId: string, resultId: string) {
    return withTenantRead(pool, tenantWorkReadInput(actor, tenantId), async (q, context) => {
      requireTenantCapability(context, 'work:read', false);
      const work = await loadWork(q, tenantId, context.scope.scope_id, workId, false);
      requireCondition(work && work.state === 'draft', 404, 'not_found', '找不到這個工作。');
      const row = (await q.query<ResultRow>(`SELECT ${resultFields} FROM tenant_work_results r
        WHERE r.result_id=$1 AND r.work_item_id=$2 AND r.tenant_id=$3 AND r.scope_id=$4`,
      [resultId, workId, tenantId, context.scope.scope_id])).rows[0];
      requireCondition(row, 404, 'not_found', '找不到這個成果。');
      return resultView(row);
    });
  }

  async function snapshot(actor: Actor, tenantId: string, workId: string, resultId: string) {
    return withTenantRead(pool, tenantWorkReadInput(actor, tenantId), async (q, context) => {
      requireTenantCapability(context, 'work:read', false);
      const work = await loadWork(q, tenantId, context.scope.scope_id, workId, false);
      requireCondition(work && work.state === 'draft', 404, 'not_found', '找不到這個工作。');
      const row = (await q.query<ResultRow>(`SELECT ${resultFields} FROM tenant_work_results r
        JOIN assets a ON a.asset_id=r.asset_id
        WHERE r.result_id=$1 AND r.work_item_id=$2 AND r.tenant_id=$3 AND r.scope_id=$4
          AND a.purpose='work.tenant-result' AND a.state='ready' AND a.deletion_fence=0`,
      [resultId, workId, tenantId, context.scope.scope_id])).rows[0];
      requireCondition(row, 404, 'not_found', '找不到這個成果。');
      const policy = (await q.query<{ revision: string | null }>(`SELECT revision::text AS revision FROM tenant_capacity_policies
        WHERE status='active' AND (tenant_id=$1 OR tenant_id IS NULL) ORDER BY tenant_id NULLS LAST LIMIT 1`, [tenantId])).rows[0]?.revision ?? null;
      await assertCurrentSessionClock(q, actor);
      return { row, workVersion: work.aggregate_version, policy };
    });
  }
  async function readContent(actor: Actor, tenantId: string, workId: string, resultId: string) {
    const active = requireStore();
    const initial = await snapshot(actor, tenantId, workId, resultId);
    const row = initial.row;
    const metadata: ObjectMetadata = {
      contentType: row.content_type, byteSize: row.byte_size, sha256: row.content_sha256,
      transformVersion: 'private-text.utf8.v1', policyRevision: row.policy_revision,
    };
    const verified = await readVerifiedObject(active, objectKey({ scopeId: row.scope_id, assetId: row.asset_id, representationId: row.representation_id }), metadata);
    await preparePrivateText(new ReadableStream({ start(c) { c.enqueue(verified.bytes); c.close(); } }), row.content_type, {
      revision: row.policy_revision, platformPersistenceAllowed: true,
    });
    const current = await snapshot(actor, tenantId, workId, resultId);
    requireCondition(current.row.result_id === row.result_id && current.workVersion === initial.workVersion, 412, 'version_conflict', '工作版本已改變，請重新讀取。');
    requireCondition(current.policy === initial.policy, 409, 'asset_policy_changed', '內容政策已變更，請重新讀取。');
    return { bytes: verified.bytes, contentType: row.content_type, displayName: row.display_name, version: current.workVersion };
  }

  return Object.freeze({ prepare, writeContent, finalize, readUpload, list, readResult, readContent });
}
