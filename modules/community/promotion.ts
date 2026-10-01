import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { isPreviewBot } from '../../packages/shared/promotion-bots.js';
import { PLATFORM_LABELS, type SocialPlatform } from '../../packages/shared/share-url.js';
import { escapeHtml } from '../development/service.js';
import { getSkillShareContent } from './skill-share-content.js';
import { communityCatalog } from './catalog.js';
import { readPublishedSkillSubmission } from '../skill-submissions/public.js';
import { getEventShareCode } from './events.js';
import { avatarUrl } from '../identity-membership/avatars.js';
import type { Actor } from '../identity-membership/service.js';

// Click totals are a display board, like the GitHub author boards.
// They are never written into XP, contributions, rewards or work records.
export const PROMOTION_KINDS = ['member_card', 'platform', 'skill_book', 'social_post', 'member_service', 'event'] as const;
export type PromotionKind = typeof PROMOTION_KINDS[number];
export type PromotionPeriod = 'week' | 'month' | 'all';
const UNAVAILABLE = new Set<PromotionKind>(['member_card', 'member_service']);
const VISITOR_CAP = 20;
const NETWORK_CAP = 60;
const LINK_CAP = 200;
const TAIPEI = 8 * 60 * 60 * 1000;

const PLATFORM_DESCRIPTION = '加入公會、領取 Repo 技能書，和夥伴一起供貨、開店與做開源作品。';
const platformOg = { title: '自由工坊', description: PLATFORM_DESCRIPTION, image: '/brand/freedom-workshop.webp', width: 1280, height: 720 };

export function taipeiParts(now: Date) {
  const shifted = new Date(now.getTime() + TAIPEI);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate(), weekday: shifted.getUTCDay() };
}
export function taipeiDate(now: Date) {
  const part = taipeiParts(now);
  return `${part.year}-${String(part.month + 1).padStart(2, '0')}-${String(part.day).padStart(2, '0')}`;
}
function taipeiMidnight(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day) - TAIPEI);
}
export function taipeiDayStart(now: Date) {
  const part = taipeiParts(now);
  return taipeiMidnight(part.year, part.month, part.day);
}
/** Week starts Monday 00:00 Asia/Taipei. Month starts on the 1st. `all` is null. */
export function periodStart(period: PromotionPeriod, now: Date): Date | null {
  if (period === 'all') return null;
  const part = taipeiParts(now);
  if (period === 'month') return taipeiMidnight(part.year, part.month, 1);
  const monday = part.day - (part.weekday === 0 ? 6 : part.weekday - 1);
  return taipeiMidnight(part.year, part.month, monday);
}

const periodSchema = z.enum(['week', 'month', 'all']);
const linkInput = z.object({
  kind: z.enum(PROMOTION_KINDS),
  target: z.string().min(1).max(80),
}).strict();

export type PromotionPoints = { week: number; month: number; all: number };
export type PromotionLinkView = { kind: PromotionKind; target: string; code: string; path: string; title: string; points: PromotionPoints };

function sha256(parts: Buffer[]) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

async function clickSalt(pool: Pool, day: string) {
  await pool.query('INSERT INTO promotion_click_salts(click_day, salt) VALUES($1,$2) ON CONFLICT DO NOTHING', [day, randomBytes(32)]);
  await pool.query('DELETE FROM promotion_click_salts WHERE click_day < $1::date - 3', [day]);
  return (await pool.query('SELECT salt FROM promotion_click_salts WHERE click_day=$1', [day])).rows[0].salt as Buffer;
}

type LinkRow = { link_id: string; community_id: string; user_id: string; kind: PromotionKind; target_key: string; code: string; revoked_at: Date | null; owner_active: boolean };

async function readLink(pool: Pool, code: string): Promise<LinkRow | null> {
  if (!/^[A-Za-z0-9_-]{10}$/.test(code)) return null;
  const row = (await pool.query(`SELECT l.link_id,l.community_id,l.user_id,l.kind,l.target_key,l.code,l.revoked_at,u.active AS owner_active
    FROM promotion_links l JOIN users u ON u.user_id=l.user_id WHERE l.code=$1`, [code])).rows[0];
  return row ?? null;
}

async function skillTarget(pool: Pool, target: string) {
  if (target.startsWith('book:')) {
    const id = target.slice(5);
    const book = /^[a-z0-9-]{1,64}$/.test(id) ? communityCatalog.skill_books.find(item => item.id === id) : undefined;
    requireCondition(book, 404, 'not_found', '找不到可分享的技能書。');
    return { title: book!.title, summary: book!.description };
  }
  requireCondition(/^submission:[0-9a-f-]{36}$/i.test(target), 422, 'validation_failed', '技能書目標不正確。');
  const submission = await readPublishedSkillSubmission(pool, target.slice(11));
  requireCondition(submission, 404, 'not_found', '找不到可分享的技能書。');
  return { title: submission!.title, summary: submission!.description };
}

async function assertTarget(pool: Pool, actor: Actor, kind: PromotionKind, target: string) {
  if (kind === 'platform') {
    requireCondition(target === 'workshop', 422, 'validation_failed', '平台分享目標不正確。');
    return '自由工坊';
  }
  if (kind === 'skill_book') return (await skillTarget(pool, target)).title;
  if (kind === 'event') {
    requireCondition(z.uuid().safeParse(target).success, 422, 'validation_failed', '活動目標不正確。');
    await getEventShareCode(pool, actor, target);
    const row = (await pool.query('SELECT title FROM community_events WHERE event_id=$1 AND community_id=$2', [target, actor.community_id])).rows[0];
    return (row?.title as string) || '社群活動';
  }
  if (kind === 'social_post') {
    requireCondition(z.uuid().safeParse(target).success, 422, 'validation_failed', '貼文目標不正確。');
    const row = (await pool.query(`SELECT title FROM community_social_posts WHERE post_id=$1 AND community_id=$2 AND state='active'`, [target, actor.community_id])).rows[0];
    requireCondition(row, 404, 'not_found', '找不到可分享的貼文。');
    return row.title as string;
  }
  throw new Problem(422, 'promotion_kind_unavailable', '這個分享方式尚未開放。');
}

async function pointsFor(q: Pool | PoolClient, linkId: string, now: Date): Promise<PromotionPoints> {
  const week = periodStart('week', now), month = periodStart('month', now);
  const row = (await q.query(`SELECT count(*) FILTER (WHERE created_at>=$2)::int AS week,
    count(*) FILTER (WHERE created_at>=$3)::int AS month, count(*)::int AS all_points
    FROM promotion_clicks WHERE link_id=$1`, [linkId, week, month])).rows[0];
  return { week: row.week, month: row.month, all: row.all_points };
}

function linkView(row: { kind: PromotionKind; target_key: string; code: string }, title: string, points: PromotionPoints): PromotionLinkView {
  return { kind: row.kind, target: row.target_key, code: row.code, path: `/go/${row.code}`, title, points };
}

export async function createPromotionLink(pool: Pool, actor: Actor, raw: unknown, now = new Date()): Promise<PromotionLinkView> {
  const body = linkInput.parse(raw);
  requireCondition(!UNAVAILABLE.has(body.kind), 422, 'promotion_kind_unavailable', '這個分享方式尚未開放。');
  const title = await assertTarget(pool, actor, body.kind, body.target);
  const day = taipeiDayStart(now);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await transaction(pool, async q => {
        await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`promo-link:${actor.user_id}:${taipeiDate(now)}`]);
        const existing = (await q.query(`SELECT link_id,kind,target_key,code FROM promotion_links
          WHERE community_id=$1 AND user_id=$2 AND kind=$3 AND target_key=$4 AND revoked_at IS NULL`, [actor.community_id, actor.user_id, body.kind, body.target])).rows[0];
        if (existing) return linkView(existing, title, await pointsFor(q, existing.link_id, now));
        const used = (await q.query('SELECT count(*)::int AS n FROM promotion_links WHERE user_id=$1 AND created_at>=$2', [actor.user_id, day])).rows[0].n as number;
        requireCondition(used < LINK_CAP, 429, 'promotion_link_limit', '今天建立的分享連結已達上限。');
        const code = randomBytes(7).toString('base64url');
        const inserted = (await q.query(`INSERT INTO promotion_links(community_id,user_id,kind,target_key,code,created_at)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING link_id,kind,target_key,code`, [actor.community_id, actor.user_id, body.kind, body.target, code, now])).rows[0];
        return linkView(inserted, title, { week: 0, month: 0, all: 0 });
      });
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'promotion_links_code_key') continue;
      if (pg.code === '23505') {
        const existing = (await pool.query(`SELECT link_id,kind,target_key,code FROM promotion_links
          WHERE community_id=$1 AND user_id=$2 AND kind=$3 AND target_key=$4 AND revoked_at IS NULL`, [actor.community_id, actor.user_id, body.kind, body.target])).rows[0];
        if (existing) return linkView(existing, title, await pointsFor(pool, existing.link_id, now));
      }
      throw error;
    }
  }
  throw new Problem(503, 'promotion_link_unavailable', '分享連結暫時無法建立，請稍後再試。');
}

async function titleOf(pool: Pool, actor: Actor, kind: PromotionKind, target: string) {
  try { return await assertTarget(pool, actor, kind, target); } catch { return kind === 'platform' ? '自由工坊' : '已無法開啟的分享'; }
}

export async function listMyPromotionLinks(pool: Pool, actor: Actor, periodRaw: string | undefined, now = new Date()) {
  const period = periodSchema.parse(periodRaw ?? 'week');
  const since = periodStart(period, now);
  const rows = (await pool.query(`SELECT l.link_id,l.kind,l.target_key,l.code,l.created_at,
    count(c.link_id) FILTER (WHERE $3::timestamptz IS NULL OR c.created_at>=$3)::int AS points
    FROM promotion_links l LEFT JOIN promotion_clicks c ON c.link_id=l.link_id
    WHERE l.community_id=$1 AND l.user_id=$2 AND l.revoked_at IS NULL
    GROUP BY l.link_id ORDER BY points DESC,l.created_at DESC LIMIT 100`, [actor.community_id, actor.user_id, since])).rows as { link_id: string; kind: PromotionKind; target_key: string; code: string; points: number }[];
  const items = [];
  for (const row of rows) items.push({ ...linkView(row, await titleOf(pool, actor, row.kind, row.target_key), await pointsFor(pool, row.link_id, now)), period_points: row.points });
  return { period, since: since?.toISOString() ?? null, items };
}

type Scored = { user_id: string; display_name: string; points: number; rank: number; avatar_url: string | null };

export async function promotionLeaderboards(pool: Pool, actor: Actor, periodRaw: string | undefined, now = new Date()) {
  const period = periodSchema.parse(periodRaw ?? 'week');
  const since = periodStart(period, now);
  const rows = (await pool.query(`SELECT c.kind,c.user_id,u.display_name,count(*)::int AS points,
    a.aggregate_version,a.image_bytes IS NOT NULL AS has_avatar
    FROM promotion_clicks c
    JOIN users u ON u.user_id=c.user_id AND u.community_id=c.community_id
    LEFT JOIN member_avatars a ON a.user_id=u.user_id AND a.community_id=u.community_id
    WHERE c.community_id=$1 AND ($2::timestamptz IS NULL OR c.created_at>=$2)
      AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND (u.user_id=$3 OR NOT is_verification_test_account(u.user_id))
    GROUP BY c.kind,c.user_id,u.display_name,a.aggregate_version,a.image_bytes`, [actor.community_id, since, actor.user_id])).rows as { kind: PromotionKind; user_id: string; display_name: string; points: number; aggregate_version: string | null; has_avatar: boolean }[];
  const boards = PROMOTION_KINDS.map(kind => {
    const scored: Scored[] = rows.filter(row => row.kind === kind).map(row => ({
      user_id: row.user_id, display_name: row.display_name, points: row.points, rank: 0,
      avatar_url: avatarUrl(row.user_id, row.aggregate_version ?? 1, row.has_avatar),
    })).sort((a, b) => b.points - a.points || a.display_name.localeCompare(b.display_name, 'zh-Hant') || a.user_id.localeCompare(b.user_id));
    scored.forEach((row, index) => { row.rank = index === 0 || row.points !== scored[index - 1].points ? index + 1 : scored[index - 1].rank; });
    const mine = scored.find(row => row.user_id === actor.user_id);
    return { kind, items: scored.slice(0, 10).map(({ user_id, display_name, avatar_url, rank, points }) => ({ rank, user_id, display_name, avatar_url, points })), me: mine && mine.points > 0 ? { rank: mine.rank, points: mine.points } : null };
  });
  return { period, since: since?.toISOString() ?? null, boards };
}

async function eventStillShared(pool: Pool, id: string) {
  const row = (await pool.query(`SELECT e.title,e.description,e.visibility,e.state,
    b.event_id IS NOT NULL AS has_banner,is_verification_test_account(e.organizer_ref) AS test_host
    FROM community_events e LEFT JOIN community_event_banners b ON b.event_id=e.event_id WHERE e.event_id=$1`, [id])).rows[0];
  if (!row || row.state !== 'published') return null;
  return row as { title: string; description: string; visibility: string; has_banner: boolean; test_host: boolean };
}

async function shareable(pool: Pool, link: LinkRow) {
  if (link.revoked_at || !link.owner_active) return false;
  if (link.kind === 'platform') return link.target_key === 'workshop';
  if (link.kind === 'skill_book') {
    if (link.target_key.startsWith('book:')) return communityCatalog.skill_books.some(item => item.id === link.target_key.slice(5));
    if (/^submission:[0-9a-f-]{36}$/i.test(link.target_key)) return Boolean(await readPublishedSkillSubmission(pool, link.target_key.slice(11)));
    return false;
  }
  if (link.kind === 'event') return Boolean(await eventStillShared(pool, link.target_key));
  if (link.kind === 'social_post') {
    const row = (await pool.query(`SELECT 1 FROM community_social_posts WHERE post_id=$1 AND community_id=$2 AND state='active'`, [link.target_key, link.community_id])).rows[0];
    return Boolean(row);
  }
  return false;
}

function introNumber(raw: string | undefined) {
  if (!raw || !/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= 999 ? value : null;
}

type OpenTarget = { href: string; title: string; description: string; image?: { url: string; width: number; height: number } };

async function openTarget(pool: Pool, link: LinkRow, introRaw: string | undefined, origin: string): Promise<OpenTarget | null> {
  if (!await shareable(pool, link)) return null;
  if (link.kind === 'platform') return { href: '/', title: platformOg.title, description: platformOg.description, image: { url: origin + platformOg.image, width: platformOg.width, height: platformOg.height } };
  if (link.kind === 'skill_book') {
    const intro = introNumber(introRaw);
    const query = intro ? `?intro=${intro}` : '';
    if (link.target_key.startsWith('book:')) {
      const id = link.target_key.slice(5);
      const book = communityCatalog.skill_books.find(item => item.id === id)!;
      const content = getSkillShareContent(id);
      const chosen = intro && content && intro <= content.introductions.length ? content.introductions[intro - 1] : null;
      const image = content ? { url: origin + content.illustration_url, width: 1200, height: 630 } : undefined;
      return { href: `/development/skills/${encodeURIComponent(id)}${query}`, title: book.title, description: chosen || book.description, image };
    }
    const submission = (await readPublishedSkillSubmission(pool, link.target_key.slice(11)))!;
    const chosen = intro && intro <= submission.share_introductions.length ? submission.share_introductions[intro - 1] : null;
    const image = submission.illustration_url ? { url: origin + submission.illustration_url, width: 1200, height: 630 } : undefined;
    return { href: `/development/submissions/${submission.submission_id}${query}`, title: submission.title, description: chosen || submission.description, image };
  }
  if (link.kind === 'event') {
    const event = (await eventStillShared(pool, link.target_key))!;
    const code = (await pool.query('SELECT code FROM community_event_share_codes WHERE event_id=$1 AND user_id=$2', [link.target_key, link.user_id])).rows[0]?.code as string | undefined;
    const href = `/events/${link.target_key}${code ? `?ref=${encodeURIComponent(code)}` : ''}`;
    const open = event.visibility === 'referral' || event.visibility === 'open';
    if (!open) return { href, title: '自由工坊會員活動', description: '登入自由工坊查看活動內容。' };
    const image = event.has_banner && !event.test_host ? { url: `${origin}/api/v1/public/events/${link.target_key}/banner`, width: 1200, height: 675 } : undefined;
    return { href, title: event.title, description: event.description.slice(0, 160), image };
  }
  const post = (await pool.query(`SELECT post_id,url,title,platform FROM community_social_posts WHERE post_id=$1 AND state='active'`, [link.target_key])).rows[0] as { post_id: string; url: string; title: string; platform: SocialPlatform } | undefined;
  if (!post) return null;
  const thumb = (await pool.query('SELECT 1 FROM community_social_post_thumbnails WHERE post_id=$1', [post.post_id])).rowCount;
  return {
    href: post.url, title: post.title,
    description: `自由工坊社群分享的 ${PLATFORM_LABELS[post.platform] ?? '其他'} 貼文`,
    image: thumb ? { url: `${origin}/api/v1/public/social-posts/${post.post_id}/thumbnail`, width: 640, height: 360 } : undefined,
  };
}

function goHtml(code: string, target: OpenTarget) {
  const title = escapeHtml(target.title);
  const description = escapeHtml(target.description);
  const href = escapeHtml(target.href);
  const image = target.image ? `<meta property="og:image" content="${escapeHtml(target.image.url)}"><meta property="og:image:width" content="${target.image.width}"><meta property="og:image:height" content="${target.image.height}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escapeHtml(target.image.url)}">` : '<meta name="twitter:card" content="summary">';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在開啟：${title}｜自由工坊</title><meta name="robots" content="noindex,nofollow"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:site_name" content="自由工坊"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}">${image}<link rel="stylesheet" href="/go.css"></head><body><main data-code="${escapeHtml(code)}" data-target="${href}"><p>正在前往「${title}」…</p><p><a href="${href}">沒有自動前往？請點這裡</a></p></main><script src="/go.js" defer></script></body></html>`;
}

export async function promotionGo(pool: Pool, code: string, intro: string | undefined, origin: string) {
  const link = await readLink(pool, code);
  if (!link) return null;
  const target = await openTarget(pool, link, intro, origin);
  if (!target) return null;
  return goHtml(code, target);
}

export async function creditPromotionClick(pool: Pool, input: { code: string; userAgent: string; network: string; sessionUserId: string | null; now: Date }) {
  const link = await readLink(pool, input.code);
  if (!link || !await shareable(pool, link)) return;
  if (isPreviewBot(input.userAgent)) return;
  if (input.sessionUserId && input.sessionUserId === link.user_id) return;
  const day = taipeiDate(input.now);
  const salt = await clickSalt(pool, day);
  const visitor = input.sessionUserId ? `m:${input.sessionUserId}` : `v:${sha256([salt, Buffer.from(input.network), Buffer.from(input.userAgent)])}`;
  const network = sha256([salt, Buffer.from(input.network)]);
  await transaction(pool, async q => {
    for (const name of [`promo-v:${visitor}`, `promo-n:${network}`].sort()) await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [name]);
    const visitorCount = (await q.query('SELECT count(*)::int AS n FROM promotion_clicks WHERE click_day=$1 AND visitor_key=$2', [day, visitor])).rows[0].n as number;
    const networkCount = (await q.query('SELECT count(*)::int AS n FROM promotion_clicks WHERE click_day=$1 AND network_key=$2', [day, network])).rows[0].n as number;
    if (visitorCount >= VISITOR_CAP || networkCount >= NETWORK_CAP) return;
    await q.query(`INSERT INTO promotion_clicks(link_id,click_day,visitor_key,network_key,community_id,user_id,kind,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [link.link_id, day, visitor, network, link.community_id, link.user_id, link.kind, input.now]);
  });
}

