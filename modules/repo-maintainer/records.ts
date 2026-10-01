import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { annotateReviews, resolveSettings, type Reason } from './policy.js';
import { enqueueMaintainerJob } from './queue.js';
import { skillBookTitle } from './skill-books.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function pgCode(error: unknown): string {
  return typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
}
function reasonsFor(reasons: Reason[], path: string, previous: string | null): Reason[] {
  return reasons.filter(item => item.paths?.some(candidate => candidate === path || (previous !== null && candidate === previous)));
}

const CLAIM_EXISTS = (login: string) => `這個拉取請求已由 ${login} 認領。`;

export const PULL_LIST_COLUMNS = `p.pull_id, p.repository_id, r.full_name, p.number, p.title, p.html_url, p.state, p.queue_state,
  p.author_login, p.author_association, p.author_type, p.is_draft, p.is_fork, p.paused, p.github_updated_at, p.head_observed_at,
  p.head_sha, p.labels, p.aggregate_version, p.queue_reasons->0 AS first_queue_reason,
  r.guild_key, g.name AS guild_name, r.scope_kind, r.open_to_guilds, r.skill_book_id,
  active_claim.claim_id, active_claim.reviewer_user_id, active_claim.reviewer_login, active_claim.acting_as,
  active_claim.guild_key AS claim_guild_key, cg.name AS claim_guild_name, active_claim.skill_book_id AS claim_skill_book_id,
  active_claim.assignment, active_claim.claimed_by,
  active_claim.created_at AS claim_created_at, active_claim.expires_at AS claim_expires_at, active_claim.head_sha AS claim_head_sha,
  active_claim.github_request_state, active_claim.aggregate_version AS claim_aggregate_version,
  chk.name AS check_name, chk.status AS check_status, chk.conclusion AS check_conclusion, chk.head_sha AS check_head_sha`;

export const PULL_LIST_JOINS = `
  FROM maintainer_pull_requests p
  JOIN maintainer_repositories r ON r.repository_id=p.repository_id
  LEFT JOIN positioning_guild_catalog g ON g.guild_key=r.guild_key
  LEFT JOIN LATERAL (
    SELECT c.claim_id, c.reviewer_user_id, c.reviewer_login, c.acting_as, c.guild_key, c.skill_book_id, c.assignment,
      COALESCE(a.display_name, u.display_name) AS claimed_by,
      c.created_at, c.expires_at, c.head_sha, c.github_request_state, c.aggregate_version
    FROM maintainer_review_claims c
    LEFT JOIN platform_admins a ON a.admin_id=c.claimed_by_admin
    LEFT JOIN users u ON u.user_id=c.claimed_by_user
    WHERE c.pull_id=p.pull_id AND c.state='active'
  ) active_claim ON true
  LEFT JOIN positioning_guild_catalog cg ON cg.guild_key=active_claim.guild_key
  LEFT JOIN LATERAL (
    SELECT ck.name, ck.status, ck.conclusion, ck.head_sha
    FROM maintainer_checks ck
    WHERE ck.pull_id=p.pull_id AND ck.head_sha=p.head_sha AND ck.source='check_run'
      AND ck.name=COALESCE(r.settings->>'required_check', 'verify')
      AND ck.app_slug=COALESCE(r.settings->>'required_check_app_slug', 'github-actions')
    LIMIT 1
  ) chk ON true`;

export function presentListRow(row: Record<string, any>) {
  return {
    pull_id: row.pull_id, repository_id: row.repository_id, full_name: row.full_name, number: row.number, title: row.title,
    html_url: row.html_url, state: row.state, queue_state: row.queue_state, author_login: row.author_login,
    author_association: row.author_association, author_type: row.author_type, is_draft: row.is_draft, is_fork: row.is_fork, paused: row.paused,
    github_updated_at: iso(row.github_updated_at), head_sha: row.head_sha, labels: row.labels, aggregate_version: row.aggregate_version,
    ownership: { guild_key: row.guild_key, guild_name: row.guild_name, scope_kind: row.scope_kind, open_to_guilds: row.open_to_guilds, skill_book_id: row.skill_book_id ?? null },
    first_queue_reason: row.first_queue_reason,
    claim: row.claim_id ? {
      claim_id: row.claim_id, reviewer_user_id: row.reviewer_user_id, reviewer_login: row.reviewer_login, acting_as: row.acting_as,
      guild_key: row.claim_guild_key, guild_name: row.claim_guild_name, skill_book_id: row.claim_skill_book_id ?? null,
      skill_book_title: skillBookTitle(row.claim_skill_book_id), assignment: row.assignment, claimed_by: row.claimed_by,
      created_at: iso(row.claim_created_at), expires_at: iso(row.claim_expires_at), head_sha: row.claim_head_sha,
      github_request_state: row.github_request_state, aggregate_version: row.claim_aggregate_version,
    } : null,
    required_check: row.check_name ? { name: row.check_name, status: row.check_status, conclusion: row.check_conclusion, head_sha: row.check_head_sha } : null,
  };
}

const CLAIM_COLUMNS = `c.claim_id, c.reviewer_user_id, c.reviewer_login, c.acting_as, c.guild_key, cg.name AS guild_name, c.skill_book_id,
  c.assignment, COALESCE(a.display_name, u.display_name) AS claimed_by, c.created_at, c.expires_at, c.head_sha,
  c.github_request_state, c.github_request_error, c.aggregate_version, c.state, c.end_reason, c.ended_at`;

function presentClaim(row: Record<string, any> | undefined) {
  if (!row?.claim_id) return null;
  return {
    claim_id: row.claim_id, reviewer_user_id: row.reviewer_user_id, reviewer_login: row.reviewer_login, acting_as: row.acting_as,
    guild_key: row.guild_key, guild_name: row.guild_name, skill_book_id: row.skill_book_id ?? null,
    skill_book_title: skillBookTitle(row.skill_book_id), assignment: row.assignment, claimed_by: row.claimed_by,
    created_at: iso(row.created_at), expires_at: iso(row.expires_at), head_sha: row.head_sha,
    github_request_state: row.github_request_state, github_request_error: row.github_request_error, aggregate_version: row.aggregate_version,
  };
}

export async function assemblePullDetail(q: Queryable, pull: Record<string, any>, includeEligible: boolean) {
  const id = pull.pull_id as string;
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
  const attention = (Array.isArray(pull.attention_reasons) ? pull.attention_reasons : []) as Reason[];
  const eligibleIds = (await q.query(
    'SELECT DISTINCT github_user_id FROM maintainer_eligible_reviewers WHERE repository_id=$1',
    [pull.repository_id],
  )).rows.map(row => row.github_user_id as string);
  const claimJoin = `FROM maintainer_review_claims c
    LEFT JOIN platform_admins a ON a.admin_id=c.claimed_by_admin
    LEFT JOIN users u ON u.user_id=c.claimed_by_user
    LEFT JOIN positioning_guild_catalog cg ON cg.guild_key=c.guild_key`;
  const active = (await q.query(
    `SELECT ${CLAIM_COLUMNS} ${claimJoin} WHERE c.pull_id=$1 AND c.state='active'`,
    [id],
  )).rows[0] as Record<string, any> | undefined;
  const history = (await q.query(
    `SELECT ${CLAIM_COLUMNS} ${claimJoin} WHERE c.pull_id=$1 ORDER BY c.created_at DESC, c.claim_id DESC LIMIT 5`,
    [id],
  )).rows as Record<string, any>[];
  const ownershipHistory = (await q.query(
    `SELECT c.source, c.reason, c.created_at, c.guild_key, g.name AS guild_name, c.scope_kind, c.open_to_guilds, c.skill_book_id,
       COALESCE(a.display_name, u.display_name) AS who
     FROM maintainer_ownership_changes c
     LEFT JOIN platform_admins a ON a.admin_id=c.changed_by_admin
     LEFT JOIN users u ON u.user_id=c.changed_by_user
     LEFT JOIN positioning_guild_catalog g ON g.guild_key=c.guild_key
     WHERE c.repository_id=$1 ORDER BY c.created_at DESC, c.change_id DESC LIMIT 5`,
    [pull.repository_id],
  )).rows;
  const annotated = annotateReviews(reviews.map(review => ({
    github_review_id: review.github_review_id as string,
    reviewer_github_id: review.reviewer_github_id as string,
    reviewer_association: review.reviewer_association as string | null,
    state: review.state as string,
    commit_id: review.commit_id as string | null,
    submitted_at: iso(review.submitted_at) ?? '',
  })), { head_sha: pull.head_sha, author_github_id: pull.author_github_id }, eligibleIds);
  const eligible = includeEligible ? (await q.query(
    `SELECT e.user_id, e.display_name, e.github_login, e.acting_as, e.guild_key, g.name AS guild_name, e.skill_book_id
     FROM maintainer_eligible_reviewers e
     LEFT JOIN positioning_guild_catalog g ON g.guild_key=e.guild_key
     WHERE e.repository_id=$1 AND e.github_user_id <> $2
     ORDER BY CASE e.acting_as WHEN 'admin' THEN 0 WHEN 'guild_leader' THEN 1 ELSE 2 END, g.name NULLS LAST, e.display_name, e.user_id`,
    [pull.repository_id, pull.author_github_id],
  )).rows.map(row => ({
    user_id: row.user_id, display_name: row.display_name, github_login: row.github_login, acting_as: row.acting_as,
    guild_key: row.guild_key, guild_name: row.guild_name, skill_book_id: row.skill_book_id ?? null,
    skill_book_title: skillBookTitle(row.skill_book_id),
  })) : undefined;
  return {
    pull_id: pull.pull_id, repository_id: pull.repository_id, full_name: pull.full_name, default_branch: pull.default_branch, mode: pull.mode,
    number: pull.number, title: pull.title, html_url: pull.html_url, state: pull.state, merged_at: iso(pull.merged_at), closed_at: iso(pull.closed_at),
    is_draft: pull.is_draft, author_login: pull.author_login, author_github_id: pull.author_github_id, author_association: pull.author_association,
    author_type: pull.author_type, is_fork: pull.is_fork, head_sha: pull.head_sha, base_ref: pull.base_ref, base_sha: pull.base_sha,
    mergeable: pull.mergeable, mergeable_state: pull.mergeable_state, labels: pull.labels, additions: pull.additions, deletions: pull.deletions,
    changed_files: pull.changed_files, github_updated_at: iso(pull.github_updated_at), head_observed_at: iso(pull.head_observed_at),
    first_ready_at: iso(pull.first_ready_at),
    attention_reasons: attention, queue_state: pull.queue_state, queue_reasons: pull.queue_reasons,
    recheck_at: iso(pull.recheck_at), paused: pull.paused, policy_version: pull.policy_version,
    synced_at: iso(pull.synced_at), aggregate_version: pull.aggregate_version,
    ownership: {
      guild_key: pull.guild_key ?? null, guild_name: pull.guild_name ?? null, scope_kind: pull.scope_kind ?? null,
      open_to_guilds: Boolean(pull.open_to_guilds), skill_book_id: pull.skill_book_id ?? null,
      history: ownershipHistory.map(row => ({
        who: row.who, source: row.source, reason: row.reason, created_at: iso(row.created_at),
        guild_key: row.guild_key, guild_name: row.guild_name, scope_kind: row.scope_kind, open_to_guilds: row.open_to_guilds,
        skill_book_id: row.skill_book_id ?? null,
      })),
    },
    files: files.map(file => ({ ...file, notes: reasonsFor(attention, file.path, file.previous_path) })),
    checks: checks.map(check => ({ ...check, completed_at: iso(check.completed_at) })),
    reviews: annotated.map((review, index) => ({
      ...review,
      reviewer_login: reviews[index].reviewer_login,
      reviewer_type: reviews[index].reviewer_type,
      submitted_at: iso(reviews[index].submitted_at),
    })),
    claim: presentClaim(active),
    claims: history.map(row => ({ ...presentClaim(row), state: row.state, end_reason: row.end_reason, ended_at: iso(row.ended_at) })),
    ...(eligible ? { eligible_reviewers: eligible } : {}),
  };
}

export type ClaimIdentity = {
  user_id: string;
  github_user_id: string;
  github_login: string;
  acting_as: 'admin' | 'guild_leader' | 'skill_book_maintainer';
  guild_key: string | null;
  skill_book_id: string | null;
};

export async function activeClaimOnPull(q: Queryable, pullId: string) {
  return (await q.query(
    `SELECT c.claim_id, c.reviewer_login, c.reviewer_user_id, c.state, c.aggregate_version
     FROM maintainer_review_claims c WHERE c.pull_id=$1 AND c.state='active'`,
    [pullId],
  )).rows[0] as { claim_id: string; reviewer_login: string; reviewer_user_id: string; state: string; aggregate_version: string } | undefined;
}

export async function openReviewClaim(
  q: PoolClient,
  pull: { pull_id: string; repository_id: string; full_name: string; settings: unknown; head_sha: string },
  reviewer: ClaimIdentity,
  claimedBy: { admin_id: string | null; user_id: string | null },
  assignment: 'self' | 'assigned',
  assignReason: string | null,
  now: Date,
) {
  const existing = await activeClaimOnPull(q, pull.pull_id);
  if (existing) throw new Problem(409, 'maintainer_claim_exists', CLAIM_EXISTS(existing.reviewer_login));
  const settings = resolveSettings(pull.full_name, pull.settings);
  const githubState = settings.request_reviewers ? 'pending' : 'not_requested';
  const claimId = randomUUID();
  const expires = settings.claim_hours == null ? null : new Date(now.getTime() + settings.claim_hours * 3_600_000);
  await q.query('SAVEPOINT maintainer_claim_insert');
  try {
    await q.query(
      `INSERT INTO maintainer_review_claims (
         claim_id, pull_id, reviewer_user_id, reviewer_github_id, reviewer_login, acting_as, guild_key, skill_book_id,
         claimed_by_admin, claimed_by_user, assignment, assign_reason, head_sha,
         created_at, expires_at, state, github_request_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',$16)`,
      [claimId, pull.pull_id, reviewer.user_id, reviewer.github_user_id, reviewer.github_login, reviewer.acting_as, reviewer.guild_key, reviewer.skill_book_id,
        claimedBy.admin_id, claimedBy.user_id, assignment, assignReason, pull.head_sha, now, expires, githubState],
    );
    await q.query('RELEASE SAVEPOINT maintainer_claim_insert');
  } catch (error) {
    if (pgCode(error) !== '23505') throw error;
    await q.query('ROLLBACK TO SAVEPOINT maintainer_claim_insert');
    const raced = await activeClaimOnPull(q, pull.pull_id);
    throw new Problem(409, 'maintainer_claim_exists', CLAIM_EXISTS(raced?.reviewer_login ?? '其他審查者'));
  }
  if (githubState === 'pending') await enqueueMaintainerJob(q, pull.repository_id, 'request_reviewer', claimId, now);
  return { claim_id: claimId };
}

export function assertPullClaimable(pull: { state: string; is_draft: boolean; paused: boolean; mode: string }) {
  requireCondition(pull.state === 'open' && !pull.is_draft && !pull.paused && pull.mode !== 'off', 409, 'maintainer_claim_unavailable', '這個拉取請求目前未開啟、仍是草稿或已暫停（包括儲存庫已關閉），不能認領。');
}
