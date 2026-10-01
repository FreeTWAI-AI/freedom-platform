import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { command, transaction, checkVersion, type Command } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../identity-membership/service.js';
import { rederivePull } from './derive.js';
import { enqueueMaintainerJob } from './queue.js';
import {
  assemblePullDetail, assertPullClaimable, openReviewClaim, pgCode,
  presentListRow, PULL_LIST_COLUMNS, PULL_LIST_JOINS,
} from './records.js';

const GUILD_LEADER_REQUIRED = '此操作限目前在任的公會長。';
const GITHUB_REQUIRED = '請先在會員資料連結 GitHub，才能認領審查。';
const GUILD_SCOPE = '這個項目不屬於你負責的公會。';
const GUILD_REQUIRED = '你是多個公會的公會長，請選擇審完後要歸到哪個公會。';
const CLAIM_AUTHOR = '審查者不能認領自己開的拉取請求。';
const NOT_YOURS = '只能放棄自己的認領。';
const CLAIM_MISSING = '找不到這個認領。';
const CLAIM_INACTIVE = '這個認領已經結束。';
const WRITE_CONFLICT = '另一個操作同時在處理這個拉取請求，請重新整理後再試一次。';
const PULL_MISSING = '找不到這個拉取請求。';

const MEMBER_FILTERS = ['awaiting_review', 'in_review', 'mine', 'ready', 'open'] as const;
const guildKeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/);

type Queryable = Pick<Pool | PoolClient, 'query'>;
type Guild = { guild_key: string; name: string };

async function activeMember(q: PoolClient, actor: Actor) {
  requireCondition((await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active FOR SHARE', [actor.user_id, actor.community_id])).rowCount === 1, 401, 'session_expired', '請重新登入。');
  requireCondition((await q.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE', [actor.session_hash, actor.user_id])).rowCount === 1, 401, 'session_expired', '請重新登入。');
}

async function managedGuilds(q: Queryable, actor: Actor): Promise<Guild[]> {
  return (await q.query(
    `SELECT g.guild_key, g.name FROM positioning_guild_officers o
     JOIN positioning_guild_catalog g USING (guild_key)
     JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
     WHERE o.community_id=$1 AND o.user_id=$2 ORDER BY g.guild_key FOR SHARE OF m, o`,
    [actor.community_id, actor.user_id],
  )).rows as Guild[];
}

async function requireLeader(q: PoolClient, actor: Actor): Promise<Guild[]> {
  const guilds = await managedGuilds(q, actor);
  requireCondition(guilds.length > 0, 403, 'guild_leader_required', GUILD_LEADER_REQUIRED);
  return guilds;
}

const VISIBLE = `(r.guild_key = ANY($2::text[]) OR (r.guild_key IS NULL AND r.open_to_guilds))`;

async function visiblePull(q: Queryable, actor: Actor, id: string, guilds: Guild[], lock = false) {
  const row = (await q.query(
    `SELECT p.*, r.full_name, r.default_branch, r.mode, r.settings, r.community_id, r.guild_key, r.scope_kind, r.open_to_guilds, g.name AS guild_name
     FROM maintainer_pull_requests p
     JOIN maintainer_repositories r ON r.repository_id=p.repository_id
     LEFT JOIN positioning_guild_catalog g ON g.guild_key=r.guild_key
     WHERE p.pull_id=$1 AND r.community_id=$3 AND ${VISIBLE}${lock ? ' FOR UPDATE OF p' : ''}`,
    [id, guilds.map(guild => guild.guild_key), actor.community_id],
  )).rows[0];
  requireCondition(row, 404, 'maintainer_pull_not_found', PULL_MISSING);
  return row;
}

async function githubLogin(q: Queryable, actor: Actor): Promise<string | null> {
  const row = (await q.query(
    'SELECT github_login FROM github_social_connections WHERE user_id=$1 AND community_id=$2',
    [actor.user_id, actor.community_id],
  )).rows[0] as { github_login: string } | undefined;
  return row?.github_login ?? null;
}

function viewer(login: string | null) {
  return { github_login: login, reason: login ? null : GITHUB_REQUIRED };
}

async function leaderRows(q: Queryable, actor: Actor, repositoryId: string) {
  return (await q.query(
    `SELECT e.user_id, e.github_user_id, e.github_login, e.acting_as, e.guild_key, g.name AS guild_name
     FROM maintainer_eligible_reviewers e
     JOIN positioning_guild_catalog g ON g.guild_key=e.guild_key
     WHERE e.repository_id=$1 AND e.user_id=$2 AND e.community_id=$3 AND e.acting_as='guild_leader'
     ORDER BY g.name, e.guild_key`,
    [repositoryId, actor.user_id, actor.community_id],
  )).rows as Array<{ user_id: string; github_user_id: string; github_login: string; acting_as: 'guild_leader'; guild_key: string; guild_name: string }>;
}

async function memberDetail(q: Queryable, actor: Actor, pull: Record<string, any>) {
  const detail = await assemblePullDetail(q, pull, false);
  const options = await leaderRows(q, actor, pull.repository_id);
  return {
    ...detail,
    claim_options: options.map(row => ({ acting_as: 'guild_leader' as const, guild_key: row.guild_key, guild_name: row.guild_name })),
    can_release: detail.claim?.reviewer_user_id === actor.user_id,
  };
}

export async function listGuildReviews(pool: Pool, actor: Actor, filter: string, limit: number, offset: number) {
  const queue = z.enum(MEMBER_FILTERS).parse(filter);
  return transaction(pool, async q => {
    await activeMember(q, actor);
    const guilds = await requireLeader(q, actor);
    const keys = guilds.map(guild => guild.guild_key);
    const order = queue === 'awaiting_review' ? 'p.head_observed_at ASC, p.pull_id' : 'p.github_updated_at DESC, p.pull_id';
    const rows = await q.query(
      `SELECT ${PULL_LIST_COLUMNS} ${PULL_LIST_JOINS}
       WHERE r.community_id=$1 AND ${VISIBLE}
         AND (($3='open' AND p.state='open')
           OR ($3='mine' AND active_claim.reviewer_user_id=$6::uuid)
           OR ($3 NOT IN ('open','mine') AND p.queue_state=$3))
       ORDER BY ${order} LIMIT $4 OFFSET $5`,
      [actor.community_id, keys, queue, limit + 1, offset, actor.user_id],
    );
    return {
      guilds, viewer: viewer(await githubLogin(q, actor)),
      items: rows.rows.slice(0, limit).map(presentListRow),
      next_offset: rows.rows.length > limit ? offset + limit : null,
    };
  });
}

export async function guildReviewPull(pool: Pool, actor: Actor, id: string) {
  z.uuid().parse(id);
  return transaction(pool, async q => {
    await activeMember(q, actor);
    const guilds = await requireLeader(q, actor);
    return memberDetail(q, actor, await visiblePull(q, actor, id, guilds));
  });
}

async function memberWrite<T>(pool: Pool, input: Command, authorize: (q: PoolClient) => Promise<unknown>, run: (q: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await command(pool, input, authorize, run);
  } catch (error) {
    if (pgCode(error) === '40P01') throw new Problem(409, 'maintainer_write_conflict', WRITE_CONFLICT);
    throw error;
  }
}

export async function claimGuildReview(pool: Pool, input: Command, id: string) {
  z.uuid().parse(id);
  const body = z.object({ guild_key: guildKeySchema.optional() }).strict().parse(input.body);
  return memberWrite(pool, input, async q => {
    const guilds = await requireLeader(q, input.actor);
    await visiblePull(q, input.actor, id, guilds);
  }, async q => {
    const guilds = await requireLeader(q, input.actor);
    const pull = await visiblePull(q, input.actor, id, guilds, true);
    checkVersion(String(pull.aggregate_version), input.expected);
    const login = await githubLogin(q, input.actor);
    if (!login) throw new Problem(409, 'maintainer_claim_identity_required', GITHUB_REQUIRED);
    const options = await leaderRows(q, input.actor, pull.repository_id);
    if (!options.length) throw new Problem(403, 'maintainer_guild_scope', GUILD_SCOPE);
    const chosen = body.guild_key
      ? options.find(option => option.guild_key === body.guild_key)
      : options.length === 1 ? options[0] : undefined;
    if (!body.guild_key && options.length > 1) throw new Problem(422, 'maintainer_guild_required', GUILD_REQUIRED);
    if (!chosen) throw new Problem(403, 'maintainer_guild_scope', GUILD_SCOPE);
    assertPullClaimable(pull);
    requireCondition(chosen.github_user_id !== pull.author_github_id, 409, 'maintainer_claim_author', CLAIM_AUTHOR);
    const now = new Date();
    await openReviewClaim(q, pull, {
      user_id: chosen.user_id, github_user_id: chosen.github_user_id, github_login: chosen.github_login,
      acting_as: 'guild_leader', guild_key: chosen.guild_key,
    }, { admin_id: null, user_id: input.actor.user_id }, 'self', null, now);
    await rederivePull(q, id, now);
    return memberDetail(q, input.actor, await visiblePull(q, input.actor, id, guilds));
  });
}

export async function releaseGuildReview(pool: Pool, input: Command, claimId: string) {
  z.uuid().parse(claimId);
  z.object({}).strict().parse(input.body);
  return memberWrite(pool, input, async q => { await requireLeader(q, input.actor); }, async q => {
    const guilds = await requireLeader(q, input.actor);
    const preview = (await q.query(
      `SELECT c.pull_id FROM maintainer_review_claims c
       JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id
       JOIN maintainer_repositories r ON r.repository_id=p.repository_id
       WHERE c.claim_id=$1 AND r.community_id=$2`,
      [claimId, input.actor.community_id],
    )).rows[0] as { pull_id: string } | undefined;
    if (!preview) throw new Problem(404, 'maintainer_claim_not_found', CLAIM_MISSING);
    try {
      await visiblePull(q, input.actor, preview.pull_id, guilds, true);
    } catch (error) {
      if (error instanceof Problem && error.code === 'maintainer_pull_not_found') throw new Problem(404, 'maintainer_claim_not_found', CLAIM_MISSING);
      throw error;
    }
    const claim = (await q.query(
      `SELECT c.claim_id, c.pull_id, c.reviewer_user_id, c.state, c.aggregate_version, c.github_request_state, p.repository_id
       FROM maintainer_review_claims c
       JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id
       WHERE c.claim_id=$1 FOR UPDATE OF c`,
      [claimId],
    )).rows[0] as { claim_id: string; pull_id: string; reviewer_user_id: string; state: string; aggregate_version: string; github_request_state: string; repository_id: string };
    if (claim.reviewer_user_id !== input.actor.user_id) throw new Problem(403, 'maintainer_claim_not_yours', NOT_YOURS);
    requireCondition(claim.state === 'active', 409, 'maintainer_claim_inactive', CLAIM_INACTIVE);
    checkVersion(String(claim.aggregate_version), input.expected);
    const now = new Date();
    const updated = (await q.query(
      `UPDATE maintainer_review_claims
       SET state='released', end_reason='self_released', ended_at=$2,
         github_request_state=CASE WHEN github_request_state='requested' THEN 'removing' ELSE github_request_state END,
         aggregate_version=aggregate_version+1
       WHERE claim_id=$1 AND state='active' AND reviewer_user_id=$3
       RETURNING github_request_state`,
      [claimId, now, input.actor.user_id],
    )).rows[0];
    requireCondition(updated, 409, 'maintainer_claim_inactive', CLAIM_INACTIVE);
    if (updated.github_request_state === 'removing') await enqueueMaintainerJob(q, claim.repository_id, 'remove_reviewer_request', claimId, now);
    await rederivePull(q, claim.pull_id, now);
    return memberDetail(q, input.actor, await visiblePull(q, input.actor, claim.pull_id, guilds));
  });
}
