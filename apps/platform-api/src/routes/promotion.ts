import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Pool } from 'pg';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { digest, type Command } from '../../../../packages/db/index.js';
import { authRateLimit } from '../../../../modules/identity-membership/members.js';
import { authenticate } from '../../../../modules/identity-membership/service.js';
import { previewLink } from '../../../../modules/community/link-preview.js';
import { createPromotionLink, creditPromotionClick, listMyPromotionLinks, promotionGo, promotionLeaderboards } from '../../../../modules/community/promotion.js';
import { SocialPostExists, activeSocialPostId, createSocialPost, deleteSocialPost, hideSocialPost, listSocialPosts, publicSocialThumbnail, readSocialThumbnail, saveSocialThumbnail, socialPostDraft } from '../../../../modules/community/social-posts.js';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import type { PlatformRuntime } from '../runtime.js';

const COOKIE = 'freedom_local_session';
const THUMB_MAX = 512 * 1024;
const THUMB_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isSocialThumbnailUpload(method: string, path: string) {
  return method === 'PUT' && /^\/api\/v1\/social-posts\/[0-9a-f-]{36}\/thumbnail$/.test(path);
}
export function checkSocialThumbnailHeaders(contentType?: string, contentLength?: string) {
  requireCondition(THUMB_TYPES.has(contentType ?? ''), 415, 'social_thumbnail_format', '請選擇 JPEG、PNG 或 WebP 圖片。');
  if (contentLength !== undefined) requireCondition(/^\d+$/.test(contentLength) && Number(contentLength) <= THUMB_MAX, 413, 'social_thumbnail_too_large', '縮圖需為 512 KiB 以下。');
}

async function optionalUser(pool: Pool, raw: string | undefined) {
  try { return (await authenticate(pool, raw)).user_id; }
  catch (error) { if (error instanceof Problem && error.status === 401) return null; throw error; }
}

async function storedSocialPost(pool: Pool, input: Command) {
  const hash = digest({ body: input.body, expected: input.expected ?? null });
  const prior = (await pool.query('SELECT request_sha256,response FROM command_receipts WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3', [input.actor.user_id, input.operation, input.key])).rows[0];
  if (!prior) return null;
  requireCondition(prior.request_sha256 === hash, 409, 'idempotency_conflict', '同一操作識別碼不可搭配不同內容。');
  return prior.response as Record<string, unknown>;
}

async function bounded(request: Request) {
  const reader = request.body?.getReader();
  requireCondition(reader, 422, 'invalid_social_thumbnail', '請先選擇縮圖。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCondition(size <= THUMB_MAX, 413, 'social_thumbnail_too_large', '縮圖需為 512 KiB 以下。');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  requireCondition(size > 0, 422, 'invalid_social_thumbnail', '請先選擇縮圖。');
  return Buffer.concat(chunks, size);
}

function clock(runtime: PlatformRuntime) { return runtime.now?.() ?? new Date(); }
function previewFetch(runtime: PlatformRuntime) {
  return runtime.linkPreviewFetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
}

export function registerPublicPromotion(app: Hono<PlatformEnv>, pool: Pool, runtime: PlatformRuntime) {
  app.get('/go/:code', async c => {
    c.header('X-Robots-Tag', 'noindex, nofollow');
    c.header('Cache-Control', 'no-store');
    const html = await promotionGo(pool, c.req.param('code'), c.req.query('intro'), runtime.publicOrigin);
    if (!html) return c.redirect('/', 302);
    return c.html(html);
  });
  app.post('/api/v1/promotion/clicks', async c => {
    await authRateLimit(pool, 'promotion-click-network', runtime.sourceNetwork(c), 300, 3600);
    const body = z.object({ code: z.string().max(80) }).strict().parse(await c.req.json());
    const sessionUserId = await optionalUser(pool, getCookie(c, COOKIE));
    await creditPromotionClick(pool, { code: body.code, userAgent: c.req.header('User-Agent') ?? '', network: runtime.sourceNetwork(c), sessionUserId, now: clock(runtime) });
    return c.json({ ok: true });
  });
  app.get('/api/v1/public/social-posts/:id/thumbnail', async c => {
    const bytes = await publicSocialThumbnail(pool, z.uuid().parse(c.req.param('id')));
    c.header('Content-Type', 'image/webp');
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    return c.body(new Uint8Array(bytes));
  });
}

export function registerMemberPromotion(app: Hono<PlatformEnv>, pool: Pool, runtime: PlatformRuntime) {
  app.post('/api/v1/promotion/links', async c => c.json(await createPromotionLink(pool, c.get('actor'), await c.req.json(), clock(runtime))));
  app.get('/api/v1/promotion/links/mine', async c => c.json(await listMyPromotionLinks(pool, c.get('actor'), c.req.query('period'), clock(runtime))));
  app.get('/api/v1/promotion/leaderboards', async c => c.json(await promotionLeaderboards(pool, c.get('actor'), c.req.query('period'), clock(runtime))));
  app.get('/api/v1/social-posts', async c => c.json(await listSocialPosts(pool, c.get('actor'), { platform: c.req.query('platform'), cursor: c.req.query('cursor') })));
  app.post('/api/v1/social-posts', async c => {
    const commandInput = await moduleCommand(c);
    const draft = socialPostDraft(commandInput.body, runtime.publicOrigin);
    requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(commandInput.key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
    const existing = await activeSocialPostId(pool, commandInput.actor.community_id, draft.normalized.url);
    if (existing) {
      const replay = await storedSocialPost(pool, commandInput);
      if (replay) return c.json(replay, 201);
      return c.json({ type: 'about:blank', title: 'social_post_exists', status: 409, code: 'social_post_exists', detail: '這則貼文已經有人分享過了。', post_id: existing }, 409);
    }
    await authRateLimit(pool, 'social-post-preview', commandInput.actor.user_id, 30, 3600);
    const preview = await previewLink(draft.normalized.url, previewFetch(runtime));
    try { return c.json(await createSocialPost(pool, commandInput, preview, clock(runtime), runtime.publicOrigin), 201); }
    catch (error) {
      if (error instanceof SocialPostExists) return c.json({ type: 'about:blank', title: 'social_post_exists', status: 409, code: 'social_post_exists', detail: '這則貼文已經有人分享過了。', post_id: error.post_id }, 409);
      throw error;
    }
  });
  app.get('/api/v1/social-posts/:id/thumbnail', async c => {
    const bytes = await readSocialThumbnail(pool, c.get('actor'), z.uuid().parse(c.req.param('id')));
    c.header('Content-Type', 'image/webp');
    c.header('Cache-Control', 'private, no-store');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    return c.body(new Uint8Array(bytes));
  });
  app.put('/api/v1/social-posts/:id/thumbnail', async c => {
    checkSocialThumbnailHeaders(c.req.header('Content-Type'), c.req.header('Content-Length'));
    const key = c.req.header('Idempotency-Key') ?? '';
    requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
    await authRateLimit(pool, 'social-thumbnail-member', c.get('actor').user_id, 20, 3600);
    const bytes = await bounded(c.req.raw);
    return c.json(await saveSocialThumbnail(pool, { actor: c.get('actor'), operation: `${c.req.method} ${c.req.path}`, key, body: null }, z.uuid().parse(c.req.param('id')), { bytes, mime: c.req.header('Content-Type')! }, clock(runtime)));
  });
  app.delete('/api/v1/social-posts/:id', async c => c.json(await deleteSocialPost(pool, await moduleCommand(c), z.uuid().parse(c.req.param('id')), clock(runtime))));
  app.post('/api/v1/social-posts/:id/hide', async c => c.json(await hideSocialPost(pool, await moduleCommand(c), z.uuid().parse(c.req.param('id')), clock(runtime))));
}
