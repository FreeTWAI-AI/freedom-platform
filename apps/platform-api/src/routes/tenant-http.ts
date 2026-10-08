import type { Context } from 'hono';
import { Problem } from '../../../../packages/shared/problem.js';
import type { PlatformEnv } from '../module-context.js';

export function privateCache(c: Context<PlatformEnv>) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Cookie');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
}

export function singleQuery(c: Context<PlatformEnv>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) throw new Problem(422, 'validation_failed', '查詢參數無效。');
    result[key] = values[0];
  }
  return result;
}

export function commandHeaders(c: Context<PlatformEnv>, versionRequired: boolean) {
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

export function etag(c: Context<PlatformEnv>, version: string) {
  c.header('ETag', `"${version}"`);
}

