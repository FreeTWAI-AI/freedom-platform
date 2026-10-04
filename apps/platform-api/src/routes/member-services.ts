import type { Hono } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { requireCondition } from '../../../../packages/shared/problem.js';
import { authRateLimit } from '../../../../modules/identity-membership/members.js';
import { SERVICE_COVER_INPUT_BYTES } from '../../../../modules/skill-submissions/payload.js';
import {
  createMemberService, deleteMemberService, editMemberService, hideMemberService, listMemberServices, listMyMemberServices,
  pauseMemberService, publicMemberCover, publicServiceDocument, publicServiceListDocument, readMemberCover, removeMemberServiceCover,
  resolvePublicCommunity, resumeMemberService, saveMemberServiceCover,
} from '../../../../modules/community/member-services.js';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import type { PlatformRuntime } from '../runtime.js';

const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const HEX = '[0-9a-fA-F]';
const SERVICE_UUID = `${HEX.repeat(8)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(12)}`;

export function isServiceCoverUpload(method: string, path: string) {
  return method === 'PUT' && /^\/api\/v1\/member-services\/[0-9a-f-]{36}\/cover$/.test(path);
}
export function checkServiceCoverHeaders(contentType?: string, contentLength?: string) {
  requireCondition(COVER_TYPES.has((contentType ?? '').split(';')[0]!.trim()), 415, 'service_cover_format', '請選擇 JPEG、PNG 或 WebP 圖片。');
  if (contentLength !== undefined) requireCondition(/^\d+$/.test(contentLength) && Number(contentLength) <= SERVICE_COVER_INPUT_BYTES, 413, 'service_cover_too_large', '封面需為 4 MiB 以下。');
}

async function bounded(request: Request) {
  const reader = request.body?.getReader();
  requireCondition(reader, 422, 'invalid_service_cover', '請先選擇封面。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCondition(size <= SERVICE_COVER_INPUT_BYTES, 413, 'service_cover_too_large', '封面需為 4 MiB 以下。');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  requireCondition(size > 0, 422, 'invalid_service_cover', '請先選擇封面。');
  return Buffer.concat(chunks, size);
}

function clock(runtime: PlatformRuntime) { return runtime.now?.() ?? new Date(); }
function respond(c: { header: (name: string, value: string) => void; json: (body: unknown, status?: number) => Response }, value: { aggregate_version?: string | number }, status = 200) {
  if (value?.aggregate_version) c.header('ETag', `"${value.aggregate_version}"`);
  return c.json(value, status);
}

export function registerPublicMemberServices(app: Hono<PlatformEnv>, pool: Pool, runtime: PlatformRuntime) {
  app.get('/api/v1/public/member-services/:id/cover', async c => {
    const bytes = await publicMemberCover(pool, await resolvePublicCommunity(pool, runtime.registrationCommunityId()), c.req.param('id'),runtime.serviceCoverAssetStore);
    c.header('Content-Type', 'image/webp');
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    return c.body(new Uint8Array(bytes));
  });
  app.get('/services', async c => {
    const html = await publicServiceListDocument(pool, await resolvePublicCommunity(pool, runtime.registrationCommunityId()), runtime.publicOrigin, c.req.query('category'), c.req.query('before'));
    c.header('Cache-Control', 'public, max-age=60');
    return c.html(html);
  });
  app.get(`/services/:id{${SERVICE_UUID}}`, async c => {
    const page = await publicServiceDocument(pool, await resolvePublicCommunity(pool, runtime.registrationCommunityId()), runtime.publicOrigin, c.req.param('id'));
    c.header('Cache-Control', 'public, max-age=60');
    return c.html(page.html, page.status);
  });
}

export function registerMemberServices(app: Hono<PlatformEnv>, pool: Pool, runtime: PlatformRuntime) {
  const id = (c: { req: { param: (name: string) => string } }) => z.uuid().parse(c.req.param('id'));
  app.get('/api/v1/member-services/mine', async c => c.json(await listMyMemberServices(pool, c.get('actor'))));
  app.get('/api/v1/member-services', async c => c.json(await listMemberServices(pool, c.get('actor'), { category: c.req.query('category'), cursor: c.req.query('cursor') })));
  app.post('/api/v1/member-services', async c => {
    await authRateLimit(pool, 'member-service-create', c.get('actor').user_id, 40, 3600);
    return respond(c, await createMemberService(pool, await moduleCommand(c), clock(runtime)), 201);
  });
  app.get('/api/v1/member-services/:id/cover', async c => {
    const bytes = await readMemberCover(pool, c.get('actor'), id(c),runtime.serviceCoverAssetStore);
    c.header('Content-Type', 'image/webp');
    c.header('Cache-Control', 'private, no-store');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    return c.body(new Uint8Array(bytes));
  });
  app.put('/api/v1/member-services/:id/cover', async c => {
    checkServiceCoverHeaders(c.req.header('Content-Type'), c.req.header('Content-Length'));
    const version = c.req.header('If-Match');
    if (version) requireCondition(/^"[1-9][0-9]*"$/.test(version), 400, 'invalid_version', '請提供有效的資料版本。');
    const key = c.req.header('Idempotency-Key') ?? '';
    requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
    await authRateLimit(pool, 'member-service-cover', c.get('actor').user_id, 20, 3600);
    const bytes = await bounded(c.req.raw);
    const mime = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim();
    return respond(c, await saveMemberServiceCover(pool, { actor: c.get('actor'), operation: `${c.req.method} ${c.req.path}`, key, body: null, expected: version?.slice(1, -1) }, id(c), { bytes, mime }, clock(runtime),runtime.serviceCoverAssets));
  });
  app.post('/api/v1/member-services/:id/cover/remove', async c => respond(c, await removeMemberServiceCover(pool, await moduleCommand(c), id(c), clock(runtime))));
  app.put('/api/v1/member-services/:id', async c => respond(c, await editMemberService(pool, await moduleCommand(c), id(c), clock(runtime))));
  app.post('/api/v1/member-services/:id/pause', async c => respond(c, await pauseMemberService(pool, await moduleCommand(c), id(c), clock(runtime))));
  app.post('/api/v1/member-services/:id/resume', async c => respond(c, await resumeMemberService(pool, await moduleCommand(c), id(c), clock(runtime))));
  app.post('/api/v1/member-services/:id/hide', async c => respond(c, await hideMemberService(pool, await moduleCommand(c), id(c), clock(runtime))));
  app.delete('/api/v1/member-services/:id', async c => respond(c, await deleteMemberService(pool, await moduleCommand(c), id(c), clock(runtime))));
}
