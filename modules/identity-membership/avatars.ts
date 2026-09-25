import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { checkVersion, command, journal, type Command } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { normalizeImage } from '../../packages/shared/image-runtime.js';
import type { Actor } from './service.js';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MAX_DIMENSION = 4096;
const AVATAR_MAX_OUTPUT_BYTES = 131072;
export const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const invalidImage = () => new Problem(422, 'invalid_avatar', '圖片無法使用。請選擇完整的靜態 JPEG、PNG 或 WebP，長寬各不超過 4096 像素。');

export function avatarUrl(userId: string, version: string | number, present: boolean): string | null {
  return present ? `/api/v1/members/${userId}/avatar?v=${version}` : null;
}
export async function avatarMetadata(pool: Pool, actor: Actor) {
  const row = (await pool.query('SELECT aggregate_version,image_bytes IS NOT NULL AS present FROM member_avatars WHERE user_id=$1 AND community_id=$2', [actor.user_id, actor.community_id])).rows[0];
  return { avatar_url: avatarUrl(actor.user_id, row?.aggregate_version ?? '1', Boolean(row?.present)), aggregate_version: row?.aggregate_version ?? '1' };
}

async function normalizeAvatar(bytes: Buffer, mime: string): Promise<Buffer> {
  requireCondition(bytes.length > 0 && bytes.length <= AVATAR_MAX_BYTES, 413, 'avatar_too_large', '圖片需為 2 MB 以下的檔案。');
  requireCondition(AVATAR_MIME_TYPES.has(mime), 415, 'avatar_format', '請選擇 JPEG、PNG 或 WebP 圖片。');
  // Reject vector/doc/archive inputs before passing anything to the decoder.
  const signature = bytes.subarray(0, 12);
  const format = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : signature.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'jpeg'
      : signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp' : null;
  if (!format || mime !== `image/${format}`) throw invalidImage();
  // libpng can expose only the first APNG frame, so reject its animation
  // control chunk explicitly rather than treating it as a static PNG.
  if (format === 'png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12 || bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') throw invalidImage();
      offset += length + 12;
    }
  } else if (format === 'webp') {
    // Reject animated WebP before any processor, not only via decoder page counts.
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      if (length > bytes.length - offset - 8 || type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && length >= 1 && (bytes[offset + 8] & 0x02))) throw invalidImage();
      offset += 8 + length + (length & 1);
    }
  }
  try {
    // The request's processor (sharp on Node) fully decodes, orients and strips metadata.
    const normalized = await normalizeImage(bytes, { purpose: 'avatar', format, maxDimension: AVATAR_MAX_DIMENSION, maxPixels: AVATAR_MAX_DIMENSION ** 2, maxOutputBytes: AVATAR_MAX_OUTPUT_BYTES,
      output: { width: 256, height: 256, fit: 'cover', quality: 82, effort: 3 } });
    requireCondition(normalized.length <= AVATAR_MAX_OUTPUT_BYTES, 422, 'invalid_avatar', '這張圖片無法縮成頭像，請換一張圖片。');
    return normalized;
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw invalidImage();
  }
}

export async function saveAvatar(pool: Pool, input: Command, upload: { bytes: Buffer; mime: string } | null) {
  const body = upload ? { content_type: upload.mime, sha256: createHash('sha256').update(upload.bytes).digest('hex') } : z.object({}).strict().parse(input.body);
  // Binary content never enters command receipts, journals or diagnostic logs.
  return command(pool, { ...input, body }, async q => {
    const allowed = await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [input.actor.user_id, input.actor.community_id]);
    requireCondition(allowed.rowCount === 1, 403, 'onboarding_required', '請先完成定位並選擇主要公會。');
  }, async q => {
    await q.query('INSERT INTO member_avatars(user_id,community_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [input.actor.user_id, input.actor.community_id]);
    const row = (await q.query('SELECT aggregate_version,image_bytes IS NOT NULL AS present FROM member_avatars WHERE user_id=$1 AND community_id=$2 FOR UPDATE', [input.actor.user_id, input.actor.community_id])).rows[0];
    checkVersion(row.aggregate_version, input.expected);
    if (!upload && !row.present) return { avatar_url: null, aggregate_version: row.aggregate_version };
    const bytes = upload ? await normalizeAvatar(upload.bytes, upload.mime) : null;
    const saved = (await q.query('UPDATE member_avatars SET image_bytes=$2,aggregate_version=aggregate_version+1,updated_at=now() WHERE user_id=$1 RETURNING aggregate_version', [input.actor.user_id, bytes])).rows[0];
    await journal(q, input.actor, 'member_avatar', input.actor.user_id, saved.aggregate_version, upload ? 'save_avatar' : 'remove_avatar');
    return { avatar_url: avatarUrl(input.actor.user_id, saved.aggregate_version, Boolean(bytes)), aggregate_version: saved.aggregate_version };
  });
}

export async function readAvatar(pool: Pool, actor: Actor, id: string, version?: string) {
  id = z.uuid().parse(id).toLowerCase();
  if (version !== undefined) requireCondition(/^[1-9][0-9]*$/.test(version), 400, 'invalid_version', '頭像版本不正確。');
  // Visibility and bytes share one snapshot; every request rechecks the reader,
  // target's current community, active state and completed member visibility.
  const row = (await pool.query(`SELECT a.image_bytes,a.aggregate_version FROM member_avatars a
    JOIN users owner ON owner.user_id=a.user_id AND owner.community_id=a.community_id
    JOIN users viewer ON viewer.user_id=$3 AND viewer.community_id=a.community_id
    JOIN sessions s ON s.user_id=viewer.user_id AND s.token_hash=$4
    WHERE a.user_id=$1 AND a.community_id=$2 AND a.image_bytes IS NOT NULL
      AND owner.active AND (NOT owner.onboarding_required OR owner.onboarding_completed_at IS NOT NULL)
      AND viewer.active AND (NOT viewer.onboarding_required OR viewer.onboarding_completed_at IS NOT NULL)
      AND s.revoked_at IS NULL AND s.expires_at>now()`, [id, actor.community_id, actor.user_id, actor.session_hash])).rows[0];
  requireCondition(row && (version === undefined || row.aggregate_version === version), 404, 'avatar_not_found', '找不到這個頭像。');
  return row as { image_bytes: Buffer; aggregate_version: string };
}
