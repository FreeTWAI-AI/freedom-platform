import type { MiddlewareHandler } from 'hono';
import { readSessionCookie } from './session-cookie.js';
import { timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { authenticate } from '../../../modules/identity-membership/service.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { PlatformEnv } from './module-context.js';

/** Shared existing member-cookie/CSRF/onboarding boundary. Origin/Host and
 * body limits belong to the host router. No pre-injected Actor is trusted. */
export function memberBoundary(pool: Pool, origin: string, onboardingAllowed: (path: string, method: string) => boolean = () => false): MiddlewareHandler<PlatformEnv> {
  return async (c, next) => {
    const actor = await authenticate(pool, readSessionCookie(c.req.header('Cookie'),origin));
    c.set('actor', actor);
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      // Legacy schema only says NOT NULL. A malformed stored empty token must
      // not make an absent/empty request header pass the zero-byte comparison.
      requireCondition(typeof actor.csrf_token === 'string' && actor.csrf_token.length > 0,
        403, 'csrf_rejected', '登入狀態已變更，請重新整理。');
      const got = Buffer.from(c.req.header('X-CSRF-Token') ?? ''), expected = Buffer.from(actor.csrf_token);
      requireCondition(got.length === expected.length && timingSafeEqual(got, expected), 403, 'csrf_rejected', '登入狀態已變更，請重新整理。');
    }
    requireCondition(!actor.onboarding_required || Boolean(actor.onboarding_completed_at) || onboardingAllowed(c.req.path, c.req.method),
      403, 'onboarding_required', '請先選擇主要公會，完成加入後即可使用會員功能。');
    await next();
  };
}
