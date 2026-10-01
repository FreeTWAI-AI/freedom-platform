import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../../packages/db/index.js';
import { createMaintainerGitHub, GitHubSignal, type MaintainerGitHub, type MaintainerPull, type MaintainerPullCheck, type MaintainerPullFile, type MaintainerPullReview } from './github.js';
import { classifyRisk, deriveQueueState, migrationCheck, resolveSettings, MAINTAINER_POLICY_VERSION, type MaintainerSettings, type PolicyFile, type QueuePull, type Reason, type RepositoryMode, type Risk } from './policy.js';
import { enqueueReconcilePull } from './queue.js';

export const MAINTAINER_REQUEST_BUDGET = 60;
export const MAINTAINER_TICK_MS = 50_000;
const LEASE_MS = 5 * 60_000;
const SWEEP_OK_MS = 30 * 60_000;
const SWEEP_RETRY_MS = 15 * 60_000;
const STALE_CI_MS = 10 * 60_000;
const STALE_OPEN_MS = 6 * 60 * 60_000;
const STALE_REFRESH_CAP = 20;
const BACKOFF_MINUTES = [1, 5, 15, 60];

export type MaintainerTickConfig = { appId: string; organization: string; privateKey: string };
export type MaintainerTickDeps = { fetcher: typeof fetch; now?: () => Date; budget?: number };
export type MaintainerSummary = {
  deliveries_deleted: number; jobs_deleted: number; rederived: number; ignored_accounts: number;
  suspended_installations: number;
  repositories_upserted: number; repositories_removed: number; sweeps: number; jobs_done: number;
  jobs_failed: number; jobs_released: number; github_requests: number; stopped: string | null;
};

type RepoRow = {
  repository_id: string; community_id: string; github_repository_id: string; installation_id: string;
  full_name: string; default_branch: string; installation_state: string; mode: string; settings: unknown;
  next_sweep_at: Date; rate_limited_until: Date | null; aggregate_version: string;
};
export type MaintainerJobClaim = {
  job_id: string; repository_id: string; kind: string; payload: unknown; attempts: number; max_attempts: number;
  lease_until: Date; state: string;
};
type PullRow = Record<string, any>;
class UnitResult extends Error {
  constructor(code: string, readonly terminal: boolean) { super(code); this.name = code; }
}
function coded(code: string): Error {
  const error = new Error(code);
  error.name = /^[a-z0-9_]+$/.test(code) ? code : 'maintainer_error';
  return error;
}
function pgCode(error: unknown): string {
  return typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
}
function errorCode(error: unknown): string {
  if (error instanceof GitHubSignal || error instanceof UnitResult) return error.name.slice(0, 80);
  if (error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.name) && error.name !== 'Error') return error.name;
  if (error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)) return error.message;
  return 'github_error';
}
function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function millis(value: Date | string | null | undefined): number {
  if (!value) return Number.NaN;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
function titleOf(title: string, number: number): string {
  const trimmed = Array.from(title).slice(0, 300).join('').trim();
  return trimmed || `PR #${number}`;
}
function payloadNumber(payload: unknown): number | null {
  const body = typeof payload === 'string' ? JSON.parse(payload) as { number?: unknown } : payload as { number?: unknown } | null;
  const number = body?.number;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 && number <= 1_000_000_000 ? number : null;
}
function delayMs(attempts: number, maxAttempts: number): number | null {
  if (attempts >= maxAttempts) return null;
  return (BACKOFF_MINUTES[attempts - 1] ?? 60) * 60_000;
}
function policyFiles(files: MaintainerPullFile[]): PolicyFile[] {
  return files.map(file => ({ path: file.path, previous_path: file.previous_path, status: file.status, additions: file.additions, deletions: file.deletions }));
}
function touchesDir(files: MaintainerPullFile[], dir: string): boolean {
  const prefix = `${dir}/`;
  return files.some(file => file.path.startsWith(prefix) || Boolean(file.previous_path?.startsWith(prefix)));
}
function pullIsFork(pull: MaintainerPull): boolean {
  if (pull.head.repo === null || pull.base.repo === null) return true;
  return pull.head.repo.id !== pull.base.repo.id;
}

async function communityId(pool: Pool): Promise<string> {
  const rows = (await pool.query('SELECT community_id FROM communities')).rows;
  if (rows.length !== 1) throw coded('maintainer_community_required');
  return rows[0].community_id as string;
}
export async function claimMaintainerSweep(pool: Pool, now: Date): Promise<RepoRow | null> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await pool.query<RepoRow>(`UPDATE maintainer_repositories SET next_sweep_at=$2, updated_at=$1
    WHERE repository_id = (
      SELECT repository_id FROM maintainer_repositories
      WHERE installation_state='active' AND mode<>'off' AND next_sweep_at<=$1
        AND (rate_limited_until IS NULL OR rate_limited_until<=$1)
      ORDER BY next_sweep_at, repository_id
      FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING repository_id, community_id, github_repository_id, installation_id, full_name, default_branch,
      installation_state, mode, settings, next_sweep_at, rate_limited_until, aggregate_version`, [now, lease]);
  return claimed.rows[0] ?? null;
}
export async function claimMaintainerJob(pool: Pool, now: Date): Promise<MaintainerJobClaim | null> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await pool.query<MaintainerJobClaim>(`UPDATE maintainer_jobs
    SET state='running', lease_until=$2, attempts=attempts+1, updated_at=$1
    WHERE job_id = (
      SELECT job_id FROM maintainer_jobs
      WHERE ((state='queued' AND run_after<=$1) OR (state='running' AND lease_until<=$1))
        AND NOT EXISTS (
          SELECT 1 FROM maintainer_repositories r
          WHERE r.repository_id=maintainer_jobs.repository_id
            AND (r.rate_limited_until>$1 OR r.mode='off' OR r.installation_state<>'active'))
      ORDER BY run_after, created_at
      FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING job_id, repository_id, kind, payload, attempts, max_attempts, lease_until, state`, [now, lease]);
  return claimed.rows[0] ?? null;
}
async function claimInstallation(pool: Pool, now: Date): Promise<Date | null> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at=$2
    WHERE singleton AND next_installation_sync_at<=$1 RETURNING next_installation_sync_at`, [now, lease]);
  return claimed.rows[0]?.next_installation_sync_at ?? null;
}
async function casInstallation(pool: Pool, lease: Date, next: Date, now: Date, lastError: string | null, synced: boolean) {
  await pool.query(`UPDATE maintainer_worker_state
    SET next_installation_sync_at=$2, last_installation_sync_at=CASE WHEN $4 THEN $3 ELSE last_installation_sync_at END, last_error=$5
    WHERE singleton AND next_installation_sync_at=$1`, [lease, next, now, synced, lastError]);
}
async function requestInstallationSync(pool: Pool, now: Date) {
  await pool.query('UPDATE maintainer_worker_state SET next_installation_sync_at=LEAST(next_installation_sync_at,$1) WHERE singleton', [now]);
}
async function markRateLimited(pool: Pool, community: string, installationId: string | undefined, until: Date, now: Date) {
  await pool.query(`UPDATE maintainer_repositories SET rate_limited_until=$3, last_error='github_rate_limited', updated_at=$4
    WHERE community_id=$1 AND ($2::text IS NULL OR installation_id=$2)`, [community, installationId ?? null, until, now]);
}
async function finishJob(pool: Pool, job: MaintainerJobClaim, state: 'done' | 'failed' | 'cancelled', now: Date, lastError: string | null) {
  await pool.query(`UPDATE maintainer_jobs SET state=$3, lease_until=NULL, finished_at=$4, updated_at=$4, last_error=$5
    WHERE job_id=$1 AND lease_until=$2`, [job.job_id, job.lease_until, state, now, lastError]);
}
async function requeueJob(pool: Pool, job: MaintainerJobClaim, now: Date, runAfter: Date, lastError: string, revertAttempt: boolean): Promise<boolean> {
  return transaction(pool, async q => {
    await q.query('SAVEPOINT job_requeue');
    try {
      const updated = await q.query(`UPDATE maintainer_jobs
        SET state='queued', attempts=${revertAttempt ? 'GREATEST(attempts-1,0)' : 'attempts'}, run_after=$3, lease_until=NULL,
          updated_at=$4, last_error=$5, finished_at=NULL
        WHERE job_id=$1 AND lease_until=$2`, [job.job_id, job.lease_until, runAfter, now, lastError]);
      await q.query('RELEASE SAVEPOINT job_requeue');
      return updated.rowCount === 1;
    } catch (error) {
      if (pgCode(error) !== '23505') throw error;
      await q.query('ROLLBACK TO SAVEPOINT job_requeue');
      await q.query(`UPDATE maintainer_jobs SET state='cancelled', lease_until=NULL, finished_at=$3, updated_at=$3, last_error='superseded'
        WHERE job_id=$1 AND lease_until=$2`, [job.job_id, job.lease_until, now]);
      return false;
    }
  });
}
async function backoff(pool: Pool, job: MaintainerJobClaim, now: Date, code: string) {
  const delay = delayMs(job.attempts, job.max_attempts);
  if (delay === null) await finishJob(pool, job, 'failed', now, code);
  else await requeueJob(pool, job, now, new Date(now.getTime() + delay), code, false);
}
async function releaseSweep(pool: Pool, repo: RepoRow, now: Date, next: Date, lastError: string | null) {
  await pool.query(`UPDATE maintainer_repositories SET next_sweep_at=$3, last_error=$4, updated_at=$2
    WHERE repository_id=$1 AND next_sweep_at=$5`, [repo.repository_id, now, next, lastError, repo.next_sweep_at]);
}

function queueFromRow(row: PullRow, defaultBranch: string, observed: string): QueuePull {
  return {
    state: row.state, merged_at: iso(row.merged_at), is_draft: row.is_draft, base_ref: row.base_ref, default_branch: defaultBranch,
    mergeable: row.mergeable, mergeable_state: row.mergeable_state, labels: row.labels ?? [], head_sha: row.head_sha,
    head_observed_at: observed, author_github_id: row.author_github_id, paused: row.paused,
  };
}
async function loadChildren(q: Pool | PoolClient, pullId: string) {
  const files = (await q.query('SELECT path, previous_path, status, additions, deletions FROM maintainer_pull_files WHERE pull_id=$1 ORDER BY path', [pullId])).rows as MaintainerPullFile[];
  const checks = (await q.query('SELECT head_sha, source, name, app_slug, status, conclusion FROM maintainer_checks WHERE pull_id=$1', [pullId])).rows;
  const reviews = (await q.query(`SELECT github_review_id, reviewer_github_id, reviewer_association, state, commit_id, submitted_at
    FROM maintainer_reviews WHERE pull_id=$1`, [pullId])).rows;
  return { files, checks, reviews };
}
async function reviewersFor(q: Pool | PoolClient, community: string) {
  const rows = await q.query(`SELECT github_user_id, max_risk FROM maintainer_reviewers WHERE community_id=$1 AND active`, [community]);
  return rows.rows.map(row => ({ github_user_id: row.github_user_id as string, max_risk: row.max_risk as Risk }));
}
function snapshot(pull: Record<string, unknown>, files: unknown[], checks: unknown[], reviews: unknown[]): string {
  return JSON.stringify({ pull, files, checks, reviews });
}

async function rederive(pool: Pool, now: Date): Promise<number> {
  const due = await pool.query(`SELECT pull_id FROM maintainer_pull_requests
    WHERE state='open' AND recheck_at IS NOT NULL AND recheck_at<=$1 ORDER BY recheck_at, pull_id LIMIT 100`, [now]);
  let updated = 0;
  for (const dueRow of due.rows) {
    const changed = await transaction(pool, async q => {
      const pull = (await q.query('SELECT * FROM maintainer_pull_requests WHERE pull_id=$1 FOR UPDATE', [dueRow.pull_id])).rows[0] as PullRow | undefined;
      if (!pull || pull.state !== 'open' || !pull.recheck_at || new Date(pull.recheck_at).getTime() > now.getTime()) return false;
      const repo = (await q.query('SELECT full_name, default_branch, mode, settings, community_id FROM maintainer_repositories WHERE repository_id=$1', [pull.repository_id])).rows[0];
      if (!repo) return false;
      const settings = resolveSettings(repo.full_name, repo.settings);
      const children = await loadChildren(q, pull.pull_id);
      const risk = classifyRisk({
        files: children.files, profile: settings.rules_profile, author_association: pull.author_association,
        author_type: pull.author_type, is_fork: pull.is_fork, changed_files: pull.changed_files,
      });
      const migrationReasons = (Array.isArray(pull.migration_reasons) ? pull.migration_reasons : []) as Reason[];
      const observed = iso(pull.head_observed_at) ?? now.toISOString();
      const derived = deriveQueueState({
        pull: queueFromRow(pull, repo.default_branch, observed), risk: risk.risk,
        checks: children.checks, reviews: children.reviews.map(review => ({ ...review, submitted_at: iso(review.submitted_at) ?? '', commit_id: review.commit_id })),
        reviewers: await reviewersFor(q, repo.community_id), mode: repo.mode as RepositoryMode, settings, migration_reasons: migrationReasons,
      }, now);
      const same = pull.risk_class === risk.risk
        && JSON.stringify(pull.risk_reasons) === JSON.stringify(risk.reasons)
        && pull.queue_state === derived.state
        && JSON.stringify(pull.queue_reasons) === JSON.stringify(derived.reasons)
        && iso(pull.sla_due_at) === derived.sla_due_at
        && iso(pull.recheck_at) === derived.recheck_at
        && pull.policy_version === MAINTAINER_POLICY_VERSION;
      if (same) return false;
      await q.query(`UPDATE maintainer_pull_requests SET risk_class=$2, risk_reasons=$3::jsonb, queue_state=$4, queue_reasons=$5::jsonb,
        sla_due_at=$6, recheck_at=$7, policy_version=$8, aggregate_version=aggregate_version+1
        WHERE pull_id=$1`, [pull.pull_id, risk.risk, JSON.stringify(risk.reasons), derived.state, JSON.stringify(derived.reasons), derived.sla_due_at, derived.recheck_at, MAINTAINER_POLICY_VERSION]);
      return true;
    });
    if (changed) updated += 1;
  }
  return updated;
}

async function syncInstallations(pool: Pool, github: MaintainerGitHub, config: MaintainerTickConfig, community: string, now: Date, summary: MaintainerSummary): Promise<string | null> {
  const lease = await claimInstallation(pool, now);
  if (!lease) return null;
  try {
    const listed = await github.listInstallations();
    let incomplete = listed.truncated;
    const seen = new Set<string>();
    for (const installation of listed.items) {
      const wanted = installation.accountType === 'Organization' && installation.accountLogin.toLowerCase() === config.organization.toLowerCase();
      if (!wanted) { summary.ignored_accounts += 1; continue; }
      if (installation.suspendedAt) { summary.suspended_installations += 1; continue; }
      const repos = await github.listInstallationRepositories(installation.id);
      if (repos.truncated) incomplete = true;
      for (const repo of repos.items) {
        seen.add(repo.id);
        await pool.query(`INSERT INTO maintainer_repositories
          (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, next_sweep_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'active', 'observe', $6, $6)
          ON CONFLICT (github_repository_id) DO UPDATE SET
            installation_id=EXCLUDED.installation_id, full_name=EXCLUDED.full_name, default_branch=EXCLUDED.default_branch,
            installation_state='active', updated_at=EXCLUDED.updated_at,
            aggregate_version=maintainer_repositories.aggregate_version + CASE
              WHEN maintainer_repositories.installation_id IS DISTINCT FROM EXCLUDED.installation_id
                OR maintainer_repositories.full_name IS DISTINCT FROM EXCLUDED.full_name
                OR maintainer_repositories.default_branch IS DISTINCT FROM EXCLUDED.default_branch
                OR maintainer_repositories.installation_state IS DISTINCT FROM 'active'
              THEN 1 ELSE 0 END`, [community, repo.id, installation.id, repo.fullName, repo.defaultBranch, now]);
        summary.repositories_upserted += 1;
      }
    }
    if (!incomplete) {
      const removed = await pool.query(`UPDATE maintainer_repositories SET installation_state='removed', updated_at=$2, aggregate_version=aggregate_version+1
        WHERE community_id=$1 AND installation_state='active' AND NOT (github_repository_id = ANY($3::text[]))`, [community, now, [...seen]]);
      summary.repositories_removed += removed.rowCount ?? 0;
    }
    await casInstallation(pool, lease, new Date(now.getTime() + SWEEP_OK_MS), now, null, true);
    return null;
  } catch (error) {
    if (error instanceof GitHubSignal && (error.kind === 'budget' || error.kind === 'time' || error.kind === 'rate_limit')) {
      if (error.kind === 'rate_limit') await markRateLimited(pool, community, error.installationId, error.until ?? new Date(now.getTime() + 60_000), now);
      await casInstallation(pool, lease, error.kind === 'rate_limit' ? (error.until ?? now) : now, now, error.name, false);
      return error.kind;
    }
    await casInstallation(pool, lease, new Date(now.getTime() + SWEEP_RETRY_MS), now, errorCode(error), false);
    if (error instanceof GitHubSignal && error.kind === 'moved') await requestInstallationSync(pool, now);
    return null;
  }
}

async function sweepOne(pool: Pool, github: MaintainerGitHub, repo: RepoRow, now: Date): Promise<string | null> {
  try {
    const listed = await github.listOpenPulls(repo.full_name, repo.installation_id, repo.github_repository_id);
    const stored = (await pool.query('SELECT number, head_sha, github_updated_at, state, synced_at, queue_state, mergeable FROM maintainer_pull_requests WHERE repository_id=$1', [repo.repository_id])).rows;
    const seen = new Set<number>();
    const refreshes: Array<{ number: number; syncedAt: number }> = [];
    for (const pull of listed.items) {
      seen.add(pull.number);
      const row = stored.find(item => item.number === pull.number);
      if (!row || row.head_sha !== pull.headSha || millis(row.github_updated_at) !== Date.parse(pull.updatedAt)) {
        await enqueueReconcilePull(pool, repo.repository_id, pull.number, now);
        continue;
      }
      const age = now.getTime() - millis(row.synced_at);
      if (age > STALE_OPEN_MS || (age > STALE_CI_MS && (row.queue_state === 'waiting_ci' || row.mergeable === null))) {
        refreshes.push({ number: pull.number, syncedAt: millis(row.synced_at) });
      }
    }
    refreshes.sort((left, right) => left.syncedAt - right.syncedAt || left.number - right.number);
    for (const item of refreshes.slice(0, STALE_REFRESH_CAP)) await enqueueReconcilePull(pool, repo.repository_id, item.number, now);
    if (!listed.truncated) {
      for (const row of stored) if (row.state === 'open' && !seen.has(row.number)) await enqueueReconcilePull(pool, repo.repository_id, row.number, now);
      await releaseSweep(pool, repo, now, new Date(now.getTime() + SWEEP_OK_MS), null);
      await pool.query('UPDATE maintainer_repositories SET last_swept_at=$2 WHERE repository_id=$1 AND next_sweep_at=$3', [repo.repository_id, now, new Date(now.getTime() + SWEEP_OK_MS)]);
      return null;
    }
    await releaseSweep(pool, repo, now, new Date(now.getTime() + SWEEP_RETRY_MS), 'github_page_cap');
    return null;
  } catch (error) {
    if (error instanceof GitHubSignal && (error.kind === 'budget' || error.kind === 'time' || error.kind === 'rate_limit')) {
      if (error.kind === 'rate_limit') await markRateLimited(pool, repo.community_id, error.installationId ?? repo.installation_id, error.until ?? new Date(now.getTime() + 60_000), now);
      await releaseSweep(pool, repo, now, now, error.kind === 'rate_limit' ? 'github_rate_limited' : null);
      return error.kind;
    }
    if (error instanceof GitHubSignal && (error.kind === 'moved' || error.kind === 'not_found')) await requestInstallationSync(pool, now);
    await releaseSweep(pool, repo, now, new Date(now.getTime() + SWEEP_RETRY_MS), errorCode(error));
    return null;
  }
}

async function replaceChildren(q: PoolClient, pullId: string, headSha: string, files: MaintainerPullFile[], checks: MaintainerPullCheck[], reviews: MaintainerPullReview[]) {
  await q.query('DELETE FROM maintainer_pull_files WHERE pull_id=$1', [pullId]);
  await q.query('DELETE FROM maintainer_checks WHERE pull_id=$1', [pullId]);
  await q.query('DELETE FROM maintainer_reviews WHERE pull_id=$1', [pullId]);
  if (files.length) await q.query(`INSERT INTO maintainer_pull_files (pull_id, path, previous_path, status, additions, deletions)
    SELECT $1, r.path, r.previous_path, r.status, r.additions, r.deletions
    FROM json_to_recordset($2::json) AS r(path text, previous_path text, status text, additions int, deletions int)`, [pullId, JSON.stringify(files)]);
  if (checks.length) await q.query(`INSERT INTO maintainer_checks (pull_id, head_sha, source, name, app_key, app_slug, status, conclusion, check_suite_id, completed_at)
    SELECT $1, $2, r.source, r.name, r.app_key, r.app_slug, r.status, r.conclusion, r.check_suite_id, r.completed_at
    FROM json_to_recordset($3::json) AS r(source text, name text, app_key text, app_slug text, status text, conclusion text, check_suite_id text, completed_at timestamptz)`, [pullId, headSha, JSON.stringify(checks)]);
  if (reviews.length) await q.query(`INSERT INTO maintainer_reviews (pull_id, github_review_id, reviewer_github_id, reviewer_login, reviewer_type, reviewer_association, state, commit_id, submitted_at)
    SELECT $1, r.github_review_id, r.reviewer_github_id, r.reviewer_login, r.reviewer_type, r.reviewer_association, r.state, r.commit_id, r.submitted_at
    FROM json_to_recordset($2::json) AS r(github_review_id text, reviewer_github_id text, reviewer_login text, reviewer_type text, reviewer_association text, state text, commit_id text, submitted_at timestamptz)`, [pullId, JSON.stringify(reviews)]);
}

async function writeMirror(pool: Pool, repo: RepoRow, job: MaintainerJobClaim, pull: MaintainerPull, files: MaintainerPullFile[], checks: MaintainerPullCheck[], reviews: MaintainerPullReview[], settings: MaintainerSettings, migrationReasons: Reason[], filesTruncated: boolean, now: Date) {
  const isFork = pullIsFork(pull);
  const risk = classifyRisk({
    files: policyFiles(files), profile: settings.rules_profile, author_association: pull.author_association,
    author_type: pull.user.type, is_fork: isFork, changed_files: pull.changed_files, files_truncated: filesTruncated,
  });
  await transaction(pool, async q => {
    const owned = await q.query('SELECT job_id FROM maintainer_jobs WHERE job_id=$1 AND lease_until=$2 FOR UPDATE', [job.job_id, job.lease_until]);
    if (owned.rowCount !== 1) throw coded('lease_lost');
    const existing = (await q.query('SELECT * FROM maintainer_pull_requests WHERE repository_id=$1 AND number=$2 FOR UPDATE', [repo.repository_id, pull.number])).rows[0] as PullRow | undefined;
    if (existing && millis(existing.github_updated_at) > Date.parse(pull.updated_at)) {
      await q.query(`UPDATE maintainer_jobs SET state='done', lease_until=NULL, finished_at=$3, updated_at=$3, last_error=NULL WHERE job_id=$1 AND lease_until=$2`, [job.job_id, job.lease_until, now]);
      return;
    }
    const headChanged = !existing || existing.head_sha !== pull.head.sha;
    const observed = headChanged ? now.toISOString() : (iso(existing.head_observed_at) ?? now.toISOString());
    const firstReady = !pull.draft ? (iso(existing?.first_ready_at) ?? now.toISOString()) : iso(existing?.first_ready_at);
    const derived = deriveQueueState({
      pull: {
        state: pull.state, merged_at: pull.merged_at, is_draft: pull.draft, base_ref: pull.base.ref, default_branch: repo.default_branch,
        mergeable: pull.mergeable, mergeable_state: pull.mergeable_state, labels: pull.labels.map(label => label.name).slice(0, 100),
        head_sha: pull.head.sha, head_observed_at: observed, author_github_id: String(pull.user.id), paused: existing?.paused ?? false,
      },
      risk: risk.risk,
      checks: checks.map(check => ({ ...check, head_sha: pull.head.sha })),
      reviews,
      reviewers: await reviewersFor(q, repo.community_id),
      mode: repo.mode as RepositoryMode,
      settings,
      migration_reasons: migrationReasons,
    }, now);
    if (!pull.html_url.startsWith('https://github.com/')) throw new UnitResult('github_invalid_response', false);
    const values = {
      github_pull_id: String(pull.id), title: titleOf(pull.title, pull.number), html_url: pull.html_url, state: pull.state,
      merged_at: pull.merged_at, closed_at: pull.closed_at, is_draft: pull.draft, author_github_id: String(pull.user.id),
      author_login: pull.user.login, author_type: pull.user.type, author_association: pull.author_association,
      is_fork: isFork, head_sha: pull.head.sha, head_repository_id: pull.head.repo ? String(pull.head.repo.id) : null,
      base_ref: pull.base.ref, base_sha: pull.base.sha, mergeable: pull.mergeable, mergeable_state: pull.mergeable_state,
      labels: pull.labels.map(label => label.name).filter(Boolean).slice(0, 100), additions: pull.additions, deletions: pull.deletions,
      changed_files: pull.changed_files, github_created_at: pull.created_at, github_updated_at: pull.updated_at,
      first_ready_at: firstReady, head_observed_at: observed, risk_class: risk.risk, risk_reasons: risk.reasons,
      queue_state: derived.state, queue_reasons: derived.reasons, migration_reasons: migrationReasons, sla_due_at: derived.sla_due_at, recheck_at: derived.recheck_at,
      paused: existing?.paused ?? false, policy_version: MAINTAINER_POLICY_VERSION,
    };
    const previousChildren = existing ? await loadChildren(q, existing.pull_id) : { files: [], checks: [], reviews: [] };
    const nextSnap = snapshot(values, files, checks, reviews);
    const prevSnap = existing ? snapshot({
      github_pull_id: existing.github_pull_id, title: existing.title, html_url: existing.html_url, state: existing.state,
      merged_at: iso(existing.merged_at), closed_at: iso(existing.closed_at), is_draft: existing.is_draft,
      author_github_id: existing.author_github_id, author_login: existing.author_login, author_type: existing.author_type,
      author_association: existing.author_association, is_fork: existing.is_fork, head_sha: existing.head_sha,
      head_repository_id: existing.head_repository_id, base_ref: existing.base_ref, base_sha: existing.base_sha,
      mergeable: existing.mergeable, mergeable_state: existing.mergeable_state, labels: existing.labels,
      additions: existing.additions, deletions: existing.deletions, changed_files: existing.changed_files,
      github_created_at: iso(existing.github_created_at), github_updated_at: iso(existing.github_updated_at),
      first_ready_at: iso(existing.first_ready_at), head_observed_at: iso(existing.head_observed_at),
      risk_class: existing.risk_class, risk_reasons: existing.risk_reasons, queue_state: existing.queue_state,
      queue_reasons: existing.queue_reasons, migration_reasons: existing.migration_reasons,
      sla_due_at: iso(existing.sla_due_at), recheck_at: iso(existing.recheck_at),
      paused: existing.paused, policy_version: existing.policy_version,
    }, previousChildren.files, previousChildren.checks, previousChildren.reviews) : '';
    const pullId = existing?.pull_id ?? randomUUID();
    const visible = nextSnap !== prevSnap;
    if (!existing) {
      await q.query(`INSERT INTO maintainer_pull_requests (
        pull_id, repository_id, number, github_pull_id, title, html_url, state, merged_at, closed_at, is_draft,
        author_github_id, author_login, author_type, author_association, is_fork, head_sha, head_repository_id,
        base_ref, base_sha, mergeable, mergeable_state, labels, additions, deletions, changed_files,
        github_created_at, github_updated_at, first_ready_at, head_observed_at, risk_class, risk_reasons,
        queue_state, queue_reasons, migration_reasons, sla_due_at, recheck_at, paused, policy_version, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::jsonb,$32,$33::jsonb,$34::jsonb,$35,$36,$37,$38,$39)`, [
        pullId, repo.repository_id, pull.number, values.github_pull_id, values.title, values.html_url, values.state,
        values.merged_at, values.closed_at, values.is_draft, values.author_github_id, values.author_login, values.author_type,
        values.author_association, values.is_fork, values.head_sha, values.head_repository_id, values.base_ref, values.base_sha,
        values.mergeable, values.mergeable_state, values.labels, values.additions, values.deletions, values.changed_files,
        values.github_created_at, values.github_updated_at, values.first_ready_at, values.head_observed_at, values.risk_class,
        JSON.stringify(values.risk_reasons), values.queue_state, JSON.stringify(values.queue_reasons), JSON.stringify(values.migration_reasons), values.sla_due_at,
        values.recheck_at, values.paused, values.policy_version, now,
      ]);
      await replaceChildren(q, pullId, pull.head.sha, files, checks, reviews);
    } else if (visible) {
      await q.query(`UPDATE maintainer_pull_requests SET github_pull_id=$2, title=$3, html_url=$4, state=$5, merged_at=$6, closed_at=$7,
        is_draft=$8, author_github_id=$9, author_login=$10, author_type=$11, author_association=$12, is_fork=$13, head_sha=$14,
        head_repository_id=$15, base_ref=$16, base_sha=$17, mergeable=$18, mergeable_state=$19, labels=$20, additions=$21,
        deletions=$22, changed_files=$23, github_created_at=$24, github_updated_at=$25, first_ready_at=$26, head_observed_at=$27,
        risk_class=$28, risk_reasons=$29::jsonb, queue_state=$30, queue_reasons=$31::jsonb, migration_reasons=$32::jsonb, sla_due_at=$33, recheck_at=$34,
        policy_version=$35, synced_at=$36, aggregate_version=aggregate_version+1 WHERE pull_id=$1`, [
        existing.pull_id, values.github_pull_id, values.title, values.html_url, values.state, values.merged_at, values.closed_at,
        values.is_draft, values.author_github_id, values.author_login, values.author_type, values.author_association, values.is_fork,
        values.head_sha, values.head_repository_id, values.base_ref, values.base_sha, values.mergeable, values.mergeable_state,
        values.labels, values.additions, values.deletions, values.changed_files, values.github_created_at, values.github_updated_at,
        values.first_ready_at, values.head_observed_at, values.risk_class, JSON.stringify(values.risk_reasons), values.queue_state,
        JSON.stringify(values.queue_reasons), JSON.stringify(values.migration_reasons), values.sla_due_at, values.recheck_at, values.policy_version, now,
      ]);
      await replaceChildren(q, existing.pull_id, pull.head.sha, files, checks, reviews);
    } else {
      await q.query('UPDATE maintainer_pull_requests SET synced_at=$2 WHERE pull_id=$1', [existing.pull_id, now]);
    }
    await q.query(`UPDATE maintainer_jobs SET state='done', lease_until=NULL, finished_at=$3, updated_at=$3, last_error=NULL WHERE job_id=$1 AND lease_until=$2`, [job.job_id, job.lease_until, now]);
  });
}

async function reconcile(pool: Pool, github: MaintainerGitHub, repo: RepoRow, job: MaintainerJobClaim, number: number, now: Date) {
  const pull = await github.readPull(repo.full_name, repo.installation_id, repo.github_repository_id, number);
  if (!pull.base.repo || String(pull.base.repo.id) !== repo.github_repository_id) throw new UnitResult('repository_identity_changed', true);
  const files = await github.readFiles(repo.full_name, repo.installation_id, repo.github_repository_id, number);
  const reviews = await github.readReviews(repo.full_name, repo.installation_id, repo.github_repository_id, number);
  if (reviews.truncated) throw new GitHubSignal('retry', 'github_page_cap', undefined, repo.installation_id);
  const checks = await github.readChecks(repo.full_name, repo.installation_id, repo.github_repository_id, pull.head.sha);
  const settings = resolveSettings(repo.full_name, repo.settings);
  const baseNames = touchesDir(files.items, settings.migrations_dir)
    ? await github.readMigrationNames(repo.full_name, repo.installation_id, repo.github_repository_id, settings.migrations_dir, pull.base.ref)
    : [];
  const migrationReasons = migrationCheck(policyFiles(files.items), baseNames, settings.migrations_dir, pull.base.ref);
  await writeMirror(pool, repo, job, pull, files.items, checks, reviews.items, settings, migrationReasons, files.truncated, now);
}

async function runJob(pool: Pool, github: MaintainerGitHub, job: MaintainerJobClaim, now: Date, summary: MaintainerSummary): Promise<string | null> {
  const repo = (await pool.query('SELECT * FROM maintainer_repositories WHERE repository_id=$1', [job.repository_id])).rows[0] as RepoRow | undefined;
  if (!repo || repo.mode === 'off' || repo.installation_state !== 'active') {
    await finishJob(pool, job, 'cancelled', now, 'repository_unavailable');
    summary.jobs_failed += 1;
    return null;
  }
  if (repo.rate_limited_until && new Date(repo.rate_limited_until).getTime() > now.getTime()) {
    await requeueJob(pool, job, now, now, 'github_rate_limited', true);
    summary.jobs_released += 1;
    return 'rate_limit';
  }
  try {
    const number = job.kind === 'reconcile_pull' ? payloadNumber(job.payload) : null;
    if (number === null) throw new UnitResult('payload_invalid', true);
    await reconcile(pool, github, repo, job, number, now);
    summary.jobs_done += 1;
    return null;
  } catch (error) {
    if (error instanceof Error && error.name === 'lease_lost') return null;
    if (error instanceof GitHubSignal && (error.kind === 'budget' || error.kind === 'time' || error.kind === 'rate_limit')) {
      if (error.kind === 'rate_limit') await markRateLimited(pool, repo.community_id, error.installationId ?? repo.installation_id, error.until ?? new Date(now.getTime() + 60_000), now);
      await requeueJob(pool, job, now, now, error.name, true);
      summary.jobs_released += 1;
      return error.kind;
    }
    if (error instanceof GitHubSignal && error.kind === 'moved') {
      await requestInstallationSync(pool, now);
      await requeueJob(pool, job, now, new Date(now.getTime() + 60_000), 'github_moved', true);
      summary.jobs_released += 1;
      return null;
    }
    if ((error instanceof GitHubSignal && error.kind === 'not_found') || (error instanceof UnitResult && error.terminal)) {
      if (error instanceof GitHubSignal || error.name === 'repository_identity_changed') await requestInstallationSync(pool, now);
      await finishJob(pool, job, 'failed', now, errorCode(error));
      summary.jobs_failed += 1;
      return null;
    }
    await backoff(pool, job, now, errorCode(error));
    const failed = delayMs(job.attempts, job.max_attempts) === null;
    if (failed) summary.jobs_failed += 1;
    else summary.jobs_released += 1;
    return null;
  }
}

export async function runMaintainerTick(pool: Pool, config: MaintainerTickConfig, deps: MaintainerTickDeps): Promise<MaintainerSummary> {
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();
  const summary: MaintainerSummary = {
    deliveries_deleted: 0, jobs_deleted: 0, rederived: 0, ignored_accounts: 0, suspended_installations: 0, repositories_upserted: 0,
    repositories_removed: 0, sweeps: 0, jobs_done: 0, jobs_failed: 0, jobs_released: 0, github_requests: 0, stopped: null,
  };
  const community = await communityId(pool);
  const deliveries = await pool.query(`DELETE FROM maintainer_webhook_deliveries WHERE delivery_id IN (
    SELECT delivery_id FROM maintainer_webhook_deliveries WHERE received_at < $1::timestamptz - interval '30 days' LIMIT 1000)`, [now]);
  summary.deliveries_deleted = deliveries.rowCount ?? 0;
  const jobs = await pool.query(`DELETE FROM maintainer_jobs WHERE job_id IN (
    SELECT job_id FROM maintainer_jobs WHERE state IN ('done','failed','cancelled') AND finished_at < $1::timestamptz - interval '14 days' LIMIT 1000)`, [now]);
  summary.jobs_deleted = jobs.rowCount ?? 0;
  summary.rederived = await rederive(pool, now);
  const github = createMaintainerGitHub({
    fetcher: deps.fetcher, appId: config.appId, privateKey: config.privateKey,
    budget: deps.budget ?? MAINTAINER_REQUEST_BUDGET, deadlineMs: now.getTime() + MAINTAINER_TICK_MS, now: nowFn,
  });
  summary.stopped = await syncInstallations(pool, github, config, community, now, summary);
  while (!summary.stopped) {
    const repo = await claimMaintainerSweep(pool, nowFn());
    if (!repo) break;
    summary.sweeps += 1;
    summary.stopped = await sweepOne(pool, github, repo, nowFn());
  }
  while (!summary.stopped) {
    const job = await claimMaintainerJob(pool, nowFn());
    if (!job) break;
    summary.stopped = await runJob(pool, github, job, nowFn(), summary);
  }
  summary.github_requests = github.requests;
  return summary;
}
