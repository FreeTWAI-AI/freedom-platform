import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Command } from '../../packages/db/index.js';
import { digest } from '../../packages/db/index.js';
import { avatarMemberCommand } from '../../packages/scoped-commands/index.js';
import { AssetStorageError, AVATAR_PROFILE, snapshotBoundedBytes, type AvatarNormalizer, type ObjectStore } from '../../packages/asset-storage/index.js';
import { normalizeImage } from '../../packages/shared/image-runtime.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { createAvatarAssetService } from './index.js';
import { resolveAvatarUploadPolicy } from './avatar-policy.js';

export interface AvatarUpload { readonly bytes: Buffer; readonly mime: string }
export interface AvatarUploadResult { avatar_url: string | null; aggregate_version: string }
export interface AvatarUploadPorts {
  readonly store?: ObjectStore;
  /** Domain callback avoids a lifecycle->legacy-domain dependency cycle. */
  readonly legacySave: (input: Command, upload: AvatarUpload) => Promise<AvatarUploadResult>;
  readonly normalizeAvatar?: AvatarNormalizer;
}

/** Existing POST facade, not a new client upload protocol. Policy comes only
 * from the locked server database row; callers cannot provide a true resolver.
 * Default legacy mode remains on the original implementation and receipts. */
export function createAvatarUploadFacade(pool: Pool, ports: AvatarUploadPorts) {
  const { store, legacySave } = ports;
  const normalize = ports.normalizeAvatar ?? ((bytes, spec) => normalizeImage(Buffer.from(bytes), spec));
  return async (raw: Command, upload: AvatarUpload): Promise<AvatarUploadResult> => {
    const bytes = Buffer.from(snapshotBoundedBytes(upload.bytes, AVATAR_PROFILE.inputMaxBytes)), mime = upload.mime;
    const input = Object.freeze({ ...raw, actor: Object.freeze({ ...raw.actor }),
      body: Object.freeze({ content_type: mime, sha256: createHash('sha256').update(bytes).digest('hex') }) });
    const routing = (await pool.query("SELECT mode FROM avatar_storage_policy WHERE profile='member.avatar'")).rows[0];
    requireCondition(routing, 503, 'avatar_upload_unavailable', '頭像上傳暫時無法使用。');
    if (routing.mode === 'legacy') return legacySave(input, { bytes, mime });
    // Replay checks current scope/session/domain but does not need storage or a
    // normalizer. A miss throws privately and rolls back all lazy mappings;
    // no placeholder success or receipt is committed by this probe.
    const probe = async (): Promise<AvatarUploadResult|undefined> => {
      const miss = new Error('avatar_receipt_miss');
      try {
        return await avatarMemberCommand<AvatarUploadResult>(pool, input, async q => {
          const member = (await q.query('SELECT 1 FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [input.actor.user_id])).rowCount;
          requireCondition(member === 1, 403, 'onboarding_required', '請先完成加入。');
        }, async () => { throw miss; });
      } catch (error) { if (error !== miss) throw error; return undefined; }
    };
    const prior = await probe();
    if (prior) return prior;
    requireCondition(store, 503, 'avatar_upload_unavailable', '頭像上傳暫時無法使用。');
    let normalizationUnavailable = false;
    const api = createAvatarAssetService(pool, { store, resolvePolicy: resolveAvatarUploadPolicy,
      normalizeAvatar: async (value, spec) => {
        try { return await normalize(value, spec); }
        catch (error) { if (error instanceof Problem && error.status === 503) normalizationUnavailable = true; throw error; }
      } });
    const prepareKey = digest({ operation: input.operation, key: input.key });
    try {
      const prepared = await api.prepare(input.actor, { key: prepareKey, targetUserId: input.actor.user_id, expectedVersion: input.expected!,
        contentType: mime as 'image/png'|'image/jpeg'|'image/webp', byteSize: bytes.length, sha256: input.body.sha256 });
      const lease = await api.resumeUpload(input.actor, { key: prepareKey, intentId: prepared.intentId });
      const leased = { intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
      if (lease.state === 'processing' || lease.state === 'prepared') {
        await api.write(input.actor, { ...leased, key: digest({ prepareKey, phase: 'write', fence: leased.fence }) },
          new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
      }
      return await api.finalizeAvatar(input, { ...leased, key: digest({ prepareKey, phase: 'finalize' }) });
    } catch (error) {
      // Another same-key request may have completed while this one was still
      // processing, or COMMIT may have succeeded before its response was lost.
      // Exactly one receipt-only recheck; no effect retry and no auth bypass.
      const committed = await probe();
      if (committed) return committed;
      if (!(error instanceof AssetStorageError)) throw error;
      if (normalizationUnavailable || ['object_unavailable','integrity_mismatch','object_conflict'].includes(error.code))
        throw new Problem(503, 'avatar_upload_unavailable', '頭像上傳暫時無法使用。');
      if (error.code === 'too_large') throw new Problem(413, 'avatar_too_large', '圖片需為 2 MB 以下的檔案。');
      if (error.code === 'unsupported_content_type') throw new Problem(415, 'avatar_format', '請選擇 JPEG、PNG 或 WebP 圖片。');
      throw new Problem(422, 'invalid_avatar', '圖片無法使用。請選擇完整的靜態 JPEG、PNG 或 WebP。');
    }
  };
}
