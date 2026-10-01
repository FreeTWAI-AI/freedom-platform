import type { Pool } from 'pg';
import { transaction } from '../../packages/db/index.js';
import { rederivePull } from './derive.js';
import type { MaintainerGitHub } from './github.js';
import { resolveSettings } from './policy.js';
import { enqueueMaintainerJob } from './queue.js';

export type MaintainerWrites = 'off' | 'requested_reviewers' | 'invalid';
export type ClaimSettlement = { expired: number; released: number; completed: number };
export type ReviewerJobResult = { state: 'done' | 'failed'; error: string | null };

type ClaimJob = { kind: string; payload: unknown; repository_id: string };
type ClaimRepo = { full_name: string; installation_id: string; github_repository_id: string; settings: unknown };

const REMOVING = `CASE WHEN c.github_request_state = 'requested' THEN 'removing' ELSE c.github_request_state END`;

function pgCode(error: unknown): string {
  return typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
}
function clip(code: string): string {
  const text = code.slice(0, 80);
  return text || 'github_error';
}
export function claimIdFromPayload(payload: unknown): string | null {
  const body = typeof payload === 'string' ? JSON.parse(payload) as { claim_id?: unknown } : payload as { claim_id?: unknown } | null;
  const id = body?.claim_id;
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

type ClaimStep = { set: string; using: string; where: string };

/** Lock candidate pulls in pull_id order, then update only the claims on those pulls. */
async function transition(pool: Pool, now: Date, step: ClaimStep): Promise<number> {
  const reviewers = step.using.includes('maintainer_reviewers')
    ? 'JOIN maintainer_reviewers v ON v.reviewer_id=c.reviewer_id'
    : '';
  const lock = `SELECT p.pull_id FROM maintainer_pull_requests p
    WHERE p.pull_id IN (
      SELECT c.pull_id FROM maintainer_review_claims c
      JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id
      ${reviewers}
      WHERE ${step.where}
    )
    ORDER BY p.pull_id FOR UPDATE OF p`;
  const update = `UPDATE maintainer_review_claims AS c
    SET ${step.set}
    FROM maintainer_pull_requests p${step.using}
    WHERE c.pull_id=p.pull_id AND ${step.where} AND c.pull_id = ANY($2::uuid[])
    RETURNING c.claim_id, c.pull_id, p.repository_id, c.github_request_state`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await transaction(pool, async q => {
        const locked = await q.query(lock, step.where.includes('$1') ? [now] : []);
        const pullIds = locked.rows.map(row => row.pull_id as string);
        if (!pullIds.length) return 0;
        const updated = await q.query(update, [now, pullIds]);
        for (const row of updated.rows) {
          if (row.github_request_state === 'removing') {
            await enqueueMaintainerJob(q, row.repository_id, 'remove_reviewer_request', row.claim_id, now);
          }
          await rederivePull(q, row.pull_id, now);
        }
        return updated.rowCount ?? 0;
      });
    } catch (error) {
      if (pgCode(error) === '40P01' && attempt === 0) continue;
      throw error;
    }
  }
  return 0;
}

/**
 * End claims the database can decide without GitHub. Earlier steps win because each
 * UPDATE still requires state = 'active'. Pull rows are locked before claim rows.
 * A requested reviewer is removed afterwards, except when that person has already
 * submitted a review: GitHub drops the request then. Closing the pull leaves the
 * request in place, and this maintainer leaves it there too.
 */
export async function settleMaintainerClaims(pool: Pool, now: Date): Promise<ClaimSettlement> {
  const version = 'aggregate_version=c.aggregate_version+1';
  const expired = await transition(pool, now, {
    set: `state='expired', ended_at=$1, github_request_state=${REMOVING}, ${version}`,
    using: '',
    where: `c.state='active' AND c.expires_at<=$1`,
  });
  const closed = await transition(pool, now, {
    set: `state='released', ended_at=$1, end_reason='pull_closed', ${version}`,
    using: '',
    where: `c.state='active' AND (p.state<>'open' OR p.merged_at IS NOT NULL)`,
  });
  const inactive = await transition(pool, now, {
    set: `state='released', ended_at=$1, end_reason='reviewer_inactive', github_request_state=${REMOVING}, ${version}`,
    using: ', maintainer_reviewers v',
    where: `c.state='active' AND v.reviewer_id=c.reviewer_id AND NOT v.active`,
  });
  const rank = await transition(pool, now, {
    set: `state='released', ended_at=$1, end_reason='reviewer_rank_too_low', github_request_state=${REMOVING}, ${version}`,
    using: ', maintainer_reviewers v',
    where: `c.state='active' AND v.reviewer_id=c.reviewer_id AND (
      (p.risk_class='medium' AND v.max_risk='low') OR (p.risk_class='high' AND v.max_risk IN ('low','medium')))`,
  });
  const completed = await transition(pool, now, {
    set: `state='completed', ended_at=$1, end_reason='review_submitted', ${version}`,
    using: ', maintainer_reviewers v',
    where: `c.state='active' AND v.reviewer_id=c.reviewer_id AND EXISTS (
      SELECT 1 FROM maintainer_reviews r
      WHERE r.pull_id=c.pull_id AND r.reviewer_github_id=v.github_user_id
        AND r.state IN ('APPROVED','CHANGES_REQUESTED') AND r.submitted_at>=c.created_at)`,
  });
  return { expired, released: closed + inactive + rank, completed };
}

async function markGithub(pool: Pool, claimId: string, state: string, error: string | null, expected: string) {
  await pool.query(
    `UPDATE maintainer_review_claims
     SET github_request_state=$2, github_request_error=$3, aggregate_version=aggregate_version+1
     WHERE claim_id=$1 AND github_request_state=$4`,
    [claimId, state, error ? clip(error) : null, expected],
  );
}

/** Terminal failure for a reviewer job. Only pending requests and in-flight removals are overwritten. */
export async function failClaimGithub(pool: Pool, claimId: string, code: string, expected: 'pending' | 'removing') {
  await markGithub(pool, claimId, 'failed', code, expected);
}

type LoadedClaim = {
  claim_id: string; state: string; end_reason: string | null; github_request_state: string;
  github_login: string; number: number; repository_id: string;
};

async function loadClaim(pool: Pool, claimId: string, repositoryId: string): Promise<LoadedClaim | null> {
  const row = (await pool.query(
    `SELECT c.claim_id, c.state, c.end_reason, c.github_request_state, v.github_login, p.number, p.repository_id
     FROM maintainer_review_claims c
     JOIN maintainer_reviewers v ON v.reviewer_id=c.reviewer_id
     JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id
     WHERE c.claim_id=$1 AND p.repository_id=$2`,
    [claimId, repositoryId],
  )).rows[0] as LoadedClaim | undefined;
  return row ?? null;
}

function writesAllowed(writes: MaintainerWrites, settings: unknown, fullName: string): boolean {
  return writes === 'requested_reviewers' && resolveSettings(fullName, settings).request_reviewers === true;
}

/**
 * Request or remove only the claimed reviewer's login. The row is not locked across the GitHub call.
 * A 422 often means that login is not a collaborator, or the person renamed it since the mirror.
 */
export async function runReviewerJob(pool: Pool, github: MaintainerGitHub, job: ClaimJob, repo: ClaimRepo, now: Date, writes: MaintainerWrites): Promise<ReviewerJobResult> {
  const claimId = claimIdFromPayload(job.payload);
  if (!claimId) return { state: 'failed', error: 'payload_invalid' };
  const claim = await loadClaim(pool, claimId, job.repository_id);
  if (!claim) return { state: 'done', error: 'claim_inactive' };
  const allowed = writesAllowed(writes, repo.settings, repo.full_name);
  if (job.kind === 'remove_reviewer_request') return removeReviewer(pool, github, repo, claim, now, allowed);
  return requestReviewer(pool, github, repo, claim, now, allowed);
}

async function requestReviewer(pool: Pool, github: MaintainerGitHub, repo: ClaimRepo, claim: LoadedClaim, now: Date, allowed: boolean): Promise<ReviewerJobResult> {
  // A re-run after the 201 was stored must not rewrite requested, removing, removed or failed.
  if (claim.github_request_state !== 'pending') return { state: 'done', error: 'claim_state_changed' };
  if (claim.state !== 'active') {
    await markGithub(pool, claim.claim_id, 'skipped', 'claim_inactive', 'pending');
    return { state: 'done', error: 'claim_inactive' };
  }
  if (!allowed) {
    await markGithub(pool, claim.claim_id, 'skipped', 'writes_disabled', 'pending');
    return { state: 'done', error: 'writes_disabled' };
  }
  const status = await github.requestReviewer(repo.full_name, repo.installation_id, repo.github_repository_id, claim.number, claim.github_login);
  if (status !== 201) {
    const code = `github_http_${status}`;
    await markGithub(pool, claim.claim_id, 'failed', code, 'pending');
    return { state: 'failed', error: code };
  }
  await transaction(pool, async q => {
    const locked = (await q.query(
      `SELECT c.state, c.end_reason, p.repository_id
       FROM maintainer_review_claims c
       JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id
       WHERE c.claim_id=$1 FOR UPDATE OF c`,
      [claim.claim_id],
    )).rows[0] as { state: string; end_reason: string | null; repository_id: string } | undefined;
    if (!locked) return;
    // pull_closed keeps the GitHub request. Submitting a review is what makes GitHub drop it.
    if (locked.state === 'active' || locked.end_reason === 'pull_closed') {
      await q.query(`UPDATE maintainer_review_claims SET github_request_state='requested', github_request_error=NULL, aggregate_version=aggregate_version+1 WHERE claim_id=$1`, [claim.claim_id]);
      return;
    }
    await q.query(`UPDATE maintainer_review_claims SET github_request_state='removing', github_request_error=NULL, aggregate_version=aggregate_version+1 WHERE claim_id=$1`, [claim.claim_id]);
    await enqueueMaintainerJob(q, locked.repository_id, 'remove_reviewer_request', claim.claim_id, now);
  });
  return { state: 'done', error: null };
}

async function removeReviewer(pool: Pool, github: MaintainerGitHub, repo: ClaimRepo, claim: LoadedClaim, _now: Date, allowed: boolean): Promise<ReviewerJobResult> {
  // A re-run after removed (or any other settled state) must not mark the row skipped.
  if (claim.github_request_state !== 'removing') return { state: 'done', error: 'claim_state_changed' };
  if (!allowed) {
    // The request may still be on GitHub, so this is a failure, not a skip.
    await markGithub(pool, claim.claim_id, 'failed', 'writes_disabled', 'removing');
    return { state: 'failed', error: 'writes_disabled' };
  }
  const status = await github.removeRequestedReviewer(repo.full_name, repo.installation_id, repo.github_repository_id, claim.number, claim.github_login);
  if (status !== 200) {
    const code = `github_http_${status}`;
    await markGithub(pool, claim.claim_id, 'failed', code, 'removing');
    return { state: 'failed', error: code };
  }
  await pool.query(
    `UPDATE maintainer_review_claims SET github_request_state='removed', github_request_error=NULL, aggregate_version=aggregate_version+1
     WHERE claim_id=$1 AND github_request_state='removing'`,
    [claim.claim_id],
  );
  return { state: 'done', error: null };
}
