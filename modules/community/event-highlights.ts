import {createHash, randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {z} from 'zod';
import {command, journal, type Command} from '../../packages/db/index.js';
import type {Actor} from '../identity-membership/service.js';
import {readDomainMedia,type DomainMediaSnapshot} from '../../packages/media-migration/domain-bridge.js';
import type {ObjectStore} from '../../packages/asset-storage/index.js';
import {highlightStorageMode,type EventHighlightAssetService} from '../assets/event-highlight.js';
import {Problem, requireCondition} from '../../packages/shared/problem.js';
import {normalizeImage} from '../../packages/shared/image-runtime.js';
import {youtubeThumbnailUrl, youtubeVideoId} from '../../packages/shared/youtube-video-id.js';
import {avatarUrl} from '../identity-membership/avatars.js';
import {privateHost} from '../identity-membership/social-links.js';
import {rasterFormat, rejectAnimation} from '../skill-submissions/payload.js';

const PAGE_SIZE = 12;
const IMAGE_MAX = 10 * 1024 * 1024;
const IMAGE_VARIANT_MAX = 1024 * 1024;
const THUMB_MAX = 200 * 1024;
const control = /[\u0000-\u001f\u007f]/;
const tracking = /^(utm_|fbclid$|igshid$|si$)/i;
export const highlightPlatforms = ['youtube','facebook','instagram','threads','tiktok','x','vimeo','google_drive','google_photos','other'] as const;
export type HighlightPlatform = typeof highlightPlatforms[number];
export type HighlightMode = 'all' | 'online' | 'in_person';
type HighlightKind = 'link' | 'photo' | 'poster';
type Orientation = 'landscape' | 'portrait';
const limits: Record<HighlightKind, {mine: number; event: number; unit: string}> = {
  link: {mine: 10, event: 60, unit: '則連結'},
  photo: {mine: 30, event: 120, unit: '張照片'},
  poster: {mine: 3, event: 10, unit: '張海報'},
};
const defaultTitles: Record<HighlightPlatform, string> = {
  youtube: 'YouTube 影片', facebook: 'Facebook 影片', instagram: 'Instagram 貼文', threads: 'Threads 貼文',
  tiktok: 'TikTok 影片', x: 'X 貼文', vimeo: 'Vimeo 影片', google_drive: '雲端硬碟影片', google_photos: 'Google 相簿', other: '相關連結',
};
const platformHosts: [HighlightPlatform, string[]][] = [
  ['youtube', ['youtube.com', 'youtu.be']],
  ['facebook', ['facebook.com', 'fb.watch']],
  ['instagram', ['instagram.com']],
  ['threads', ['threads.net', 'threads.com']],
  ['tiktok', ['tiktok.com']],
  ['x', ['x.com', 'twitter.com']],
  ['vimeo', ['vimeo.com']],
  ['google_drive', ['drive.google.com']],
  ['google_photos', ['photos.google.com', 'photos.app.goo.gl']],
];
const linkBody = z.object({url: z.string().max(3000), title: z.string().max(400).optional()}).strict();
const preparedLink = z.object({url: z.string().min(1).max(2048), title: z.string().min(1).max(120), platform: z.enum(highlightPlatforms)}).strict();

function hostIs(host: string, domain: string) { return host === domain || host.endsWith('.' + domain); }
export function classifyHighlightPlatform(host: string): HighlightPlatform {
  const name = host.toLowerCase().replace(/\.$/, '');
  return platformHosts.find(([, domains]) => domains.some(domain => hostIs(name, domain)))?.[0] ?? 'other';
}
export function cleanHighlightTitle(raw: unknown): string | null {
  if (raw == null) return null;
  requireCondition(typeof raw === 'string', 422, 'highlight_title_invalid', '標題請使用 1 到 120 個字。');
  const value = raw.normalize('NFC').trim();
  if (!value) return null;
  requireCondition(!control.test(value) && [...value].length <= 120, 422, 'highlight_title_invalid', '標題請使用 1 到 120 個字。');
  return value;
}
export function decodeMediaTitle(header: string | undefined): string | null {
  if (header == null || header === '') return null;
  let decoded: string;
  try { decoded = decodeURIComponent(header); }
  catch { throw new Problem(422, 'highlight_title_invalid', '標題請使用 1 到 120 個字。'); }
  return cleanHighlightTitle(decoded);
}

// https only. Lowercase the host, drop the fragment, and strip campaign params.
export function normalizeHighlightLink(raw: unknown) {
  const input = linkBody.parse(raw);
  requireCondition(!control.test(input.url), 422, 'highlight_url_invalid', '請貼公開的 HTTPS 連結，不可含帳密、連接埠或本機位址。');
  let parsed: URL | undefined;
  try { parsed = new URL(input.url.trim()); } catch { /* invalid */ }
  requireCondition(parsed?.protocol === 'https:' && !parsed.username && !parsed.password && parsed.port === '' && !privateHost(parsed.hostname), 422, 'highlight_url_invalid', '請貼公開的 HTTPS 連結，不可含帳密、連接埠或本機位址。');
  parsed!.hostname = parsed!.hostname.toLowerCase().replace(/\.$/, '');
  parsed!.hash = '';
  for (const key of [...parsed!.searchParams.keys()].filter(key => tracking.test(key))) parsed!.searchParams.delete(key);
  const url = parsed!.toString();
  requireCondition(url.length <= 2048 && url.startsWith('https://'), 422, 'highlight_url_invalid', '網址過長。');
  const platform = classifyHighlightPlatform(parsed!.hostname);
  const title = cleanHighlightTitle(input.title) ?? defaultTitles[platform];
  return preparedLink.parse({url, title, platform});
}

function animated(bytes: Buffer, format: 'png' | 'jpeg' | 'webp') {
  if (format === 'png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return false;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL') return true;
      offset += length + 12;
      if (type === 'IEND') break;
    }
  } else if (format === 'webp') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      if (length > bytes.length - offset - 8) return false;
      if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && length >= 1 && (bytes[offset + 8] & 0x02))) return true;
      offset += 8 + length + (length & 1);
    }
  }
  return false;
}
export async function normalizeHighlightImage(bytes: Buffer, mime: string, orientation: Orientation) {
  requireCondition(bytes.length > 0 && bytes.length <= IMAGE_MAX, 413, 'highlight_image_too_large', '圖片需為 10 MiB 以下。');
  const format = rasterFormat(bytes);
  requireCondition(format && mime === `image/${format}`, 415, 'highlight_image_format', '請選擇 JPEG、PNG 或 WebP 圖片。');
  try { rejectAnimation(bytes, format); }
  catch (error) {
    if (error instanceof Problem && error.code === 'invalid_cover_image') {
      throw new Problem(422, animated(bytes, format) ? 'highlight_image_animated' : 'highlight_image_invalid', animated(bytes, format) ? '請使用靜態圖片，不要上傳動畫。' : '圖片無法使用。請選擇完整的靜態 JPEG、PNG 或 WebP。');
    }
    throw error;
  }
  const main = orientation === 'portrait' ? {width: 1200, height: 1600} : {width: 1600, height: 1200};
  try {
    const image = await normalizeImage(bytes, {purpose: 'event_highlight', format, maxDimension: 8192, maxPixels: 40_000_000, maxOutputBytes: IMAGE_VARIANT_MAX,
      output: {...main, fit: 'contain', background: '#14161b', quality: 80, effort: 4}});
    requireCondition(image.length <= IMAGE_VARIANT_MAX, 422, 'highlight_image_too_large', '這張圖片壓縮後仍過大，請換一張較簡單的圖片。');
    const thumb = await normalizeImage(bytes, {purpose: 'event_highlight', format, maxDimension: 8192, maxPixels: 40_000_000, maxOutputBytes: THUMB_MAX,
      output: {width: 480, height: 360, fit: 'cover', quality: 80, effort: 4}});
    requireCondition(thumb.length <= THUMB_MAX, 422, 'highlight_image_too_large', '這張圖片的預覽壓縮後仍過大，請換一張較簡單的圖片。');
    return {image, thumb};
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(422, 'highlight_image_invalid', '圖片無法使用。請選擇完整的靜態 JPEG、PNG 或 WebP。');
  }
}

const listedSql = `e.state='published' AND e.ends_at<=now()
 AND ($1::uuid IS NULL OR e.community_id=$1)
 AND (($2::uuid IS NOT NULL AND e.organizer_ref=$2) OR NOT is_verification_test_account(e.organizer_ref))`;
const attendanceSql = `((SELECT count(*)::int FROM community_event_rsvps r WHERE r.event_id=e.event_id AND r.state='going' AND NOT is_verification_test_account(r.user_id))+
 (SELECT count(*)::int FROM community_event_guest_rsvps g WHERE g.event_id=e.event_id AND g.email_sent_at IS NOT NULL))`;
const itemVisible = `(h.uploader_user_id IS NOT DISTINCT FROM $2::uuid OR NOT is_verification_test_account(h.uploader_user_id))`;

export function encodeHighlightCursor(endsAt: string, eventId: string) {
  return Buffer.from(`${endsAt}|${eventId}`, 'utf8').toString('base64url');
}
export function decodeHighlightCursor(raw: string): {endsAt: string; eventId: string} | null {
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const split = text.lastIndexOf('|');
    if (split < 1) return null;
    const endsAt = text.slice(0, split), eventId = text.slice(split + 1);
    if (!z.uuid().safeParse(eventId).success || Number.isNaN(Date.parse(endsAt))) return null;
    return {endsAt, eventId};
  } catch { return null; }
}
export function readHighlightMode(raw: string | undefined, loose: boolean): HighlightMode {
  if (!raw || raw === 'all') return 'all';
  if (raw === 'online' || raw === 'in_person') return raw;
  if (loose) return 'all';
  throw new Problem(422, 'highlight_mode_invalid', '請選擇全部、線上或實體。');
}
export function readHighlightCursor(raw: string | undefined, loose: boolean) {
  if (!raw) return null;
  const cursor = decodeHighlightCursor(raw);
  if (!cursor && !loose) throw new Problem(400, 'highlight_cursor_invalid', '分頁標記不正確。');
  return cursor;
}

function iso(value: Date | string) { return new Date(value).toISOString(); }
function imagePath(mediaId: string) { return `/api/v1/public/event-highlights/media/${mediaId}/image`; }
function thumbPath(mediaId: string) { return `/api/v1/public/event-highlights/media/${mediaId}/thumb`; }
function bannerPath(eventId: string) { return `/api/v1/public/event-highlights/${eventId}/banner`; }
function uniqueViolation(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && (error as {code: string}).code === '23505'; }
function limitProblem(kind: HighlightKind, scope: 'mine' | 'event') {
  const limit = limits[kind];
  const amount = scope === 'mine' ? limit.mine : limit.event;
  const who = scope === 'mine' ? '每位夥伴在同一場活動最多新增' : '一場活動最多';
  return new Problem(409, 'highlight_limit_reached', `${who} ${amount} ${limit.unit}。`);
}
type CardRow = {event_id: string; title: string; starts_at: Date; ends_at: Date; ends_cursor: string; mode: string; event_kind: string; organizer_name: string; attending_count: number; banner_orientation: Orientation | null; description?: string; organizer_ref?: string; community_id?: string};
type ItemRow = {event_id?: string; media_id: string; kind: HighlightKind; title: string | null; url: string | null; platform: HighlightPlatform | null; orientation: Orientation | null; created_at: Date; uploader_user_id?: string; display_name?: string; avatar_version?: string | number | null; avatar_present?: boolean};

function coverFor(eventId: string, banner: Orientation | null, items: ItemRow[]) {
  if (banner) return {kind: 'banner' as const, url: bannerPath(eventId)};
  const poster = items.find(item => item.kind === 'poster');
  if (poster) return {kind: 'poster' as const, url: imagePath(poster.media_id)};
  const photo = items.find(item => item.kind === 'photo');
  if (photo) return {kind: 'photo' as const, url: thumbPath(photo.media_id)};
  const video = items.find(item => item.kind === 'link' && item.url && youtubeThumbnailUrl(item.url));
  if (video?.url) return {kind: 'youtube' as const, url: youtubeThumbnailUrl(video.url)!};
  return null;
}
function countsFor(items: ItemRow[]) {
  return {links: items.filter(item => item.kind === 'link').length, photos: items.filter(item => item.kind === 'photo').length, posters: items.filter(item => item.kind === 'poster').length};
}
function presentItem(row: ItemRow, organizerId: string, viewerId: string | null, admin: boolean) {
  const base = {media_id: row.media_id, kind: row.kind, title: row.title, created_at: iso(row.created_at),
    uploader: {user_id: row.uploader_user_id, display_name: row.display_name, avatar_url: avatarUrl(row.uploader_user_id!, row.avatar_version ?? '1', Boolean(row.avatar_present))},
    uploaded_by_organizer: row.uploader_user_id === organizerId,
    can_remove: Boolean(viewerId && (viewerId === row.uploader_user_id || viewerId === organizerId || admin))};
  if (row.kind === 'link') {
    const thumbnail = row.url ? youtubeThumbnailUrl(row.url) : null;
    return {...base, url: row.url, platform: row.platform, ...(thumbnail ? {thumbnail_url: thumbnail} : {})};
  }
  return {...base, image_url: imagePath(row.media_id), thumb_url: thumbPath(row.media_id), orientation: row.orientation};
}
function card(row: CardRow, items: ItemRow[]) {
  return {event_id: row.event_id, title: row.title, starts_at: iso(row.starts_at), ends_at: iso(row.ends_at), mode: row.mode, event_kind: row.event_kind,
    organizer_name: row.organizer_name, attending_count: Number(row.attending_count), public_path: `/highlights/${row.event_id}`,
    cover: coverFor(row.event_id, row.banner_orientation, items), counts: countsFor(items)};
}

async function visibleItems(q: Pick<Pool, 'query'>, eventIds: string[], viewerId: string | null) {
  if (!eventIds.length) return new Map<string, ItemRow[]>();
  const rows = (await q.query(`SELECT h.event_id,h.media_id,h.kind,h.title,h.url,h.platform,h.created_at
    FROM community_event_highlights h WHERE h.event_id = ANY($1::uuid[]) AND h.state='active' AND ${itemVisible}
    ORDER BY h.created_at DESC, h.media_id DESC`, [eventIds, viewerId])).rows as ItemRow[];
  const grouped = new Map<string, ItemRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.event_id!) ?? [];
    list.push(row);
    grouped.set(row.event_id!, list);
  }
  return grouped;
}

export async function listHighlightEvents(pool: Pool, scope: {communityId: string | null; viewerId: string | null; mode: HighlightMode; cursor: {endsAt: string; eventId: string} | null}) {
  const rows = (await pool.query(`SELECT e.event_id,e.title,e.starts_at,e.ends_at,e.mode,e.event_kind,u.display_name AS organizer_name,
    to_char(e.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_cursor,
    (SELECT orientation FROM community_event_banners b WHERE b.event_id=e.event_id) AS banner_orientation,
    ${attendanceSql} AS attending_count
    FROM community_events e JOIN users u ON u.user_id=e.organizer_ref
    WHERE ${listedSql} AND ($3::text='all' OR e.mode=$3 OR e.mode='hybrid')
      AND ($4::timestamptz IS NULL OR (e.ends_at,e.event_id)<($4::timestamptz,$5::uuid))
    ORDER BY e.ends_at DESC, e.event_id DESC LIMIT ${PAGE_SIZE + 1}`,
  [scope.communityId, scope.viewerId, scope.mode, scope.cursor?.endsAt ?? null, scope.cursor?.eventId ?? null])).rows as CardRow[];
  const page = rows.slice(0, PAGE_SIZE);
  const grouped = await visibleItems(pool, page.map(row => row.event_id), scope.viewerId);
  const last = page.at(-1);
  return {items: page.map(row => card(row, grouped.get(row.event_id) ?? [])), next_cursor: rows.length > PAGE_SIZE && last ? encodeHighlightCursor(last.ends_cursor, last.event_id) : null};
}

async function isPlatformAdmin(q: Pick<Pool, 'query'>, userId: string, communityId: string) {
  const row = await q.query(`SELECT 1 FROM users u WHERE u.user_id=$1 AND u.community_id=$2 AND u.active AND u.email_verified_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM platform_admins p WHERE p.community_id=u.community_id AND p.active AND p.email=lower(u.email))`, [userId, communityId]);
  return row.rowCount === 1;
}
async function loadListed(q: Pick<Pool, 'query'>, eventId: string, communityId: string | null, viewerId: string | null, lock = false) {
  const row = (await q.query(`SELECT e.event_id,e.community_id,e.organizer_ref,e.title,e.description,e.visibility,e.guild_key,e.starts_at,e.ends_at,e.mode,e.event_kind,e.state,
    u.display_name AS organizer_name,
    (SELECT orientation FROM community_event_banners b WHERE b.event_id=e.event_id) AS banner_orientation,
    ${attendanceSql} AS attending_count
    FROM community_events e JOIN users u ON u.user_id=e.organizer_ref
    WHERE e.event_id=$3 AND ${listedSql}${lock ? ' FOR UPDATE OF e' : ''}`, [communityId, viewerId, eventId])).rows[0] as (CardRow & {description: string; visibility: string; guild_key: string | null; organizer_ref: string; community_id: string; state: string}) | undefined;
  requireCondition(row, 404, 'not_found', '找不到這場活動集錦。');
  return row;
}
async function quota(q: Pick<Pool, 'query'>, eventId: string, viewerId: string) {
  const counts = (await q.query(`SELECT
    count(*) FILTER (WHERE kind='link')::int AS event_links, count(*) FILTER (WHERE kind='link' AND uploader_user_id=$2)::int AS my_links,
    count(*) FILTER (WHERE kind='photo')::int AS event_photos, count(*) FILTER (WHERE kind='photo' AND uploader_user_id=$2)::int AS my_photos,
    count(*) FILTER (WHERE kind='poster')::int AS event_posters, count(*) FILTER (WHERE kind='poster' AND uploader_user_id=$2)::int AS my_posters
    FROM community_event_highlights WHERE event_id=$1 AND state='active'`, [eventId, viewerId])).rows[0];
  const remaining = (kind: HighlightKind, mine: number, event: number) => ({remaining_for_me: Math.max(0, limits[kind].mine - mine), remaining_for_event: Math.max(0, limits[kind].event - event)});
  return {links: remaining('link', counts.my_links, counts.event_links), photos: remaining('photo', counts.my_photos, counts.event_photos), posters: remaining('poster', counts.my_posters, counts.event_posters)};
}
function assertRoom(counts: {my_links: number; event_links: number; my_photos: number; event_photos: number; my_posters: number; event_posters: number}, kind: HighlightKind) {
  const mine = kind === 'link' ? counts.my_links : kind === 'photo' ? counts.my_photos : counts.my_posters;
  const event = kind === 'link' ? counts.event_links : kind === 'photo' ? counts.event_photos : counts.event_posters;
  if (mine >= limits[kind].mine) throw limitProblem(kind, 'mine');
  if (event >= limits[kind].event) throw limitProblem(kind, 'event');
}

export async function readHighlightEvent(pool: Pool, scope: {communityId: string | null; viewerId: string | null; eventId: string}) {
  const row = await loadListed(pool, scope.eventId, scope.communityId, scope.viewerId);
  const items = (await pool.query(`SELECT h.media_id,h.kind,h.title,h.url,h.platform,h.orientation,h.created_at,h.uploader_user_id,u.display_name,
    a.aggregate_version AS avatar_version, a.present AS avatar_present
    FROM community_event_highlights h JOIN users u ON u.user_id=h.uploader_user_id
    LEFT JOIN member_avatar_presence a ON a.user_id=h.uploader_user_id AND a.community_id=h.community_id
    WHERE h.event_id=$1 AND h.state='active' AND ${itemVisible}
    ORDER BY h.created_at DESC, h.media_id DESC`, [scope.eventId, scope.viewerId])).rows as ItemRow[];
  const admin = scope.viewerId ? await isPlatformAdmin(pool, scope.viewerId, row.community_id) : false;
  const detail = {event_id: row.event_id, title: row.title, description: row.description, starts_at: iso(row.starts_at), ends_at: iso(row.ends_at),
    mode: row.mode, event_kind: row.event_kind, organizer_name: row.organizer_name, attending_count: Number(row.attending_count),
    banner_url: row.banner_orientation ? bannerPath(row.event_id) : null, banner_orientation: row.banner_orientation,
    public_path: `/highlights/${row.event_id}`, items: items.map(item => presentItem(item, row.organizer_ref, scope.viewerId, admin))};
  if (!scope.viewerId) return detail;
  return {...detail, can_upload: true, quota: await quota(pool, row.event_id, scope.viewerId)};
}

async function uploaderView(q: PoolClient, userId: string, communityId: string) {
  const row = (await q.query(`SELECT u.display_name, a.aggregate_version AS avatar_version, a.present AS avatar_present
    FROM users u LEFT JOIN member_avatar_presence a ON a.user_id=u.user_id AND a.community_id=$2 WHERE u.user_id=$1`, [userId, communityId])).rows[0];
  return {user_id: userId, display_name: row.display_name as string, avatar_url: avatarUrl(userId, row.avatar_version ?? '1', Boolean(row.avatar_present))};
}

export async function addHighlightLink(pool: Pool, input: Command, eventId: string) {
  const body = normalizeHighlightLink(input.body);
  return command(pool, {...input, body}, async q => { await loadListed(q, eventId, input.actor.community_id, input.actor.user_id); }, async q => {
    const event = await loadListed(q, eventId, input.actor.community_id, input.actor.user_id, true);
    const counts = (await q.query(`SELECT count(*) FILTER (WHERE kind='link')::int AS event_links, count(*) FILTER (WHERE kind='link' AND uploader_user_id=$2)::int AS my_links,
      0::int AS event_photos, 0::int AS my_photos, 0::int AS event_posters, 0::int AS my_posters
      FROM community_event_highlights WHERE event_id=$1 AND state='active'`, [eventId, input.actor.user_id])).rows[0];
    assertRoom(counts, 'link');
    const mediaId = randomUUID();
    try {
      await q.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,title,url,platform,state)
        VALUES($1,$2,$3,$4,'link',$5,$6,$7,'active')`, [mediaId, eventId, event.community_id, input.actor.user_id, body.title, body.url, body.platform]);
    } catch (error) {
      if (uniqueViolation(error)) throw new Problem(409, 'highlight_link_exists', '這個連結已經在活動集錦裡了。');
      throw error;
    }
    await journal(q, input.actor, 'community_event_highlight', mediaId, 1, 'create', {kind: 'link', event_id: eventId}, 'freedom.community.event_highlight.created.v1');
    const created = iso((await q.query('SELECT created_at FROM community_event_highlights WHERE media_id=$1', [mediaId])).rows[0].created_at);
    const thumbnail = youtubeThumbnailUrl(body.url);
    return {media_id: mediaId, kind: 'link' as const, title: body.title, created_at: created, url: body.url, platform: body.platform, ...(thumbnail ? {thumbnail_url: thumbnail} : {}),
      uploader: await uploaderView(q, input.actor.user_id, event.community_id), uploaded_by_organizer: input.actor.user_id === event.organizer_ref, can_remove: true};
  });
}

/** Original listed-event permission: any current community member, not organizer-only. */
export async function authorizeHighlightUpload(q:Pick<Pool,'query'>,actor:Actor,eventId:string,kind:'photo'|'poster',lock=false,checkQuota=false){
 const event=await loadListed(q,eventId,actor.community_id,actor.user_id,lock);
 if(checkQuota){const counts=(await q.query(`SELECT 0::int AS event_links,0::int AS my_links,
 count(*) FILTER(WHERE kind='photo')::int AS event_photos,count(*) FILTER(WHERE kind='photo' AND uploader_user_id=$2)::int AS my_photos,
 count(*) FILTER(WHERE kind='poster')::int AS event_posters,count(*) FILTER(WHERE kind='poster' AND uploader_user_id=$2)::int AS my_posters
 FROM community_event_highlights WHERE event_id=$1 AND state='active'`,[eventId,actor.user_id])).rows[0];assertRoom(counts,kind);}
 return event;
}
/** Database-only original metadata/response port, used only after BOTH Assets are ready. */
export async function publishHighlightAssetPair(q:PoolClient,actor:Actor,eventId:string,mediaId:string,kind:'photo'|'poster',imageByteSize:number,orientation:Orientation,title:string|null){
 const event=await authorizeHighlightUpload(q,actor,eventId,kind,true,true);
 await q.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,title,orientation,byte_size,state,storage_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active','asset')`,[mediaId,eventId,event.community_id,actor.user_id,kind,title,orientation,imageByteSize]);
 await q.query("INSERT INTO community_event_highlight_images(media_id,variant,bytes) VALUES($1,'image',NULL),($1,'thumb',NULL)",[mediaId]);
 await journal(q,actor,'community_event_highlight',mediaId,1,'create',{kind,event_id:eventId},'freedom.community.event_highlight.created.v1');
 const created=iso((await q.query('SELECT created_at FROM community_event_highlights WHERE media_id=$1',[mediaId])).rows[0].created_at);
 return {media_id:mediaId,kind,title,created_at:created,image_url:imagePath(mediaId),thumb_url:thumbPath(mediaId),orientation,uploader:await uploaderView(q,actor.user_id,event.community_id),uploaded_by_organizer:actor.user_id===event.organizer_ref,can_remove:true};
}
export async function addHighlightImage(pool: Pool, input: Command, eventId: string, kind: 'photo' | 'poster', image: Buffer, thumb: Buffer, orientation: Orientation, title: string | null,assets?:EventHighlightAssetService) {
  if(await highlightStorageMode(pool)!=='legacy'){requireCondition(assets,503,'media_upload_unavailable','內容上傳暫時無法使用。');return assets.uploadPair(input,eventId,kind,image,thumb,orientation,title);}
  return command(pool, input, async q => { await loadListed(q, eventId, input.actor.community_id, input.actor.user_id); }, async q => {
    const event = await loadListed(q, eventId, input.actor.community_id, input.actor.user_id, true);
    const counts = (await q.query(`SELECT 0::int AS event_links, 0::int AS my_links,
      count(*) FILTER (WHERE kind='photo')::int AS event_photos, count(*) FILTER (WHERE kind='photo' AND uploader_user_id=$2)::int AS my_photos,
      count(*) FILTER (WHERE kind='poster')::int AS event_posters, count(*) FILTER (WHERE kind='poster' AND uploader_user_id=$2)::int AS my_posters
      FROM community_event_highlights WHERE event_id=$1 AND state='active'`, [eventId, input.actor.user_id])).rows[0];
    assertRoom(counts, kind);
    const mediaId = randomUUID();
    await q.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,title,orientation,byte_size,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active')`, [mediaId, eventId, event.community_id, input.actor.user_id, kind, title, orientation, image.length]);
    await q.query(`INSERT INTO community_event_highlight_images(media_id,variant,bytes) VALUES ($1,'image',$2),($1,'thumb',$3)`, [mediaId, image, thumb]);
    await journal(q, input.actor, 'community_event_highlight', mediaId, 1, 'create', {kind, event_id: eventId}, 'freedom.community.event_highlight.created.v1');
    const created = iso((await q.query('SELECT created_at FROM community_event_highlights WHERE media_id=$1', [mediaId])).rows[0].created_at);
    return {media_id: mediaId, kind, title, created_at: created, image_url: imagePath(mediaId), thumb_url: thumbPath(mediaId), orientation,
      uploader: await uploaderView(q, input.actor.user_id, event.community_id), uploaded_by_organizer: input.actor.user_id === event.organizer_ref, can_remove: true};
  });
}

export async function removeHighlight(pool: Pool, input: Command, mediaId: string) {
  return command(pool, input, async q => {
    const row = (await q.query(`SELECT h.uploader_user_id,e.organizer_ref,e.community_id FROM community_event_highlights h
      JOIN community_events e ON e.event_id=h.event_id WHERE h.media_id=$1 AND e.community_id=$2`, [mediaId, input.actor.community_id])).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這個集錦項目。');
    const allowed = row.uploader_user_id === input.actor.user_id || row.organizer_ref === input.actor.user_id || await isPlatformAdmin(q, input.actor.user_id, row.community_id);
    requireCondition(allowed, 403, 'highlight_remove_forbidden', '只有上傳的人、主辦者或平台管理員可以移除。');
  }, async q => {
    const row = (await q.query(`SELECT h.media_id,h.kind,h.event_id,h.state FROM community_event_highlights h
      JOIN community_events e ON e.event_id=h.event_id WHERE h.media_id=$1 AND e.community_id=$2 FOR UPDATE OF h`, [mediaId, input.actor.community_id])).rows[0];
    requireCondition(row?.state === 'active', 404, 'not_found', '找不到這個集錦項目。');
    await q.query(`UPDATE community_event_highlights SET state='removed', removed_at=now(), removed_by_user_id=$2 WHERE media_id=$1`, [mediaId, input.actor.user_id]);
    await q.query('DELETE FROM community_event_highlight_images WHERE media_id=$1', [mediaId]);
    await journal(q, input.actor, 'community_event_highlight', mediaId, 2, 'remove', {kind: row.kind, event_id: row.event_id}, 'freedom.community.event_highlight.removed.v1');
    return {media_id: mediaId, state: 'removed' as const};
  });
}

async function highlightBannerSnapshot(pool:Pool,eventId:string):Promise<DomainMediaSnapshot|undefined>{
 const row=(await pool.query(`SELECT e.aggregate_version,e.state,e.ends_at,e.organizer_ref,b.storage_source,b.image_bytes,b.orientation,t.asset_id,t.scope_id,o.representation_id,o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision,o.profile_id
 FROM community_event_banners b JOIN community_events e USING(event_id)
 LEFT JOIN community_event_banner_asset_targets t ON t.event_id=e.event_id AND t.linked_at_version<=e.aggregate_version
 LEFT JOIN assets a ON a.asset_id=t.asset_id AND a.state='ready' AND a.purpose='community.event-banner'
 LEFT JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='community.event-banner'
 WHERE e.event_id=$1 AND e.state='published' AND e.ends_at<=clock_timestamp() AND NOT is_verification_test_account(e.organizer_ref)`,[eventId])).rows[0];
 if(!row)return;return {purpose:'community.event-banner',targetId:eventId,variant:'banner',domainVersion:String(row.aggregate_version),authorizationVersion:JSON.stringify([row.state,row.ends_at,row.organizer_ref,row.orientation]),source:row.storage_source,legacyBytes:row.image_bytes,legacyContentType:'image/webp',assetId:row.asset_id,scopeId:row.scope_id,representationId:row.representation_id,metadata:row.profile_id?{profileId:row.profile_id,contentType:row.content_type,byteSize:row.byte_size,sha256:row.content_sha256,transformVersion:row.transform_version,policyRevision:row.policy_revision}:null};
}
export async function highlightBannerBytes(pool:Pool,eventId:string,store?:ObjectStore){
 try{return (await readDomainMedia(()=>highlightBannerSnapshot(pool,eventId),{purpose:'community.event-banner',targetId:eventId,variant:'banner'},store)).bytes;}catch(error){if(error instanceof Problem&&error.status===404&&error.code==='media_not_found')throw new Problem(404,'not_found','找不到活動海報。');throw error;}
}
async function highlightImageSnapshot(pool:Pool,mediaId:string,variant:'image'|'thumb'):Promise<DomainMediaSnapshot|undefined>{
 const row=(await pool.query(`SELECT h.storage_source,h.event_id,h.orientation,h.kind,h.state,e.aggregate_version,e.state AS event_state,e.ends_at,h.uploader_user_id,e.organizer_ref,i.bytes,t.scope_id,
 CASE WHEN $2='image' THEN t.image_asset_id ELSE t.thumb_asset_id END AS asset_id,
 o.representation_id,o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision,o.profile_id
 FROM community_event_highlight_images i JOIN community_event_highlights h USING(media_id) JOIN community_events e ON e.event_id=h.event_id
 LEFT JOIN community_event_highlight_asset_targets t USING(media_id)
 LEFT JOIN asset_objects o ON o.asset_id=CASE WHEN $2='image' THEN t.image_asset_id ELSE t.thumb_asset_id END
 WHERE i.media_id=$1 AND i.variant=$2 AND h.state='active' AND h.kind IN ('photo','poster') AND e.state='published' AND e.ends_at<=clock_timestamp()
 AND NOT is_verification_test_account(e.organizer_ref) AND NOT is_verification_test_account(h.uploader_user_id)`,[mediaId,variant])).rows[0];
 if(!row)return;return {purpose:'community.event-highlight',targetId:mediaId,variant,domainVersion:row.aggregate_version,authorizationVersion:JSON.stringify([row.state,row.event_state,row.ends_at,row.uploader_user_id,row.organizer_ref,row.kind,row.orientation]),source:row.storage_source,legacyBytes:row.bytes,legacyContentType:'image/webp',assetId:row.asset_id,scopeId:row.scope_id,representationId:row.representation_id,metadata:row.profile_id?{profileId:row.profile_id,contentType:row.content_type,byteSize:row.byte_size,sha256:row.content_sha256,transformVersion:row.transform_version,policyRevision:row.policy_revision}:null};
}
export async function highlightImageBytes(pool:Pool,mediaId:string,variant:'image'|'thumb',store?:ObjectStore){
 try{return (await readDomainMedia(()=>highlightImageSnapshot(pool,mediaId,variant),{purpose:'community.event-highlight',targetId:mediaId,variant},store)).bytes;}catch(error){if(error instanceof Problem&&error.status===404&&error.code==='media_not_found')throw new Problem(404,'not_found','找不到這張圖片。');throw error;}
}

type ShareItem = {kind: string; image_url?: string; orientation?: Orientation | null; thumbnail_url?: string};
function shareSize(orientation: Orientation | null | undefined, landscape: {width: number; height: number}, portrait: {width: number; height: number}) {
  return orientation === 'portrait' ? portrait : landscape;
}
// Processors always emit these exact sizes, so a public page can describe the share image without loading bytes.
export function highlightShareImage(detail: {title: string; banner_url: string | null; banner_orientation: Orientation | null; items: ShareItem[]}) {
  const alt = detail.title;
  if (detail.banner_url) return {url: detail.banner_url, alt, ...shareSize(detail.banner_orientation, {width: 1200, height: 675}, {width: 900, height: 1200})};
  const poster = detail.items.find(item => item.kind === 'poster' && item.image_url);
  if (poster?.image_url) return {url: poster.image_url, alt, ...shareSize(poster.orientation, {width: 1600, height: 1200}, {width: 1200, height: 1600})};
  const photo = detail.items.find(item => item.kind === 'photo' && item.image_url);
  if (photo?.image_url) return {url: photo.image_url, alt, ...shareSize(photo.orientation, {width: 1600, height: 1200}, {width: 1200, height: 1600})};
  const video = detail.items.find(item => item.kind === 'link' && item.thumbnail_url);
  if (video?.thumbnail_url) return {url: video.thumbnail_url, alt, width: 480, height: 360};
  return {url: '/brand/freedom-workshop.webp', alt: '自由工坊', width: 1280, height: 720};
}

export function highlightImageDigest(bytes: Buffer, orientation: Orientation, title: string | null) {
  return {sha256: createHash('sha256').update(bytes).digest('hex'), orientation, title};
}
export {youtubeVideoId};
