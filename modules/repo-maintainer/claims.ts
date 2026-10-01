import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../packages/db/index.js';
import { rederivePull } from './derive.js';
import type { MaintainerGitHub } from './github.js';
import { resolveSettings } from './policy.js';
import { enqueueMaintainerJob } from './queue.js';

export type MaintainerWrites = 'off' | 'requested_reviewers' | 'invalid';
export type ClaimSettlement = { expired: number; released: number; completed: number; adopted: number };
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

type ClaimStep = { set: string; where: string };

/** Lock candidate pulls in pull_id order, then update only the claims on those pulls. */
async function transition(pool: Pool, now: Date, step: ClaimStep): Promise<number> {
  const lock = `SELECT p.pull_id FROM maintainer_pull_requests p
    WHERE p.pull_id IN (
      SELECT c.pull_id FROM maintainer_review_claims c
      JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id
      WHERE ${step.where}
    )
    ORDER BY p.pull_id FOR UPDATE OF p`;
  const update = `UPDATE maintainer_review_claims AS c
    SET ${step.set}
    FROM maintainer_pull_requests p
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

const NOT_ELIGIBLE = `NOT EXISTS (
  SELECT 1 FROM maintainer_eligible_reviewers e
  WHERE e.repository_id = p.repository_id
    AND e.user_id = c.reviewer_user_id
    AND e.github_user_id = c.reviewer_github_id
    AND e.acting_as = c.acting_as
    AND e.guild_key IS NOT DISTINCT FROM c.guild_key)`;

/**
 * Complete claims that already have a decisive review, then adopt an open repository
 * when the claim was a guild leader's. Pull rows are locked before claim rows; the
 * repository row is locked after that, then the repository's other open pulls.
 * Two leaders finishing in one pass are applied in pull_id order, so only the first
 * conditional update adopts.
 */
async function completeClaims(pool: Pool, now: Date): Promise<{ completed: number; adopted: number }> {
  const where = `c.state='active' AND EXISTS (
    SELECT 1 FROM maintainer_reviews r
    WHERE r.pull_id=c.pull_id AND r.reviewer_github_id=c.reviewer_github_id
      AND r.state IN ('APPROVED','CHANGES_REQUESTED') AND r.submitted_at>=c.created_at)`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await transaction(pool, async q => {
        const locked = await q.query(`SELECT p.pull_id FROM maintainer_pull_requests p
          WHERE p.pull_id IN (
            SELECT c.pull_id FROM maintainer_review_claims c
            JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id
            WHERE ${where}
          )
          ORDER BY p.pull_id FOR UPDATE OF p`);
        const pullIds = locked.rows.map(row => row.pull_id as string);
        if (!pullIds.length) return { completed: 0, adopted: 0 };
        const updated = await q.query(`WITH done AS (
            UPDATE maintainer_review_claims AS c
            SET state='completed', ended_at=$1, end_reason='review_submitted', aggregate_version=c.aggregate_version+1
            FROM maintainer_pull_requests p
            WHERE c.pull_id=p.pull_id AND ${where} AND c.pull_id = ANY($2::uuid[])
            RETURNING c.claim_id, c.pull_id, c.acting_as, c.guild_key, c.reviewer_user_id, p.repository_id, p.number
          )
          SELECT * FROM done ORDER BY pull_id`, [now, pullIds]);
        let adopted = 0;
        for (const row of updated.rows) {
          if (row.acting_as !== 'guild_leader' || !row.guild_key) continue;
          const repo = (await q.query(
            `UPDATE maintainer_repositories
             SET guild_key=$2, open_to_guilds=false, aggregate_version=aggregate_version+1, updated_at=$3
             WHERE repository_id=$1 AND guild_key IS NULL AND open_to_guilds
             RETURNING repository_id, scope_kind, full_name`,
            [row.repository_id, row.guild_key, now],
          )).rows[0] as { repository_id: string; scope_kind: string | null; full_name: string } | undefined;
          if (!repo) continue;
          adopted += 1;
          await q.query(
            `INSERT INTO maintainer_ownership_changes (
               change_id, repository_id, guild_key, scope_kind, open_to_guilds, source, changed_by_user, pull_id, reason, created_at)
             VALUES ($1,$2,$3,$4,false,'adopted',$5,$6,$7,$8)`,
            [randomUUID(), row.repository_id, row.guild_key, repo.scope_kind, row.reviewer_user_id, row.pull_id,
              `審完 ${repo.full_name}#${row.number} 後歸到這個公會。`, now],
          );
          await q.query(
            `SELECT pull_id FROM maintainer_pull_requests WHERE repository_id=$1 AND state='open' ORDER BY pull_id FOR UPDATE`,
            [row.repository_id],
          );
          await q.query(
            `UPDATE maintainer_pull_requests SET recheck_at=$2 WHERE repository_id=$1 AND state='open'`,
            [row.repository_id, now],
          );
        }
        for (const row of updated.rows) await rederivePull(q, row.pull_id, now);
        return { completed: updated.rowCount ?? 0, adopted };
      });
    } catch (error) {
      if (pgCode(error) === '40P01' && attempt === 0) continue;
      throw error;
    }
  }
  return { completed: 0, adopted: 0 };
}

/**
 * End claims the database can decide without GitHub. Earlier steps win because each
 * UPDATE still requires state = 'active'. Pull rows are locked before claim rows.
 * A requested reviewer is removed afterwards, except when that person has already
 * submitted a review: GitHub drops the request then. Closing the pull leaves the
 * request in place. A leader who submitted and then lost eligibility is released
 * here and does not adopt, because this step runs before completion.
 */
export async function settleMaintainerClaims(pool: Pool, now: Date): Promise<ClaimSettlement> {
  const version = 'aggregate_version=c.aggregate_version+1';
  const expired = await transition(pool, now, {
    set: `state='expired', ended_at=$1, github_request_state=${REMOVING}, ${version}`,
    where: `c.state='active' AND c.expires_at IS NOT NULL AND c.expires_at<=$1`,
  });
  const closed = await transition(pool, now, {
    set: `state='released', ended_at=$1, end_reason='pull_closed', ${version}`,
    where: `c.state='active' AND (p.state<>'open' OR p.merged_at IS NOT NULL)`,
  });
  const ineligible = await transition(pool, now, {
    set: `state='released', ended_at=$1, end_reason='reviewer_not_eligible', github_request_state=${REMOVING}, ${version}`,
    where: `c.state='active' AND ${NOT_ELIGIBLE}`,
  });
  const done = await completeClaims(pool, now);
  return { expired, released: closed + ineligible, completed: done.completed, adopted: done.adopted };
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
    `SELECT c.claim_id, c.state, c.end_reason, c.github_request_state, c.reviewer_login AS github_login, p.number, p.repository_id
     FROM maintainer_review_claims c
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
 * A 422 often means that login is not a collaborator, or the person renamed it since the snapshot.
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
  if (claim.github_request_state !== 'removing') return { state: 'done', error: 'claim_state_changed' };
  if (!allowed) {
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
