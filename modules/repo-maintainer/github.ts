import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { readGitHub, type GitHubRead } from '../opensource-marketing/github.js';
import { Problem } from '../../packages/shared/problem.js';

export const SYNC_PERMISSIONS = { metadata: 'read' } as const;
export const READ_PERMISSIONS = { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', contents: 'read' } as const;
export type GitHubPermissions = Record<string, 'read' | 'write'>;

const PAGE = 100;
const POST_BYTES = 64 * 1024;
function clipCodePoints(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}
const githubHeaders = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Freedom-Platform-maintainer' };
const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const shaSchema = z.string().regex(/^[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const loginSchema = z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/);
const userSchema = z.object({ id: idSchema, login: loginSchema, type: z.string().min(1).max(40) });
const installationSchema = z.object({
  id: idSchema,
  account: z.object({ login: z.string().min(1).max(100), type: z.string().min(1).max(40) }).nullable(),
  suspended_at: z.string().nullable().optional(),
});
const repoSchema = z.object({
  id: idSchema,
  full_name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  default_branch: z.string().min(1).max(255),
});
const installationRepositoryPageSchema = z.object({
  total_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  repository_selection: z.string().min(1),
  repositories: z.array(repoSchema),
});
const pullListSchema = z.object({ number: idSchema, updated_at: z.string(), head: z.object({ sha: shaSchema }) });
const pullSchema = z.object({
  id: idSchema,
  number: idSchema,
  title: z.string(),
  html_url: z.string().max(500),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  draft: z.boolean(),
  user: userSchema,
  author_association: z.string().min(1).max(40),
  head: z.object({ sha: shaSchema, repo: z.object({ id: idSchema, fork: z.boolean() }).nullable() }),
  base: z.object({ ref: z.string().min(1).max(255), sha: shaSchema, repo: z.object({ id: idSchema }).nullable() }),
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string().max(40).nullable(),
  labels: z.array(z.object({ name: z.string().transform(value => clipCodePoints(value, 100)) })).default([]),
  additions: z.number().int().nonnegative().max(100000000),
  deletions: z.number().int().nonnegative().max(100000000),
  changed_files: z.number().int().nonnegative().max(100000000),
  created_at: z.string(),
  updated_at: z.string(),
});
const fileSchema = z.object({
  filename: z.string().min(1).max(1024),
  previous_filename: z.string().min(1).max(1024).nullable().optional(),
  status: z.string().min(1).max(40),
  additions: z.number().int().nonnegative().max(100000000),
  deletions: z.number().int().nonnegative().max(100000000),
});
const reviewSchema = z.object({
  id: idSchema,
  user: userSchema.nullable(),
  author_association: z.string().max(40).nullable(),
  state: z.string().min(1).max(40),
  commit_id: z.string().regex(/^[0-9a-fA-F]{40}$/).nullable(),
  submitted_at: z.string().nullable(),
});
const checkSchema = z.object({
  id: idSchema,
  name: z.string().min(1).transform(value => clipCodePoints(value, 200)),
  status: z.string().min(1).max(40).nullable().optional(),
  conclusion: z.string().max(40).nullable().optional(),
  app: z.object({ id: idSchema, slug: z.string().min(1).max(100).nullable().optional() }).nullable().optional(),
  check_suite: z.object({ id: idSchema }).nullable().optional(),
  completed_at: z.string().nullable().optional(),
});
const statusSchema = z.object({
  context: z.string().min(1).transform(value => clipCodePoints(value, 200)),
  state: z.string().min(1).max(40),
});
const contentSchema = z.object({ name: z.string().min(1).max(255), type: z.string() });
const tokenSchema = z.object({ token: z.string().min(1).max(2000), permissions: z.record(z.string(), z.string()) });

export class GitHubSignal extends Error {
  constructor(
    readonly kind: 'budget' | 'time' | 'rate_limit' | 'moved' | 'not_found' | 'retry' | 'permission',
    code: string,
    readonly until?: Date,
    readonly installationId?: string,
  ) {
    super(code);
    this.name = code;
  }
}

export type MaintainerInstallation = { id: string; accountLogin: string; accountType: string; suspendedAt: string | null };
export type MaintainerRepoRef = { id: string; fullName: string; defaultBranch: string };
export type MaintainerPullRef = { number: number; updatedAt: string; headSha: string };
export type MaintainerPull = z.infer<typeof pullSchema>;
export type MaintainerPullFile = { path: string; previous_path: string | null; status: string; additions: number; deletions: number };
export type MaintainerPullReview = { github_review_id: string; reviewer_github_id: string; reviewer_login: string; reviewer_type: string; reviewer_association: string | null; state: string; commit_id: string | null; submitted_at: string };
export type MaintainerPullCheck = { source: 'check_run' | 'status'; name: string; app_key: string; app_slug: string | null; status: string; conclusion: string | null; check_suite_id: string | null; completed_at: string | null };

export type MaintainerGitHub = {
  requests: number;
  listInstallations: () => Promise<{ items: MaintainerInstallation[]; truncated: boolean }>;
  listInstallationRepositories: (installationId: string) => Promise<{ items: MaintainerRepoRef[]; truncated: boolean }>;
  listOpenPulls: (fullName: string, installationId: string, repositoryId: string) => Promise<{ items: MaintainerPullRef[]; truncated: boolean }>;
  readPull: (fullName: string, installationId: string, repositoryId: string, number: number) => Promise<MaintainerPull>;
  readFiles: (fullName: string, installationId: string, repositoryId: string, number: number) => Promise<{ items: MaintainerPullFile[]; truncated: boolean }>;
  readReviews: (fullName: string, installationId: string, repositoryId: string, number: number) => Promise<{ items: MaintainerPullReview[]; truncated: boolean }>;
  readChecks: (fullName: string, installationId: string, repositoryId: string, headSha: string) => Promise<MaintainerPullCheck[]>;
  readMigrationNames: (fullName: string, installationId: string, repositoryId: string, dir: string, ref: string) => Promise<string[]>;
};

const MIN_RATE_MS = 60_000;
const MAX_RATE_MS = 3_600_000;

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 86400 ? undefined : seconds * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const delta = parsed - now;
  return delta < 0 || delta > 86400 * 1000 ? undefined : delta;
}
function rateUntil(now: Date, reset: string | null, retryAfter: string | null): Date {
  let chosen: number | undefined;
  if (reset && /^\d+$/.test(reset.trim())) chosen = Number(reset.trim()) * 1000 - now.getTime();
  if (chosen === undefined || !Number.isFinite(chosen)) chosen = retryAfterMs(retryAfter, now.getTime());
  if (chosen === undefined || !Number.isFinite(chosen) || chosen <= 0) chosen = MIN_RATE_MS;
  return new Date(now.getTime() + Math.min(MAX_RATE_MS, Math.max(MIN_RATE_MS, Math.ceil(chosen))));
}
function isRateLimit(read: GitHubRead): boolean {
  if (read.status !== 403 && read.status !== 429) return false;
  return read.rateRemaining === '0' || Boolean(read.retryAfter?.trim());
}
function permissionCovers(got: string | undefined, want: 'read' | 'write'): boolean {
  if (want === 'read') return got === 'read' || got === 'write';
  return got === 'write';
}
function parse<T>(schema: z.ZodType<T>, body: unknown, installationId?: string): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new GitHubSignal('retry', 'github_invalid_response', undefined, installationId);
  return result.data;
}
function withPage(path: string, page: number): string {
  return `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`;
}
function repoPath(fullName: string, rest: string): string {
  const [owner, name] = fullName.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`;
}

async function postGitHub(path: string, body: unknown, token: string, signal: AbortSignal, fetcher: typeof fetch): Promise<GitHubRead> {
  let response: Response;
  try {
    response = await fetcher(`https://api.github.com${path}`, {
      method: 'POST',
      headers: { ...githubHeaders, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal,
    });
  } catch {
    throw new Problem(503, 'github_unavailable', '暫時無法讀取 GitHub。');
  }
  const meta = {
    etag: response.headers.get('etag'),
    retryAfter: response.headers.get('retry-after'),
    rateRemaining: response.headers.get('x-ratelimit-remaining'),
    rateReset: response.headers.get('x-ratelimit-reset'),
  };
  if (response.status >= 300 && response.status < 400) {
    try { await response.body?.cancel(); } catch { /* status is final */ }
    return { status: response.status, ...meta, body: null };
  }
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, ...meta, body: null };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > POST_BYTES) { await reader.cancel(); throw new Problem(503, 'github_response_too_large', 'GitHub 回應過大。'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(503, 'github_invalid_response', 'GitHub 回應不完整。');
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (response.status !== 200 && response.status !== 201) return { status: response.status, ...meta, body: text };
  try { return { status: response.status, ...meta, body: text ? JSON.parse(text) : null }; }
  catch { throw new Problem(503, 'github_invalid_response', 'GitHub 回應不完整。'); }
}

export function createMaintainerGitHub(options: {
  fetcher: typeof fetch;
  appId: string;
  privateKey: string;
  budget: number;
  deadlineMs: number;
  now: () => Date;
}): MaintainerGitHub {
  // workerd throws Illegal invocation if fetch is called as a method. Keep a bare function.
  const fetcher = options.fetcher;
  let requests = 0;
  let signingKey: CryptoKey | null = null;
  let appJwt: { token: string; exp: number } | null = null;
  const tokens = new Map<string, string>();

  async function appToken(): Promise<string> {
    const now = Math.floor(options.now().getTime() / 1000);
    if (appJwt && appJwt.exp - 30 > now) return appJwt.token;
    signingKey ??= await importPKCS8(options.privateKey, 'RS256');
    const exp = now + 540;
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(options.appId).setIssuedAt(now - 60).setExpirationTime(exp).sign(signingKey);
    appJwt = { token, exp };
    return token;
  }
  async function call(path: string, auth: { jwt?: boolean; token?: string }, installationId: string | undefined, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    if (requests >= options.budget) throw new GitHubSignal('budget', 'github_budget', undefined, installationId);
    if (options.now().getTime() >= options.deadlineMs) throw new GitHubSignal('time', 'github_tick_time', undefined, installationId);
    requests += 1;
    const signal = AbortSignal.timeout(10_000);
    let read: GitHubRead;
    try {
      if (method === 'POST') read = await postGitHub(path, body, auth.token ?? '', signal, fetcher);
      else read = await readGitHub(path, signal, fetcher, 4_194_304, auth.token);
    } catch (error) {
      if (error instanceof GitHubSignal) throw error;
      const code = error instanceof Problem && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'github_unavailable';
      throw new GitHubSignal('retry', code, undefined, installationId);
    }
    if (isRateLimit(read)) throw new GitHubSignal('rate_limit', 'github_rate_limited', rateUntil(options.now(), read.rateReset, read.retryAfter), installationId);
    if (read.status >= 300 && read.status < 400) throw new GitHubSignal('moved', 'github_moved', undefined, installationId);
    if (read.status === 404 || read.status === 410) throw new GitHubSignal('not_found', 'github_not_found', undefined, installationId);
    if (read.status !== 200 && read.status !== 201) throw new GitHubSignal('retry', `github_http_${read.status}`, undefined, installationId);
    return read.body;
  }
  async function mintInstallationToken(installationId: string, cacheKey: string, body: Record<string, unknown>, permissions: GitHubPermissions): Promise<string> {
    const cached = tokens.get(cacheKey);
    if (cached) return cached;
    const response = await call(`/app/installations/${installationId}/access_tokens`, { token: await appToken() }, installationId, 'POST', body);
    const parsed = parse(tokenSchema, response, installationId);
    for (const [name, want] of Object.entries(permissions)) {
      if (!permissionCovers(parsed.permissions[name], want)) throw new GitHubSignal('permission', 'github_permission_missing', undefined, installationId);
    }
    tokens.set(cacheKey, parsed.token);
    return parsed.token;
  }
  async function installationToken(installationId: string, repositoryId: string, permissions: GitHubPermissions): Promise<string> {
    const repositoryIds = [Number(repositoryId)];
    if (!Number.isSafeInteger(repositoryIds[0]) || repositoryIds[0] <= 0) throw new GitHubSignal('retry', 'github_invalid_response', undefined, installationId);
    const key = `${installationId}\n${repositoryIds.join(',')}\n${JSON.stringify(permissions)}`;
    return mintInstallationToken(installationId, key, { repository_ids: repositoryIds, permissions }, permissions);
  }
  // No repository list: this token covers every repository the installation can access.
  async function syncInstallationToken(installationId: string): Promise<string> {
    const permissions: GitHubPermissions = { ...SYNC_PERMISSIONS };
    const key = `${installationId}\n*\n${JSON.stringify(permissions)}`;
    return mintInstallationToken(installationId, key, { permissions }, permissions);
  }
  async function pages<T>(path: string, schema: z.ZodType<T[]>, cap: number, token: string | null, installationId?: string): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    for (let page = 1; page <= cap; page += 1) {
      const body = await call(withPage(path, page), token ? { token } : { token: await appToken() }, installationId, 'GET');
      const batch = parse(schema, body, installationId);
      items.push(...batch);
      if (batch.length < PAGE) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  return {
    get requests() { return requests; },
    async listInstallations() {
      const page = await pages('/app/installations', z.array(installationSchema), 10, null);
      return {
        truncated: page.truncated,
        items: page.items.filter(item => item.account).map(item => ({
          id: String(item.id), accountLogin: item.account!.login, accountType: item.account!.type, suspendedAt: item.suspended_at || null,
        })),
      };
    },
    async listInstallationRepositories(installationId) {
      // GET /installation/repositories is the installation-token route. The App JWT path does not exist.
      const token = await syncInstallationToken(installationId);
      const items: MaintainerRepoRef[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const body = await call(withPage('/installation/repositories', page), { token }, installationId, 'GET');
        const parsed = parse(installationRepositoryPageSchema, body, installationId);
        items.push(...parsed.repositories.map(repo => ({ id: String(repo.id), fullName: repo.full_name, defaultBranch: repo.default_branch })));
        if (parsed.repositories.length < PAGE) return { items, truncated: false };
      }
      return { items, truncated: true };
    },
    async listOpenPulls(fullName, installationId, repositoryId) {
      const token = await installationToken(installationId, repositoryId, { ...READ_PERMISSIONS });
      const page = await pages(repoPath(fullName, '/pulls?state=open'), z.array(pullListSchema), 10, token, installationId);
      return { truncated: page.truncated, items: page.items.map(item => ({ number: item.number, updatedAt: item.updated_at, headSha: item.head.sha })) };
    },
    async readPull(fullName, installationId, repositoryId, number) {
      const token = await installationToken(installationId, repositoryId, { ...READ_PERMISSIONS });
      return parse(pullSchema, await call(repoPath(fullName, `/pulls/${number}`), { token }, installationId, 'GET'), installationId);
    },
    async readFiles(fullName, installationId, repositoryId, number) {
      const token = await installationToken(installationId, repositoryId, { ...READ_PERMISSIONS });
      const page = await pages(repoPath(fullName, `/pulls/${number}/files`), z.array(fileSchema), 10, token, installationId);
      const items = new Map<string, MaintainerPullFile>();
      for (const file of page.items) items.set(file.filename, { path: file.filename, previous_path: file.previous_filename ?? null, status: file.status, additions: file.additions, deletions: file.deletions });
      return { items: [...items.values()], truncated: page.truncated };
    },
    async readReviews(fullName, installationId, repositoryId, number) {
      const token = await installationToken(installationId, repositoryId, { ...READ_PERMISSIONS });
      const page = await pages(repoPath(fullName, `/pulls/${number}/reviews`), z.array(reviewSchema), 10, token, installationId);
      const items = new Map<string, MaintainerPullReview>();
      for (const review of page.items) {
        if (!review.user || !review.submitted_at) continue;
        items.set(String(review.id), {
          github_review_id: String(review.id),
          reviewer_github_id: String(review.user.id),
          reviewer_login: review.user.login,
          reviewer_type: review.user.type,
          reviewer_association: review.author_association,
          state: review.state,
          commit_id: review.commit_id ? review.commit_id.toLowerCase() : null,
          submitted_at: review.submitted_at,
        });
      }
      return { items: [...items.values()], truncated: page.truncated };
    },
    async readChecks(fullName, installationId, repositoryId, headSha) {
      const token = await installationToken(installationId, repositoryId, { ...READ_PERMISSIONS });
      const runs = await pages(repoPath(fullName, `/commits/${headSha}/check-runs?filter=latest`), z.object({ check_runs: z.array(checkSchema) }).transform(value => value.check_runs), 5, token, installationId);
      if (runs.truncated) throw new GitHubSignal('retry', 'github_page_cap', undefined, installationId);
      const statusBody = await call(repoPath(fullName, `/commits/${headSha}/status?per_page=${PAGE}`), { token }, installationId, 'GET');
      const statuses = parse(z.object({ statuses: z.array(statusSchema) }), statusBody, installationId);
      const checks = new Map<string, MaintainerPullCheck>();
      const checkIds = new Map<string, number>();
      for (const run of runs.items) {
        const appKey = run.app ? String(run.app.id) : '';
        const key = `check_run\n${appKey}\n${run.name}`;
        const previousId = checkIds.get(key);
        if (previousId !== undefined && previousId >= run.id) continue;
        checkIds.set(key, run.id);
        checks.set(key, {
          source: 'check_run', name: run.name, app_key: appKey, app_slug: run.app?.slug ?? null,
          status: run.status ?? 'completed', conclusion: run.conclusion ?? null, check_suite_id: run.check_suite ? String(run.check_suite.id) : null,
          completed_at: run.completed_at ?? null,
        });
      }
      for (const status of statuses.statuses) {
        const conclusion = status.state === 'success' ? 'success' : status.state === 'pending' ? null : 'failure';
        checks.set(`status\n\n${status.context}`, {
          source: 'status', name: status.context, app_key: '', app_slug: null,
          status: status.state === 'pending' ? 'pending' : 'completed', conclusion, check_suite_id: null, completed_at: null,
        });
      }
      return [...checks.values()];
    },
    async readMigrationNames(fullName, installationId, repositoryId, dir, ref) {
      const token = await installationToken(installationId, repositoryId, { ...READ_PERMISSIONS });
      const encoded = dir.split('/').map(encodeURIComponent).join('/');
      try {
        const body = await call(repoPath(fullName, `/contents/${encoded}?ref=${encodeURIComponent(ref)}`), { token }, installationId, 'GET');
        const entries = parse(z.array(contentSchema), body, installationId);
        return entries.filter(entry => entry.type === 'file').map(entry => entry.name);
      } catch (error) {
        // A repository with no migrations directory is normal. A missing pull is not.
        if (error instanceof GitHubSignal && error.kind === 'not_found') return [];
        throw error;
      }
    },
  };
}
