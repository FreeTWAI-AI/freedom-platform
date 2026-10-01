import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { checkVersion } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { adminCommand, audit, type AdminActor, type AdminCommand } from '../platform-admin/service.js';
import { enqueueReconcilePull } from './queue.js';
import {
  annotateReviews, MAINTAINER_POLICY_VERSION, QUEUE_STATES, repositorySettingsSchema, resolveSettings,
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
  return { policy_version: MAINTAINER_POLICY_VERSION, counts, repositories: repositories.rows };
}

export async function listReviewCenterPulls(pool: Pool, admin: AdminActor, filter: string, repositoryId: string | null, limit: number, offset: number) {
  const awaiting = filter === 'awaiting_review';
  const order = awaiting
    ? 'p.sla_due_at ASC NULLS LAST, p.github_updated_at DESC, p.pull_id'
    : 'p.github_updated_at DESC, p.pull_id';
  const rows = await pool.query(
    `SELECT p.pull_id, p.repository_id, r.full_name, p.number, p.title, p.html_url, p.state, p.queue_state, p.risk_class,
       p.author_login, p.is_draft, p.is_fork, p.sla_due_at, p.github_updated_at, p.head_sha, p.labels, p.aggregate_version
     FROM maintainer_pull_requests p JOIN maintainer_repositories r ON r.repository_id=p.repository_id
     WHERE r.community_id=$1 AND ($2::uuid IS NULL OR p.repository_id=$2)
       AND (($3='open' AND p.state='open') OR ($3='done' AND p.queue_state IN ('merged','closed')) OR ($3 NOT IN ('open','done') AND p.queue_state=$3))
     ORDER BY ${order} LIMIT $4 OFFSET $5`,
    [admin.community_id, repositoryId, filter, limit + 1, offset],
  );
  return { items: rows.rows.slice(0, limit), next_offset: rows.rows.length > limit ? offset + limit : null };
}

async function scopedPull(q: Queryable, admin: AdminActor, id: string) {
  const row = (await q.query(
    `SELECT p.*, r.full_name, r.default_branch, r.mode, r.community_id
     FROM maintainer_pull_requests p JOIN maintainer_repositories r ON r.repository_id=p.repository_id
     WHERE p.pull_id=$1 AND r.community_id=$2`,
    [id, admin.community_id],
  )).rows[0];
  requireCondition(row, 404, 'maintainer_pull_not_found', '找不到這個拉取請求。');
  return row;
}

export async function reviewCenterPull(pool: Pool, admin: AdminActor, id: string) {
  z.uuid().parse(id);
  const pull = await scopedPull(pool, admin, id);
  const files = (await pool.query(
    `SELECT path, previous_path, status, additions, deletions FROM maintainer_pull_files WHERE pull_id=$1 ORDER BY path`,
    [id],
  )).rows as Array<{ path: string; previous_path: string | null; status: string; additions: number; deletions: number }>;
  const checks = (await pool.query(
    `SELECT head_sha, source, name, app_key, app_slug, status, conclusion, check_suite_id, completed_at
     FROM maintainer_checks WHERE pull_id=$1 ORDER BY source, name`,
    [id],
  )).rows;
  const reviews = (await pool.query(
    `SELECT github_review_id, reviewer_github_id, reviewer_login, reviewer_type, reviewer_association, state, commit_id, submitted_at
     FROM maintainer_reviews WHERE pull_id=$1 ORDER BY submitted_at, github_review_id`,
    [id],
  )).rows;
  const reviewers = (await pool.query(
    `SELECT github_user_id, max_risk FROM maintainer_reviewers WHERE community_id=$1 AND active`,
    [admin.community_id],
  )).rows as ActiveReviewer[];
  const riskReasons = (Array.isArray(pull.risk_reasons) ? pull.risk_reasons : []) as Reason[];
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
  };
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
