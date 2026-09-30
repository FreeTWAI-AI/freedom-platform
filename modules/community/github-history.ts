import {z} from 'zod';
import type {Pool, PoolClient} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import {communityCatalog, skillBooksForGuild} from './catalog.js';
import {guildTitles} from '../positioning/assessment.js';
import {githubCoordinate, publicJson} from '../opensource-marketing/github.js';
import {Problem, requireCondition} from '../../packages/shared/problem.js';
import {transaction} from '../../packages/db/index.js';
import repositorySet from '../../repositories.lock.json' with {type:'json'};

export type HistoryCategory = 'platform' | 'official' | 'personal';
export type HistoryRepository = {name: string; title: string; category: HistoryCategory; url: string};
export type HistoryKind = 'issue' | 'pr';
export type HistoryItem = {
  kind: HistoryKind; repository: string; number: number; title: string; url: string; author: string | null;
  created_at: string; updated_at: string; state: 'open' | 'closed'; state_reason?: string | null; merged_at?: string | null;
};
export type HistoryUnavailable = 'github_rate_limited' | 'github_unavailable' | 'github_invalid_response' | 'github_refresh_in_progress';
export type HistoryPage = {items: HistoryItem[]; has_more: boolean; checked_at: string | null; stale: boolean; unavailable?: HistoryUnavailable};
export const GITHUB_HISTORY_PAGE_CAP = 100;

const FRESH_MS = 20 * 60 * 1000;
const FAILURE_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const MIN_BACKOFF_MS = 1000;
const coordinate = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const loginPattern = /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/;
const date = z.iso.datetime({offset: true});
const issueSchema = z.object({
  number: z.number().int().positive(), title: z.string().max(1000), state: z.enum(['open', 'closed']),
  state_reason: z.string().max(100).nullable().optional(), user: z.object({login: z.string()}).nullable(),
  created_at: date, updated_at: date, pull_request: z.unknown().optional(),
});
const pullSchema = z.object({
  number: z.number().int().positive(), title: z.string().max(1000), state: z.enum(['open', 'closed']),
  user: z.object({login: z.string()}).nullable(), created_at: date, updated_at: date, merged_at: date.nullable(),
});
const storedItem = z.object({
  kind: z.enum(['issue', 'pr']), repository: z.string().regex(coordinate), number: z.number().int().positive(),
  title: z.string().max(300), url: z.string().url(), author: z.string().regex(loginPattern).nullable(),
  created_at: date, updated_at: date, state: z.enum(['open', 'closed']),
  state_reason: z.string().max(100).nullable().optional(), merged_at: date.nullable().optional(),
});
const snapshotSchema = z.object({items: z.array(storedItem).max(100), has_more: z.boolean()});
const STORED_ERRORS = ['github_rate_limited', 'github_unavailable', 'github_invalid_response'] as const;
type StoredError = typeof STORED_ERRORS[number];
type CacheRow = {snapshot: unknown; checked_at: Date | null; retry_after: Date; last_error: string | null};

function cleanTitle(value: string, fallback: string) {
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return text || fallback;
}
function authorOf(login: string | null | undefined) {
  return login && loginPattern.test(login) ? login : null;
}
function knownError(code: string): StoredError {
  return (STORED_ERRORS as readonly string[]).includes(code) ? code as StoredError : 'github_unavailable';
}
function describe(error: unknown): {code: StoredError; retryAfterSeconds?: number} {
  if (error instanceof Problem) {
    const code = error.code === 'github_rate_limited' || error.code === 'github_invalid_response' ? error.code : 'github_unavailable';
    return {code, retryAfterSeconds: error.retryAfterSeconds};
  }
  return {code: 'github_unavailable'};
}
function backoffMs(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return FAILURE_MS;
  return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, Math.ceil(seconds * 1000)));
}
function toItems(repository: string, kind: HistoryKind, data: Array<z.infer<typeof issueSchema> | z.infer<typeof pullSchema>>): HistoryItem[] {
  return data.filter(item => kind === 'pr' || !('pull_request' in item) || item.pull_request == null).map(item => {
    const fallback = `${kind === 'issue' ? 'Issue' : 'PR'} #${item.number}`;
    return {
      kind, repository, number: item.number, title: cleanTitle(item.title, fallback),
      url: `https://github.com/${repository}/${kind === 'issue' ? 'issues' : 'pull'}/${item.number}`,
      author: authorOf(item.user?.login ?? null), created_at: item.created_at, updated_at: item.updated_at, state: item.state,
      ...(kind === 'issue'
        ? {state_reason: 'state_reason' in item && typeof item.state_reason === 'string' ? item.state_reason : null}
        : {merged_at: 'merged_at' in item ? item.merged_at : null}),
    };
  });
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
    if (!coordinate.test(value)) return;
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

export class GitHubHistory {
  private pending = new Map<string, Promise<HistoryPage>>();
  constructor(private pool: Pool, private fetcher: typeof fetch = (...args) => globalThis.fetch(...args), private now = () => Date.now()) {}
  async page(repository: string, kind: HistoryKind, page: number, token?: string): Promise<HistoryPage> {
    requireCondition(coordinate.test(repository), 422, 'invalid_repository', '請選擇清單中的儲存庫。');
    requireCondition(Number.isInteger(page) && page >= 1 && page <= GITHUB_HISTORY_PAGE_CAP, 422, 'invalid_page', '歷史頁碼無效。');
    const key = `${repository.toLowerCase()}/${kind}/${page}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = this.load(repository, kind, page, key, token).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  private view(row: CacheRow): HistoryPage | null {
    const parsed = row.snapshot == null ? null : snapshotSchema.safeParse(row.snapshot);
    const snapshot = parsed?.success ? parsed.data : null;
    if (!snapshot && !row.last_error) return null;
    const unavailable = row.last_error ? knownError(row.last_error) : undefined;
    if (!snapshot) return {items: [], has_more: false, checked_at: row.checked_at?.toISOString() ?? null, stale: true, unavailable: unavailable ?? 'github_unavailable'};
    return {items: snapshot.items, has_more: snapshot.has_more, checked_at: row.checked_at?.toISOString() ?? null, stale: Boolean(row.last_error), ...(unavailable ? {unavailable} : {})};
  }
  private async read(q: PoolClient, key: string) {
    return (await q.query<CacheRow>('SELECT snapshot,checked_at,retry_after,last_error FROM github_history_cache WHERE cache_key=$1', [key])).rows[0];
  }
  private async save(q: PoolClient, key: string, snapshot: {items: HistoryItem[]; has_more: boolean}) {
    const retryAt = new Date(this.now() + FRESH_MS);
    return (await q.query<CacheRow>(`INSERT INTO github_history_cache(cache_key,snapshot,checked_at,retry_after,last_error) VALUES($1,$2::jsonb,now(),$3,NULL)
      ON CONFLICT(cache_key) DO UPDATE SET snapshot=EXCLUDED.snapshot,checked_at=now(),retry_after=EXCLUDED.retry_after,last_error=NULL
      RETURNING snapshot,checked_at,retry_after,last_error`, [key, JSON.stringify(snapshot), retryAt])).rows[0];
  }
  private async fail(q: PoolClient, key: string, code: string, retryAt: Date) {
    return (await q.query<CacheRow>(`INSERT INTO github_history_cache(cache_key,snapshot,checked_at,retry_after,last_error) VALUES($1,NULL,NULL,$2,$3)
      ON CONFLICT(cache_key) DO UPDATE SET retry_after=EXCLUDED.retry_after,last_error=EXCLUDED.last_error
      RETURNING snapshot,checked_at,retry_after,last_error`, [key, retryAt, code.slice(0, 80)])).rows[0];
  }
  private async fetchRaw(repository: string, kind: HistoryKind, page: number, token?: string) {
    const path = `/repos/${repository}/${kind === 'issue' ? 'issues' : 'pulls'}?state=all&sort=created&direction=desc&per_page=100&page=${page}`;
    const once = (authorization?: string) => publicJson(path, AbortSignal.timeout(10000), this.fetcher, false, 4194304, authorization);
    if (!token) return once();
    try { return await once(token); }
    catch (error) {
      if (!(error instanceof Problem) || error.code !== 'github_rate_limited') throw error;
      try { return await once(); }
      catch (second) {
        if (second instanceof Problem && error.retryAfterSeconds !== undefined && second.retryAfterSeconds === undefined) second.retryAfterSeconds = error.retryAfterSeconds;
        throw second;
      }
    }
  }
  private async load(repository: string, kind: HistoryKind, page: number, key: string, token?: string): Promise<HistoryPage> {
    return transaction(this.pool, async q => {
      let row = await this.read(q, key);
      if (row && row.retry_after.getTime() > this.now()) {
        const cached = this.view(row);
        if (cached) return cached;
      }
      const locked = (await q.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`github-history/${key}`])).rows[0].acquired;
      if (!locked) {
        row = await this.read(q, key);
        const cached = row ? this.view(row) : null;
        if (cached) return {...cached, stale: true};
        return {items: [], has_more: false, checked_at: null, stale: true, unavailable: 'github_refresh_in_progress'};
      }
      row = await this.read(q, key);
      if (row && row.retry_after.getTime() > this.now()) {
        const cached = this.view(row);
        if (cached) return cached;
      }
      try {
        const raw = await this.fetchRaw(repository, kind, page, token);
        const parsed = z.array(kind === 'issue' ? issueSchema : pullSchema).max(100).safeParse(raw);
        if (!parsed.success) throw new Problem(503, 'github_invalid_response', 'GitHub 歷史資料不完整，請稍後重試。');
        const items = toItems(repository, kind, parsed.data);
        const snapshot = {items, has_more: parsed.data.length === 100};
        const saved = await this.save(q, key, snapshot);
        return this.view(saved) ?? {items, has_more: snapshot.has_more, checked_at: new Date(this.now()).toISOString(), stale: false};
      } catch (error) {
        const failure = describe(error);
        const saved = await this.fail(q, key, failure.code, new Date(this.now() + backoffMs(failure.retryAfterSeconds)));
        return this.view(saved) ?? {items: [], has_more: false, checked_at: null, stale: true, unavailable: failure.code};
      }
    });
  }
}
