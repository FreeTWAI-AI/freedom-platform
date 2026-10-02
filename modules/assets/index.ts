import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { checkVersion, digest } from '../../packages/db/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { AVATAR_PROFILE, objectKey, prepareAvatar, readBounded, requirePersistence, sha256, verifyObject, writeVerifiedObject,
  type AvatarNormalizer, type ObjectMetadata, type ObjectStore, type PersistencePolicy } from '../../packages/asset-storage/index.js';

const version = z.string().refine(v => /^[1-9][0-9]{0,18}$/.test(v) && !/[\r\n]/.test(v) && BigInt(v) <= 9223372036854775807n);
const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(v => !/[\r\n]/.test(v));
const prepareInput = z.object({ key, targetUserId: OpaqueId, expectedVersion: version,
  contentType: z.enum(['image/png','image/jpeg','image/webp']), byteSize: z.number().int().min(1).max(AVATAR_PROFILE.inputMaxBytes),
  sha256: z.string().length(64).regex(/^[0-9a-f]+$/) }).strict();
const claimInput = z.object({ key, intentId: OpaqueId }).strict();
const leaseInput = claimInput.extend({ fence: version, leaseToken: OpaqueId });
export type AvatarPrepareInput = z.infer<typeof prepareInput>;
export type AvatarClaimInput = z.infer<typeof claimInput>;
export type AvatarLeaseInput = z.infer<typeof leaseInput>;
export interface AvatarAssetDependencies {
  readonly store: ObjectStore;
  readonly normalizeAvatar: AvatarNormalizer;
  /** Trusted server resolver: same transaction, database-only; lock any mutable
   * policy backing records until commit. Never accept caller-supplied policy. */
  readonly resolvePolicy: (q: PoolClient, context: MemberScopeContext, targetUserId: string) => Promise<PersistencePolicy>;
  readonly intentTtlSeconds?: number;
  readonly leaseSeconds?: number;
  readonly maxPendingIntents?: number;
}
interface Target { user_id: string; aggregate_version: string; asset_id: string | null }
interface Intent {
  intent_id: string; asset_id: string; representation_id: string; scope_id: string; owner_principal_id: string;
  target_user_id: string; policy_revision: string; expected_version: string;
  source_content_type: 'image/png' | 'image/jpeg' | 'image/webp'; source_byte_size: number; source_sha256: string;
  state: 'prepared' | 'processing' | 'stored' | 'finalized'; fence: string; lease_token: string | null;
  lease_expires_at: Date | null; expires_at: Date;
}
const missing = (present: unknown) => requireCondition(present, 404, 'asset_intent_not_found', '找不到這個上傳。');
const invalidState = (allowed: boolean) => requireCondition(allowed, 409, 'asset_intent_state', '上傳狀態已改變。');

/** CLOSED internal prototype. No HTTP registration, storage binding, private
 * Work creation, legacy bytes replacement, GC, execution or service auth. */
export function createAvatarAssetService(pool: Pool, dependencies: AvatarAssetDependencies) {
  const settings = z.object({ ttl: z.number().int().min(1).max(86400), lease: z.number().int().min(1).max(3600), pending: z.number().int().min(1).max(100) })
    .parse({ ttl: dependencies.intentTtlSeconds ?? 3600, lease: dependencies.leaseSeconds ?? 300, pending: dependencies.maxPendingIntents ?? 3 });
  // Capture ports once; dependencies are server configuration, not request data.
  const { store, normalizeAvatar, resolvePolicy } = dependencies;

  async function policy(q: PoolClient, context: MemberScopeContext, userId: string, pinned?: string): Promise<PersistencePolicy> {
    const resolved = await resolvePolicy(q, context, userId);
    const snapshot = Object.freeze({ revision: resolved?.revision, platformPersistenceAllowed: resolved?.platformPersistenceAllowed });
    requirePersistence(snapshot);
    requireCondition(pinned === undefined || snapshot.revision === pinned, 409, 'asset_policy_changed', '內容政策已變更，請重新準備上傳。');
    return snapshot;
  }
  async function eligibleMember(q: PoolClient, actor: Actor): Promise<{ community_id: string }> {
    const current = (await q.query('SELECT community_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id])).rows[0];
    requireCondition(current, 403, 'onboarding_required', '請先完成加入。');
    return current;
  }
  async function target(q: PoolClient, context: MemberScopeContext, actor: Actor, create = false): Promise<Target> {
    requireCondition(context.scope.kind === 'personal', 403, 'asset_scope_required', '需要本人的私人範圍。');
    const current = await eligibleMember(q, actor);
    if (create) await q.query('INSERT INTO member_avatars(user_id,community_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [actor.user_id, current.community_id]);
    const avatar = (await q.query('SELECT user_id,aggregate_version FROM member_avatars WHERE user_id=$1 FOR UPDATE', [actor.user_id])).rows[0];
    missing(avatar);
    if (create) await q.query('INSERT INTO member_avatar_asset_targets(user_id,scope_id,owner_principal_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [actor.user_id, context.scope.scope_id, context.subject_principal.principal_id]);
    const pointer = (await q.query('SELECT asset_id FROM member_avatar_asset_targets WHERE user_id=$1 AND scope_id=$2 AND owner_principal_id=$3 FOR UPDATE',
      [actor.user_id, context.scope.scope_id, context.subject_principal.principal_id])).rows[0];
    missing(pointer);
    return { ...avatar, asset_id: pointer.asset_id };
  }
  async function intent(q: PoolClient, context: MemberScopeContext, actor: Actor, id: string): Promise<Intent> {
    const row = (await q.query<Intent>('SELECT * FROM asset_upload_intents WHERE intent_id=$1 AND target_user_id=$2 AND scope_id=$3 AND owner_principal_id=$4 FOR UPDATE',
      [id, actor.user_id, context.scope.scope_id, context.subject_principal.principal_id])).rows[0];
    missing(row);
    // Acquire the last lifecycle row lock before lease/expiry decisions.
    await q.query('SELECT asset_id FROM assets WHERE asset_id=$1 FOR UPDATE', [row.asset_id]);
    return row;
  }
  async function live(q: PoolClient, row: Intent, lease?: AvatarLeaseInput): Promise<void> {
    // This query runs AFTER all potentially blocking locks and policy resolution.
    const now = (await q.query<{ live: boolean; leased: boolean }>('SELECT expires_at>clock_timestamp() AS live,lease_expires_at>clock_timestamp() AS leased FROM asset_upload_intents WHERE intent_id=$1', [row.intent_id])).rows[0];
    requireCondition(now.live, 409, 'asset_intent_expired', '上傳已到期。');
    if (lease) requireCondition(row.fence === lease.fence && row.lease_token === lease.leaseToken && now.leased,
      409, 'asset_lease_stale', '上傳租約已失效。');
  }
  const storageKey = (row: Intent) => objectKey({ scopeId: row.scope_id, assetId: row.asset_id, representationId: row.representation_id });
  async function metadata(q: PoolClient, row: Intent): Promise<ObjectMetadata> {
    const object = (await q.query('SELECT content_type,byte_size,content_sha256,transform_version,policy_revision FROM asset_objects WHERE asset_id=$1 AND scope_id=$2 AND representation_id=$3',
      [row.asset_id, row.scope_id, row.representation_id])).rows[0];
    requireCondition(object, 409, 'asset_not_stored', '內容尚未完成儲存。');
    return Object.freeze({ contentType: object.content_type, byteSize: object.byte_size, sha256: object.content_sha256,
      transformVersion: object.transform_version, policyRevision: object.policy_revision });
  }

  async function prepare(actor: Actor, raw: AvatarPrepareInput) {
    actor = Object.freeze({ ...actor });
    const input = prepareInput.parse(raw), { key: receiptKey, ...body } = input;
    let resolved!: PersistencePolicy, avatar!: Target;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation: 'asset.upload.prepare', key: receiptKey,
      target: { kind: 'member.avatar', id: input.targetUserId }, expected: input.expectedVersion, body }, async (q, context) => {
      requireCondition(input.targetUserId === actor.user_id, 404, 'asset_target_not_found', '找不到這個目標。');
      avatar = await target(q, context, actor, true);
      resolved = await policy(q, context, actor.user_id);
    }, async (q, context) => {
      checkVersion(avatar.aggregate_version, input.expectedVersion);
      // Avatar target lock serializes quota checks across different request keys.
      const pending = (await q.query('SELECT count(*)::int AS n FROM asset_upload_intents WHERE owner_principal_id=$1 AND scope_id=$2 AND state<>\'finalized\' AND expires_at>clock_timestamp()',
        [context.subject_principal.principal_id, context.scope.scope_id])).rows[0].n;
      requireCondition(pending < settings.pending, 409, 'asset_upload_quota', '進行中的上傳已達上限。');
      const assetId = randomUUID(), intentId = randomUUID(), representationId = randomUUID();
      await q.query('INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id) VALUES($1,$2,$3,$4,$5,$6)',
        [assetId, context.scope.scope_id, context.subject_principal.principal_id, actor.user_id, resolved.revision, representationId]);
      const row = (await q.query('INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+make_interval(secs=>$14)) RETURNING expires_at',
        [intentId, assetId, representationId, context.scope.scope_id, context.subject_principal.principal_id, actor.user_id, resolved.revision,
          receiptKey, digest(body), input.contentType, input.byteSize, input.sha256, input.expectedVersion, settings.ttl])).rows[0];
      await scopedJournal(q, context, { aggregate_type: 'asset_upload_intent', id: intentId, version: '1', operation: 'asset.upload.prepare', data: { asset_id: assetId } });
      return { intentId, assetId, representationId, expiresAt: row.expires_at.toISOString() as string };
    });
  }
  async function claim(actor: Actor, raw: AvatarClaimInput) {
    actor = Object.freeze({ ...actor });
    const input = claimInput.parse(raw); let row!: Intent;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation: 'asset.upload.claim', key: input.key,
      target: { kind: 'asset_upload_intent', id: input.intentId }, body: { intentId: input.intentId } }, async (q, context) => {
      await target(q, context, actor); row = await intent(q, context, actor, input.intentId);
      await policy(q, context, actor.user_id, row.policy_revision); invalidState(row.state !== 'finalized'); await live(q, row);
    }, async q => {
      const updated = (await q.query<Intent>(`UPDATE asset_upload_intents SET fence=fence+1,lease_token=$2,
        lease_expires_at=LEAST(expires_at,clock_timestamp()+make_interval(secs=>$3)),state=CASE WHEN state='stored' THEN 'stored' ELSE 'processing' END
        WHERE intent_id=$1 AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *`, [row.intent_id, randomUUID(), settings.lease])).rows[0];
      requireCondition(updated, 409, 'asset_lease_active', '目前仍有有效上傳租約。');
      return { intentId: updated.intent_id, assetId: updated.asset_id, representationId: updated.representation_id, fence: updated.fence,
        leaseToken: updated.lease_token!, leaseExpiresAt: updated.lease_expires_at!.toISOString() };
    });
  }
  async function inspect(actor: Actor, input: AvatarLeaseInput, allowFinalized = false) {
    return withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (q, context) => {
      await target(q, context, actor); const row = await intent(q, context, actor, input.intentId);
      const resolved = await policy(q, context, actor.user_id, row.policy_revision);
      invalidState(row.state === 'processing' || row.state === 'stored' || (allowFinalized && row.state === 'finalized'));
      if (row.state !== 'finalized') await live(q, row, input);
      else requireCondition(row.fence === input.fence && row.lease_token === input.leaseToken, 409, 'asset_lease_stale', '上傳租約已失效。');
      const storedMetadata = row.state === 'stored' ? await metadata(q, row) : null;
      // Scope auth may precede a blocked target/policy/metadata query. Reject an
      // elapsed session before releasing this snapshot to external object I/O.
      await assertCurrentSessionClock(q, actor);
      return { row: Object.freeze({ ...row }), policy: resolved, metadata: storedMetadata };
    });
  }
  async function write(actor: Actor, raw: AvatarLeaseInput, body: ReadableStream<Uint8Array>) {
    actor = Object.freeze({ ...actor });
    const input = leaseInput.parse(raw), snapshot = await inspect(actor, input);
    // All source processing and object-store calls are outside SQL transactions.
    const bytes = await readBounded(body, AVATAR_PROFILE.inputMaxBytes);
    requireCondition(bytes.byteLength === snapshot.row.source_byte_size && await sha256(bytes) === snapshot.row.source_sha256,
      409, 'asset_source_mismatch', '上傳內容與準備紀錄不同。');
    const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    const prepared = await prepareAvatar(source, snapshot.row.source_content_type, snapshot.policy, normalizeAvatar);
    const verified = await writeVerifiedObject(store, storageKey(snapshot.row), prepared, snapshot.policy);
    let row!: Intent;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation: 'asset.upload.write', key: input.key,
      target: { kind: 'asset_upload_intent', id: input.intentId }, body: { intentId: input.intentId, fence: input.fence, metadata: verified.metadata } }, async (q, context) => {
      await target(q, context, actor); row = await intent(q, context, actor, input.intentId);
      await policy(q, context, actor.user_id, row.policy_revision);
      invalidState(row.state === 'processing' || row.state === 'stored'); await live(q, row, input);
    }, async q => {
      if (row.state === 'stored') {
        requireCondition(digest(await metadata(q, row)) === digest(verified.metadata), 409, 'asset_object_conflict', '已儲存內容不同。');
      } else {
        const value = verified.metadata;
        await q.query('INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [row.asset_id, row.scope_id, row.representation_id, value.contentType, value.byteSize, value.sha256, value.transformVersion, value.policyRevision]);
        await q.query("UPDATE asset_upload_intents SET state='stored' WHERE intent_id=$1", [row.intent_id]);
      }
      return { intentId: row.intent_id, assetId: row.asset_id, state: 'stored' as const };
    });
  }
  async function finalize(actor: Actor, raw: AvatarLeaseInput) {
    actor = Object.freeze({ ...actor });
    const input = leaseInput.parse(raw), snapshot = await inspect(actor, input, true);
    invalidState(snapshot.row.state === 'stored' || snapshot.row.state === 'finalized');
    if (snapshot.row.state === 'stored') await verifyObject(store, storageKey(snapshot.row), snapshot.metadata!);
    let row!: Intent, avatar!: Target, routing!: { mode: string };
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation: 'asset.upload.finalize', key: input.key,
      target: { kind: 'asset_upload_intent', id: input.intentId }, body: { intentId: input.intentId, fence: input.fence } }, async (q, context) => {
      avatar = await target(q, context, actor); row = await intent(q, context, actor, input.intentId);
      await policy(q, context, actor.user_id, row.policy_revision);
      routing = (await q.query("SELECT mode FROM avatar_storage_policy WHERE profile='member.avatar' FOR SHARE")).rows[0];
      invalidState(row.state === 'stored' || row.state === 'finalized');
      if (row.state !== 'finalized') await live(q, row, input);
      else requireCondition(row.fence === input.fence && row.lease_token === input.leaseToken, 409, 'asset_lease_stale', '上傳租約已失效。');
    }, async (q, context) => {
      invalidState(row.state === 'stored');
      checkVersion(avatar.aggregate_version, row.expected_version);
      const activated = await q.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1 AND state='pending'", [row.asset_id]);
      invalidState(activated.rowCount === 1);
      const result = (await q.query("UPDATE member_avatars SET aggregate_version=aggregate_version+1,storage_source=CASE WHEN $3='legacy' THEN storage_source ELSE 'asset' END,updated_at=clock_timestamp() WHERE user_id=$1 AND aggregate_version=$2 RETURNING aggregate_version",
        [actor.user_id, row.expected_version, routing.mode])).rows[0];
      requireCondition(result, 412, 'version_conflict', '頭像版本已改變。');
      await q.query('UPDATE member_avatar_asset_targets SET asset_id=$2,linked_at_version=$3 WHERE user_id=$1', [actor.user_id, row.asset_id, result.aggregate_version]);
      if (avatar.asset_id && avatar.asset_id !== row.asset_id) await q.query("UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=$1 AND state='ready'", [avatar.asset_id]);
      await q.query("UPDATE asset_upload_intents SET state='finalized',finalized_at=clock_timestamp() WHERE intent_id=$1", [row.intent_id]);
      await scopedJournal(q, context, { aggregate_type: 'asset', id: row.asset_id, version: result.aggregate_version,
        operation: 'asset.upload.finalize', data: { intent_id: row.intent_id, target_user_id: actor.user_id }, eventType: 'freedom.asset.avatar.stored.v1' });
      return { intentId: row.intent_id, assetId: row.asset_id, targetUserId: actor.user_id, aggregateVersion: result.aggregate_version as string };
    });
  }
  async function readTarget(actor: Actor) {
    actor = Object.freeze({ ...actor });
    return withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (q, context) => {
      await eligibleMember(q, actor);
      await policy(q, context, actor.user_id);
      const row = (await q.query('SELECT a.aggregate_version,t.asset_id FROM member_avatars a LEFT JOIN member_avatar_asset_targets t ON t.user_id=a.user_id AND t.scope_id=$2 AND t.owner_principal_id=$3 AND t.linked_at_version=a.aggregate_version WHERE a.user_id=$1',
        [actor.user_id, context.scope.scope_id, context.subject_principal.principal_id])).rows[0];
      await assertCurrentSessionClock(q, actor);
      return { targetUserId: actor.user_id, assetId: (row?.asset_id ?? null) as string | null, aggregateVersion: (row?.aggregate_version ?? '1') as string };
    });
  }
  return Object.freeze({ prepare, claim, write, finalize, readTarget });
}
