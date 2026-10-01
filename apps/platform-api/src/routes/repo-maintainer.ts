import { Hono, type Context } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireCondition } from '../../../../packages/shared/problem.js';
import type { AdminActor, AdminCommand } from '../../../../modules/platform-admin/service.js';
import { QUEUE_FILTERS } from '../../../../modules/repo-maintainer/policy.js';
import { receiveMaintainerWebhook } from '../../../../modules/repo-maintainer/webhook.js';
import {
  appointReviewer, changeRepositorySettings, changeReviewer, listReviewCenterPulls, listReviewCenterRepositories,
  listReviewers, resyncReviewCenterPull, reviewCenterPull, reviewCenterSummary, reviewerCandidates,
} from '../../../../modules/repo-maintainer/service.js';

export const MAINTAINER_WEBHOOK_PATH = '/api/v1/maintainer/github/webhook';

/** Exact POST only. A trailing slash or a longer path keeps the normal body rules. */
export function isMaintainerWebhookPath(method: string, path: string): boolean {
  return method === 'POST' && path === MAINTAINER_WEBHOOK_PATH;
}

export function createMaintainerWebhookRoutes(pool: Pool, secret: () => string | undefined) {
  const app = new Hono();
  app.post(MAINTAINER_WEBHOOK_PATH, async c => c.json(await receiveMaintainerWebhook(pool, c.req.raw, secret()), 202));
  return app;
}

type AdminEnv = { Variables: { admin: AdminActor; adminCsrf: string } };

/** Mount inside createAdminRoutes, after Access and admin CSRF, before the catch-all. */
export function createRepoMaintainerAdminRoutes(pool: Pool) {
  const app = new Hono<AdminEnv>();
  const command = async (c: Context<AdminEnv>): Promise<AdminCommand> => {
    const version = c.req.header('If-Match');
    if (version) requireCondition(/^"[1-9][0-9]*"$/.test(version), 400, 'invalid_version', 'If-Match 須為加引號的整數版本。');
    return { admin: c.get('admin'), operation: `${c.req.method} ${c.req.path}`, key: c.req.header('Idempotency-Key') ?? '', body: await c.req.json(), expected: version?.slice(1, -1) };
  };
  const result = (c: Context<AdminEnv>, value: { aggregate_version?: string | number }) => {
    if (value.aggregate_version) c.header('ETag', `"${value.aggregate_version}"`);
    return c.json(value);
  };
  const paging = (c: Context<AdminEnv>) => z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }).parse(c.req.query());
  app.get('/review-center/summary', async c => c.json(await reviewCenterSummary(pool, c.get('admin'))));
  app.get('/review-center/pulls', async c => {
    const filter = z.enum(QUEUE_FILTERS).parse(c.req.query('queue') ?? 'open');
    const repository = c.req.query('repository_id');
    const repositoryId = repository ? z.uuid().parse(repository) : null;
    const { limit, offset } = paging(c);
    return c.json(await listReviewCenterPulls(pool, c.get('admin'), filter, repositoryId, limit, offset));
  });
  app.get('/review-center/pulls/:id', async c => {
    const value = await reviewCenterPull(pool, c.get('admin'), c.req.param('id'));
    c.header('ETag', `"${value.aggregate_version}"`);
    return c.json(value);
  });
  app.post('/review-center/pulls/:id/resync', async c => c.json(await resyncReviewCenterPull(pool, await command(c), c.req.param('id'))));
  app.get('/review-center/repositories', async c => c.json(await listReviewCenterRepositories(pool, c.get('admin'))));
  app.post('/review-center/repositories/:id/settings', async c => result(c, await changeRepositorySettings(pool, await command(c), c.req.param('id'))));
  app.get('/review-center/reviewers', async c => c.json(await listReviewers(pool, c.get('admin'))));
  app.get('/review-center/reviewer-candidates', async c => c.json(await reviewerCandidates(pool, c.get('admin'), z.string().trim().max(100).parse(c.req.query('q') ?? ''))));
  app.post('/review-center/reviewers', async c => result(c, await appointReviewer(pool, await command(c))));
  app.post('/review-center/reviewers/:id', async c => result(c, await changeReviewer(pool, await command(c), c.req.param('id'))));
  return app;
}
