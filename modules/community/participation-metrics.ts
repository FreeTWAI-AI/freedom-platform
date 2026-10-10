import type { Pool } from 'pg';
import { z } from 'zod';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { communitySearchKinds } from '../../packages/shared/community-search.js';
import type { Actor } from '../identity-membership/service.js';

// Versioned so a changed definition never silently rewrites an older report.
export const PARTICIPATION_METRICS_VERSION = 'participation-metrics/v2';
export const MIN_SAMPLE = 10;
const TIME_ZONE = 'Asia/Taipei';

const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const at = Date.parse(value + 'T00:00:00Z');
  return Number(value.slice(0, 4)) >= 1 && Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}, '日期必須是有效的 YYYY-MM-DD。');
const rangeInput = z.object({ from: dateText.optional(), to: dateText.optional() }).strict();

export const metricsDefinition = {
  version: PARTICIPATION_METRICS_VERSION,
  time_zone: TIME_ZONE,
  min_sample: MIN_SAMPLE,
  cohorts: 'Cohorts are assigned by Asia/Taipei calendar day of the starting event. A member or post only enters the denominator once its full observation window has elapsed; the rest is reported as pending_window.',
  exclusions: ['verification/test accounts (author and responder)', 'members who joined on the launch-day backfill', 'authors replying to themselves', 'inactive or other-community responders', 'removed, hidden or deleted posts/comments'],
  metrics: {
    registration_first_share_7d: 'Registered members whose first share (active native post, published showcase or published skill submission) happens within 7 days of registration.',
    registration_first_comment_7d: 'Registered members whose first native comment happens within 7 days of registration.',
    post_human_reply_48h: 'Active native posts that received an active comment from a different, active, non-test member of the same community within 48 hours. This is a reproducible proxy, not a quality judgement.',
    first_share_return_7d: 'Participation-return proxy: members whose first share is in range and who subsequently post, comment, publish a showcase/skill or search on a later Taipei calendar day within 7 days. Uses event timestamps, never mutable session last-seen; not all visits. Removing source facts can change recomputation.',
    search_zero_result: 'Search page reads that returned no readable result, over all recorded non-test search page reads; excluded_test_accounts counts distinct excluded actors and excluded_search_reads counts excluded reads.',
    search_open: 'Search page reads with at least one result in which a result was opened, over non-test page reads with results; exclusion counts are restricted to reads with results.',
    moderation_case_time: 'Not yet measured: reporting case processing time is not instrumented.',
  },
} as const;

type Admin = { community_id: string };
type Rate = { numerator: number; denominator: number; pending_window: number; rate: number | null; status: 'ok' | 'insufficient_sample' };

function rate(numerator: number, denominator: number, pending: number): Rate {
  const enough = denominator >= MIN_SAMPLE;
  return { numerator, denominator, pending_window: pending, rate: enough ? Math.round(numerator / denominator * 10000) / 10000 : null, status: enough ? 'ok' : 'insufficient_sample' };
}

function taipeiToday(now: Date) { return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now); }
function addDays(day: string, days: number) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

// One CTE shared by registration and return metrics: the first time a member shared anything.
// Current visibility remains authoritative; journal times describe publication
// events, not permission. Legacy rows without a matching event retain their
// recorded consent time. A later consent must never replace valid history.
const firstShare = `showcase_publications AS (
  SELECT s.owner_ref AS user_id, COALESCE(j.created_at,s.consent_recorded_at) AS at
  FROM showcases s LEFT JOIN transition_journal j ON j.community_id=s.community_id
    AND j.aggregate_type='showcase' AND j.aggregate_id=s.showcase_id
    AND j.actor_ref=s.owner_ref AND j.command='share_with_community'
  WHERE s.community_id=$1 AND s.status='published' AND s.consent_recorded_at IS NOT NULL
), first_share AS (
  SELECT user_id, min(at) AS at FROM (
    SELECT author_user_id AS user_id, created_at AS at FROM community_social_posts WHERE community_id=$1 AND state='active'
    UNION ALL SELECT user_id, at FROM showcase_publications
    UNION ALL SELECT owner_ref, published_at FROM skill_submissions WHERE community_id=$1 AND status='published' AND published_at IS NOT NULL
  ) facts GROUP BY user_id)`;

export async function participationMetrics(pool: Pool, admin: Admin, rawRange: unknown, now = new Date()) {
  const range = rangeInput.parse(rawRange ?? {});
  const to = range.to ?? taipeiToday(now);
  const from = range.from ?? (to < '0001-01-28' ? '0001-01-01' : addDays(to, -27));
  requireCondition(from <= to, 422, 'invalid_range', '起始日不可晚於結束日。');
  requireCondition(Date.parse(to) - Date.parse(from) <= 365 * 86400000, 422, 'invalid_range', '一次最多查詢 366 天。');
  const start = `(($2::date)::timestamp AT TIME ZONE '${TIME_ZONE}')`, end = `((($3::date)+1)::timestamp AT TIME ZONE '${TIME_ZONE}')`;
  const args = [admin.community_id, from, to, now];
  const q = async (sql: string, withNow = true) => (await pool.query(sql, withNow ? args : args.slice(0, 3))).rows[0] as Record<string, string | null>;
  const n = (value: unknown) => Number(value ?? 0);

  const registered = await q(`WITH ${firstShare},
    first_comment AS (SELECT c.author_user_id AS user_id, min(c.created_at) AS at FROM community_social_comments c
      JOIN community_social_posts p ON p.post_id=c.post_id AND p.community_id=c.community_id
      WHERE c.community_id=$1 AND c.state='active' AND p.state='active' GROUP BY 1),
    cohort AS (SELECT u.user_id, u.created_at FROM users u WHERE u.community_id=$1 AND u.created_at_source='registered'
      AND u.created_at >= ${start} AND u.created_at < ${end} AND NOT is_verification_test_account(u.user_id))
    SELECT
      count(*) FILTER (WHERE c.created_at + interval '7 days' <= $4::timestamptz) AS denominator,
      count(*) FILTER (WHERE c.created_at + interval '7 days' > $4::timestamptz) AS pending,
      count(*) FILTER (WHERE c.created_at + interval '7 days' <= $4::timestamptz AND s.at <= c.created_at + interval '7 days' AND s.at >= c.created_at) AS shared,
      count(*) FILTER (WHERE c.created_at + interval '7 days' <= $4::timestamptz AND m.at <= c.created_at + interval '7 days' AND m.at >= c.created_at) AS commented,
      (SELECT count(*) FROM users u WHERE u.community_id=$1 AND u.created_at_source='registered' AND u.created_at >= ${start} AND u.created_at < ${end} AND is_verification_test_account(u.user_id)) AS excluded_test_accounts
    FROM cohort c LEFT JOIN first_share s ON s.user_id=c.user_id LEFT JOIN first_comment m ON m.user_id=c.user_id`);

  const posts = await q(`WITH cohort AS (
      SELECT p.post_id, p.author_user_id, p.created_at FROM community_social_posts p JOIN users a ON a.user_id=p.author_user_id AND a.community_id=p.community_id
      WHERE p.community_id=$1 AND p.state='active' AND a.active AND p.created_at >= ${start} AND p.created_at < ${end} AND NOT is_verification_test_account(p.author_user_id))
    SELECT
      count(*) FILTER (WHERE c.created_at + interval '48 hours' <= $4::timestamptz) AS denominator,
      count(*) FILTER (WHERE c.created_at + interval '48 hours' > $4::timestamptz) AS pending,
      count(*) FILTER (WHERE c.created_at + interval '48 hours' <= $4::timestamptz AND EXISTS (
        SELECT 1 FROM community_social_comments r JOIN users ru ON ru.user_id=r.author_user_id AND ru.community_id=r.community_id
        WHERE r.post_id=c.post_id AND r.community_id=$1 AND r.state='active' AND r.author_user_id<>c.author_user_id AND ru.active
          AND NOT is_verification_test_account(r.author_user_id) AND r.created_at >= c.created_at AND r.created_at <= c.created_at + interval '48 hours')) AS replied,
      (SELECT count(*) FROM community_social_posts p WHERE p.community_id=$1 AND p.state='active' AND p.created_at >= ${start} AND p.created_at < ${end} AND is_verification_test_account(p.author_user_id)) AS excluded_test_accounts
    FROM cohort c`);

  const returns = await q(`WITH ${firstShare},
    activity AS (
      SELECT author_user_id AS user_id, created_at AS at FROM community_social_posts WHERE community_id=$1 AND state='active'
      UNION ALL SELECT c.author_user_id, c.created_at FROM community_social_comments c
        JOIN community_social_posts p ON p.post_id=c.post_id AND p.community_id=c.community_id
        WHERE c.community_id=$1 AND c.state='active' AND p.state='active'
      UNION ALL SELECT user_id, at FROM showcase_publications
      UNION ALL SELECT owner_ref, published_at FROM skill_submissions WHERE community_id=$1 AND status='published'
      UNION ALL SELECT user_id, searched_at FROM community_search_operations WHERE community_id=$1
    ),
    cohort AS (SELECT s.user_id, s.at FROM first_share s JOIN users u ON u.user_id=s.user_id AND u.community_id=$1
      WHERE s.at >= ${start} AND s.at < ${end} AND NOT is_verification_test_account(s.user_id))
    SELECT
      count(*) FILTER (WHERE at + interval '7 days' <= $4::timestamptz) AS denominator,
      count(*) FILTER (WHERE at + interval '7 days' > $4::timestamptz) AS pending,
      count(*) FILTER (WHERE at + interval '7 days' <= $4::timestamptz AND EXISTS (
        SELECT 1 FROM activity x WHERE x.user_id=cohort.user_id
          AND x.at >= ((((cohort.at AT TIME ZONE '${TIME_ZONE}')::date + 1)::timestamp) AT TIME ZONE '${TIME_ZONE}')
          AND x.at <= cohort.at + interval '7 days')) AS returned
    FROM cohort`);

  const search = await q(`WITH scoped AS (
      SELECT *, is_verification_test_account(user_id) AS synthetic FROM community_search_operations
      WHERE community_id=$1 AND searched_at >= ${start} AND searched_at < ${end})
    SELECT count(*) FILTER (WHERE NOT synthetic) AS reads,
      count(*) FILTER (WHERE NOT synthetic AND result_count=0) AS zero,
      count(*) FILTER (WHERE NOT synthetic AND result_count>0) AS with_results,
      count(*) FILTER (WHERE NOT synthetic AND opened_at IS NOT NULL) AS opened,
      count(DISTINCT user_id) FILTER (WHERE synthetic) AS excluded_accounts,
      count(DISTINCT user_id) FILTER (WHERE synthetic AND result_count>0) AS excluded_result_accounts,
      count(*) FILTER (WHERE synthetic) AS excluded_reads,
      count(*) FILTER (WHERE synthetic AND result_count>0) AS excluded_result_reads
    FROM scoped`, false);

  return {
    definition: metricsDefinition,
    community_id: admin.community_id,
    range: { from, to },
    generated_at: now.toISOString(),
    freshness: 'recomputed from current authoritative records on every read',
    metrics: {
      registration_first_share_7d: { ...rate(n(registered.shared), n(registered.denominator), n(registered.pending)), excluded_test_accounts: n(registered.excluded_test_accounts) },
      registration_first_comment_7d: { ...rate(n(registered.commented), n(registered.denominator), n(registered.pending)), excluded_test_accounts: n(registered.excluded_test_accounts) },
      post_human_reply_48h: { ...rate(n(posts.replied), n(posts.denominator), n(posts.pending)), excluded_test_accounts: n(posts.excluded_test_accounts) },
      first_share_return_7d: rate(n(returns.returned), n(returns.denominator), n(returns.pending)),
      search_zero_result: { ...rate(n(search.zero), n(search.reads), 0), excluded_test_accounts: n(search.excluded_accounts), excluded_search_reads: n(search.excluded_reads) },
      search_open: { ...rate(n(search.opened), n(search.with_results), 0), excluded_test_accounts: n(search.excluded_result_accounts), excluded_search_reads: n(search.excluded_result_reads) },
      moderation_case_time: { status: 'not_available', reason: 'reporting case processing time is not yet instrumented' },
    },
  };
}

export async function recordSearchOperation(pool: Pool, actor: Actor, input: { first_page: boolean; result_count: number }) {
  const count = Math.min(Math.max(Math.trunc(input.result_count), 0), 100);
  const row = (await pool.query('INSERT INTO community_search_operations(community_id,user_id,first_page,result_count) VALUES($1,$2,$3,$4) RETURNING operation_id', [actor.community_id, actor.user_id, input.first_page, count])).rows[0];
  return String(row.operation_id);
}

const openInput = z.object({ kind: z.enum(communitySearchKinds) }).strict();
export async function markSearchOpened(pool: Pool, actor: Actor, operationId: string, rawBody: unknown) {
  requireCondition(z.uuid().safeParse(operationId).success, 404, 'not_found', '找不到這次搜尋。');
  const body = openInput.parse(rawBody);
  const result = await pool.query(
    `UPDATE community_search_operations SET opened_at=now(), opened_kind=$4 WHERE operation_id=$1 AND community_id=$2 AND user_id=$3 AND result_count>0 AND opened_at IS NULL`,
    [operationId, actor.community_id, actor.user_id, body.kind]);
  if (result.rowCount === 0) {
    // A repeat open is a no-op; anything not owned or without results is indistinguishable from missing.
    const owned = (await pool.query('SELECT 1 FROM community_search_operations WHERE operation_id=$1 AND community_id=$2 AND user_id=$3 AND result_count>0', [operationId, actor.community_id, actor.user_id])).rowCount;
    if (!owned) throw new Problem(404, 'not_found', '找不到這次搜尋。');
  }
  return { ok: true as const };
}
