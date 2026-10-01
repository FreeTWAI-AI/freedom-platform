import type { Pool, PoolClient } from 'pg';
import type { MaintainerPullFile, MaintainerPullReview } from './github.js';
import {
  classifyRisk, deriveQueueState, MAINTAINER_POLICY_VERSION, resolveSettings,
  type PolicyCheck, type QueueClaim, type Reason, type RepositoryMode, type Risk,
} from './policy.js';

type Queryable = Pool | PoolClient;
type PullRow = Record<string, any>;

export type ActiveClaim = {
  claim_id: string;
  reviewer_github_id: string;
  reviewer_login: string;
  expires_at: Date;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function loadPullChildren(q: Queryable, pullId: string) {
  const files = (await q.query('SELECT path, previous_path, status, additions, deletions FROM maintainer_pull_files WHERE pull_id=$1 ORDER BY path', [pullId])).rows as MaintainerPullFile[];
  const checks = (await q.query('SELECT head_sha, source, name, app_slug, status, conclusion FROM maintainer_checks WHERE pull_id=$1', [pullId])).rows as PolicyCheck[];
  const reviews = (await q.query(`SELECT github_review_id, reviewer_github_id, reviewer_association, state, commit_id, submitted_at
    FROM maintainer_reviews WHERE pull_id=$1`, [pullId])).rows as MaintainerPullReview[];
  return { files, checks, reviews };
}

export async function loadActiveReviewers(q: Queryable, communityId: string) {
  const rows = await q.query(`SELECT github_user_id, max_risk FROM maintainer_reviewers WHERE community_id=$1 AND active`, [communityId]);
  return rows.rows.map(row => ({ github_user_id: row.github_user_id as string, max_risk: row.max_risk as Risk }));
}

/** The one active claim, if any. An expired timestamp still counts as absent inside deriveQueueState. */
export async function loadActiveClaim(q: Queryable, pullId: string): Promise<ActiveClaim | null> {
  const row = (await q.query(
    `SELECT c.claim_id, v.github_user_id AS reviewer_github_id, v.github_login AS reviewer_login, c.expires_at
     FROM maintainer_review_claims c
     JOIN maintainer_reviewers v ON v.reviewer_id = c.reviewer_id
     WHERE c.pull_id=$1 AND c.state='active'`,
    [pullId],
  )).rows[0] as ActiveClaim | undefined;
  return row ?? null;
}

function claimInput(claim: ActiveClaim | null): QueueClaim | null {
  if (!claim) return null;
  const expires = iso(claim.expires_at);
  if (!expires) return null;
  return { reviewer_github_id: claim.reviewer_github_id, reviewer_login: claim.reviewer_login, expires_at: expires };
}

/**
 * Recompute one pull from the stored mirror, its children, active reviewers, the stored
 * migration_reasons column, and the active claim. Writes derived fields only when they changed.
 * Callers run this inside the transaction that changed the claim or the pause flag.
 * Migration reasons are not derived again here.
 */
export async function rederivePull(q: Queryable, pullId: string, now: Date): Promise<boolean> {
  const pull = (await q.query('SELECT * FROM maintainer_pull_requests WHERE pull_id=$1 FOR UPDATE', [pullId])).rows[0] as PullRow | undefined;
  if (!pull) return false;
  const repo = (await q.query('SELECT full_name, default_branch, mode, settings, community_id FROM maintainer_repositories WHERE repository_id=$1', [pull.repository_id])).rows[0];
  if (!repo) return false;
  const settings = resolveSettings(repo.full_name, repo.settings);
  const children = await loadPullChildren(q, pull.pull_id);
  const risk = classifyRisk({
    files: children.files, profile: settings.rules_profile, author_association: pull.author_association,
    author_type: pull.author_type, is_fork: pull.is_fork, changed_files: pull.changed_files,
  });
  const migrationReasons = (Array.isArray(pull.migration_reasons) ? pull.migration_reasons : []) as Reason[];
  const observed = iso(pull.head_observed_at) ?? now.toISOString();
  const derived = deriveQueueState({
    pull: {
      state: pull.state, merged_at: iso(pull.merged_at), is_draft: pull.is_draft, base_ref: pull.base_ref,
      default_branch: repo.default_branch, mergeable: pull.mergeable, mergeable_state: pull.mergeable_state,
      labels: pull.labels ?? [], head_sha: pull.head_sha, head_observed_at: observed,
      author_github_id: pull.author_github_id, paused: pull.paused,
    },
    risk: risk.risk,
    checks: children.checks,
    reviews: children.reviews.map(review => ({ ...review, submitted_at: iso(review.submitted_at) ?? '', commit_id: review.commit_id })),
    reviewers: await loadActiveReviewers(q, repo.community_id),
    mode: repo.mode as RepositoryMode,
    settings,
    migration_reasons: migrationReasons,
    claim: claimInput(await loadActiveClaim(q, pull.pull_id)),
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
}
