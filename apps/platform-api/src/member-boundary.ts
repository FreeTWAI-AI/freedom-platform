import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { authenticate } from '../../../modules/identity-membership/service.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { PlatformEnv } from './module-context.js';

/** Shared existing member-cookie/CSRF/onboarding boundary. Origin/Host and
 * body limits belong to the host router. No pre-injected Actor is trusted. */
export function memberBoundary(pool: Pool, onboardingAllowed: (path: string, method: string) => boolean = () => false): MiddlewareHandler<PlatformEnv> {
  return async (c, next) => {
    const actor = await authenticate(pool, getCookie(c, 'freedom_local_session'));
    c.set('actor', actor);
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const got = Buffer.from(c.req.header('X-CSRF-Token') ?? ''), expected = Buffer.from(actor.csrf_token);
      requireCondition(got.length === expected.length && timingSafeEqual(got, expected), 403, 'csrf_rejected', '登入狀態已變更，請重新整理。');
    }
    requireCondition(!actor.onboarding_required || Boolean(actor.onboarding_completed_at) || onboardingAllowed(c.req.path, c.req.method),
      403, 'onboarding_required', '請先選擇主要公會，完成加入後即可使用會員功能。');
    await next();
  };
}
