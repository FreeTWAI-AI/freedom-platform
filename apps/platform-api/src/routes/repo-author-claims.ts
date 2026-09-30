import {Hono} from 'hono';
import {z} from 'zod';
import type {Pool} from 'pg';
import type {Actor} from '../../../../modules/identity-membership/service.js';
import type {Command} from '../../../../packages/db/index.js';
import {requireCondition} from '../../../../packages/shared/problem.js';
import {appealAuthorClaim, memberAuthorClaim, publicAuthorClaimForBook, publicAuthorClaims, submitAuthorClaim, withdrawAuthorClaim} from '../../../../modules/community/repo-author-claims.js';

const bookId = z.string().regex(/^[a-z0-9-]{1,100}$/);
function commandInput(c: {req: {method: string; path: string; header: (name: string) => string | undefined}; get: (key: 'actor') => Actor}, body: unknown): Command {
  const ifMatch = c.req.header('If-Match');
  if (ifMatch) requireCondition(/^"[1-9][0-9]*"$/.test(ifMatch), 400, 'invalid_version', 'If-Match 須為加引號的整數版本。');
  return {actor: c.get('actor'), operation: `${c.req.method} ${c.req.path}`, key: c.req.header('Idempotency-Key') ?? '', body, expected: ifMatch?.slice(1, -1)};
}
function etag(c: {header: (name: string, value: string) => void}, value: {version?: number}) {
  if (value?.version) c.header('ETag', `"${value.version}"`);
  return value;
}

export function createPublicAuthorClaimRoutes(pool: Pool) {
  const app = new Hono();
  app.get('/skills/author-claims', async c => c.json(await publicAuthorClaims(pool)));
  app.get('/skills/:id/author-claim', async c => c.json(await publicAuthorClaimForBook(pool, bookId.parse(c.req.param('id')))));
  return app;
}
export function createMemberAuthorClaimRoutes(pool: Pool, fetcher: typeof fetch = globalThis.fetch) {
  const app = new Hono<{Variables: {actor: Actor}}>();
  app.get('/me/skill-books/:id/author-claim', async c => c.json(await memberAuthorClaim(pool, c.get('actor'), bookId.parse(c.req.param('id')))));
  app.post('/me/skill-books/:id/author-claims', async c => {
    const value = await submitAuthorClaim(pool, commandInput(c, await c.req.json()), bookId.parse(c.req.param('id')), fetcher);
    return c.json(etag(c, value), 201);
  });
  app.post('/me/author-claims/:id/withdraw', async c => c.json(etag(c, await withdrawAuthorClaim(pool, commandInput(c, await c.req.json()), z.uuid().parse(c.req.param('id'))))));
  app.post('/me/author-claims/:id/appeal', async c => c.json(etag(c, await appealAuthorClaim(pool, commandInput(c, await c.req.json()), z.uuid().parse(c.req.param('id'))))));
  return app;
}
