import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { command, journal, transaction, type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { communitySearchKinds, communitySearchTopics, communitySearchTopicLabels, type CommunitySearchPage } from '../../packages/shared/community-search.js';
import { lockMemberSession, assertCurrentSessionClock } from '../../packages/db/member-session.js';
import type { Actor } from '../identity-membership/service.js';
import { searchCommunityContent, type CommunityContentFilter } from './content-search.js';

type ContentKind = typeof communitySearchKinds[number];
type FollowKind = 'author' | 'topic';
interface BookmarkRow { relation_id: string; content_kind: ContentKind; content_id: string; sort_key: string }
interface FollowItem { relation_id: string; kind: FollowKind; id: string; label: string | null; available: boolean }
const bookmarkBody = z.object({ kind: z.enum(communitySearchKinds), id: z.string().trim().min(1).max(100), selected: z.boolean() }).strict();
const followBody = z.object({ kind: z.enum(['author', 'topic']), id: z.string().trim().min(1).max(100), selected: z.boolean() }).strict();
const activeAuthor = `u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
  AND (u.user_id=$2::uuid OR NOT is_verification_test_account(u.user_id))`;

async function readBookmarks(pool: PoolClient, actor: Actor, raw: Record<string, string | undefined>) {
  requireCondition(Object.keys(raw).every(key => key === 'cursor'), 422, 'validation_failed', '收藏只接受分頁標記。');
  let sort: string | null = null;
  let id: string | null = null;
  if (raw.cursor !== undefined) {
    requireCondition(raw.cursor.length <= 200 && /^[A-Za-z0-9_-]+$/.test(raw.cursor), 422, 'invalid_cursor', '分頁標記不正確。');
    const parts = Buffer.from(raw.cursor, 'base64url').toString('utf8').split('\n');
    requireCondition(parts.length === 2 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parts[0]!) && z.uuid().safeParse(parts[1]).success, 422, 'invalid_cursor', '分頁標記不正確。');
    [sort, id] = parts as [string, string];
  }
  const rows = (await pool.query(`SELECT relation_id::text,content_kind,content_id,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key
    FROM community_content_bookmarks WHERE community_id=$1 AND owner_user_id=$2
      AND ($3::text IS NULL OR to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') < $3
        OR (to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=$3 AND relation_id::text>$4))
    ORDER BY created_at DESC,relation_id LIMIT 21`, [actor.community_id, actor.user_id, sort, id])).rows as BookmarkRow[];
  const page = rows.slice(0, 20);
  const ids: CommunityContentFilter['ids'] = {};
  for (const row of page) (ids[row.content_kind] ??= []).push(row.content_id);
  const content = page.length ? (await searchCommunityContent(pool, actor, {}, { ids })).items : [];
  const last = page.at(-1);
  return {
    items: page.map(row => ({ relation_id: row.relation_id, kind: row.content_kind, id: row.content_id,
      content: content.find(item => item.kind === row.content_kind && item.id === row.content_id) ?? null })),
    next_cursor: rows.length > 20 && last ? Buffer.from(`${last.sort_key}\n${last.relation_id}`).toString('base64url') : null,
  };
}

export async function changeCommunityBookmark(pool: Pool, input: Command) {
  const body = bookmarkBody.parse(input.body);
  if (body.kind !== 'skill_book') {
    requireCondition(z.uuid().safeParse(body.id).success, 422, 'validation_failed', '內容識別碼不正確。');
    body.id = body.id.toLowerCase();
  }
  return changeRelation(pool, input, 'bookmark', body, async q => {
    const page = await searchCommunityContent(q, input.actor, { kinds: body.kind }, { ids: { [body.kind]: [body.id] } });
    requireCondition(page.items.length === 1, 404, 'not_found', '找不到這份內容。');
  });
}

async function readFollows(pool: PoolClient, actor: Actor): Promise<{ items: FollowItem[] }> {
  const rows = (await pool.query(`SELECT f.relation_id::text,f.target_kind AS kind,f.target_id AS id,
    CASE WHEN ${activeAuthor} THEN u.display_name ELSE NULL END AS label
    FROM community_content_follows f LEFT JOIN users u ON f.target_kind='author'
      AND u.user_id::text=f.target_id AND u.community_id=f.community_id
    WHERE f.community_id=$1 AND f.owner_user_id=$2 ORDER BY f.created_at DESC,f.relation_id`, [actor.community_id, actor.user_id])).rows;
  return { items: rows.map(row => {
    const topicAvailable = row.kind === 'topic' && communitySearchTopics.includes(row.id);
    return { relation_id: String(row.relation_id), kind: row.kind as FollowKind, id: String(row.id),
      label: row.kind === 'topic' ? topicAvailable ? communitySearchTopicLabels[row.id as typeof communitySearchTopics[number]] : null : row.label ?? null,
      available: row.kind === 'topic' ? topicAvailable : row.label !== null };
  }) };
}

export async function changeCommunityFollow(pool: Pool, input: Command) {
  const body = followBody.parse(input.body);
  if (body.kind === 'author') {
    requireCondition(z.uuid().safeParse(body.id).success, 422, 'validation_failed', '作者識別碼不正確。');
    body.id = body.id.toLowerCase();
  }
  return changeRelation(pool, input, 'follow', body, async q => {
    if (body.kind === 'topic') {
      requireCondition(communitySearchTopics.includes(body.id as typeof communitySearchTopics[number]), 404, 'not_found', '找不到這個主題。');
    } else {
      requireCondition((await q.query(`SELECT 1 FROM users u WHERE u.community_id=$1 AND ${activeAuthor} AND u.user_id=$3 FOR SHARE`, [input.actor.community_id, input.actor.user_id, body.id])).rowCount === 1, 404, 'not_found', '找不到這位作者。');
    }
  });
}

export async function readFollowUpdates(pool: PoolClient, actor: Actor, raw: Record<string, string | undefined>): Promise<CommunitySearchPage> {
  requireCondition(Object.keys(raw).every(key => key === 'cursor'), 422, 'validation_failed', '追蹤更新只接受分頁標記。');
  const { items } = await readFollows(pool, actor);
  const authorIds: string[] = [];
  const followedTopics: string[] = [];
  for (const item of items) if (item.available) (item.kind === 'author' ? authorIds : followedTopics).push(item.id);
  return searchCommunityContent(pool, actor, raw, { authorIds, followedTopics });
}

async function changeRelation(pool: Pool, input: Command, relation: 'bookmark' | 'follow', body: { kind: ContentKind | FollowKind; id: string; selected: boolean }, validate: (q: PoolClient) => Promise<void>) {
  const table = relation === 'bookmark' ? 'community_content_bookmarks' : 'community_content_follows';
  const kindColumn = relation === 'bookmark' ? 'content_kind' : 'target_kind';
  const idColumn = relation === 'bookmark' ? 'content_id' : 'target_id';
  let prior: { relation_id: string; aggregate_version: string } | undefined;
  return command(pool, input, async q => {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`community-${relation}/${input.actor.community_id}/${input.actor.user_id}/${body.kind}/${body.id}`]);
    prior = (await q.query(`SELECT relation_id,aggregate_version FROM ${table} WHERE community_id=$1 AND owner_user_id=$2 AND ${kindColumn}=$3 AND ${idColumn}=$4 FOR UPDATE`, [input.actor.community_id, input.actor.user_id, body.kind, body.id])).rows[0];
    // Existing unavailable references remain selectable/removable; only initial creation checks the target.
    if (body.selected && !prior) await validate(q);
  }, async q => {
    if (body.selected && !prior) {
      const relationId = randomUUID();
      await q.query(`INSERT INTO ${table}(relation_id,community_id,owner_user_id,${kindColumn},${idColumn}) VALUES($1,$2,$3,$4,$5)`, [relationId, input.actor.community_id, input.actor.user_id, body.kind, body.id]);
      await journal(q, input.actor, `community_content_${relation}`, relationId, 1, 'select', body);
    } else if (!body.selected && prior) {
      await q.query(`DELETE FROM ${table} WHERE relation_id=$1 AND community_id=$2 AND owner_user_id=$3`, [prior.relation_id, input.actor.community_id, input.actor.user_id]);
      await journal(q, input.actor, `community_content_${relation}`, prior.relation_id, Number(prior.aggregate_version) + 1, 'remove', body);
    }
    return { kind: body.kind, id: body.id, selected: body.selected };
  });
}

// Hold current user/session locks through every private read, including all
// source lookups, then refresh the decision clock after their final wait.
async function privateRead<T>(pool: Pool, actor: Actor, read: (q: PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool, async q => {
    await lockMemberSession(q, actor);
    const result = await read(q);
    await assertCurrentSessionClock(q, actor);
    return result;
  });
}
export function listCommunityBookmarks(pool: Pool, actor: Actor, raw: Record<string, string | undefined>) {
  return privateRead(pool, actor, q => readBookmarks(q, actor, raw));
}
export function listCommunityFollows(pool: Pool, actor: Actor) {
  return privateRead(pool, actor, q => readFollows(q, actor));
}
export function listCommunityFollowUpdates(pool: Pool, actor: Actor, raw: Record<string, string | undefined>) {
  return privateRead(pool, actor, q => readFollowUpdates(q, actor, raw));
}
