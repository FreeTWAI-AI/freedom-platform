import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { command, checkVersion, journal, type Command } from '../../packages/db/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../identity-membership/service.js';
import { lockMemberGuilds } from '../positioning/onboarding.js';
import { readFollowUpdates } from '../community/content-relations.js';
import { CHANNEL_KEY_MAX, GUILD_CHANNEL_KEY_PATTERN, SQUAD_CHANNEL_KEY_PATTERN, type ChannelKind } from './channel-types.js';
import type { Notification, NotificationList } from './types.js';

export type NotificationCategory = 'friends' | 'squads' | 'events' | 'following';
export type NotificationMode = 'instant' | 'summary' | 'off';
export interface NotificationPreferences {
  version: number;
  categories: Record<NotificationCategory, NotificationMode>;
  quiet_hours: { enabled: boolean; time_zone: string; start: string; end: string };
  /** Canonical logical room IDs: guild:<catalog key>, squad:<lowercase UUID>, world:world. */
  muted_channel_ids: string[];
  email_digest: { enabled: false; status: 'not_enabled'; reason: string };
  supported_categories: NotificationCategory[];
}
export interface NotificationSummary {
  items: { id: string; source: 'notification' | 'following' | 'event_bulletin'; title: string; path: string | null }[];
  generated_at: string;
  email_status: 'not_enabled';
}
export interface FollowingReminders {
  items: { id: string; title: string; path: string }[];
  /** Projection time, not the source content's update timestamp. */
  generated_at: string;
}
export type ChannelReminderCounts = Record<ChannelKind, number>;
const mode = z.enum(['instant', 'summary', 'off']);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; } catch { return false; }
}, '請使用有效的時區。');
function validRoomId(id: string) {
  const split = id.indexOf(':');
  const kind = id.slice(0, split), key = id.slice(split + 1);
  return split > 0 && key.length <= CHANNEL_KEY_MAX && (kind === 'guild' ? GUILD_CHANNEL_KEY_PATTERN.test(key)
    : kind === 'squad' ? SQUAD_CHANNEL_KEY_PATTERN.test(key) && z.uuid().safeParse(key).success : kind === 'world' && key === 'world');
}
const preferencesBody = z.object({
  categories: z.object({ friends: mode, squads: mode, events: mode, following: mode }).strict(),
  quiet_hours: z.object({ enabled: z.boolean(), time_zone: zone, start: clock, end: clock }).strict()
    .refine(value => !value.enabled || value.start !== value.end, '安靜時段的開始與結束不可相同。'),
  muted_channel_ids: z.array(z.string().max(CHANNEL_KEY_MAX + 6).refine(validRoomId, '頻道代碼格式不正確。')).max(50)
    .refine(ids => new Set(ids).size === ids.length, '頻道代碼不可重複。'),
}).strict();
const emailReason = 'Email 摘要未啟用：尚未配置經授權的摘要寄送環境與訂閱／寄送政策；預設未訂閱。';
interface PreferenceRow {
  aggregate_version: string; friends_mode: NotificationMode; squads_mode: NotificationMode;
  events_mode: NotificationMode; following_mode: NotificationMode; quiet_enabled: boolean;
  time_zone: string; quiet_start: string; quiet_end: string; muted_channel_ids: string[];
}
function preferences(row: PreferenceRow | undefined, followingEnabled: boolean): NotificationPreferences {
  return { version: row ? Number(row.aggregate_version) : 1,
    categories: { friends: row?.friends_mode ?? 'instant', squads: row?.squads_mode ?? 'instant', events: row?.events_mode ?? 'instant', following: row?.following_mode ?? 'instant' },
    quiet_hours: { enabled: row?.quiet_enabled ?? false, time_zone: row?.time_zone ?? 'Asia/Taipei', start: row?.quiet_start ?? '22:00', end: row?.quiet_end ?? '08:00' },
    muted_channel_ids: row?.muted_channel_ids ?? [], email_digest: { enabled: false, status: 'not_enabled', reason: emailReason },
    supported_categories: followingEnabled ? ['friends', 'squads', 'events', 'following'] : ['friends', 'squads', 'events'] };
}
async function currentMember(q: PoolClient, actor: Actor, session: boolean) {
  const user = (await q.query(`SELECT (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AS ready
    FROM users WHERE user_id=$1 AND community_id=$2 AND active FOR SHARE`, [actor.user_id, actor.community_id])).rows[0];
  requireCondition(user, 401, 'session_expired', '請重新登入。');
  if (session) requireCondition((await q.query(`SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2
    AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`, [actor.session_hash, actor.user_id])).rowCount === 1, 401, 'session_expired', '請重新登入。');
  requireCondition(user.ready, 403, 'onboarding_required', '請先選擇主要公會，完成加入後即可使用會員功能。');
}
async function snapshot<T>(pool: Pool, actor: Actor, run: (q: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1;; attempt++) {
    const q = await pool.connect();
    try {
      await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await currentMember(q, actor, true);
      const result = await run(q);
      await assertCurrentSessionClock(q, actor);
      await q.query('COMMIT'); return result;
    } catch (error) {
      await q.query('ROLLBACK');
      if (error instanceof Problem || !error || typeof error !== 'object' || !('code' in error) || error.code !== '40001') throw error;
      if (attempt === 3) throw new Problem(503, 'communications_busy', '資料正在更新，請稍後再試。');
    } finally { q.release(); }
  }
}
async function load(q: PoolClient, actor: Actor, followingEnabled: boolean) {
  const row = (await q.query('SELECT * FROM member_notification_preferences WHERE community_id=$1 AND owner_user_id=$2', [actor.community_id, actor.user_id])).rows[0] as PreferenceRow | undefined;
  return preferences(row, followingEnabled);
}
export async function readNotificationPreferences(pool: Pool, actor: Actor, followingEnabled: boolean): Promise<NotificationPreferences> {
  return snapshot(pool, actor, q => load(q, actor, followingEnabled));
}

// Same membership locks, approved custom-guild scope and ordering as channels.ts.
const guildScope = `(m.guild_key NOT LIKE 'guild_custom_%' OR EXISTS(SELECT 1 FROM guild_creation_applications a
  WHERE a.state='approved' AND a.approved_guild_key=m.guild_key AND a.community_id=m.community_id))`;
async function accessibleRooms(q: PoolClient, actor: Actor, wanted?: readonly string[]): Promise<string[]> {
  const ids: string[] = ['world:world'];
  if (!wanted || wanted.some(id => id.startsWith('guild:'))) {
    await lockMemberGuilds(q, actor);
    const rows = (await q.query(`SELECT m.guild_key FROM positioning_profession_memberships m JOIN positioning_guild_catalog g ON g.guild_key=m.guild_key
      WHERE m.community_id=$1 AND m.user_id=$2 AND m.state='active' AND ${guildScope} ORDER BY m.guild_key FOR SHARE OF m`, [actor.community_id, actor.user_id])).rows;
    ids.push(...rows.map(row => `guild:${row.guild_key}`));
  }
  const squads = wanted ? wanted.filter(id => id.startsWith('squad:')).map(id => id.slice(6)).sort()
    : (await q.query(`SELECT m.squad_id FROM member_squad_memberships m JOIN member_squads s ON s.squad_id=m.squad_id
      WHERE m.user_id=$1 AND m.state='active' AND s.community_id=$2 ORDER BY m.squad_id`, [actor.user_id, actor.community_id])).rows.map(row => String(row.squad_id));
  for (const id of squads) {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`squad-membership/${id}/${actor.user_id}`]);
    if ((await q.query(`SELECT 1 FROM member_squad_memberships m JOIN member_squads s ON s.squad_id=m.squad_id
      WHERE m.squad_id=$1 AND m.user_id=$2 AND m.state='active' AND s.community_id=$3 FOR SHARE OF m`, [id, actor.user_id, actor.community_id])).rowCount) ids.push(`squad:${id}`);
  }
  return ids;
}
export async function saveNotificationPreferences(pool: Pool, input: Command, followingEnabled: boolean): Promise<NotificationPreferences> {
  const body = preferencesBody.parse(input.body), actor = input.actor;
  let prior: PreferenceRow | undefined;
  const result = await command(pool, input, async q => {
    await currentMember(q, actor, false);
    const rooms = new Set(await accessibleRooms(q, actor, body.muted_channel_ids));
    requireCondition(body.muted_channel_ids.every(id => rooms.has(id)), 404, 'channel_not_available', '找不到這個頻道，或你目前不是成員。');
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`notification-preferences/${actor.community_id}/${actor.user_id}`]);
    prior = (await q.query('SELECT * FROM member_notification_preferences WHERE community_id=$1 AND owner_user_id=$2 FOR UPDATE', [actor.community_id, actor.user_id])).rows[0];
  }, async q => {
    checkVersion(String(prior?.aggregate_version ?? 1), input.expected);
    const version = Number(prior?.aggregate_version ?? 1) + 1;
    const row = (await q.query(`INSERT INTO member_notification_preferences
      (community_id,owner_user_id,aggregate_version,friends_mode,squads_mode,events_mode,following_mode,quiet_enabled,time_zone,quiet_start,quiet_end,muted_channel_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(community_id,owner_user_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,
      friends_mode=EXCLUDED.friends_mode,squads_mode=EXCLUDED.squads_mode,events_mode=EXCLUDED.events_mode,following_mode=EXCLUDED.following_mode,
      quiet_enabled=EXCLUDED.quiet_enabled,time_zone=EXCLUDED.time_zone,quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,
      muted_channel_ids=EXCLUDED.muted_channel_ids,updated_at=now() RETURNING *`,
    [actor.community_id, actor.user_id, version, body.categories.friends, body.categories.squads, body.categories.events, body.categories.following,
      body.quiet_hours.enabled, body.quiet_hours.time_zone, body.quiet_hours.start, body.quiet_hours.end, body.muted_channel_ids])).rows[0] as PreferenceRow;
    // Policy metadata only, never message bodies, channel subjects or email recipients.
    await journal(q, actor, 'member_notification_preferences', actor.user_id, version, 'save', { version });
    return preferences(row, followingEnabled);
  });
  // Replays retain the committed version/body but expose the current feature support, not an old flag snapshot.
  return { ...result, supported_categories: preferences(undefined, followingEnabled).supported_categories };
}

/** Local wall-clock comparison handles midnight and DST without inventing a UTC offset. Start inclusive, end exclusive. */
export function isNotificationQuietHours(prefs: Pick<NotificationPreferences, 'quiet_hours'>, now: Date): boolean {
  const quiet = prefs.quiet_hours;
  if (!quiet.enabled) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const local = `${parts.find(part => part.type === 'hour')!.value}:${parts.find(part => part.type === 'minute')!.value}`;
  return quiet.start < quiet.end ? local >= quiet.start && local < quiet.end : local >= quiet.start || local < quiet.end;
}
function category(kind: string): NotificationCategory | null {
  if (kind === 'friend_request' || kind === 'friend_accepted' || kind === 'friend_declined') return 'friends';
  if (kind === 'squad_invitation' || kind === 'squad_join_requested' || kind === 'squad_join_accepted') return 'squads';
  if (kind === 'event_submitted' || kind === 'event_review_needed' || kind === 'event_approved' || kind === 'event_rejected' || kind === 'event_start_reminder') return 'events';
  return null; // Guild authority, security/transaction and unknown future kinds are never muted.
}
interface NoticeRow { notification_id: string; kind: Notification['kind']; title: string; created_at: Date | string; action_tab: NonNullable<Notification['action']>['tab'] | null; action_resource_id: string | null }
async function unreadNotices(q: PoolClient, actor: Actor, kinds: string[], only: boolean): Promise<NoticeRow[]> {
  return (await q.query(`SELECT n.notification_id,n.kind,n.title,n.created_at,n.action_tab,n.action_resource_id FROM member_notifications n
    WHERE n.community_id=$1 AND n.recipient_ref=$2 AND n.read_at IS NULL AND (n.kind=ANY($3::text[]))=$4
    AND ${eventNoticeAccessSql} ORDER BY n.created_at DESC,n.notification_id DESC LIMIT 40`, [actor.community_id, actor.user_id, kinds, only])).rows;
}
const eventAccessSql = `e.community_id=$1 AND (e.organizer_ref=$2 OR NOT is_verification_test_account(e.organizer_ref)) AND (
  e.organizer_ref=$2 OR (e.state='published' AND (e.visibility<>'guild' OR EXISTS(
    SELECT 1 FROM positioning_profession_memberships m WHERE m.community_id=e.community_id AND m.user_id=$2 AND m.guild_key=e.guild_key AND m.state='active')))
  OR (e.state='pending' AND EXISTS(SELECT 1 FROM positioning_guild_officers o JOIN positioning_profession_memberships m
    ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
    WHERE o.community_id=e.community_id AND o.guild_key=e.review_guild_key AND o.user_id=$2)))`;
const eventNoticeAccessSql = `(n.kind NOT IN ('event_submitted','event_review_needed','event_approved','event_rejected','event_start_reminder','event_waitlist_invited','event_schedule_changed','event_cancelled')
  OR n.action_resource_id IS NULL OR EXISTS(SELECT 1 FROM community_events e
    WHERE e.event_id::text=n.action_resource_id::text AND (${eventAccessSql} OR (
      n.kind='event_cancelled' AND e.state='cancelled' AND e.community_id=$1
      AND (e.organizer_ref=$2 OR NOT is_verification_test_account(e.organizer_ref))
      AND (e.visibility<>'guild' OR EXISTS(SELECT 1 FROM positioning_profession_memberships m
        WHERE m.community_id=e.community_id AND m.user_id=$2 AND m.guild_key=e.guild_key AND m.state='active'))
      AND (EXISTS(SELECT 1 FROM community_event_rsvps r WHERE r.event_id=e.event_id AND r.user_id=$2 AND r.confirmed_at IS NOT NULL)
        OR EXISTS(SELECT 1 FROM community_event_waitlist w WHERE w.event_id=e.event_id AND w.member_ref=$2))
    ))))`;
const socialNotificationKinds = ['friend_request', 'friend_accepted', 'friend_declined', 'squad_invitation', 'squad_join_requested', 'squad_join_accepted',
  'event_submitted', 'event_review_needed', 'event_approved', 'event_rejected', 'event_start_reminder'];
interface EventBulletinReminder { bulletin_id: string; event_id: string; kind: string; message: string; title: string; created_at: string }
async function readableEventBulletins(q: PoolClient, actor: Actor): Promise<EventBulletinReminder[]> {
  return (await q.query(`SELECT b.bulletin_id,b.event_id,b.kind,b.message,e.title,b.created_at
    FROM community_event_bulletins b JOIN community_events e ON e.event_id=b.event_id
    WHERE b.community_id=$1 AND ${eventAccessSql}
    ORDER BY b.created_at DESC,b.bulletin_id DESC LIMIT 20`, [actor.community_id, actor.user_id])).rows;
}
export async function readEventBulletinReminders(pool: Pool, actor: Actor, now: Date): Promise<{ items: EventBulletinReminder[] }> {
  return snapshot(pool, actor, async q => {
    const prefs = await load(q, actor, false);
    return { items: prefs.categories.events === 'instant' && !isNotificationQuietHours(prefs, now) ? await readableEventBulletins(q, actor) : [] };
  });
}
export async function readNotificationReminders(pool: Pool, actor: Actor, followingEnabled: boolean, now: Date): Promise<NotificationList> {
  return snapshot(pool, actor, async q => {
    const prefs = await load(q, actor, followingEnabled), quiet = isNotificationQuietHours(prefs, now);
    const suppressed = socialNotificationKinds.filter(kind => {
      const group = category(kind)!;
      return quiet || prefs.categories[group] !== 'instant';
    });
    // Post interactions have no separate category yet, but are social reminders, not essential notices.
    if (quiet) suppressed.push('social_post_commented', 'social_post_liked');
    const unread = (await q.query(`SELECT count(*)::int AS n FROM member_notifications n
      WHERE n.community_id=$1 AND n.recipient_ref=$2 AND n.read_at IS NULL AND NOT(n.kind=ANY($3::text[]))
      AND ${eventNoticeAccessSql}`, [actor.community_id, actor.user_id, suppressed])).rows[0];
    const items: Notification[] = [];
    for (const row of await unreadNotices(q, actor, suppressed, false)) {
      const group = category(row.kind);
      let action: Notification['action'] = row.action_tab === 'events' ? { tab: 'events', resource_id: row.action_resource_id }
        : row.action_tab === 'social' ? row.action_resource_id ? { tab: 'social', resource_id: row.action_resource_id } : null
        : row.action_tab ? { tab: row.action_tab, resource_id: row.action_resource_id } : null;
      if (group === 'events' && !row.action_resource_id) action = null;
      items.push({ notification_id: row.notification_id, kind: row.kind, title: group === 'events' ? '活動通知' : row.title,
        body: '', created_at: new Date(row.created_at).toISOString(), read_at: null, action });
    }
    return { items, unread_count: Number(unread.n), next_offset: null };
  });
}
export async function readNotificationSummary(pool: Pool, actor: Actor, followingEnabled: boolean, now: Date): Promise<NotificationSummary> {
  return snapshot(pool, actor, async q => {
    const prefs = await load(q, actor, followingEnabled);
    const items: NotificationSummary['items'] = [];
    const selected = socialNotificationKinds.filter(kind => prefs.categories[category(kind)!] === 'summary');
    for (const row of await unreadNotices(q, actor, selected, true)) {
      const group = category(row.kind)!;
      let path: string | null = group === 'friends' ? '#members' : group === 'squads' ? '#squads' : null;
      if (group === 'events' && row.action_resource_id) path = `#events/${row.action_resource_id}`;
      items.push({ id: row.notification_id, source: 'notification', title: group === 'friends' ? '好友通知' : group === 'squads' ? '小隊通知' : '活動通知', path });
    }
    if (prefs.categories.events === 'summary') {
      for (const item of await readableEventBulletins(q, actor)) items.push({ id: item.bulletin_id, source: 'event_bulletin', title: item.title, path: `#events/${item.event_id}` });
    }
    if (followingEnabled && prefs.categories.following === 'summary') {
      const updates = await readFollowUpdates(q, actor, {});
      for (const item of updates.items.slice(0, 20)) items.push({ id: `${item.kind}:${item.id}`, source: 'following', title: item.title, path: item.path });
    }
    return { items, generated_at: now.toISOString(), email_status: 'not_enabled' };
  });
}
export async function readFollowingReminders(pool: Pool, actor: Actor, followingEnabled: boolean, now: Date): Promise<FollowingReminders> {
  return snapshot(pool, actor, async q => {
    const prefs = await load(q, actor, followingEnabled);
    const items: FollowingReminders['items'] = [];
    if (followingEnabled && prefs.categories.following === 'instant' && !isNotificationQuietHours(prefs, now)) {
      const updates = await readFollowUpdates(q, actor, {});
      for (const item of updates.items.slice(0, 20)) items.push({ id: `${item.kind}:${item.id}`, title: item.title, path: item.path });
    }
    return { items, generated_at: now.toISOString() };
  });
}
export async function readChannelReminderCounts(pool: Pool, actor: Actor, now: Date): Promise<ChannelReminderCounts> {
  return snapshot(pool, actor, async q => {
    const prefs = await load(q, actor, false), result: ChannelReminderCounts = { guild: 0, squad: 0, world: 0 };
    if (isNotificationQuietHours(prefs, now)) return result;
    const muted = new Set(prefs.muted_channel_ids);
    const rooms = (await accessibleRooms(q, actor)).filter(id => !muted.has(id));
    for (const kind of ['guild', 'squad', 'world'] as const) {
      const keys = rooms.filter(id => id.startsWith(`${kind}:`)).map(id => id.slice(kind.length + 1));
      const row = (await q.query(`SELECT count(*)::int AS n FROM member_channel_messages x
        WHERE x.community_id=$1 AND x.kind=$2 AND x.channel_key=ANY($4::text[]) AND x.sender_ref<>$3 AND x.retracted_at IS NULL
        AND ($2<>'world' OR NOT is_verification_test_account(x.sender_ref))
        AND x.sequence>COALESCE((SELECT d.last_read_sequence FROM member_channel_reads d
          WHERE d.community_id=$1 AND d.kind=$2 AND d.channel_key=x.channel_key AND d.user_id=$3),0)`, [actor.community_id, kind, actor.user_id, keys])).rows[0];
      result[kind] = Number(row.n);
    }
    return result;
  });
}
