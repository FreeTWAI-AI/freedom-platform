import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { AssetStorageError, readBounded, type ObjectStore } from '../../../../packages/asset-storage/index.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { createPrivateWorkCommands } from '../../../../modules/opportunity-project-work/private-commands.js';
import { listPrivateWork, readPrivateWork } from '../../../../modules/opportunity-project-work/private-work.js';
import { createPrivateResultService } from '../../../../modules/autopilot-work/results.js';
import { resolvePrivateWorkPersistencePolicy } from '../../../../modules/autopilot-work/policy.js';
import { allowedBrowserOrigins, allowedRequestHosts, type FreedomEnv } from '../env.js';
import { memberBoundary } from '../member-boundary.js';
import type { PlatformEnv } from '../module-context.js';

const MAX_BODY = 32768;
const editBody = z.object({ title: z.string(), objective: z.string() }).strict();
const emptyBody = z.object({}).strict();
const page = z.object({ limit: z.string().regex(/^[1-9][0-9]*$(?![\s\S])/).transform(Number).pipe(z.number().int().max(50)).optional(),
  offset: z.string().regex(/^(0|[1-9][0-9]*)$(?![\s\S])/).transform(Number).pipe(z.number().int().max(10000)).optional() }).strict();
const errorCodes = new Set(['login_required', 'session_expired', 'csrf_rejected', 'onboarding_required', 'host_rejected', 'origin_rejected',
  'json_required', 'encoding_rejected', 'body_too_large', 'invalid_json', 'invalid_body', 'idempotency_required', 'invalid_version',
  'version_required', 'version_conflict', 'version_overflow', 'not_found', 'resource_not_found', 'principal_disabled', 'scope_disabled',
  'foundation_mapping_unavailable', 'scope_kind_unavailable', 'personal_scope_required', 'idempotency_conflict',
  'private_work_archived', 'private_work_persistence_denied', 'private_work_policy_unavailable', 'private_result_unavailable', 'asset_policy_changed']);

// Read-only fallback port, not a FakeObjectStore and never a legacy-content
// fallback. Services still authorize exact Work/Result and policy before GET.
const missingStore: ObjectStore = Object.freeze({
  async get() { throw new AssetStorageError('object_unavailable'); },
  async head() { throw new AssetStorageError('object_unavailable'); },
  async putImmutable() { throw new AssetStorageError('object_unavailable'); },
  async delete() { throw new AssetStorageError('object_unavailable'); },
});

function security(c: Context<PlatformEnv>) {
  c.header('Cache-Control', 'private, no-store'); c.header('Vary', 'Cookie');
  c.header('X-Content-Type-Options', 'nosniff'); c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Referrer-Policy', 'no-referrer'); c.header('Cross-Origin-Resource-Policy', 'same-origin');
}
function query(c: Context<PlatformEnv>): Record<string, string> {
  requireCondition(c.req.url.length <= 2048, 422, 'invalid_body', 'Invalid request.');
  const entries = c.req.queries(), result: Record<string, string> = Object.create(null);
  for (const [key, values] of Object.entries(entries)) {
    requireCondition(values.length === 1, 422, 'invalid_body', 'Invalid request.'); result[key] = values[0];
  }
  return result;
}
function commandHeaders(c: Context<PlatformEnv>, versionRequired: boolean) {
  const key = c.req.header('Idempotency-Key') ?? '', quoted = c.req.header('If-Match');
  requireCondition(key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key) && !/[\r\n]/.test(key),
    400, 'idempotency_required', 'Invalid request.');
  if (!versionRequired) {
    requireCondition(quoted === undefined, 400, 'invalid_version', 'Invalid request.'); return { key };
  }
  requireCondition(quoted !== undefined, 428, 'version_required', 'Current version required.');
  requireCondition(/^"[1-9][0-9]{0,18}"$/.test(quoted) && !/[\r\n]/.test(quoted)
    && BigInt(quoted.slice(1, -1)) <= 9223372036854775807n, 400, 'invalid_version', 'Invalid request.');
  return { key, expectedVersion: quoted.slice(1, -1) };
}

/** The only accepted JSON grammar is a flat object of string fields (or {}).
 * This is not a general JSON parser or canonicalization/digest implementation. */
function flatStringObject(raw: string): Record<string, string> {
  let index = 0; const result: Record<string, string> = Object.create(null);
  const invalid = (): never => { throw new Problem(400, 'invalid_json', 'Invalid JSON.'); };
  const space = () => { while (index < raw.length && /[ \t\r\n]/.test(raw[index])) index++; };
  const string = () => {
    const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
    token.lastIndex = index; const match = token.exec(raw); if (!match) return invalid();
    index = token.lastIndex;
    try { return JSON.parse(match[0]) as string; } catch { return invalid(); }
  };
  space(); if (raw[index++] !== '{') invalid(); space();
  if (raw[index] !== '}') for (;;) {
    const key = string();
    if (Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
    space(); if (raw[index++] !== ':') invalid(); space(); result[key] = string(); space();
    if (raw[index] === '}') break;
    if (raw[index++] !== ',') invalid(); space();
  }
  if (raw[index++] !== '}') invalid(); space(); if (index !== raw.length) invalid(); return result;
}
async function body(c: Context<PlatformEnv>) {
  const type = c.req.header('Content-Type') ?? '';
  requireCondition(/^application\/json(?:;\s*charset=utf-8)?$/i.test(type), 415, 'json_required', 'JSON required.');
  requireCondition(c.req.header('Content-Encoding') === undefined, 415, 'encoding_rejected', 'Content encoding unsupported.');
  const length = c.req.header('Content-Length');
  requireCondition(length === undefined || /^(0|[1-9][0-9]*)$/.test(length) && !/[\r\n]/.test(length) && Number(length) <= MAX_BODY,
    413, 'body_too_large', 'Body too large.');
  requireCondition(c.req.raw.body, 400, 'invalid_body', 'Body required.');
  let bytes: Uint8Array;
  try { bytes = await readBounded(c.req.raw.body, MAX_BODY); }
  catch (error) { throw new Problem(error instanceof AssetStorageError && error.code === 'too_large' ? 413 : 400,
    error instanceof AssetStorageError && error.code === 'too_large' ? 'body_too_large' : 'invalid_body', 'Invalid body.'); }
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Problem(400, 'invalid_json', 'Invalid JSON.'); }
  return flatStringObject(raw);
}
// Preserve the existing GET wire contract, including rejecting unsafe bigint.
function workDto(row: Record<string, unknown>) {
  const version = Number(row.aggregate_version);
  requireCondition(Number.isSafeInteger(version) && version >= 0, 500, 'version_overflow', 'Version unavailable.');
  return { work_item_id: row.work_item_id, title: row.title, objective: row.objective, state: row.state,
    aggregate_version: version, created_at: row.created_at };
}

/** CLOSED member-only transport. Not mounted by the production app/Worker.
 * Options are trusted construction-time server ports, never request fields.
 * No uploads, execution credentials, sharing, publication or policy override. */
export function createPrivateWorkTransport(pool: Pool, options: { origin: string; freedomEnv: FreedomEnv; store?: ObjectStore }) {
  const origins = allowedBrowserOrigins(options.freedomEnv, options.origin), hosts = allowedRequestHosts(options.freedomEnv, options.origin);
  const commands = createPrivateWorkCommands(pool, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
  const results = createPrivateResultService(pool, { store: options.store ?? missingStore, resolvePolicy: resolvePrivateWorkPersistencePolicy });
  const app = new Hono<PlatformEnv>();
  app.onError((error, c) => {
    security(c);
    let status = 500, code = 'internal_error';
    if (error instanceof z.ZodError) { status = 422; code = 'validation_failed'; }
    else if (error instanceof AssetStorageError) { status = 503; code = 'private_result_unavailable'; }
    else if (error instanceof Problem && errorCodes.has(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      status = error.status; code = error.code;
    }
    return c.json({ type: 'about:blank', title: code, status, code, detail: 'Request could not be completed.' }, status as 400);
  });
  app.use('*', async (c, next) => {
    security(c);
    requireCondition(hosts.has(new URL(c.req.url).hostname), 403, 'host_rejected', 'Host rejected.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireCondition(origins.has(c.req.header('Origin') ?? ''), 403, 'origin_rejected', 'Origin rejected.');
    await next();
  });
  app.use('*', memberBoundary(pool));
  app.get('/me/private-work', async c => {
    const value = await listPrivateWork(pool, c.get('actor'), query(c));
    return c.json({ items: value.items.map(workDto), total: value.total, limit: value.limit, offset: value.offset });
  });
  app.get('/me/private-work/:id', async c => {
    emptyBody.parse(query(c)); const id = OpaqueId.parse(c.req.param('id'));
    return c.json(workDto(await readPrivateWork(pool, c.get('actor'), id)));
  });
  app.post('/me/private-work', async c => {
    emptyBody.parse(query(c)); const headers = commandHeaders(c, false), input = editBody.parse(await body(c));
    const result = await commands.create(c.get('actor'), { ...headers, ...input });
    c.header('ETag', `"${result.aggregateVersion}"`); return c.json(result, 201);
  });
  app.post('/me/private-work/:id/edit', async c => {
    emptyBody.parse(query(c)); const workId = OpaqueId.parse(c.req.param('id')), headers = commandHeaders(c, true), input = editBody.parse(await body(c));
    const result = await commands.update(c.get('actor'), { ...headers, ...input, workId });
    c.header('ETag', `"${result.aggregateVersion}"`); return c.json(result);
  });
  app.post('/me/private-work/:id/archive', async c => {
    emptyBody.parse(query(c)); const workId = OpaqueId.parse(c.req.param('id')), headers = commandHeaders(c, true); emptyBody.parse(await body(c));
    const result = await commands.archive(c.get('actor'), { ...headers, workId });
    c.header('ETag', `"${result.aggregateVersion}"`); return c.json(result);
  });
  app.get('/me/private-work/:id/results', async c => {
    const workId = OpaqueId.parse(c.req.param('id')), pagination = page.parse(query(c));
    return c.json(await results.list(c.get('actor'), { workId, ...pagination }));
  });
  app.get('/me/private-work/:id/results/current', async c => {
    emptyBody.parse(query(c)); const workId = OpaqueId.parse(c.req.param('id'));
    return c.json(await results.readCurrent(c.get('actor'), { workId }));
  });
  app.get('/me/private-work/:id/results/:resultId', async c => {
    emptyBody.parse(query(c)); const workId = OpaqueId.parse(c.req.param('id')), resultId = OpaqueId.parse(c.req.param('resultId'));
    return c.json(await results.readResult(c.get('actor'), { workId, resultId }));
  });
  app.notFound(c => { security(c); return c.json({ type: 'about:blank', title: 'not_found', status: 404, code: 'not_found', detail: 'Not found.' }, 404); });
  return app;
}
