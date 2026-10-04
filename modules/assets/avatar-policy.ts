import type { PoolClient } from 'pg';
import type { MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import type { PersistencePolicy } from '../../packages/asset-storage/index.js';

export interface AvatarPersistencePolicy extends PersistencePolicy {
  /** Bigint decimal bytes; required by live upload configuration, no default. */
  readonly retainedByteLimit: string;
}
/** Trusted server resolver, never an HTTP policy. Caller already holds owner
 * avatar/scope locks; the policy row stays locked through the same transaction. */
export async function resolveAvatarUploadPolicy(q: PoolClient, _context: MemberScopeContext, _targetUserId: string): Promise<AvatarPersistencePolicy> {
  const row = (await q.query("SELECT mode,policy_revision,persistence_allowed,retained_byte_limit FROM avatar_storage_policy WHERE profile='member.avatar' FOR SHARE")).rows[0];
  requireCondition(row && row.mode !== 'legacy' && row.persistence_allowed === true && row.policy_revision && row.retained_byte_limit,
    503, 'avatar_upload_unavailable', '頭像上傳暫時無法使用。');
  return Object.freeze({ revision: row.policy_revision, platformPersistenceAllowed: true, retainedByteLimit: row.retained_byte_limit });
}

/** Conservative physical accounting, not only live pending-intent counts.
 * Immutable metadata charges actual stored size. Any object lacking SQL
 * verification still reserves its maximum, including expired/orphaned intents.
 * Retired and tombstoned assets remain charged: observed missing is not proof a
 * delayed PUT can never recreate bytes. Retained legacy bytea is also charged.
 * Caller MUST hold the owner's real avatar FOR UPDATE while checking+inserting. */
export function requireAvatarQuotaLimit(limit: string): void {
  requireCondition(typeof limit === 'string' && /^[1-9][0-9]{0,18}$/.test(limit) && !/[\r\n]/.test(limit)
    && BigInt(limit) >= 131072n && BigInt(limit) <= 9223372036854775807n, 503, 'avatar_upload_unavailable', '頭像上傳暫時無法使用。');
}
export async function requireAvatarCapacity(q: PoolClient, userId: string, limit: string, reserveBytes: number): Promise<void> {
  requireAvatarQuotaLimit(limit);
  const row = (await q.query(`SELECT
      COALESCE((SELECT sum(COALESCE(o.byte_size,i.reserved_bytes,131072)::bigint)
        FROM assets a LEFT JOIN asset_objects o ON o.asset_id=a.asset_id
        LEFT JOIN asset_upload_intents i ON i.asset_id=a.asset_id WHERE a.owner_user_id=$1 AND a.purpose='member.avatar'),0)
      + COALESCE((SELECT octet_length(image_bytes) FROM member_avatars WHERE user_id=$1),0) AS used`, [userId])).rows[0];
  requireCondition(BigInt(row.used) + BigInt(reserveBytes) <= BigInt(limit), 409, 'asset_retained_quota', '頭像儲存容量已達上限。');
}
