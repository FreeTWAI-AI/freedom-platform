import { Hono, type Context } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireCondition } from '../../../../packages/shared/problem.js';
import type { AdminActor, AdminCommand } from '../../../../modules/platform-admin/service.js';
import { QUEUE_FILTERS } from '../../../../modules/repo-maintainer/policy.js';
import { receiveMaintainerWebhook } from '../../../../modules/repo-maintainer/webhook.js';
import { claimGuildReview, createGuildIssueHandoff, createGuildPullHandoff, guildReviewPull, listGuildReviews, releaseGuildReview } from '../../../../modules/repo-maintainer/guild-reviews.js';
import {
  assignReviewer, changeRepositoryOwnership, changeRepositorySettings, claimForSelf, createAdminIssueHandoff,
  createAdminPullHandoff, listReviewCenterPulls, listReviewCenterRepositories, listReviewers, pausePull, releaseClaim,
  resyncReviewCenterPull, resumePull, reviewCenterPull, reviewCenterSummary,
} from '../../../../modules/repo-maintainer/service.js';
import { moduleCommand, type PlatformEnv } from '../module-context.js';

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
  const handoffAdmin = async (c: Context<AdminEnv>): Promise<AdminCommand> => ({
    admin: c.get('admin'), operation: `${c.req.method} ${c.req.path}`, key: c.req.header('Idempotency-Key') ?? '', body: await c.req.json(),
  });
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
    const guild = c.req.query('guild_key');
    const guildKey = guild ? z.union([z.literal('none'), z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/)]).parse(guild) : null;
    const { limit, offset } = paging(c);
    return c.json(await listReviewCenterPulls(pool, c.get('admin'), filter, repositoryId, guildKey, limit, offset));
  });
  app.get('/review-center/pulls/:id', async c => {
    const value = await reviewCenterPull(pool, c.get('admin'), c.req.param('id'));
    c.header('ETag', `"${value.aggregate_version}"`);
    return c.json(value);
  });
  app.post('/review-center/pulls/:id/resync', async c => c.json(await resyncReviewCenterPull(pool, await command(c), c.req.param('id'))));
  app.post('/review-center/pulls/:id/claim', async c => result(c, await claimForSelf(pool, await command(c), c.req.param('id'))));
  app.post('/review-center/pulls/:id/assign', async c => result(c, await assignReviewer(pool, await command(c), c.req.param('id'))));
  app.post('/review-center/claims/:id/release', async c => result(c, await releaseClaim(pool, await command(c), c.req.param('id'))));
  app.post('/review-center/pulls/:id/pause', async c => result(c, await pausePull(pool, await command(c), c.req.param('id'))));
  app.post('/review-center/pulls/:id/resume', async c => result(c, await resumePull(pool, await command(c), c.req.param('id'))));
  app.post('/review-center/pulls/:id/handoffs', async c => c.json(await createAdminPullHandoff(pool, await handoffAdmin(c), c.req.param('id')), 201));
  app.post('/review-center/repositories/:id/issue-handoffs', async c => c.json(await createAdminIssueHandoff(pool, await handoffAdmin(c), c.req.param('id')), 201));
  app.get('/review-center/repositories', async c => c.json(await listReviewCenterRepositories(pool, c.get('admin'))));
  app.post('/review-center/repositories/:id/settings', async c => result(c, await changeRepositorySettings(pool, await command(c), c.req.param('id'))));
  app.post('/review-center/repositories/:id/ownership', async c => result(c, await changeRepositoryOwnership(pool, await command(c), c.req.param('id'))));
  app.get('/review-center/reviewers', async c => c.json(await listReviewers(pool, c.get('admin'))));
  return app;
}

/** Mount at /api/v1 next to guild workspace, after the shared session, Origin and CSRF middleware. */
export function createRepoMaintainerMemberRoutes(pool: Pool) {
  const app = new Hono<PlatformEnv>();
  const handoffMember = async (c: Context<PlatformEnv>) => ({
    actor: c.get('actor'), operation: `${c.req.method} ${c.req.path}`, key: c.req.header('Idempotency-Key') ?? '', body: await c.req.json(),
  });
  const paging = (c: Context<PlatformEnv>) => z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }).parse(c.req.query());
  app.get('/guild-reviews', async c => {
    const { limit, offset } = paging(c);
    return c.json(await listGuildReviews(pool, c.get('actor'), c.req.query('queue') ?? 'open', limit, offset));
  });
  app.post('/guild-reviews/claims/:claimId/release', async c => c.json(await releaseGuildReview(pool, await moduleCommand(c), c.req.param('claimId'))));
  app.post('/guild-reviews/repositories/:repositoryId/issue-handoffs', async c => c.json(await createGuildIssueHandoff(pool, await handoffMember(c), c.req.param('repositoryId')), 201));
  app.get('/guild-reviews/:pullId', async c => {
    const value = await guildReviewPull(pool, c.get('actor'), c.req.param('pullId'));
    c.header('ETag', `"${value.aggregate_version}"`);
    return c.json(value);
  });
  app.post('/guild-reviews/:pullId/handoffs', async c => c.json(await createGuildPullHandoff(pool, await handoffMember(c), c.req.param('pullId')), 201));
  app.post('/guild-reviews/:pullId/claim', async c => {
    const value = await claimGuildReview(pool, await moduleCommand(c), c.req.param('pullId'));
    c.header('ETag', `"${value.aggregate_version}"`);
    return c.json(value, 201);
  });
  return app;
}
