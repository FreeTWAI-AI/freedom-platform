import { Buffer } from 'node:buffer';
import { objectKey, readVerifiedObject, type ObjectStore } from '../../packages/asset-storage/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';

/** Internal SQL fragments require alias a=member_avatars; never client DTOs. */
export const avatarReadColumns = `a.user_id,a.aggregate_version,a.storage_source,
  CASE WHEN a.storage_source='legacy' THEN a.image_bytes ELSE NULL END AS image_bytes,
  t.asset_id,t.scope_id,o.representation_id,o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision`;
export const avatarReadJoins = `JOIN member_avatar_presence presence ON presence.user_id=a.user_id AND presence.present
  LEFT JOIN member_avatar_asset_targets t ON t.user_id=a.user_id AND t.linked_at_version=a.aggregate_version
  LEFT JOIN asset_objects o ON o.asset_id=t.asset_id`;
export interface AvatarReadSnapshot {
  user_id: string; aggregate_version: string; storage_source: 'legacy'|'asset'; image_bytes: Buffer|null;
  asset_id: string|null; scope_id: string|null; representation_id: string|null;
  content_type: 'image/webp'; byte_size: number; content_sha256: string; transform_version: 'avatar.webp.v1'; policy_revision: string;
  share_generation?: string;
}
const missing = () => new Problem(404, 'avatar_not_found', '找不到這個頭像。');
function identity(row: AvatarReadSnapshot): string {
  return JSON.stringify([row.user_id,row.aggregate_version,row.storage_source,row.asset_id,row.scope_id,row.representation_id,row.share_generation]);
}
/** Domain callback must perform the SAME fresh ACL query twice, including any
 * share generation/opt-in. No SQL transaction or locks may span object I/O.
 * Success linearizes at the second SQL snapshot. Revocation cannot retract
 * already downloaded bytes; changes during I/O reject without a retry loop. */
export async function readAuthorizedAvatar(snapshot: () => Promise<AvatarReadSnapshot|undefined>, store?: ObjectStore, version?: string) {
  const first = await snapshot();
  if (!first || (version !== undefined && first.aggregate_version !== version)) throw missing();
  let bytes: Buffer;
  if (first.storage_source === 'legacy') {
    if (!first.image_bytes) throw missing();
    bytes = Buffer.from(first.image_bytes);
  } else {
    requireCondition(store && first.asset_id && first.scope_id && first.representation_id, 503, 'avatar_unavailable', '頭像暫時無法讀取。');
    try {
      const object = await readVerifiedObject(store!, objectKey({ scopeId: first.scope_id!, assetId: first.asset_id!, representationId: first.representation_id! }),
        { contentType: first.content_type, byteSize: first.byte_size, sha256: first.content_sha256, transformVersion: first.transform_version, policyRevision: first.policy_revision });
      bytes = Buffer.from(object.bytes);
    } catch { throw new Problem(503, 'avatar_unavailable', '頭像暫時無法讀取。'); }
  }
  const last = await snapshot();
  if (!last || identity(last) !== identity(first)) throw missing();
  return { image_bytes: bytes, aggregate_version: first.aggregate_version };
}
