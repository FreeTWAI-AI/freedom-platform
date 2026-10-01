import type {Pool} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import {communityCatalog, skillBooksForGuild} from './catalog.js';
import {guildTitles} from '../positioning/assessment.js';
import {githubCoordinate} from '../opensource-marketing/github.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {rankedLeaderboards} from '../../packages/shared/github-leaderboard.js';
import repositorySet from '../../repositories.lock.json' with {type:'json'};

export type HistoryCategory = 'platform' | 'official' | 'personal';
export type HistoryRepository = {name: string; title: string; category: HistoryCategory; url: string};
export type HistorySyncStatus = 'syncing' | 'ok' | 'unreadable';
export type HistoryRepositoryView = HistoryRepository & {sync: {status: HistorySyncStatus; last_synced_at: string | null}};
export type HistoryKind = 'issue' | 'pr';
export type HistoryItem = {
  kind: HistoryKind; repository: string; number: number; title: string; url: string; author: string | null;
  created_at: string; updated_at: string; state: 'open' | 'closed'; state_reason?: string | null; merged_at?: string | null;
};
export type HistoryUnavailable = 'github_rate_limited' | 'github_unavailable' | 'github_invalid_response' | 'github_refresh_in_progress' | 'github_sync_pending' | 'github_unreadable';
export type HistoryPage = {items: HistoryItem[]; has_more: boolean; checked_at: string | null; stale: boolean; unavailable?: HistoryUnavailable};
export type HistoryLeaderboards = {
  ideas: {login: string; count: number}[];
  edits: {login: string; count: number}[];
  contributions: {login: string; count: number}[];
  complete: boolean;
  oldest_synced_at: string | null;
  syncing: string[];
  unreadable: string[];
};
export const GITHUB_HISTORY_PAGE_CAP = 100;
export const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const PAGE_SIZE = 100;
const STALE_MS = 60 * 60 * 1000;
const loginPattern = /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** PostgreSQL text: drop NUL and lone surrogates, then keep at most `maxCodePoints` (`char_length`). */
export function postgresText(value: string, maxCodePoints: number): string {
  const cleaned = value.replace(/\u0000/g, '').replace(loneSurrogate, '');
  let index = 0;
  let points = 0;
  while (index < cleaned.length && points < maxCodePoints) {
    const unit = cleaned.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      if (index + 1 >= cleaned.length) break;
      index += 2;
    } else index += 1;
    points += 1;
  }
  return cleaned.slice(0, index);
}
export function cleanTitle(value: string, fallback: string) {
  const text = postgresText(value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim(), 300);
  return text || fallback;
}
export function authorOf(login: string | null | undefined) {
  return login && loginPattern.test(login) ? login : null;
}

type SyncMeta = {repository_key: string; access_status: string; backfilled: boolean; last_synced_at: Date | null};

function syncStatus(row: SyncMeta | undefined): HistorySyncStatus {
  if (row?.access_status === 'unreadable') return 'unreadable';
  if (!row?.backfilled) return 'syncing';
  return 'ok';
}
function iso(value: Date | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

/** The list is based on the current platform architecture set, guild bindings, and public works registered here. */
export async function historyRepositories(pool: Pool, actor: Actor): Promise<HistoryRepository[]> {
  const rows = await Promise.all([
    pool.query('SELECT book_id FROM guild_skill_book_bindings WHERE community_id=$1', [actor.community_id]),
    pool.query('SELECT repository_full_name,title FROM oss_projects WHERE community_id=$1 ORDER BY created_at DESC', [actor.community_id]),
  ]);
  const assigned = new Set<string>(rows[0].rows.map(row => row.book_id));
  for (const key of Object.keys(guildTitles)) for (const book of skillBooksForGuild(key)) assigned.add(book.id);
  const byName = new Map<string, HistoryRepository>();
  const add = (value: string, title: string, category: HistoryCategory) => {
    if (!GITHUB_REPOSITORY_NAME.test(value)) return;
    const name = value.toLowerCase(), prior = byName.get(name);
    const priority = {personal: 0, official: 1, platform: 2};
    if (!prior || priority[category] > priority[prior.category]) byName.set(name, {name: value, title, category, url: `https://github.com/${value}`});
  };
  add('FreeTWAI-AI/freedom-platform', '自由工坊平台', 'platform');
  for (const entry of repositorySet.repositories) add(entry.repository, entry.repository.split('/')[1], 'platform');
  for (const book of communityCatalog.skill_books) {
    const value = book.upstream_url || book.repository_url;
    try { add(githubCoordinate(value), book.title, assigned.has(book.id) ? 'official' : 'personal'); } catch { /* A catalog entry without a valid GitHub source is not queried. */ }
  }
  for (const row of rows[1].rows) add(row.repository_full_name, row.title, 'personal');
  return [...byName.values()].sort((a, b) => ({platform: 0, official: 1, personal: 2})[a.category] - ({platform: 0, official: 1, personal: 2})[b.category] || a.title.localeCompare(b.title, 'zh-TW'));
}

async function syncMeta(pool: Pool, keys: string[]) {
  if (!keys.length) return new Map<string, SyncMeta>();
  const rows = await pool.query<SyncMeta>('SELECT repository_key, access_status, backfilled, last_synced_at FROM github_sync_repositories WHERE repository_key = ANY($1::text[])', [keys]);
  return new Map(rows.rows.map(row => [row.repository_key, row]));
}

export async function historyRepositoryViews(pool: Pool, actor: Actor): Promise<HistoryRepositoryView[]> {
  const repos = await historyRepositories(pool, actor);
  const meta = await syncMeta(pool, repos.map(repo => repo.name.toLowerCase()));
  return repos.map(repo => {
    const row = meta.get(repo.name.toLowerCase());
    return {...repo, sync: {status: syncStatus(row), last_synced_at: iso(row?.last_synced_at)}};
  });
}

/** One page of stored issues or pull requests. This path does not call GitHub. */
export async function githubHistoryPage(pool: Pool, repository: string, kind: HistoryKind, page: number, now = Date.now()): Promise<HistoryPage> {
  requireCondition(GITHUB_REPOSITORY_NAME.test(repository), 422, 'invalid_repository', '請選擇清單中的儲存庫。');
  requireCondition(Number.isInteger(page) && page >= 1 && page <= GITHUB_HISTORY_PAGE_CAP, 422, 'invalid_page', '歷史頁碼無效。');
  const key = repository.toLowerCase();
  const meta = (await syncMeta(pool, [key])).get(key);
  const checkedAt = iso(meta?.last_synced_at);
  const stale = !meta?.backfilled || !meta.last_synced_at || now - new Date(meta.last_synced_at).getTime() > STALE_MS;
  const unavailable: HistoryUnavailable | undefined = meta?.access_status === 'unreadable' ? 'github_unreadable' : !meta?.last_synced_at ? 'github_sync_pending' : undefined;
  const loaded = await pool.query<{number: number; title: string; author_login: string | null; state: 'open' | 'closed'; state_reason: string | null; merged_at: Date | null; created_at: Date; updated_at: Date}>(
    `SELECT number, title, author_login, state, state_reason, merged_at, created_at, updated_at
     FROM github_items WHERE repository_key=$1 AND kind=$2
     ORDER BY created_at DESC, number DESC
     LIMIT $3 OFFSET $4`,
    [key, kind, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE],
  );
  const hasMore = loaded.rows.length > PAGE_SIZE;
  const items: HistoryItem[] = loaded.rows.slice(0, PAGE_SIZE).map(row => {
    const base = {
      kind, repository, number: row.number, title: row.title,
      url: `https://github.com/${repository}/${kind === 'issue' ? 'issues' : 'pull'}/${row.number}`,
      author: row.author_login, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(), state: row.state,
    };
    return kind === 'issue' ? {...base, state_reason: row.state_reason} : {...base, merged_at: iso(row.merged_at)};
  });
  return {items, has_more: hasMore, checked_at: checkedAt, stale, ...(unavailable ? {unavailable} : {})};
}

/** Three display-only boards over the repositories this actor can already see. */
export async function githubHistoryLeaderboards(pool: Pool, actor: Actor): Promise<HistoryLeaderboards> {
  const repos = await historyRepositories(pool, actor);
  const keys = repos.map(repo => repo.name.toLowerCase());
  const meta = await syncMeta(pool, keys);
  const syncing: string[] = [];
  const unreadable: string[] = [];
  let complete = repos.length > 0;
  let oldest: number | null = null;
  for (const repo of repos) {
    const row = meta.get(repo.name.toLowerCase());
    if (row?.access_status === 'unreadable') unreadable.push(repo.name);
    else if (!row?.backfilled) syncing.push(repo.name);
    if (row?.access_status === 'unreadable' || !row?.backfilled) complete = false;
    if (row?.last_synced_at) {
      const time = new Date(row.last_synced_at).getTime();
      if (oldest === null || time < oldest) oldest = time;
    }
  }
  const counts = keys.length ? await pool.query<{login: string; ideas: number; edits: number}>(
    `SELECT min(author_login) AS login,
            count(*) FILTER (WHERE kind = 'issue')::int AS ideas,
            count(*) FILTER (WHERE kind = 'pr')::int AS edits
     FROM github_items
     WHERE repository_key = ANY($1::text[])
       AND author_login IS NOT NULL
       AND btrim(author_login) <> ''
       AND lower(btrim(author_login)) NOT LIKE '%[bot]'
       AND lower(btrim(author_login)) NOT IN ('dependabot', 'github-actions')
     GROUP BY lower(btrim(author_login))`,
    [keys],
  ) : {rows: []};
  const boards = rankedLeaderboards(counts.rows.map(row => ({login: row.login, ideas: Number(row.ideas), edits: Number(row.edits)})));
  return {...boards, complete, oldest_synced_at: oldest === null ? null : new Date(oldest).toISOString(), syncing, unreadable};
}
