import type { Pool, PoolClient } from 'pg';
import type { MaintainerPullFile, MaintainerPullReview } from './github.js';
import {
  classifyAttention, deriveQueueState, MAINTAINER_POLICY_VERSION, resolveSettings,
  type PolicyCheck, type QueueClaim, type Reason, type RepositoryMode,
} from './policy.js';

type Queryable = Pool | PoolClient;
type PullRow = Record<string, any>;

export type ActiveClaim = {
  claim_id: string;
  reviewer_login: string;
  acting_as: 'admin' | 'guild_leader';
  guild_name: string | null;
  adopts_repository: boolean;
  expires_at: Date | null;
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

/** GitHub numeric ids of everyone who may approve pulls on this repository now. */
export async function loadEligibleReviewerIds(q: Queryable, repositoryId: string): Promise<string[]> {
  const rows = await q.query(
    'SELECT DISTINCT github_user_id FROM maintainer_eligible_reviewers WHERE repository_id=$1',
    [repositoryId],
  );
  return rows.rows.map(row => row.github_user_id as string);
}

/** The one active claim, if any. A past expires_at still counts as absent inside deriveQueueState. */
export async function loadActiveClaim(q: Queryable, pullId: string): Promise<ActiveClaim | null> {
  const row = (await q.query(
    `SELECT c.claim_id, c.reviewer_login, c.acting_as, g.name AS guild_name, c.expires_at,
       (c.acting_as = 'guild_leader' AND r.guild_key IS NULL AND r.open_to_guilds) AS adopts_repository
     FROM maintainer_review_claims c
     JOIN maintainer_pull_requests p ON p.pull_id = c.pull_id
     JOIN maintainer_repositories r ON r.repository_id = p.repository_id
     LEFT JOIN positioning_guild_catalog g ON g.guild_key = c.guild_key
     WHERE c.pull_id=$1 AND c.state='active'`,
    [pullId],
  )).rows[0] as ActiveClaim | undefined;
  return row ?? null;
}

export function claimInput(claim: ActiveClaim | null): QueueClaim | null {
  if (!claim) return null;
  return {
    reviewer_login: claim.reviewer_login,
    acting_as: claim.acting_as,
    guild_name: claim.guild_name,
    adopts_repository: Boolean(claim.adopts_repository),
    expires_at: iso(claim.expires_at),
  };
}

/**
 * Recompute one pull from the stored mirror, its children, the eligibility view,
 * the stored migration_reasons column, and the active claim. Writes derived fields
 * only when they changed. Migration reasons are not derived again here.
 */
export async function rederivePull(q: Queryable, pullId: string, now: Date): Promise<boolean> {
  const pull = (await q.query('SELECT * FROM maintainer_pull_requests WHERE pull_id=$1 FOR UPDATE', [pullId])).rows[0] as PullRow | undefined;
  if (!pull) return false;
  const repo = (await q.query(
    'SELECT full_name, default_branch, mode, settings, community_id FROM maintainer_repositories WHERE repository_id=$1',
    [pull.repository_id],
  )).rows[0];
  if (!repo) return false;
  const settings = resolveSettings(repo.full_name, repo.settings);
  const children = await loadPullChildren(q, pull.pull_id);
  const attention = classifyAttention({
    files: children.files, profile: settings.rules_profile, changed_files: pull.changed_files,
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
    eligible_reviewer_ids: await loadEligibleReviewerIds(q, pull.repository_id),
    checks: children.checks,
    reviews: children.reviews.map(review => ({ ...review, submitted_at: iso(review.submitted_at) ?? '', commit_id: review.commit_id })),
    mode: repo.mode as RepositoryMode,
    settings,
    migration_reasons: migrationReasons,
    claim: claimInput(await loadActiveClaim(q, pull.pull_id)),
  }, now);
  const same = JSON.stringify(pull.attention_reasons) === JSON.stringify(attention)
    && pull.queue_state === derived.state
    && JSON.stringify(pull.queue_reasons) === JSON.stringify(derived.reasons)
    && iso(pull.recheck_at) === derived.recheck_at
    && pull.policy_version === MAINTAINER_POLICY_VERSION;
  if (same) return false;
  await q.query(`UPDATE maintainer_pull_requests SET attention_reasons=$2::jsonb, queue_state=$3, queue_reasons=$4::jsonb,
    recheck_at=$5, policy_version=$6, aggregate_version=aggregate_version+1
    WHERE pull_id=$1`, [pull.pull_id, JSON.stringify(attention), derived.state, JSON.stringify(derived.reasons), derived.recheck_at, MAINTAINER_POLICY_VERSION]);
  return true;
}
