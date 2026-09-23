import { Hono } from 'hono';
import type { Pool } from 'pg';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { requireCondition } from '../../../../packages/shared/problem.js';
import { authRateLimit } from '../../../../modules/identity-membership/members.js';
import { AVATAR_MAX_BYTES, AVATAR_MIME_TYPES, avatarMetadata, readAvatar, saveAvatar } from '../../../../modules/identity-membership/avatars.js';

export function isAvatarUpload(method: string, path: string) {
  return method === 'POST' && path === '/api/v1/me/avatar';
}
export function checkAvatarUploadHeaders(contentType?: string, contentLength?: string) {
  requireCondition(AVATAR_MIME_TYPES.has(contentType ?? ''), 415, 'avatar_format', '請選擇 JPEG、PNG 或 WebP 圖片。');
  if (contentLength !== undefined) requireCondition(/^\d+$/.test(contentLength) && Number(contentLength) <= AVATAR_MAX_BYTES, 413, 'avatar_too_large', '圖片需為 2 MB 以下的檔案。');
}
async function boundedUpload(request: Request) {
  const reader = request.body?.getReader();
  requireCondition(reader, 422, 'invalid_avatar', '請先選擇圖片。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCondition(size <= AVATAR_MAX_BYTES, 413, 'avatar_too_large', '圖片需為 2 MB 以下的檔案。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  requireCondition(size > 0, 422, 'invalid_avatar', '請先選擇圖片。');
  return Buffer.concat(chunks, size);
}
export function createAvatarRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  app.get('/me/avatar', async c => c.json(await avatarMetadata(pool, c.get('actor'))));
  app.post('/me/avatar', async c => {
    checkAvatarUploadHeaders(c.req.header('Content-Type'), c.req.header('Content-Length'));
    const version = c.req.header('If-Match');
    requireCondition(version && /^"[1-9][0-9]*"$/.test(version), version ? 400 : 428, 'version_required', '請重新整理頭像資料後再保存。');
    const key = c.req.header('Idempotency-Key') ?? '';
    requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
    await authRateLimit(pool, 'avatar-upload-member', c.get('actor').user_id, 12, 60);
    await authRateLimit(pool, 'avatar-upload-global', 'global', 120, 60);
    const bytes = await boundedUpload(c.req.raw);
    const result = await saveAvatar(pool, { actor: c.get('actor'), operation: `${c.req.method} ${c.req.path}`, key, expected: version.slice(1, -1), body: null }, { bytes, mime: c.req.header('Content-Type')! });
    c.header('ETag', `"${result.aggregate_version}"`);
    return c.json(result);
  });
  app.post('/me/avatar/remove', async c => {
    const result = await saveAvatar(pool, await moduleCommand(c), null);
    c.header('ETag', `"${result.aggregate_version}"`);
    return c.json(result);
  });
  app.get('/members/:id/avatar', async c => {
    const avatar = await readAvatar(pool, c.get('actor'), c.req.param('id'), c.req.query('v'));
    c.header('Content-Type', 'image/webp');
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Cookie');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Content-Length', String(avatar.image_bytes.length));
    return c.body(new Uint8Array(avatar.image_bytes));
  });
  return app;
}
