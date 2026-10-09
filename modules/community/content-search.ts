import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { checkVersion, command, journal, transaction, type Command } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { communitySearchKinds, communitySearchTopics, type CommunitySearchPage } from '../../packages/shared/community-search.js';
import type { Actor } from '../identity-membership/service.js';
import { catalogRepositoryKeys } from '../skill-submissions/repository-match.js';
import { publishedWorkFrom, publishedWorkPayload } from '../skill-submissions/public.js';
import { communityCatalog } from './catalog.js';
import { getSkillCollaboration } from './skill-collaboration.js';
import { requireSkillBookMaintainer } from '../guild-workspace/service.js';
import { activeDevelopmentGuilds } from '../development-access/guild-eligibility.js';
import { lockMemberSession, assertCurrentSessionClock } from '../../packages/db/member-session.js';

const SORT = `to_char(%s AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const TOPIC = communitySearchTopics;
const KIND = communitySearchKinds;
type Kind = typeof KIND[number];
type Row = CommunitySearchPage['items'][number] & { sort_key: string };
type ContentSearchCursor = { sort: string; kind: string; id: string } | null;
export interface CommunityContentFilter {
  ids?: Partial<Record<Kind, string[]>>;
  authorIds?: string[];
  followedTopics?: string[];
}
type SearchDatabase = Pool | PoolClient;
const relationSql = (kind: Kind, id: string, author: string) => `($10::text[] IS NULL OR ${id}::text = ANY($10::text[]))
  AND (NOT $13::boolean OR (${author}::text = ANY($11::text[]) AND u.community_id=$14::uuid
    AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)) OR EXISTS (
    SELECT 1 FROM community_content_topic_sets followed_tags WHERE followed_tags.content_kind='${kind}'
      AND followed_tags.content_id=${id}::text AND followed_tags.topics && $12::text[]))`;
const relationValues = (filter: CommunityContentFilter | undefined, kind: Kind) =>
  [filter?.ids ? filter.ids[kind] ?? [] : null, filter?.authorIds ?? [], filter?.followedTopics ?? [], Boolean(filter && (filter.authorIds || filter.followedTopics))];

const sortOf = (column: string) => SORT.replace('%s', column);
const clip = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180);
const likeOf = (value: string) => `%${value.replace(/[\\%_]/g, char => `\\${char}`)}%`;

function listed(raw: string | undefined, allowed: readonly string[], name: string) {
  const values = (raw ?? '').split(',').map(item => item.trim()).filter(Boolean);
  requireCondition(values.every(item => allowed.includes(item)) && new Set(values).size === values.length, 422, 'validation_failed', `${name}篩選不正確。`);
  return values;
}
function cursorOf(raw: string | undefined): ContentSearchCursor {
  if (!raw) return null;
  let text = '';
  try { text = Buffer.from(raw, 'base64url').toString('utf8'); } catch { throw new Problem(422, 'invalid_cursor', '分頁標記不正確。'); }
  const [sort, kind, id] = text.split('\n');
  requireCondition(Boolean(sort && kind && id) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(sort!) && KIND.includes(kind as Kind) && id!.length <= 100, 422, 'invalid_cursor', '分頁標記不正確。');
  return { sort: sort!, kind: kind!, id: id! };
}
function after(row: Row, cursor: { sort: string; kind: string; id: string } | null) {
  if (!cursor) return true;
  return row.sort_key < cursor.sort || (row.sort_key === cursor.sort && (row.kind > cursor.kind || (row.kind === cursor.kind && row.id > cursor.id)));
}
function compare(left: Row, right: Row) {
  return right.sort_key.localeCompare(left.sort_key) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}
const cursorSql = (sort: string, kind: Kind, id = kind === 'event' ? 'e.event_id' : kind === 'post' ? 'p.post_id' : 's.submission_id') => `($3::text IS NULL OR ${sort} < $3 OR (${sort} = $3 AND '${kind}' > $4) OR (${sort} = $3 AND '${kind}' = $4 AND ${id}::text > $5))`;
const topicSql = (kind: Kind, id: string) => `(cardinality($6::text[]) = 0 OR EXISTS (SELECT 1 FROM community_content_topic_sets tags WHERE tags.content_kind='${kind}' AND tags.content_id=${id} AND tags.topics && $6::text[]))`;
const textSql = (columns: string[]) => `($1 = '' OR ${columns.map(column => `${column} ILIKE $2 ESCAPE '\\'`).join(' OR ')})`;


export async function searchCommunityContent(pool: SearchDatabase, actor: Actor | null, raw: Record<string, string | undefined>, filter?: CommunityContentFilter): Promise<CommunitySearchPage> {
  const text = (raw.q ?? '').trim();
  requireCondition(text.length <= 80 && !/[\u0000-\u001f\u007f]/.test(text), 422, 'validation_failed', '搜尋文字請在 80 字以內。');
  const kinds = listed(raw.kinds, KIND, '類型');
  const topics = listed(raw.topics, TOPIC, '主題');
  const cursor = cursorOf(raw.cursor);
  const limit = raw.limit === undefined ? 20 : Number(raw.limit);
  requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 20, 422, 'validation_failed', '每頁最多 20 筆。');
  const selected = kinds.length ? kinds as Kind[] : KIND;
  const found: Row[] = [];
  if (selected.includes('event')) found.push(...await eventRows(pool, actor, text, cursor, topics, limit + 1, filter));
  if (selected.includes('post') && actor) found.push(...await postRows(pool, actor, text, cursor, topics, limit + 1, filter));
  if (selected.includes('work')) found.push(...await workRows(pool, actor, text, cursor, topics, limit + 1, filter));
  if (selected.includes('work') && actor) found.push(...await showcaseRows(pool, actor, text, cursor, topics, limit + 1, filter));
  if (selected.includes('skill_book')) found.push(...await bookRows(pool, text, cursor, topics, limit + 1, filter));
  const page = found.filter(row => after(row, cursor)).sort(compare).slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ sort_key: _sort, ...item }) => item),
    next_cursor: found.filter(row => after(row, cursor)).length > limit && last ? Buffer.from(`${last.sort_key}\n${last.kind}\n${last.id}`).toString('base64url') : null,
  };
}

async function eventRows(pool: SearchDatabase, actor: Actor | null, text: string, cursor: ContentSearchCursor, topics: string[], limit: number, filter?: CommunityContentFilter) {
  const sort = sortOf('e.created_at');
  const sql = `SELECT 'event' AS kind,e.event_id::text AS id,e.title,left(e.description,180) AS summary,
    CASE WHEN e.visibility IN ('open','referral') THEN '/events/' || e.event_id::text ELSE '#events/' || e.event_id::text END AS path,
    u.display_name AS label,
    CASE WHEN u.community_id=$9::uuid AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) THEN u.user_id::text ELSE NULL END AS author_id,
    CASE WHEN b.event_id IS NULL THEN NULL WHEN e.visibility IN ('open','referral') THEN '/api/v1/public/events/' || e.event_id::text || '/banner' ELSE '/api/v1/events/' || e.event_id::text || '/banner' END AS media_path,
    COALESCE(tags.topics,'{}'::text[]) AS topics,${sort} AS sort_key
    FROM community_events e JOIN users u ON u.user_id=e.organizer_ref
    LEFT JOIN community_event_banners b ON b.event_id=e.event_id
    LEFT JOIN community_content_topic_sets tags ON tags.content_kind='event' AND tags.content_id=e.event_id::text
    WHERE e.state='published' AND NOT (is_verification_test_account(e.organizer_ref) AND ($8::uuid IS NULL OR e.organizer_ref<>$8::uuid))
      AND (e.visibility IN ('open','referral')
        OR ($8::uuid IS NOT NULL AND (e.organizer_ref=$8::uuid
          OR (e.community_id=$9::uuid AND e.visibility='workshop')
          OR (e.community_id=$9::uuid AND e.visibility='guild' AND EXISTS (
            SELECT 1 FROM positioning_profession_memberships m WHERE m.community_id=e.community_id AND m.user_id=$8::uuid AND m.guild_key=e.guild_key AND m.state='active')))))
      AND ${textSql(['e.title', 'e.description'])} AND ${topicSql('event', 'e.event_id::text')} AND ${cursorSql(sort, 'event')}
      AND ${relationSql('event', 'e.event_id', 'e.organizer_ref')}
    ORDER BY e.created_at DESC,e.event_id LIMIT $7`;
  return (await pool.query(sql, [text, text ? likeOf(text) : '', cursor?.sort ?? null, cursor?.kind ?? null, cursor?.id ?? null, topics, limit, actor?.user_id ?? null, actor?.community_id ?? null, ...relationValues(filter, 'event'), actor?.community_id ?? null])).rows as Row[];
}

async function postRows(pool: SearchDatabase, actor: Actor, text: string, cursor: ContentSearchCursor, topics: string[], limit: number, filter?: CommunityContentFilter) {
  const sort = sortOf('p.created_at');
  const sql = `SELECT 'post' AS kind,p.post_id::text AS id,p.title,left(COALESCE(p.note,''),180) AS summary,COALESCE(p.url,'#social') AS path,u.display_name AS label,u.user_id::text AS author_id,
    CASE WHEN t.post_id IS NULL THEN NULL ELSE '/api/v1/social-posts/' || p.post_id::text || '/thumbnail' END AS media_path,
    COALESCE(tags.topics,'{}'::text[]) AS topics,${sort} AS sort_key
    FROM community_social_posts p JOIN users u ON u.user_id=p.author_user_id AND u.community_id=p.community_id
    LEFT JOIN community_social_post_thumbnails t ON t.post_id=p.post_id
    LEFT JOIN community_content_topic_sets tags ON tags.content_kind='post' AND tags.content_id=p.post_id::text
    WHERE p.community_id=$8 AND p.state='active' AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND (p.author_user_id=$9 OR NOT is_verification_test_account(u.user_id))
      AND ${textSql(['p.title', 'COALESCE(p.note,\'\')'])} AND ${topicSql('post', 'p.post_id::text')} AND ${cursorSql(sort, 'post')}
      AND ${relationSql('post', 'p.post_id', 'p.author_user_id')}
    ORDER BY p.created_at DESC,p.post_id LIMIT $7`;
  return (await pool.query(sql, [text, text ? likeOf(text) : '', cursor?.sort ?? null, cursor?.kind ?? null, cursor?.id ?? null, topics, limit, actor.community_id, actor.user_id, ...relationValues(filter, 'post'), actor.community_id])).rows as Row[];
}

async function workRows(pool: SearchDatabase, actor: Actor | null, text: string, cursor: ContentSearchCursor, topics: string[], limit: number, filter?: CommunityContentFilter) {
  const sort = sortOf('s.published_at');
  const title = `(${publishedWorkPayload})->>'title'`;
  const description = `(${publishedWorkPayload})->>'description'`;
  const sql = `SELECT 'work' AS kind,s.submission_id::text AS id,${title} AS title,left(${description},180) AS summary,
    '/development/submissions/' || s.submission_id::text AS path,NULL::text AS label,
    CASE WHEN u.community_id=$9::uuid THEN u.user_id::text ELSE NULL END AS author_id,
    CASE WHEN s.image_bytes IS NOT NULL OR s.storage_source='asset' THEN '/api/v1/skill-submissions/' || s.submission_id::text || '/illustration' ELSE NULL END AS media_path,
    COALESCE((SELECT tags.topics FROM community_content_topic_sets tags WHERE tags.content_kind='work' AND tags.content_id=s.submission_id::text),'{}'::text[]) AS topics,${sort} AS sort_key
    ${publishedWorkFrom}
    AND NOT EXISTS (SELECT 1 FROM skill_submissions d WHERE d.upgrades_submission_id=s.submission_id AND d.status='published')
    AND lower(v.repository_full_name) <> ALL($8::text[])
    AND ${textSql([title, description])} AND ${topicSql('work', 's.submission_id::text')} AND ${cursorSql(sort, 'work')}
    AND ${relationSql('work', 's.submission_id', 's.owner_ref')}
    ORDER BY s.published_at DESC,s.submission_id LIMIT $7`;
  return (await pool.query(sql, [text, text ? likeOf(text) : '', cursor?.sort ?? null, cursor?.kind ?? null, cursor?.id ?? null, topics, limit, catalogRepositoryKeys, actor?.community_id ?? null, ...relationValues(filter, 'work'), actor?.community_id ?? null])).rows as Row[];
}
async function showcaseRows(pool: SearchDatabase, actor: Actor, text: string, cursor: ContentSearchCursor, topics: string[], limit: number, filter?: CommunityContentFilter) {
  const sort = sortOf('s.created_at');
  const sql = `SELECT 'work' AS kind,s.showcase_id::text AS id,s.title,left(s.description,180) AS summary,
    '#showcase/' || s.showcase_id::text AS path,u.display_name AS label,NULL::text AS media_path,
    CASE WHEN u.community_id=$8::uuid AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) THEN u.user_id::text ELSE NULL END AS author_id,
    COALESCE(tags.topics,'{}'::text[]) AS topics,${sort} AS sort_key
    FROM showcases s JOIN users u ON u.user_id=s.owner_ref
    LEFT JOIN community_content_topic_sets tags ON tags.content_kind='work' AND tags.content_id=s.showcase_id::text
    WHERE s.community_id=$8::uuid AND (s.owner_ref=$9::uuid OR NOT is_verification_test_account(s.owner_ref))
      AND ${textSql(['s.title', 's.description'])} AND ${topicSql('work', 's.showcase_id::text')}
      AND ${cursorSql(sort, 'work', 's.showcase_id')} AND ${relationSql('work', 's.showcase_id', 's.owner_ref')}
    ORDER BY s.created_at DESC,s.showcase_id LIMIT $7`;
  return (await pool.query(sql, [text, text ? likeOf(text) : '', cursor?.sort ?? null, cursor?.kind ?? null, cursor?.id ?? null, topics, limit, actor.community_id, actor.user_id, ...relationValues(filter, 'work'), actor.community_id])).rows as Row[];
}


async function bookRows(pool: SearchDatabase, text: string, cursor: ContentSearchCursor, topics: string[], limit: number, filter?: CommunityContentFilter) {
  const editorial = new Map((await pool.query('SELECT book_id,summary FROM skill_book_editorial')).rows.map(row => [String(row.book_id), String(row.summary)]));
  const assigned = new Map((await pool.query(`SELECT content_id,topics FROM community_content_topic_sets WHERE content_kind='skill_book'`)).rows.map(row => [String(row.content_id), row.topics as string[]]));
  const needle = text.toLocaleLowerCase('zh-Hant');
  return communityCatalog.skill_books.flatMap(book => {
    if (filter?.ids && !filter.ids.skill_book?.includes(book.id)) return [];
    if (!getSkillCollaboration(book.id)) return [];
    const summary = editorial.get(book.id) ?? book.description;
    const haystack = `${book.title}\n${summary}\n${book.guide?.summary ?? ''}\n${book.guide?.beginner.purpose ?? ''}`.toLocaleLowerCase('zh-Hant');
    const tags = (assigned.get(book.id) ?? []).filter((topic): topic is typeof TOPIC[number] => TOPIC.includes(topic as typeof TOPIC[number]));
    const row: Row = { kind: 'skill_book', id: book.id, title: book.title, summary: clip(summary), path: `/development/skills/${book.id}`, label: null, author_id: null, media_path: book.cover_url ?? null, topics: tags, sort_key: '2000-01-01T00:00:00.000000Z' };
    if ((needle && !haystack.includes(needle)) || (topics.length && !topics.some(topic => tags.includes(topic as typeof TOPIC[number]))) || !after(row, cursor)) return [];
    if (filter && (filter.authorIds || filter.followedTopics) && !filter.followedTopics?.some(topic => tags.includes(topic as typeof TOPIC[number]))) return [];
    return [row];
  }).sort(compare).slice(0, limit);
}

const topicBody = z.object({
  kind: z.enum(KIND),
  id: z.string().trim().min(1).max(100),
  topics: z.array(z.enum(TOPIC)).max(3),
}).strict();

async function owned(q: PoolClient, actor: Actor, kind: Kind, id: string) {
  if (kind === 'skill_book') {
    // Reuse the editor's appointment + current full AI-guild authority. It takes
    // the member-guild barrier before membership/appointment row locks.
    await requireSkillBookMaintainer(q, actor, id);
    return;
  }
  requireCondition(z.uuid().safeParse(id).success, 404, 'not_found', '找不到這份內容。');
  if (kind === 'work' && (await q.query(`SELECT 1 FROM showcases WHERE showcase_id=$1 AND community_id=$2 AND owner_ref=$3 FOR SHARE`, [id, actor.community_id, actor.user_id])).rowCount === 1) return;
  const sql = kind === 'post'
    ? `SELECT 1 FROM community_social_posts WHERE post_id=$1 AND community_id=$2 AND author_user_id=$3 AND state='active'`
    : kind === 'work'
      ? `SELECT 1 FROM skill_submissions WHERE submission_id=$1 AND community_id=$2 AND owner_ref=$3 AND status='published'`
      : `SELECT 1 FROM community_events WHERE event_id=$1 AND community_id=$2 AND organizer_ref=$3 AND state='published'`;
  requireCondition((await q.query(`${sql} FOR SHARE`, [id, actor.community_id, actor.user_id])).rowCount === 1, 404, 'not_found', '找不到這份內容。');
}

export async function assignContentTopics(pool: Pool, input: Command) {
  const body = topicBody.parse(input.body);
  if (body.kind !== 'skill_book') body.id = body.id.toLowerCase();
  const topics = [...new Set(body.topics)].sort();
  return command(pool, input, async q => { await owned(q, input.actor, body.kind, body.id); }, async q => {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`content-topic/${body.kind}/${body.id}`]);
    const prior = (await q.query(`SELECT set_id,aggregate_version FROM community_content_topic_sets WHERE content_kind=$1 AND content_id=$2 AND community_id=$3 FOR UPDATE`, [body.kind, body.id, input.actor.community_id])).rows[0];
    if (prior) checkVersion(String(prior.aggregate_version), input.expected);
    else requireCondition(!input.expected, 412, 'version_conflict', '主題已變更，請重新整理。');
    if (!topics.length && !prior) return { kind: body.kind, id: body.id, topics, aggregate_version: null };
    const setId = prior?.set_id ?? randomUUID();
    // Like saveSkillEditorial, scope both the prior and the unique-conflict
    // update: a matching public book/version is not community authority.
    const row = (await q.query(`INSERT INTO community_content_topic_sets(set_id,community_id,content_kind,content_id,topics,updated_by)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(content_kind,content_id) DO UPDATE SET topics=$5,updated_by=$6,updated_at=now(),aggregate_version=community_content_topic_sets.aggregate_version+1
      WHERE community_content_topic_sets.community_id=$2 RETURNING aggregate_version`,
    [setId, input.actor.community_id, body.kind, body.id, topics, input.actor.user_id])).rows[0];
    requireCondition(row, 403, 'editorial_scope_denied', '這份內容由另一個社群維護。');
    await journal(q, input.actor, 'community_content_topics', setId, row.aggregate_version, prior ? 'update' : 'assign', { kind: body.kind, id: body.id, topics });
    return { kind: body.kind, id: body.id, topics, aggregate_version: Number(row.aggregate_version) };
  });
}

export async function listTaggableContent(pool: Pool, actor: Actor) {
  return transaction(pool, async q => {
    await lockMemberSession(q, actor);
    const eligibleBooks = (await activeDevelopmentGuilds(q, actor, 'skill')).length > 0;
    const topics = new Map((await q.query(`SELECT content_kind,content_id,topics,aggregate_version FROM community_content_topic_sets WHERE community_id=$1`, [actor.community_id])).rows.map(row => [`${row.content_kind}:${row.content_id}`, row]));
    const tag = (kind: Kind, id: string) => { const row = topics.get(`${kind}:${id}`); return { topics: (row?.topics ?? []) as string[], aggregate_version: row ? Number(row.aggregate_version) : null }; };
    const [posts, works, events, books] = await Promise.all([
      q.query(`SELECT post_id::text AS id,title FROM community_social_posts WHERE community_id=$1 AND author_user_id=$2 AND state='active' ORDER BY created_at DESC,post_id LIMIT 20`, [actor.community_id, actor.user_id]),
      q.query(`SELECT id,title FROM (
        SELECT submission_id::text AS id,payload->>'title' AS title,published_at AS created_at
        FROM skill_submissions WHERE community_id=$1 AND owner_ref=$2 AND status='published'
        UNION ALL
        SELECT showcase_id::text AS id,title,created_at FROM showcases WHERE community_id=$1 AND owner_ref=$2
      ) owned_works ORDER BY created_at DESC,id LIMIT 20`, [actor.community_id, actor.user_id]),
      q.query(`SELECT event_id::text AS id,title FROM community_events WHERE community_id=$1 AND organizer_ref=$2 AND state='published' ORDER BY created_at DESC,event_id LIMIT 20`, [actor.community_id, actor.user_id]),
      q.query(`SELECT book_id FROM skill_book_maintainers WHERE community_id=$1 AND user_id=$2 AND active AND $3::boolean ORDER BY book_id LIMIT 20 FOR SHARE`, [actor.community_id, actor.user_id, eligibleBooks]),
    ]);
    await assertCurrentSessionClock(q, actor);
    return { items: [
      ...posts.rows.map(row => ({ kind: 'post' as const, id: String(row.id), title: String(row.title), ...tag('post', row.id) })),
      ...works.rows.map(row => ({ kind: 'work' as const, id: String(row.id), title: String(row.title ?? '作品'), ...tag('work', row.id) })),
      ...events.rows.map(row => ({ kind: 'event' as const, id: String(row.id), title: String(row.title), ...tag('event', row.id) })),
      ...books.rows.flatMap(row => { const book = communityCatalog.skill_books.find(item => item.id === row.book_id); return book ? [{ kind: 'skill_book' as const, id: book.id, title: book.title, ...tag('skill_book', book.id) }] : []; }),
    ] };
  });
}
