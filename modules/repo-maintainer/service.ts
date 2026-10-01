import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { checkVersion } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { adminCommand, audit, type AdminActor, type AdminCommand } from '../platform-admin/service.js';
import { rederivePull } from './derive.js';
import { enqueueMaintainerJob, enqueueReconcilePull } from './queue.js';
import {
  annotateReviews, MAINTAINER_POLICY_VERSION, QUEUE_STATES, repositorySettingsSchema, resolveSettings, reviewerCovers,
  type ActiveReviewer, type Reason, type Risk,
} from './policy.js';

const reason = z.string().trim().min(3).max(1000);
const riskSchema = z.enum(['low', 'medium', 'high']);
const OPEN_STATES = QUEUE_STATES.filter(state => state !== 'merged' && state !== 'closed');

type Queryable = Pick<Pool | PoolClient, 'query'>;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function pgCode(error: unknown): string {
  return typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
}
function reasonsFor(reasons: Reason[], path: string, previous: string | null): Reason[] {
  return reasons.filter(item => item.paths?.some(candidate => candidate === path || (previous !== null && candidate === previous)));
}

const REPOSITORY_FIELDS = `repository_id, full_name, default_branch, installation_state, mode, settings, last_swept_at, last_error, rate_limited_until, aggregate_version`;

const IDENTITY_REQUIRED = '你還沒有已驗證的會員或 GitHub 連結，不能認領給自己，仍可以指派其他人。';
const NOT_REVIEWER_SELF = '你不是啟用中的審查者，不能認領給自己，仍可以指派其他人。';
const NOT_REVIEWER_ASSIGN = '這位審查者目前不是啟用中的審查者，不能指派。';
const RANK_TOO_LOW = '這位審查者的風險上限低於這次變更，不能認領。';
const CLAIM_AUTHOR = '審查者不能認領自己開的拉取請求。';
const CLAIM_UNAVAILABLE = '這個拉取請求目前未開啟、仍是草稿或已暫停，不能認領。';
const CLAIM_MISSING = '找不到這個認領。';
const CLAIM_INACTIVE = '這個認領已經結束。';
const PULL_ALREADY_PAUSED = '這個拉取請求已經暫停。';
const PULL_NOT_PAUSED = '這個拉取請求沒有暫停。';
const WRITE_CONFLICT = '另一個操作同時在處理這個拉取請求，請重新整理後再試一次。';
const SELF_CLAIM_REASON = '自己認領這次審查。';

type ViewerReviewer = { reviewer_id: string; github_user_id: string; github_login: string; max_risk: Risk };
export type ReviewCenterViewer = { github_login: string | null; reviewer_id: string | null; max_risk: Risk | null; reason: string | null };

async function resolveViewer(q: Queryable, admin: AdminActor): Promise<ReviewCenterViewer & { reviewer: ViewerReviewer | null }> {
  const member = (await q.query(
    `SELECT u.user_id FROM users u
     JOIN platform_admins a ON a.community_id=u.community_id AND lower(u.email)=a.email
     WHERE a.admin_id=$1 AND u.community_id=$2 AND u.active AND u.email_verified_at IS NOT NULL`,
    [admin.admin_id, admin.community_id],
  )).rows[0] as { user_id: string } | undefined;
  if (!member) return { github_login: null, reviewer_id: null, max_risk: null, reason: IDENTITY_REQUIRED, reviewer: null };
  const github = (await q.query(
    `SELECT github_user_id, github_login FROM github_social_connections WHERE user_id=$1 AND community_id=$2`,
    [member.user_id, admin.community_id],
  )).rows[0] as { github_user_id: string; github_login: string } | undefined;
  if (!github) return { github_login: null, reviewer_id: null, max_risk: null, reason: IDENTITY_REQUIRED, reviewer: null };
  const reviewer = (await q.query(
    `SELECT reviewer_id, github_user_id, github_login, max_risk FROM maintainer_reviewers
     WHERE community_id=$1 AND user_id=$2 AND github_user_id=$3 AND active`,
    [admin.community_id, member.user_id, github.github_user_id],
  )).rows[0] as ViewerReviewer | undefined;
  if (!reviewer) return { github_login: github.github_login, reviewer_id: null, max_risk: null, reason: NOT_REVIEWER_SELF, reviewer: null };
  return { github_login: reviewer.github_login, reviewer_id: reviewer.reviewer_id, max_risk: reviewer.max_risk, reason: null, reviewer };
}

export async function reviewCenterSummary(pool: Pool, admin: AdminActor) {
  const counts: Record<string, number> = {};
  for (const state of OPEN_STATES) counts[state] = 0;
  const grouped = await pool.query(
    `SELECT p.queue_state, count(*)::int AS n
     FROM maintainer_pull_requests p JOIN maintainer_repositories r ON r.repository_id=p.repository_id
     WHERE r.community_id=$1 AND p.state='open' GROUP BY p.queue_state`,
    [admin.community_id],
  );
  for (const row of grouped.rows) counts[row.queue_state as string] = row.n as number;
  const repositories = await pool.query(
    `SELECT ${REPOSITORY_FIELDS} FROM maintainer_repositories WHERE community_id=$1 ORDER BY full_name, repository_id`,
    [admin.community_id],
  );
  const viewer = await resolveViewer(pool, admin);
  return {
    policy_version: MAINTAINER_POLICY_VERSION, counts, repositories: repositories.rows,
    viewer: { github_login: viewer.github_login, reviewer_id: viewer.reviewer_id, max_risk: viewer.max_risk, reason: viewer.reason },
  };
}

function presentListRow(row: Record<string, any>) {
  return {
    pull_id: row.pull_id, repository_id: row.repository_id, full_name: row.full_name, number: row.number, title: row.title,
    html_url: row.html_url, state: row.state, queue_state: row.queue_state, risk_class: row.risk_class, author_login: row.author_login,
    author_association: row.author_association, author_type: row.author_type, is_draft: row.is_draft, is_fork: row.is_fork, paused: row.paused,
    sla_due_at: row.sla_due_at, github_updated_at: row.github_updated_at, head_sha: row.head_sha, labels: row.labels, aggregate_version: row.aggregate_version,
    first_risk_reason: row.first_risk_reason, first_queue_reason: row.first_queue_reason,
    claim: row.claim_id ? {
      claim_id: row.claim_id, reviewer_id: row.claim_reviewer_id, reviewer_login: row.reviewer_login, assignment: row.assignment,
      claimed_by: row.claimed_by, created_at: row.claim_created_at, expires_at: row.claim_expires_at, head_sha: row.claim_head_sha,
      github_request_state: row.github_request_state, aggregate_version: row.claim_aggregate_version,
    } : null,
    required_check: row.check_name ? { name: row.check_name, status: row.check_status, conclusion: row.check_conclusion, head_sha: row.check_head_sha } : null,
  };
}

export async function listReviewCenterPulls(pool: Pool, admin: AdminActor, filter: string, repositoryId: string | null, limit: number, offset: number) {
  const viewer = await resolveViewer(pool, admin);
  const order = filter === 'awaiting_review'
    ? 'p.sla_due_at ASC NULLS LAST, p.github_updated_at DESC, p.pull_id'
    : 'p.github_updated_at DESC, p.pull_id';
  const rows = await pool.query(
    `SELECT p.pull_id, p.repository_id, r.full_name, p.number, p.title, p.html_url, p.state, p.queue_state, p.risk_class,
       p.author_login, p.author_association, p.author_type, p.is_draft, p.is_fork, p.paused, p.sla_due_at, p.github_updated_at,
       p.head_sha, p.labels, p.aggregate_version, p.risk_reasons->0 AS first_risk_reason, p.queue_reasons->0 AS first_queue_reason,
       active_claim.claim_id, active_claim.reviewer_id AS claim_reviewer_id, active_claim.reviewer_login, active_claim.assignment,
       active_claim.claimed_by, active_claim.created_at AS claim_created_at, active_claim.expires_at AS claim_expires_at,
       active_claim.head_sha AS claim_head_sha, active_claim.github_request_state, active_claim.aggregate_version AS claim_aggregate_version,
       chk.name AS check_name, chk.status AS check_status, chk.conclusion AS check_conclusion, chk.head_sha AS check_head_sha
     FROM maintainer_pull_requests p
     JOIN maintainer_repositories r ON r.repository_id=p.repository_id
     LEFT JOIN LATERAL (
       SELECT c.claim_id, c.reviewer_id, v.github_login AS reviewer_login, c.assignment, a.display_name AS claimed_by,
         c.created_at, c.expires_at, c.head_sha, c.github_request_state, c.aggregate_version
       FROM maintainer_review_claims c
       JOIN maintainer_reviewers v ON v.reviewer_id=c.reviewer_id
       JOIN platform_admins a ON a.admin_id=c.claimed_by_admin
       WHERE c.pull_id=p.pull_id AND c.state='active'
     ) active_claim ON true
     LEFT JOIN LATERAL (
       SELECT ck.name, ck.status, ck.conclusion, ck.head_sha
       FROM maintainer_checks ck
       WHERE ck.pull_id=p.pull_id AND ck.head_sha=p.head_sha AND ck.source='check_run'
         AND ck.name=COALESCE(r.settings->>'required_check', 'verify')
         AND ck.app_slug=COALESCE(r.settings->>'required_check_app_slug', 'github-actions')
       LIMIT 1
     ) chk ON true
     WHERE r.community_id=$1 AND ($2::uuid IS NULL OR p.repository_id=$2)
       AND (($3='open' AND p.state='open')
         OR ($3='done' AND p.queue_state IN ('merged','closed'))
         OR ($3='author_action' AND p.queue_state IN ('needs_author','ci_not_run'))
         OR ($3='mine' AND active_claim.reviewer_id=$6::uuid)
         OR ($3 NOT IN ('open','done','author_action','mine') AND p.queue_state=$3))
     ORDER BY ${order} LIMIT $4 OFFSET $5`,
    [admin.community_id, repositoryId, filter, limit + 1, offset, viewer.reviewer_id],
  );
  return { items: rows.rows.slice(0, limit).map(presentListRow), next_offset: rows.rows.length > limit ? offset + limit : null };
}

async function scopedPull(q: Queryable, admin: AdminActor, id: string, lock = false) {
  const row = (await q.query(
    `SELECT p.*, r.full_name, r.default_branch, r.mode, r.settings, r.community_id
     FROM maintainer_pull_requests p JOIN maintainer_repositories r ON r.repository_id=p.repository_id
     WHERE p.pull_id=$1 AND r.community_id=$2${lock ? ' FOR UPDATE OF p' : ''}`,
    [id, admin.community_id],
  )).rows[0];
  requireCondition(row, 404, 'maintainer_pull_not_found', '找不到這個拉取請求。');
  return row;
}

const CLAIM_COLUMNS = `c.claim_id, c.reviewer_id, v.github_login AS reviewer_login, c.assignment, a.display_name AS claimed_by,
  c.created_at, c.expires_at, c.head_sha, c.github_request_state, c.aggregate_version, c.state, c.end_reason, c.ended_at`;

function presentActiveClaim(row: Record<string, any> | undefined) {
  if (!row?.claim_id) return null;
  return {
    claim_id: row.claim_id, reviewer_id: row.reviewer_id, reviewer_login: row.reviewer_login, assignment: row.assignment,
    claimed_by: row.claimed_by, created_at: iso(row.created_at), expires_at: iso(row.expires_at), head_sha: row.head_sha,
    github_request_state: row.github_request_state, aggregate_version: row.aggregate_version,
  };
}

async function loadPullDetail(q: Queryable, admin: AdminActor, id: string) {
  z.uuid().parse(id);
  const pull = await scopedPull(q, admin, id);
  const files = (await q.query(
    `SELECT path, previous_path, status, additions, deletions FROM maintainer_pull_files WHERE pull_id=$1 ORDER BY path`,
    [id],
  )).rows as Array<{ path: string; previous_path: string | null; status: string; additions: number; deletions: number }>;
  const checks = (await q.query(
    `SELECT head_sha, source, name, app_key, app_slug, status, conclusion, check_suite_id, completed_at
     FROM maintainer_checks WHERE pull_id=$1 ORDER BY source, name`,
    [id],
  )).rows;
  const reviews = (await q.query(
    `SELECT github_review_id, reviewer_github_id, reviewer_login, reviewer_type, reviewer_association, state, commit_id, submitted_at
     FROM maintainer_reviews WHERE pull_id=$1 ORDER BY submitted_at, github_review_id`,
    [id],
  )).rows;
  const reviewers = (await q.query(
    `SELECT github_user_id, max_risk FROM maintainer_reviewers WHERE community_id=$1 AND active`,
    [admin.community_id],
  )).rows as ActiveReviewer[];
  const riskReasons = (Array.isArray(pull.risk_reasons) ? pull.risk_reasons : []) as Reason[];
  const active = (await q.query(
    `SELECT ${CLAIM_COLUMNS}
     FROM maintainer_review_claims c
     JOIN maintainer_reviewers v ON v.reviewer_id=c.reviewer_id
     JOIN platform_admins a ON a.admin_id=c.claimed_by_admin
     WHERE c.pull_id=$1 AND c.state='active'`,
    [id],
  )).rows[0] as Record<string, any> | undefined;
  const history = (await q.query(
    `SELECT ${CLAIM_COLUMNS}
     FROM maintainer_review_claims c
     JOIN maintainer_reviewers v ON v.reviewer_id=c.reviewer_id
     JOIN platform_admins a ON a.admin_id=c.claimed_by_admin
     WHERE c.pull_id=$1 ORDER BY c.created_at DESC, c.claim_id DESC LIMIT 5`,
    [id],
  )).rows as Record<string, any>[];
  const annotated = annotateReviews(reviews.map(review => ({
    github_review_id: review.github_review_id as string,
    reviewer_github_id: review.reviewer_github_id as string,
    reviewer_association: review.reviewer_association as string | null,
    state: review.state as string,
    commit_id: review.commit_id as string | null,
    submitted_at: iso(review.submitted_at) ?? '',
  })), { head_sha: pull.head_sha, author_github_id: pull.author_github_id }, pull.risk_class as Risk, reviewers);
  return {
    pull_id: pull.pull_id, repository_id: pull.repository_id, full_name: pull.full_name, default_branch: pull.default_branch, mode: pull.mode,
    number: pull.number, title: pull.title, html_url: pull.html_url, state: pull.state, merged_at: pull.merged_at, closed_at: pull.closed_at,
    is_draft: pull.is_draft, author_login: pull.author_login, author_github_id: pull.author_github_id, author_association: pull.author_association,
    author_type: pull.author_type, is_fork: pull.is_fork, head_sha: pull.head_sha, base_ref: pull.base_ref, base_sha: pull.base_sha,
    mergeable: pull.mergeable, mergeable_state: pull.mergeable_state, labels: pull.labels, additions: pull.additions, deletions: pull.deletions,
    changed_files: pull.changed_files, github_updated_at: pull.github_updated_at, head_observed_at: pull.head_observed_at, first_ready_at: pull.first_ready_at,
    risk_class: pull.risk_class, risk_reasons: riskReasons, queue_state: pull.queue_state, queue_reasons: pull.queue_reasons,
    sla_due_at: pull.sla_due_at, recheck_at: pull.recheck_at, paused: pull.paused, policy_version: pull.policy_version,
    synced_at: pull.synced_at, aggregate_version: pull.aggregate_version,
    files: files.map(file => ({ ...file, risk_reasons: reasonsFor(riskReasons, file.path, file.previous_path) })),
    checks,
    reviews: annotated.map((review, index) => ({
      ...review,
      reviewer_login: reviews[index].reviewer_login,
      reviewer_type: reviews[index].reviewer_type,
    })),
    claim: presentActiveClaim(active),
    claims: history.map(row => ({ ...presentActiveClaim(row), state: row.state, end_reason: row.end_reason, ended_at: iso(row.ended_at) })),
  };
}

export async function reviewCenterPull(pool: Pool, admin: AdminActor, id: string) {
  return loadPullDetail(pool, admin, id);
}

type ClaimReviewer = { reviewer_id: string; github_user_id: string; github_login: string; max_risk: Risk };

function requireSelfReviewer(viewer: ReviewCenterViewer & { reviewer: ViewerReviewer | null }): ViewerReviewer {
  if (viewer.reviewer) return viewer.reviewer;
  if (!viewer.github_login) throw new Problem(409, 'maintainer_claim_identity_required', IDENTITY_REQUIRED);
  throw new Problem(409, 'maintainer_claim_not_reviewer', NOT_REVIEWER_SELF);
}
function assertPullClaimable(pull: { state: string; is_draft: boolean; paused: boolean }) {
  requireCondition(pull.state === 'open' && !pull.is_draft && !pull.paused, 409, 'maintainer_claim_unavailable', CLAIM_UNAVAILABLE);
}
async function claimWrite<T>(pool: Pool, input: AdminCommand, authorize: (q: PoolClient) => Promise<unknown>, run: (q: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await adminCommand(pool, input, authorize, run);
  } catch (error) {
    // The transaction has rolled back, so the same Idempotency-Key can be retried.
    if (pgCode(error) === '40P01') throw new Problem(409, 'maintainer_write_conflict', WRITE_CONFLICT);
    throw error;
  }
}
function assertReviewerCanClaim(reviewer: { github_user_id: string; max_risk: Risk }, pull: { author_github_id: string; risk_class: Risk }) {
  requireCondition(reviewer.github_user_id !== pull.author_github_id, 409, 'maintainer_claim_author', CLAIM_AUTHOR);
  requireCondition(reviewerCovers(reviewer.max_risk, pull.risk_class), 409, 'maintainer_claim_rank_too_low', RANK_TOO_LOW);
}
async function activeClaimOnPull(q: Queryable, pullId: string) {
  return (await q.query(
    `SELECT c.claim_id, v.github_login AS reviewer_login, c.state, c.aggregate_version
     FROM maintainer_review_claims c JOIN maintainer_reviewers v ON v.reviewer_id=c.reviewer_id
     WHERE c.pull_id=$1 AND c.state='active'`,
    [pullId],
  )).rows[0] as { claim_id: string; reviewer_login: string; state: string; aggregate_version: string } | undefined;
}
function claimExists(login: string): never {
  throw new Problem(409, 'maintainer_claim_exists', `這個拉取請求已由 ${login} 認領。`);
}
async function insertClaim(q: PoolClient, pull: Record<string, any>, reviewer: ClaimReviewer, admin: AdminActor, assignment: 'self' | 'assigned', assignReason: string | null, now: Date) {
  const existing = await activeClaimOnPull(q, pull.pull_id);
  if (existing) claimExists(existing.reviewer_login);
  const settings = resolveSettings(pull.full_name, pull.settings);
  const githubState = settings.request_reviewers ? 'pending' : 'not_requested';
  const claimId = randomUUID();
  const expires = new Date(now.getTime() + settings.claim_hours * 3_600_000);
  await q.query('SAVEPOINT maintainer_claim_insert');
  let row: Record<string, any>;
  try {
    row = (await q.query(
      `INSERT INTO maintainer_review_claims (
         claim_id, pull_id, reviewer_id, claimed_by_admin, assignment, assign_reason, head_sha,
         created_at, expires_at, state, github_request_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10)
       RETURNING claim_id, reviewer_id, assignment, github_request_state, aggregate_version, state`,
      [claimId, pull.pull_id, reviewer.reviewer_id, admin.admin_id, assignment, assignReason, pull.head_sha, now, expires, githubState],
    )).rows[0];
    await q.query('RELEASE SAVEPOINT maintainer_claim_insert');
  } catch (error) {
    if (pgCode(error) !== '23505') throw error;
    await q.query('ROLLBACK TO SAVEPOINT maintainer_claim_insert');
    const raced = await activeClaimOnPull(q, pull.pull_id);
    claimExists(raced?.reviewer_login ?? '其他審查者');
  }
  if (githubState === 'pending') await enqueueMaintainerJob(q, pull.repository_id, 'request_reviewer', claimId, now);
  return row!;
}
async function finishClaimWrite(q: PoolClient, admin: AdminActor, pullId: string, now: Date, action: string, targetType: string, targetRef: string, why: string, before: unknown, after: Record<string, unknown> = {}) {
  await rederivePull(q, pullId, now);
  const detail = await loadPullDetail(q, admin, pullId);
  await audit(q, admin, action, targetType, targetRef, why, before, {
    claim_id: detail.claim?.claim_id ?? null, reviewer_login: detail.claim?.reviewer_login ?? null,
    state: detail.claim ? 'active' : null, queue_state: detail.queue_state,
    aggregate_version: detail.aggregate_version, claim_aggregate_version: detail.claim?.aggregate_version ?? null,
    ...after,
  });
  return detail;
}

export async function claimForSelf(pool: Pool, input: AdminCommand, id: string) {
  z.uuid().parse(id);
  z.object({}).strict().parse(input.body);
  return claimWrite(pool, input, async q => { await scopedPull(q, input.admin, id); }, async q => {
    const pull = await scopedPull(q, input.admin, id, true);
    checkVersion(String(pull.aggregate_version), input.expected);
    const reviewer = requireSelfReviewer(await resolveViewer(q, input.admin));
    assertPullClaimable(pull);
    assertReviewerCanClaim(reviewer, pull);
    const now = new Date();
    const claim = await insertClaim(q, pull, reviewer, input.admin, 'self', null, now);
    return finishClaimWrite(q, input.admin, id, now, 'maintainer_claim_self', 'maintainer_pull', id, SELF_CLAIM_REASON, {
      claim_id: null, reviewer_login: null, state: null, queue_state: pull.queue_state, aggregate_version: String(pull.aggregate_version),
      claim_aggregate_version: null, opened_claim_id: claim.claim_id,
    });
  });
}

async function assignableReviewer(q: Queryable, admin: AdminActor, reviewerId: string): Promise<ClaimReviewer> {
  const row = (await q.query(
    `SELECT v.reviewer_id, v.github_user_id, v.github_login, v.max_risk
     FROM maintainer_reviewers v
     JOIN users u ON u.user_id=v.user_id AND u.community_id=v.community_id AND u.active AND u.email_verified_at IS NOT NULL
     JOIN github_social_connections g ON g.user_id=v.user_id AND g.community_id=v.community_id AND g.github_user_id=v.github_user_id
     WHERE v.reviewer_id=$1 AND v.community_id=$2 AND v.active`,
    [reviewerId, admin.community_id],
  )).rows[0] as ClaimReviewer | undefined;
  requireCondition(row, 409, 'maintainer_claim_not_reviewer', NOT_REVIEWER_ASSIGN);
  return row;
}

export async function assignReviewer(pool: Pool, input: AdminCommand, id: string) {
  z.uuid().parse(id);
  const body = z.object({ reviewer_id: z.uuid(), reason }).strict().parse(input.body);
  return claimWrite(pool, input, async q => { await scopedPull(q, input.admin, id); }, async q => {
    const pull = await scopedPull(q, input.admin, id, true);
    checkVersion(String(pull.aggregate_version), input.expected);
    const reviewer = await assignableReviewer(q, input.admin, body.reviewer_id);
    assertPullClaimable(pull);
    assertReviewerCanClaim(reviewer, pull);
    const now = new Date();
    const claim = await insertClaim(q, pull, reviewer, input.admin, 'assigned', body.reason, now);
    return finishClaimWrite(q, input.admin, id, now, 'maintainer_claim_assign', 'maintainer_pull', id, body.reason, {
      claim_id: null, reviewer_login: reviewer.github_login, state: null, queue_state: pull.queue_state,
      aggregate_version: String(pull.aggregate_version), claim_aggregate_version: null, opened_claim_id: claim.claim_id,
    });
  });
}

async function scopedClaim(q: Queryable, admin: AdminActor, id: string, lock = false) {
  const row = (await q.query(
    `SELECT c.claim_id, c.pull_id, c.reviewer_id, c.state, c.aggregate_version, c.github_request_state,
       v.github_login AS reviewer_login, p.repository_id, p.queue_state, p.aggregate_version AS pull_aggregate_version
     FROM maintainer_review_claims c
     JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id
     JOIN maintainer_repositories r ON r.repository_id=p.repository_id
     JOIN maintainer_reviewers v ON v.reviewer_id=c.reviewer_id
     WHERE c.claim_id=$1 AND r.community_id=$2${lock ? ' FOR UPDATE OF c' : ''}`,
    [id, admin.community_id],
  )).rows[0];
  requireCondition(row, 404, 'maintainer_claim_not_found', CLAIM_MISSING);
  return row;
}

export async function releaseClaim(pool: Pool, input: AdminCommand, id: string) {
  z.uuid().parse(id);
  const body = z.object({ reason }).strict().parse(input.body);
  return claimWrite(pool, input, async q => { await scopedClaim(q, input.admin, id); }, async q => {
    const preview = await scopedClaim(q, input.admin, id);
    await scopedPull(q, input.admin, preview.pull_id, true);
    const claim = await scopedClaim(q, input.admin, id, true);
    requireCondition(claim.state === 'active', 409, 'maintainer_claim_inactive', CLAIM_INACTIVE);
    checkVersion(String(claim.aggregate_version), input.expected);
    const now = new Date();
    const updated = (await q.query(
      `UPDATE maintainer_review_claims
       SET state='released', end_reason='admin_released', ended_at=$2,
         github_request_state=CASE WHEN github_request_state='requested' THEN 'removing' ELSE github_request_state END,
         aggregate_version=aggregate_version+1
       WHERE claim_id=$1 AND state='active'
       RETURNING claim_id, github_request_state, aggregate_version, state`,
      [id, now],
    )).rows[0];
    requireCondition(updated, 409, 'maintainer_claim_inactive', CLAIM_INACTIVE);
    if (updated.github_request_state === 'removing') await enqueueMaintainerJob(q, claim.repository_id, 'remove_reviewer_request', id, now);
    return finishClaimWrite(q, input.admin, claim.pull_id, now, 'maintainer_claim_release', 'maintainer_claim', id, body.reason, {
      claim_id: claim.claim_id, reviewer_login: claim.reviewer_login, state: 'active', queue_state: claim.queue_state,
      aggregate_version: String(claim.pull_aggregate_version), claim_aggregate_version: String(claim.aggregate_version),
    }, {
      claim_id: claim.claim_id, reviewer_login: claim.reviewer_login, state: 'released', claim_aggregate_version: updated.aggregate_version,
    });
  });
}

async function setPullPaused(pool: Pool, input: AdminCommand, id: string, paused: boolean) {
  z.uuid().parse(id);
  const body = z.object({ reason }).strict().parse(input.body);
  const action = paused ? 'maintainer_pull_pause' : 'maintainer_pull_resume';
  return claimWrite(pool, input, async q => { await scopedPull(q, input.admin, id); }, async q => {
    const pull = await scopedPull(q, input.admin, id, true);
    checkVersion(String(pull.aggregate_version), input.expected);
    if (paused && pull.paused) throw new Problem(409, 'maintainer_pull_already_paused', PULL_ALREADY_PAUSED);
    if (!paused && !pull.paused) throw new Problem(409, 'maintainer_pull_not_paused', PULL_NOT_PAUSED);
    const current = await activeClaimOnPull(q, id);
    await q.query('UPDATE maintainer_pull_requests SET paused=$2, aggregate_version=aggregate_version+1 WHERE pull_id=$1', [id, paused]);
    const now = new Date();
    return finishClaimWrite(q, input.admin, id, now, action, 'maintainer_pull', id, body.reason, {
      claim_id: current?.claim_id ?? null, reviewer_login: current?.reviewer_login ?? null, state: current ? 'active' : null,
      queue_state: pull.queue_state, aggregate_version: String(pull.aggregate_version), paused: pull.paused,
      claim_aggregate_version: current?.aggregate_version ?? null,
    });
  });
}

export function pausePull(pool: Pool, input: AdminCommand, id: string) {
  return setPullPaused(pool, input, id, true);
}
export function resumePull(pool: Pool, input: AdminCommand, id: string) {
  return setPullPaused(pool, input, id, false);
}

export async function resyncReviewCenterPull(pool: Pool, input: AdminCommand, id: string) {
  z.uuid().parse(id);
  z.object({}).strict().parse(input.body);
  return adminCommand(pool, input, async q => { await scopedPull(q, input.admin, id); }, async q => {
    const pull = await scopedPull(q, input.admin, id);
    const enqueued = await enqueueReconcilePull(q, pull.repository_id, pull.number, new Date());
    await audit(q, input.admin, 'maintainer_pull_resync', 'maintainer_pull', id, '重新同步這個拉取請求。',
      { pull_id: pull.pull_id, number: pull.number, queue_state: pull.queue_state }, { enqueued });
    return { pull_id: pull.pull_id, enqueued };
  });
}

export async function listReviewCenterRepositories(pool: Pool, admin: AdminActor) {
  const rows = await pool.query(`SELECT ${REPOSITORY_FIELDS} FROM maintainer_repositories WHERE community_id=$1 ORDER BY full_name, repository_id`, [admin.community_id]);
  return { items: rows.rows };
}

async function scopedRepository(q: Queryable, admin: AdminActor, id: string, lock = false) {
  const row = (await q.query(
    `SELECT ${REPOSITORY_FIELDS} FROM maintainer_repositories WHERE repository_id=$1 AND community_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [id, admin.community_id],
  )).rows[0];
  requireCondition(row, 404, 'maintainer_repository_not_found', '找不到這個儲存庫。');
  return row;
}

export async function changeRepositorySettings(pool: Pool, input: AdminCommand, id: string) {
  z.uuid().parse(id);
  const body = z.object({
    mode: z.enum(['off', 'observe', 'ai_review', 'merge_dry_run', 'merge']),
    settings: repositorySettingsSchema,
    reason,
  }).strict().parse(input.body);
  requireCondition(body.mode === 'off' || body.mode === 'observe', 422, 'maintainer_mode_unavailable', '這個模式會在後續階段開放。目前只能關閉或觀察。');
  return adminCommand(pool, input, async q => { await scopedRepository(q, input.admin, id); }, async q => {
    const prior = await scopedRepository(q, input.admin, id, true);
    checkVersion(prior.aggregate_version, input.expected);
    const settings = resolveSettings(prior.full_name, body.settings);
    const updated = (await q.query(
      `UPDATE maintainer_repositories SET mode=$2, settings=$3::jsonb, aggregate_version=aggregate_version+1, updated_at=now()
       WHERE repository_id=$1 RETURNING ${REPOSITORY_FIELDS}`,
      [id, body.mode, JSON.stringify(settings)],
    )).rows[0];
    await q.query(`UPDATE maintainer_pull_requests SET recheck_at=now() WHERE repository_id=$1 AND state='open'`, [id]);
    await audit(q, input.admin, 'maintainer_repository_settings', 'maintainer_repository', id, body.reason,
      { mode: prior.mode, settings: prior.settings, aggregate_version: prior.aggregate_version },
      { mode: updated.mode, settings: updated.settings, aggregate_version: updated.aggregate_version });
    return updated;
  });
}

const REVIEWER_FIELDS = `v.reviewer_id, v.user_id, u.display_name, v.github_user_id, v.github_login, v.max_risk, v.active, v.appointed_at, v.updated_at, v.aggregate_version`;

export async function listReviewers(pool: Pool, admin: AdminActor) {
  const rows = await pool.query(
    `SELECT ${REVIEWER_FIELDS} FROM maintainer_reviewers v JOIN users u ON u.user_id=v.user_id
     WHERE v.community_id=$1 ORDER BY v.github_login, v.reviewer_id`,
    [admin.community_id],
  );
  return { items: rows.rows };
}

export async function reviewerCandidates(pool: Pool, admin: AdminActor, search: string) {
  const rows = await pool.query(
    `SELECT u.user_id, u.display_name, g.github_login, g.github_user_id,
       EXISTS (SELECT 1 FROM maintainer_reviewers v WHERE v.community_id=u.community_id AND v.github_user_id=g.github_user_id AND v.active) AS active_reviewer
     FROM users u
     JOIN github_social_connections g ON g.user_id=u.user_id AND g.community_id=u.community_id
     JOIN member_account_classification t ON t.user_id=u.user_id AND t.community_id=u.community_id
     WHERE u.community_id=$1 AND u.active AND NOT t.is_test_account
       AND ($2='' OR strpos(lower(u.display_name), lower($2))>0 OR strpos(lower(g.github_login), lower($2))>0)
     ORDER BY u.display_name, u.user_id LIMIT 20`,
    [admin.community_id, search],
  );
  return { items: rows.rows };
}

async function linkedMember(q: Queryable, admin: AdminActor, userId: string) {
  const row = (await q.query(
    `SELECT u.user_id, u.display_name, g.github_user_id, g.github_login
     FROM users u
     JOIN member_account_classification t ON t.user_id=u.user_id AND t.community_id=u.community_id
     LEFT JOIN github_social_connections g ON g.user_id=u.user_id AND g.community_id=u.community_id
     WHERE u.user_id=$1 AND u.community_id=$2 AND u.active AND NOT t.is_test_account`,
    [userId, admin.community_id],
  )).rows[0] as { user_id: string; display_name: string; github_user_id: string | null; github_login: string | null } | undefined;
  requireCondition(row, 404, 'member_not_found', '找不到這個社群的會員。');
  requireCondition(row.github_user_id && row.github_login, 409, 'github_link_required', '這位會員還沒有已驗證的 GitHub 連結。請先由本人完成連結。');
  return row;
}
async function touchOpenPulls(q: PoolClient, communityId: string) {
  await q.query(
    `UPDATE maintainer_pull_requests p SET recheck_at=now() FROM maintainer_repositories r
     WHERE p.repository_id=r.repository_id AND r.community_id=$1 AND p.state='open'`,
    [communityId],
  );
}

export async function appointReviewer(pool: Pool, input: AdminCommand) {
  const body = z.object({ user_id: z.uuid(), max_risk: riskSchema, reason }).strict().parse(input.body);
  return adminCommand(pool, input, async q => { await linkedMember(q, input.admin, body.user_id); }, async q => {
    const member = await linkedMember(q, input.admin, body.user_id);
    const existing = (await q.query(
      `SELECT reviewer_id, active, aggregate_version, max_risk, github_login FROM maintainer_reviewers
       WHERE community_id=$1 AND github_user_id=$2 FOR UPDATE`,
      [input.admin.community_id, member.github_user_id],
    )).rows[0];
    if (existing?.active) throw new Problem(409, 'maintainer_reviewer_exists', '這位審查者已經在名單上。請改用變更操作。');
    let row;
    if (existing) {
      row = (await q.query(
        `UPDATE maintainer_reviewers SET user_id=$2, github_login=$3, max_risk=$4, active=true, appointed_by=$5, appointed_at=now(), updated_at=now(), aggregate_version=aggregate_version+1
         WHERE reviewer_id=$1 RETURNING reviewer_id, user_id, github_user_id, github_login, max_risk, active, aggregate_version`,
        [existing.reviewer_id, member.user_id, member.github_login, body.max_risk, input.admin.admin_id],
      )).rows[0];
    } else {
      try {
        row = (await q.query(
          `INSERT INTO maintainer_reviewers (reviewer_id, community_id, github_user_id, github_login, user_id, max_risk, active, appointed_by)
           VALUES ($1,$2,$3,$4,$5,$6,true,$7)
           RETURNING reviewer_id, user_id, github_user_id, github_login, max_risk, active, aggregate_version`,
          [randomUUID(), input.admin.community_id, member.github_user_id, member.github_login, member.user_id, body.max_risk, input.admin.admin_id],
        )).rows[0];
      } catch (error) {
        if (pgCode(error) === '23505') throw new Problem(409, 'maintainer_reviewer_exists', '這位審查者已經在名單上。請改用變更操作。');
        throw error;
      }
    }
    await touchOpenPulls(q, input.admin.community_id);
    await audit(q, input.admin, 'maintainer_reviewer_appoint', 'maintainer_reviewer', row.reviewer_id, body.reason,
      existing ? { reviewer_id: existing.reviewer_id, active: existing.active, max_risk: existing.max_risk, aggregate_version: existing.aggregate_version } : null,
      { reviewer_id: row.reviewer_id, github_login: row.github_login, max_risk: row.max_risk, active: row.active, aggregate_version: row.aggregate_version });
    return { ...row, display_name: member.display_name };
  });
}

async function scopedReviewer(q: Queryable, admin: AdminActor, id: string, lock = false) {
  const row = (await q.query(
    `SELECT ${REVIEWER_FIELDS} FROM maintainer_reviewers v JOIN users u ON u.user_id=v.user_id
     WHERE v.reviewer_id=$1 AND v.community_id=$2${lock ? ' FOR UPDATE OF v' : ''}`,
    [id, admin.community_id],
  )).rows[0];
  requireCondition(row, 404, 'maintainer_reviewer_not_found', '找不到這位審查者。');
  return row;
}

export async function changeReviewer(pool: Pool, input: AdminCommand, id: string) {
  z.uuid().parse(id);
  const body = z.object({ max_risk: riskSchema.optional(), active: z.boolean().optional(), reason }).strict()
    .refine(value => value.max_risk !== undefined || value.active !== undefined, { path: ['max_risk'], message: '請指定風險上限或是否啟用。' })
    .parse(input.body);
  return adminCommand(pool, input, async q => { await scopedReviewer(q, input.admin, id); }, async q => {
    const prior = await scopedReviewer(q, input.admin, id, true);
    checkVersion(prior.aggregate_version, input.expected);
    const updated = (await q.query(
      `UPDATE maintainer_reviewers SET max_risk=COALESCE($2, max_risk), active=COALESCE($3, active), updated_at=now(), aggregate_version=aggregate_version+1
       WHERE reviewer_id=$1 RETURNING reviewer_id, user_id, github_user_id, github_login, max_risk, active, aggregate_version`,
      [id, body.max_risk ?? null, body.active ?? null],
    )).rows[0];
    const display = (await q.query('SELECT display_name FROM users WHERE user_id=$1', [updated.user_id])).rows[0];
    await touchOpenPulls(q, input.admin.community_id);
    await audit(q, input.admin, 'maintainer_reviewer_change', 'maintainer_reviewer', id, body.reason,
      { max_risk: prior.max_risk, active: prior.active, aggregate_version: prior.aggregate_version },
      { max_risk: updated.max_risk, active: updated.active, aggregate_version: updated.aggregate_version });
    return { ...updated, display_name: display?.display_name ?? prior.display_name };
  });
}
