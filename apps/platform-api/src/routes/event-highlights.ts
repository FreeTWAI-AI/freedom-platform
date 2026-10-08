import type {PlatformRuntime} from '../runtime.js';
import {Hono} from 'hono';
import {z} from 'zod';
import type {Pool} from 'pg';
import {requireCondition} from '../../../../packages/shared/problem.js';
import {authRateLimit} from '../../../../modules/identity-membership/members.js';
import {moduleCommand, type PlatformEnv} from '../module-context.js';
import {boundedMedia} from './community-events.js';
import {addHighlightImage, addHighlightLink, decodeMediaTitle, highlightBannerBytes, highlightImageBytes, highlightImageDigest, listHighlightEvents, normalizeHighlightImage, normalizeHighlightLink, readHighlightCursor, readHighlightEvent, readHighlightMode, removeHighlight} from '../../../../modules/community/event-highlights.js';
import {highlightsCss, highlightsDetailHtml, highlightsListHtml, highlightsNotFoundHtml} from '../../../../modules/community/event-highlights-page.js';
import {Problem} from '../../../../packages/shared/problem.js';
import {resolvePublicCommunity} from '../../../../modules/community/member-services.js';

const IMAGE_MAX = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isHighlightPhotoUpload(method: string, path: string) {
  return method === 'POST' && /^\/api\/v1\/event-highlights\/[0-9a-f-]{36}\/photos$/.test(path);
}
export function isHighlightPosterUpload(method: string, path: string) {
  return method === 'POST' && /^\/api\/v1\/event-highlights\/[0-9a-f-]{36}\/posters$/.test(path);
}
function checkHighlightImageUploadHeaders(contentType?: string, contentLength?: string) {
  requireCondition(IMAGE_TYPES.has(contentType ?? ''), 415, 'highlight_image_format', '請選擇 JPEG、PNG 或 WebP 圖片。');
  if (contentLength !== undefined) requireCondition(/^\d+$/.test(contentLength) && Number(contentLength) <= IMAGE_MAX, 413, 'highlight_image_too_large', '圖片需為 10 MiB 以下。');
}
export function checkHighlightPhotoUploadHeaders(contentType?: string, contentLength?: string) { checkHighlightImageUploadHeaders(contentType, contentLength); }
export function checkHighlightPosterUploadHeaders(contentType?: string, contentLength?: string) { checkHighlightImageUploadHeaders(contentType, contentLength); }

function webp(c: {header: (name: string, value: string) => void}, bytes: Buffer) {
  c.header('Content-Type', 'image/webp');
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  return new Uint8Array(bytes);
}

export function createEventHighlightPublicRoutes(pool: Pool, origin: string,runtime:Pick<PlatformRuntime,'eventHighlightAssetStore'|'eventBannerAssetStore'|'communityDiscoveryEnabled'> & Partial<Pick<PlatformRuntime,'registrationCommunityId'>>={}) {
  const app = new Hono();
  app.get('/highlights.css', c => { c.header('Content-Type', 'text/css; charset=utf-8'); return c.body(highlightsCss); });
  app.get('/highlights', async c => c.html(await highlightsListHtml(pool, origin, {mode: c.req.query('mode'), before: c.req.query('before')},runtime.communityDiscoveryEnabled===true?{publicOnly:true,communityId:await resolvePublicCommunity(pool,runtime.registrationCommunityId?.())}:undefined)));
  app.get('/api/v1/public/event-highlights/:eventId/banner', async c => c.body(webp(c, await highlightBannerBytes(pool, z.uuid().parse(c.req.param('eventId')),runtime.eventBannerAssetStore))));
  app.get('/api/v1/public/event-highlights/media/:mediaId/image', async c => c.body(webp(c, await highlightImageBytes(pool, z.uuid().parse(c.req.param('mediaId')), 'image',runtime.eventHighlightAssetStore))));
  app.get('/api/v1/public/event-highlights/media/:mediaId/thumb', async c => c.body(webp(c, await highlightImageBytes(pool, z.uuid().parse(c.req.param('mediaId')), 'thumb',runtime.eventHighlightAssetStore))));
  app.get('/highlights/:eventId', async c => {
    const eventId = c.req.param('eventId');
    if (!uuidPattern.test(eventId)) return c.html(highlightsNotFoundHtml(origin), 404);
    try { return c.html(await highlightsDetailHtml(pool, origin, eventId)); }
    catch (error) { if (error instanceof Problem && error.status === 404) return c.html(highlightsNotFoundHtml(origin), 404); throw error; }
  });
  return app;
}

export function createEventHighlightMemberRoutes(pool: Pool,runtime:Pick<PlatformRuntime,'eventHighlightAssets'>={}) {
  const app = new Hono<PlatformEnv>();
  app.get('/event-highlights', async c => {
    const actor = c.get('actor');
    return c.json(await listHighlightEvents(pool, {communityId: actor.community_id, viewerId: actor.user_id, mode: readHighlightMode(c.req.query('mode'), false), cursor: readHighlightCursor(c.req.query('cursor'), false)}));
  });
  app.get('/event-highlights/:eventId', async c => c.json(await readHighlightEvent(pool, {communityId: c.get('actor').community_id, viewerId: c.get('actor').user_id, eventId: z.uuid().parse(c.req.param('eventId'))})));
  app.post('/event-highlights/:eventId/links', async c => {
    const input = await moduleCommand(c);
    const eventId = z.uuid().parse(c.req.param('eventId'));
    normalizeHighlightLink(input.body);
    await authRateLimit(pool, 'event-highlight-link', c.get('actor').user_id, 20, 3600);
    return c.json(await addHighlightLink(pool, input, eventId), 201);
  });
  const upload = (kind: 'photo' | 'poster') => async (c: import('hono').Context<PlatformEnv>) => {
    const check = kind === 'photo' ? checkHighlightPhotoUploadHeaders : checkHighlightPosterUploadHeaders;
    check(c.req.header('Content-Type'), c.req.header('Content-Length'));
    const key = c.req.header('Idempotency-Key') ?? '';
    requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
    const orientation = c.req.header('X-Photo-Orientation');
    requireCondition(orientation === 'landscape' || orientation === 'portrait', 422, 'invalid_orientation', '請標明照片方向。');
    await authRateLimit(pool, 'event-highlight-image', c.get('actor').user_id, 30, 3600);
    const bytes = await boundedMedia(c.req.raw, IMAGE_MAX, '圖片需為 10 MiB 以下。');
    const title = decodeMediaTitle(c.req.header('X-Media-Title'));
    const eventId = z.uuid().parse(c.req.param('eventId'));
    const stored = await normalizeHighlightImage(bytes, c.req.header('Content-Type')!, orientation);
    const result = await addHighlightImage(pool, {actor: c.get('actor'), operation: `${c.req.method} ${c.req.path}`, key, body: highlightImageDigest(bytes, orientation, title)}, eventId, kind, stored.image, stored.thumb, orientation, title,runtime.eventHighlightAssets);
    return c.json(result, 201);
  };
  app.post('/event-highlights/:eventId/photos', upload('photo'));
  app.post('/event-highlights/:eventId/posters', upload('poster'));
  app.post('/event-highlights/media/:mediaId/remove', async c => c.json(await removeHighlight(pool, await moduleCommand(c), z.uuid().parse(c.req.param('mediaId')))));
  return app;
}
