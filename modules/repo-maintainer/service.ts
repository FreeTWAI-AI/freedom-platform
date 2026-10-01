import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { checkVersion } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { adminCommand, audit, type AdminActor, type AdminCommand } from '../platform-admin/service.js';
import { rederivePull } from './derive.js';
import { enqueueMaintainerJob, enqueueReconcilePull } from './queue.js';
import { MAINTAINER_POLICY_VERSION, QUEUE_STATES, repositorySettingsSchema, resolveSettings } from './policy.js';
import {
  activeClaimOnPull, assemblePullDetail, assertPullClaimable, openReviewClaim, pgCode,
  presentListRow, PULL_LIST_COLUMNS, PULL_LIST_JOINS, type ClaimIdentity,
} from './records.js';

const reason = z.string().trim().min(3).max(1000);
const guildKey = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/);
const OPEN_STATES = QUEUE_STATES.filter(state => state !== 'merged' && state !== 'closed');

type Queryable = Pick<Pool | PoolClient, 'query'>;

const REPOSITORY_FIELDS = `repository_id, full_name, default_branch, installation_state, mode, settings, last_swept_at, last_error, rate_limited_until, aggregate_version, guild_key, scope_kind, open_to_guilds`;

const IDENTITY_REQUIRED = '你的管理員帳號還沒有對應到 email 已驗證、且連結了 GitHub 的會員帳號，不能認領給自己，仍可以指派其他人。';
const NOT_ELIGIBLE = '這個人目前不是這個項目的公會長或管理員，或還沒有連結 GitHub，不能審查。';
const CLAIM_AUTHOR = '審查者不能認領自己開的拉取請求。';
const CLAIM_MISSING = '找不到這個認領。';
const CLAIM_INACTIVE = '這個認領已經結束。';
const PULL_ALREADY_PAUSED = '這個拉取請求已經暫停。';
const PULL_NOT_PAUSED = '這個拉取請求沒有暫停。';
const WRITE_CONFLICT = '另一個操作同時在處理這個拉取請求，請重新整理後再試一次。';
const SELF_CLAIM_REASON = '自己認領這次審查。';
const OWNERSHIP_INVALID = '已指定公會的儲存庫不能同時開放所有公會長認領。';
const GUILD_NOT_FOUND = '找不到這個公會。';

export type ReviewCenterViewer = { user_id: string | null; github_login: string | null; can_self_claim: boolean; reason: string | null };

async function resolveViewer(q: Queryable, admin: AdminActor): Promise<ReviewCenterViewer> {
  const row = (await q.query(
    `SELECT e.user_id, e.github_login
     FROM maintainer_eligible_reviewers e
     JOIN users u ON u.user_id = e.user_id
     JOIN platform_admins a ON a.admin_id = $2 AND a.community_id = e.community_id AND lower(u.email) = a.email AND a.active
     WHERE e.acting_as = 'admin' AND e.community_id = $1
     LIMIT 1`,
    [admin.community_id, admin.admin_id],
  )).rows[0] as { user_id: string; github_login: string } | undefined;
  if (!row) return { user_id: null, github_login: null, can_self_claim: false, reason: IDENTITY_REQUIRED };
  return { user_id: row.user_id, github_login: row.github_login, can_self_claim: true, reason: null };
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
  return { policy_version: MAINTAINER_POLICY_VERSION, counts, repositories: repositories.rows, viewer: await resolveViewer(pool, admin) };
}

export async function listReviewCenterPulls(pool: Pool, admin: AdminActor, filter: string, repositoryId: string | null, guildKeyFilter: string | null, limit: number, offset: number) {
  const viewer = await resolveViewer(pool, admin);
  const order = filter === 'awaiting_review'
    ? 'p.head_observed_at ASC, p.pull_id'
    : 'p.github_updated_at DESC, p.pull_id';
  const rows = await pool.query(
    `SELECT ${PULL_LIST_COLUMNS} ${PULL_LIST_JOINS}
     WHERE r.community_id=$1 AND ($2::uuid IS NULL OR p.repository_id=$2)
       AND ($7::text IS NULL OR ($7 = 'none' AND r.guild_key IS NULL) OR r.guild_key = $7)
       AND (($3='open' AND p.state='open')
         OR ($3='done' AND p.queue_state IN ('merged','closed'))
         OR ($3='author_action' AND p.queue_state IN ('needs_author','ci_not_run'))
         OR ($3='mine' AND active_claim.reviewer_user_id=$6::uuid)
         OR ($3 NOT IN ('open','done','author_action','mine') AND p.queue_state=$3))
     ORDER BY ${order} LIMIT $4 OFFSET $5`,
    [admin.community_id, repositoryId, filter, limit + 1, offset, viewer.user_id, guildKeyFilter],
  );
  return { items: rows.rows.slice(0, limit).map(presentListRow), next_offset: rows.rows.length > limit ? offset + limit : null };
}

const PULL_SCOPE = `p.*, r.full_name, r.default_branch, r.mode, r.settings, r.community_id, r.guild_key, r.scope_kind, r.open_to_guilds, g.name AS guild_name`;

async function scopedPull(q: Queryable, admin: AdminActor, id: string, lock = false) {
  const row = (await q.query(
    `SELECT ${PULL_SCOPE}
     FROM maintainer_pull_requests p
     JOIN maintainer_repositories r ON r.repository_id=p.repository_id
     LEFT JOIN positioning_guild_catalog g ON g.guild_key=r.guild_key
     WHERE p.pull_id=$1 AND r.community_id=$2${lock ? ' FOR UPDATE OF p' : ''}`,
    [id, admin.community_id],
  )).rows[0];
  requireCondition(row, 404, 'maintainer_pull_not_found', '找不到這個拉取請求。');
  return row;
}

export async function reviewCenterPull(pool: Pool, admin: AdminActor, id: string) {
  z.uuid().parse(id);
  return assemblePullDetail(pool, await scopedPull(pool, admin, id), true);
}

async function claimWrite<T>(pool: Pool, input: AdminCommand, authorize: (q: PoolClient) => Promise<unknown>, run: (q: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await adminCommand(pool, input, authorize, run);
  } catch (error) {
    if (pgCode(error) === '40P01') throw new Problem(409, 'maintainer_write_conflict', WRITE_CONFLICT);
    throw error;
  }
}

async function adminIdentity(q: Queryable, admin: AdminActor, repositoryId: string): Promise<ClaimIdentity> {
  const row = (await q.query(
    `SELECT e.user_id, e.github_user_id, e.github_login
     FROM maintainer_eligible_reviewers e
     JOIN users u ON u.user_id = e.user_id
     JOIN platform_admins a ON a.admin_id = $3 AND a.community_id = e.community_id AND lower(u.email) = a.email AND a.active
     WHERE e.repository_id=$1 AND e.community_id=$2 AND e.acting_as='admin' AND e.guild_key IS NULL
     LIMIT 1`,
    [repositoryId, admin.community_id, admin.admin_id],
  )).rows[0] as { user_id: string; github_user_id: string; github_login: string } | undefined;
  requireCondition(row, 409, 'maintainer_claim_identity_required', IDENTITY_REQUIRED);
  return { ...row, acting_as: 'admin', guild_key: null };
}

async function eligibleIdentity(q: Queryable, repositoryId: string, userId: string, actingAs: 'admin' | 'guild_leader', key: string | null): Promise<ClaimIdentity> {
  const row = (await q.query(
    `SELECT user_id, github_user_id, github_login, acting_as, guild_key
     FROM maintainer_eligible_reviewers
     WHERE repository_id=$1 AND user_id=$2 AND acting_as=$3 AND guild_key IS NOT DISTINCT FROM $4`,
    [repositoryId, userId, actingAs, key],
  )).rows[0] as ClaimIdentity | undefined;
  requireCondition(row, 409, 'maintainer_reviewer_not_eligible', NOT_ELIGIBLE);
  return row;
}

async function finishClaimWrite(q: PoolClient, admin: AdminActor, pullId: string, now: Date, action: string, targetType: string, targetRef: string, why: string, before: unknown, after: Record<string, unknown> = {}) {
  await rederivePull(q, pullId, now);
  const detail = await assemblePullDetail(q, await scopedPull(q, admin, pullId), true);
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
    const reviewer = await adminIdentity(q, input.admin, pull.repository_id);
    assertPullClaimable(pull);
    requireCondition(reviewer.github_user_id !== pull.author_github_id, 409, 'maintainer_claim_author', CLAIM_AUTHOR);
    const now = new Date();
    const claim = await openReviewClaim(q, pull, reviewer, { admin_id: input.admin.admin_id, user_id: null }, 'self', null, now);
    return finishClaimWrite(q, input.admin, id, now, 'maintainer_claim_self', 'maintainer_pull', id, SELF_CLAIM_REASON, {
      claim_id: null, reviewer_login: null, state: null, queue_state: pull.queue_state, aggregate_version: String(pull.aggregate_version),
      claim_aggregate_version: null, opened_claim_id: claim.claim_id,
    });
  });
}

export async function assignReviewer(pool: Pool, input: AdminCommand, id: string) {
  z.uuid().parse(id);
  const body = z.object({
    user_id: z.uuid(),
    acting_as: z.enum(['admin', 'guild_leader']),
    guild_key: guildKey.nullable(),
    reason,
  }).strict().parse(input.body);
  return claimWrite(pool, input, async q => { await scopedPull(q, input.admin, id); }, async q => {
    const pull = await scopedPull(q, input.admin, id, true);
    checkVersion(String(pull.aggregate_version), input.expected);
    const reviewer = await eligibleIdentity(q, pull.repository_id, body.user_id, body.acting_as, body.guild_key);
    assertPullClaimable(pull);
    requireCondition(reviewer.github_user_id !== pull.author_github_id, 409, 'maintainer_claim_author', CLAIM_AUTHOR);
    const now = new Date();
    const claim = await openReviewClaim(q, pull, reviewer, { admin_id: input.admin.admin_id, user_id: null }, 'assigned', body.reason, now);
    return finishClaimWrite(q, input.admin, id, now, 'maintainer_claim_assign', 'maintainer_pull', id, body.reason, {
      claim_id: null, reviewer_login: reviewer.github_login, state: null, queue_state: pull.queue_state,
      aggregate_version: String(pull.aggregate_version), claim_aggregate_version: null, opened_claim_id: claim.claim_id,
    });
  });
}

async function scopedClaim(q: Queryable, admin: AdminActor, id: string, lock = false) {
  const row = (await q.query(
    `SELECT c.claim_id, c.pull_id, c.reviewer_user_id, c.reviewer_login, c.state, c.aggregate_version, c.github_request_state,
       p.repository_id, p.queue_state, p.aggregate_version AS pull_aggregate_version
     FROM maintainer_review_claims c
     JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id
     JOIN maintainer_repositories r ON r.repository_id=p.repository_id
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
    checkVersion(String(prior.aggregate_version), input.expected);
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

export async function changeRepositoryOwnership(pool: Pool, input: AdminCommand, id: string) {
  z.uuid().parse(id);
  const body = z.object({
    guild_key: guildKey.nullable(),
    scope_kind: z.enum(['module', 'skill_book']).nullable(),
    open_to_guilds: z.boolean(),
    reason,
  }).strict().parse(input.body);
  requireCondition(!(body.guild_key && body.open_to_guilds), 422, 'maintainer_ownership_invalid', OWNERSHIP_INVALID);
  return adminCommand(pool, input, async q => { await scopedRepository(q, input.admin, id); }, async q => {
    if (body.guild_key) {
      const found = await q.query('SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1', [body.guild_key]);
      requireCondition(found.rowCount === 1, 422, 'maintainer_guild_not_found', GUILD_NOT_FOUND);
    }
    const prior = await scopedRepository(q, input.admin, id, true);
    checkVersion(String(prior.aggregate_version), input.expected);
    const unchanged = prior.guild_key === body.guild_key && prior.scope_kind === body.scope_kind && prior.open_to_guilds === body.open_to_guilds;
    requireCondition(!unchanged, 409, 'maintainer_ownership_unchanged', '歸屬沒有變更。');
    const updated = (await q.query(
      `UPDATE maintainer_repositories
       SET guild_key=$2, scope_kind=$3, open_to_guilds=$4, aggregate_version=aggregate_version+1, updated_at=now()
       WHERE repository_id=$1 RETURNING ${REPOSITORY_FIELDS}`,
      [id, body.guild_key, body.scope_kind, body.open_to_guilds],
    )).rows[0];
    await q.query(
      `INSERT INTO maintainer_ownership_changes (
         change_id, repository_id, guild_key, scope_kind, open_to_guilds, source, changed_by_admin, reason)
       VALUES ($1,$2,$3,$4,$5,'admin',$6,$7)`,
      [randomUUID(), id, body.guild_key, body.scope_kind, body.open_to_guilds, input.admin.admin_id, body.reason],
    );
    await q.query(`SELECT pull_id FROM maintainer_pull_requests WHERE repository_id=$1 AND state='open' ORDER BY pull_id FOR UPDATE`, [id]);
    await q.query(`UPDATE maintainer_pull_requests SET recheck_at=now() WHERE repository_id=$1 AND state='open'`, [id]);
    await audit(q, input.admin, 'maintainer_repository_ownership', 'maintainer_repository', id, body.reason,
      { guild_key: prior.guild_key, scope_kind: prior.scope_kind, open_to_guilds: prior.open_to_guilds, aggregate_version: prior.aggregate_version },
      { guild_key: updated.guild_key, scope_kind: updated.scope_kind, open_to_guilds: updated.open_to_guilds, aggregate_version: updated.aggregate_version });
    return updated;
  });
}

function adminLinkStatus(row: { user_id: string | null; user_active: boolean | null; email_verified_at: Date | null; github_login: string | null }): 'ready' | 'no_member' | 'email_unverified' | 'no_github' {
  if (!row.user_id || !row.user_active) return 'no_member';
  if (!row.email_verified_at) return 'email_unverified';
  if (!row.github_login) return 'no_github';
  return 'ready';
}

/** Read-only picture of who can review, plus every catalog guild so ownership can name one that has no repository yet. */
export async function listReviewers(pool: Pool, admin: AdminActor) {
  const admins = (await pool.query(
    `SELECT a.admin_id, a.display_name, u.user_id, u.active AS user_active, u.email_verified_at, g.github_login
     FROM platform_admins a
     LEFT JOIN LATERAL (
       SELECT user_id, active, email_verified_at FROM users
       WHERE community_id=a.community_id AND lower(email)=a.email
       ORDER BY active DESC, (email_verified_at IS NOT NULL) DESC, user_id LIMIT 1
     ) u ON true
     LEFT JOIN github_social_connections g ON g.user_id=u.user_id AND g.community_id=a.community_id
     WHERE a.community_id=$1 AND a.active
     ORDER BY a.display_name, a.admin_id`,
    [admin.community_id],
  )).rows;
  const guildRows = (await pool.query(
    `SELECT g.guild_key, g.name,
       CASE WHEN lu.user_id IS NOT NULL THEN lu.user_id ELSE NULL END AS leader_user_id,
       lu.display_name AS leader_name, lg.github_login AS leader_login
     FROM positioning_guild_catalog g
     LEFT JOIN positioning_guild_officers o ON o.guild_key=g.guild_key AND o.community_id=$1
     LEFT JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key
       AND m.user_id=o.user_id AND m.state='active'
     LEFT JOIN users lu ON lu.user_id=o.user_id AND lu.community_id=o.community_id AND lu.active AND m.user_id IS NOT NULL
     LEFT JOIN github_social_connections lg ON lg.user_id=lu.user_id AND lg.community_id=$1
     WHERE EXISTS (
         SELECT 1 FROM positioning_guild_officers o2
         JOIN positioning_profession_memberships m2 ON m2.community_id=o2.community_id AND m2.guild_key=o2.guild_key
           AND m2.user_id=o2.user_id AND m2.state='active'
         JOIN users u2 ON u2.user_id=o2.user_id AND u2.community_id=o2.community_id AND u2.active
         WHERE o2.community_id=$1 AND o2.guild_key=g.guild_key
       )
       OR EXISTS (SELECT 1 FROM maintainer_repositories r WHERE r.community_id=$1 AND r.guild_key=g.guild_key)
     ORDER BY g.name, g.guild_key`,
    [admin.community_id],
  )).rows;
  const owned = (await pool.query(
    `SELECT repository_id, full_name, scope_kind, guild_key, open_to_guilds
     FROM maintainer_repositories WHERE community_id=$1 ORDER BY full_name, repository_id`,
    [admin.community_id],
  )).rows as Array<{ repository_id: string; full_name: string; scope_kind: string | null; guild_key: string | null; open_to_guilds: boolean }>;
  const guildChoices = (await pool.query('SELECT guild_key, name FROM positioning_guild_catalog ORDER BY name, guild_key')).rows;
  return {
    admins: admins.map(row => ({
      admin_id: row.admin_id, display_name: row.display_name, github_login: row.github_login, status: adminLinkStatus(row),
    })),
    guilds: guildRows.map(row => ({
      guild_key: row.guild_key,
      name: row.name,
      leader: row.leader_user_id ? { user_id: row.leader_user_id, display_name: row.leader_name, github_login: row.leader_login } : null,
      repositories: owned.filter(repo => repo.guild_key === row.guild_key).map(repo => ({
        repository_id: repo.repository_id, full_name: repo.full_name, scope_kind: repo.scope_kind,
      })),
    })),
    open_repositories: owned.filter(repo => repo.guild_key == null && repo.open_to_guilds).map(repo => ({
      repository_id: repo.repository_id, full_name: repo.full_name, scope_kind: repo.scope_kind,
    })),
    admin_only_repositories: owned.filter(repo => repo.guild_key == null && !repo.open_to_guilds).map(repo => ({
      repository_id: repo.repository_id, full_name: repo.full_name, scope_kind: repo.scope_kind,
    })),
    guild_choices: guildChoices,
  };
}
