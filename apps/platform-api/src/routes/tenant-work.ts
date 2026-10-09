import type { TenantListCursorCodec } from '../../../../packages/shared/tenant-list-cursor.js';
import { Hono, type Context } from 'hono';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import {
  EmptyObjectSchema, FinalizeSchema, ResultListQuerySchema, UploadPrepareSchema, WorkListQuerySchema, WorkWriteSchema,
} from '../../../../contracts/guild-launchpad/v1/tenant-work.js';
import { createTenantResultService } from '../../../../modules/autopilot-work/tenant-results.js';
import { createTenantWorkCommands } from '../../../../modules/opportunity-project-work/tenant-work-commands.js';
import { listTenantWork, readTenantWork } from '../../../../modules/opportunity-project-work/tenant-work.js';
import type { ObjectStore } from '../../../../packages/asset-storage/index.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import type { PlatformEnv } from '../module-context.js';

const CONTENT_MAX = 262144;
const CONTENT_PATH = /^\/api\/v1\/tenants\/[0-9a-fA-F-]{36}\/works\/[0-9a-fA-F-]{36}\/results\/uploads\/[0-9a-fA-F-]{36}\/content$/;

/** Raw result bytes. The generic JSON reader must not consume this body. */
export function isTenantResultContentUpload(method: string, path: string) {
  return method === 'PUT' && CONTENT_PATH.test(path);
}

export function checkTenantResultContentHeaders(contentLength?: string) {
  if (contentLength !== undefined) {
    requireCondition(/^\d+$/.test(contentLength) && Number(contentLength) <= CONTENT_MAX, 413, 'payload_too_large', '內容超過 256 KiB。');
  }
}

function privateCache(c: Context<PlatformEnv>) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Cookie');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
}

function singleQuery(c: Context<PlatformEnv>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) throw new Problem(422, 'validation_failed', '查詢參數無效。');
    result[key] = values[0];
  }
  return result;
}

function commandHeaders(c: Context<PlatformEnv>, versionRequired: boolean) {
  const key = c.req.header('Idempotency-Key') ?? '';
  const quoted = c.req.header('If-Match');
  if (!(key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key) && !/[\r\n]/.test(key))) {
    throw new Problem(400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  }
  if (!versionRequired) {
    if (quoted !== undefined) throw new Problem(400, 'invalid_version', '這個操作不使用 If-Match。');
    return { key };
  }
  if (quoted === undefined) throw new Problem(428, 'version_required', '請提供 If-Match 版本。');
  if (!(/^"[1-9][0-9]{0,18}"$/.test(quoted) && !/[\r\n]/.test(quoted) && BigInt(quoted.slice(1, -1)) <= 9223372036854775807n)) {
    throw new Problem(400, 'invalid_version', 'If-Match 須為加引號的正整數版本。');
  }
  return { key, expected: quoted.slice(1, -1) };
}

function etag(c: Context<PlatformEnv>, version: string) {
  c.header('ETag', `"${version}"`);
}

function attachmentDisposition(name: string) {
  const ascii = Array.from(name).map(char => {
    const code = char.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e && char !== '"' && char !== '\\' ? char : '_';
  }).join('');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function readCapped(request: Request) {
  requireCondition(request.headers.get('Content-Encoding') === null, 415, 'encoding_rejected', '不接受內容編碼。');
  const declared = request.headers.get('Content-Length');
  checkTenantResultContentHeaders(declared ?? undefined);
  const reader = request.body?.getReader();
  requireCondition(reader, 422, 'validation_failed', '上傳內容與準備紀錄不同。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CONTENT_MAX) {
        await reader.cancel().catch(() => {});
        throw new Problem(413, 'payload_too_large', '內容超過 256 KiB。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (declared !== null && Number(declared) !== size) throw new Problem(422, 'validation_failed', '上傳內容與準備紀錄不同。');
  return Buffer.concat(chunks, size);
}

/** Tenant Work and human Result routes. Mounted only when guild launchpad is enabled. */
export function createTenantWorkRoutes(pool: Pool, store?: ObjectStore, cursors?: TenantListCursorCodec) {
  const commands = createTenantWorkCommands(pool);
  const results = createTenantResultService(pool, store, cursors);
  const app = new Hono<PlatformEnv>();
  app.use('*', async (c, next) => {
    try { await next(); }
    finally { privateCache(c); }
  });

  app.post('/tenants/:tenant_id/workspaces/:workspace_id/works', async c => {
    const headers = commandHeaders(c, false);
    const tenantId = OpaqueId.parse(c.req.param('tenant_id'));
    const workspaceId = OpaqueId.parse(c.req.param('workspace_id'));
    const body = WorkWriteSchema.parse(await c.req.json());
    return c.json(await commands.create(c.get('actor'), tenantId, workspaceId, body, headers.key), 201);
  });
  app.get('/tenants/:tenant_id/workspaces/:workspace_id/works', async c => {
    const query = WorkListQuerySchema.parse(singleQuery(c));
    return c.json(await listTenantWork(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('workspace_id')), query, cursors));
  });
  app.get('/tenants/:tenant_id/works/:work_id', async c => {
    EmptyObjectSchema.parse(singleQuery(c));
    const work = await readTenantWork(pool, c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')));
    etag(c, work.version);
    return c.json(work);
  });
  app.patch('/tenants/:tenant_id/works/:work_id', async c => {
    const headers = commandHeaders(c, true);
    const body = WorkWriteSchema.parse(await c.req.json());
    return c.json(await commands.update(c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')), body, headers.key, headers.expected!));
  });
  app.post('/tenants/:tenant_id/works/:work_id/archive', async c => {
    const headers = commandHeaders(c, true);
    EmptyObjectSchema.parse(await c.req.json());
    return c.json(await commands.archive(c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')), headers.key, headers.expected!));
  });

  app.post('/tenants/:tenant_id/works/:work_id/results/uploads', async c => {
    const headers = commandHeaders(c, false);
    const body = UploadPrepareSchema.parse(await c.req.json());
    return c.json(await results.prepare(c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')), body, headers.key), 201);
  });
  app.get('/tenants/:tenant_id/works/:work_id/results/uploads/:upload_id', async c => {
    EmptyObjectSchema.parse(singleQuery(c));
    const upload = await results.readUpload(poolActor(c), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')), OpaqueId.parse(c.req.param('upload_id')));
    etag(c, upload.version);
    return c.json(upload);
  });
  app.put('/tenants/:tenant_id/works/:work_id/results/uploads/:upload_id/content', async c => {
    const headers = commandHeaders(c, true);
    const bytes = await readCapped(c.req.raw);
    return c.json(await results.writeContent(c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')), OpaqueId.parse(c.req.param('upload_id')), bytes, headers.key, headers.expected!));
  });
  app.post('/tenants/:tenant_id/works/:work_id/results/uploads/:upload_id/finalize', async c => {
    const headers = commandHeaders(c, true);
    const body = FinalizeSchema.parse(await c.req.json());
    return c.json(await results.finalize(c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')), OpaqueId.parse(c.req.param('upload_id')), body, headers.key, headers.expected!));
  });

  app.get('/tenants/:tenant_id/works/:work_id/results', async c => {
    const query = ResultListQuerySchema.parse(singleQuery(c));
    return c.json(await results.list(c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')), query));
  });
  app.get('/tenants/:tenant_id/works/:work_id/results/:result_id', async c => {
    EmptyObjectSchema.parse(singleQuery(c));
    const result = await results.readResult(c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')), OpaqueId.parse(c.req.param('result_id')));
    etag(c, result.work_version);
    return c.json(result);
  });
  app.on('HEAD', '/tenants/:tenant_id/works/:work_id/results/:result_id/content', () => {
    throw new Problem(405, 'method_not_allowed', '這個操作不接受這個方法。');
  });
  app.get('/tenants/:tenant_id/works/:work_id/results/:result_id/content', async c => {
    if (c.req.method === 'HEAD') throw new Problem(405, 'method_not_allowed', '這個操作不接受這個方法。');
    if (c.req.header('Range') !== undefined) throw new Problem(405, 'method_not_allowed', '這個操作不接受範圍讀取。');
    EmptyObjectSchema.parse(singleQuery(c));
    const content = await results.readContent(c.get('actor'), OpaqueId.parse(c.req.param('tenant_id')), OpaqueId.parse(c.req.param('work_id')), OpaqueId.parse(c.req.param('result_id')));
    etag(c, content.version);
    c.header('Content-Type', `${content.contentType}; charset=utf-8`);
    c.header('Content-Disposition', attachmentDisposition(content.displayName));
    return c.body(new Uint8Array(content.bytes));
  });
  return app;
}

function poolActor(c: Context<PlatformEnv>) {
  return c.get('actor');
}
