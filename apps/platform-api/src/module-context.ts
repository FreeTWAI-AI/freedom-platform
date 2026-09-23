import type { Context } from 'hono';
import type { Actor } from '../../../modules/identity-membership/service.js';
import type { Command } from '../../../packages/db/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';

export type PlatformEnv = { Variables: { actor: Actor } };

// Module routes are mounted after the shared session, Origin and CSRF middleware.
export async function moduleCommand(c: Context<PlatformEnv>): Promise<Command> {
  const version = c.req.header('If-Match');
  if (version) requireCondition(/^"[1-9][0-9]*"$/.test(version), 400, 'invalid_version', '請提供有效的資料版本。');
  return {
    actor: c.get('actor'), operation: `${c.req.method} ${c.req.path}`,
    key: c.req.header('Idempotency-Key') ?? '', body: await c.req.json(), expected: version?.slice(1, -1),
  };
}
