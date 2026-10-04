import { Hono } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PlatformEnv } from '../module-context.js';
import { listPrivateWork, readPrivateWork } from '../../../../modules/opportunity-project-work/private-work.js';

// Mounted only behind shared member session + onboarding middleware. There are
// deliberately no write, share, artifact, export, execution or service routes.
export function createPrivateWorkRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  app.use('/me/private-work*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    await next();
  });
  app.get('/me/private-work', async c => {
    // Reject duplicate keys rather than silently choosing one owner/scope/filter.
    const query = z.record(z.string(), z.array(z.string()).length(1)).parse(c.req.queries());
    return c.json(await listPrivateWork(pool, c.get('actor'), Object.fromEntries(Object.entries(query).map(([key, values]) => [key, values[0]]))));
  });
  app.get('/me/private-work/:id', async c => {
    z.object({}).strict().parse(c.req.query());
    // HEAD follows Hono's GET path and still executes current authorization.
    // Range/If-None-Match never produce a cached 206/304 or skip the ACL.
    return c.json(await readPrivateWork(pool, c.get('actor'), c.req.param('id')));
  });
  return app;
}
