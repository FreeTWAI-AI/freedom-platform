import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import {
  buildHandoffTask, handoffCommand, handoffFileName, HandoffTaskError,
  type HandoffActor, type HandoffCli, type HandoffKind, type HandoffObserved,
} from './handoff-task.js';
import { resolveSettings } from './policy.js';
import {
  assemblePullDetail, HANDOFF_HEAD_MOVED, HANDOFF_MERGE_UNAVAILABLE, HANDOFF_PULL_UNAVAILABLE,
  HANDOFF_REPO_UNAVAILABLE, pullHandoffAvailability, type ClaimIdentity,
} from './records.js';
import { skillBookTitle } from './skill-books.js';

export const HANDOFF_BODY_INVALID = '交接的內容不符合格式。';
const AUDIT_REASON = '產生本機 AI 交接任務。';

const cliSchema = z.enum(['claude', 'codex', 'grok']);
export const pullHandoffSchema = z.object({
  kind: z.enum(['fix', 'merge']),
  cli: cliSchema,
  expected_head_sha: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();
export const issueHandoffSchema = z.object({
  issue_number: z.number().int().min(1).max(1_000_000_000),
  cli: cliSchema,
}).strict();

export type PullHandoffBody = z.infer<typeof pullHandoffSchema>;
export type IssueHandoffBody = z.infer<typeof issueHandoffSchema>;

export function parsePullHandoff(body: unknown): PullHandoffBody {
  const parsed = pullHandoffSchema.safeParse(body);
  if (!parsed.success) throw new Problem(400, 'validation_failed', HANDOFF_BODY_INVALID);
  return parsed.data;
}
export function parseIssueHandoff(body: unknown): IssueHandoffBody {
  const parsed = issueHandoffSchema.safeParse(body);
  if (!parsed.success) throw new Problem(400, 'validation_failed', HANDOFF_BODY_INVALID);
  return parsed.data;
}

type IdentityRow = ClaimIdentity & { guild_name?: string | null };

export function pickHandoffIdentity<T extends { acting_as: 'guild_leader' | 'skill_book_maintainer'; guild_key: string | null; guild_name: string | null; skill_book_id: string | null }>(options: T[]): T | undefined {
  if (!options.length) return undefined;
  return [...options].sort((left, right) => {
    const rank = (row: T) => row.acting_as === 'guild_leader' ? 0 : 1;
    const byRank = rank(left) - rank(right);
    if (byRank) return byRank;
    const label = (row: T) => row.acting_as === 'guild_leader'
      ? (row.guild_name ?? row.guild_key ?? '')
      : (skillBookTitle(row.skill_book_id) ?? row.skill_book_id ?? '');
    const byName = label(left).localeCompare(label(right), 'zh-Hant');
    if (byName) return byName;
    return (left.guild_key ?? left.skill_book_id ?? '').localeCompare(right.guild_key ?? right.skill_book_id ?? '', 'zh-Hant');
  })[0];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function reasons(value: unknown): Array<{ code: string; message: string; paths?: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { code?: unknown; message?: unknown; paths?: unknown };
    if (typeof row.code !== 'string') return [];
    return [{
      code: row.code,
      message: typeof row.message === 'string' ? row.message : '',
      paths: Array.isArray(row.paths) ? row.paths.filter((path): path is string => typeof path === 'string') : [],
    }];
  });
}

function actorFrom(reviewer: IdentityRow, names: { guild_name: string | null; skill_book_title: string | null }): HandoffActor {
  return {
    github_login: reviewer.github_login,
    acting_as: reviewer.acting_as,
    guild_key: reviewer.guild_key,
    guild_name: names.guild_name,
    skill_book_id: reviewer.skill_book_id,
    skill_book_title: names.skill_book_title,
  };
}

function observedFrom(detail: Awaited<ReturnType<typeof assemblePullDetail>>, head: string): HandoffObserved {
  return {
    number: Number(detail.number),
    title: String(detail.title ?? ''),
    head_sha: head,
    queue_state: String(detail.queue_state),
    queue_reasons: reasons(detail.queue_reasons),
    author_login: String(detail.author_login ?? ''),
    labels: strings(detail.labels),
    attention_reasons: reasons(detail.attention_reasons),
    checks: detail.checks.filter(check => check.head_sha === head).map(check => ({
      name: String(check.name ?? ''),
      status: String(check.status ?? ''),
      conclusion: check.conclusion == null ? null : String(check.conclusion),
      app_slug: check.app_slug == null ? null : String(check.app_slug),
    })),
    files: detail.files.map(file => ({
      path: String(file.path), status: String(file.status), additions: Number(file.additions), deletions: Number(file.deletions),
    })),
    reviews: detail.reviews.map(review => ({
      login: String(review.reviewer_login ?? ''),
      state: String(review.state ?? ''),
      commit_id: review.commit_id == null ? null : String(review.commit_id),
      submitted_at: review.submitted_at == null ? null : String(review.submitted_at),
      counts_as_valid: review.counts_as_valid === true,
    })),
  };
}

export type HandoffResponse = {
  handoff_id: string;
  kind: HandoffKind;
  cli: HandoffCli;
  file_name: string;
  command: string;
  markdown: string;
  created_at: string;
};

function responseOf(id: string, kind: HandoffKind, cli: HandoffCli, markdown: string, now: Date): HandoffResponse {
  const file_name = handoffFileName(id);
  return { handoff_id: id, kind, cli, file_name, command: handoffCommand(cli, file_name), markdown, created_at: now.toISOString() };
}

function guardTask(run: () => string): string {
  try {
    return run();
  } catch (error) {
    if (error instanceof HandoffTaskError) throw new Problem(409, 'maintainer_handoff_unavailable', '這筆交接的資料無法寫進任務檔。');
    throw error;
  }
}

export async function recordPullHandoff(
  q: PoolClient,
  pull: Record<string, any>,
  reviewer: IdentityRow,
  names: { guild_name: string | null; skill_book_title: string | null },
  body: PullHandoffBody,
  requestedByAdmin: string | null,
  now = new Date(),
): Promise<HandoffResponse> {
  const availability = pullHandoffAvailability(pull);
  requireCondition(availability.allowed, 409, 'maintainer_handoff_unavailable', HANDOFF_PULL_UNAVAILABLE);
  requireCondition(pull.head_sha === body.expected_head_sha, 409, 'maintainer_head_moved', HANDOFF_HEAD_MOVED);
  if (body.kind === 'merge') requireCondition(pull.queue_state === 'ready', 409, 'maintainer_handoff_merge_unavailable', HANDOFF_MERGE_UNAVAILABLE);
  const detail = await assemblePullDetail(q, pull, false);
  const settings = resolveSettings(String(pull.full_name), pull.settings);
  const id = randomUUID();
  const markdown = guardTask(() => buildHandoffTask({
    id, now, kind: body.kind,
    repository: { full_name: String(pull.full_name), default_branch: pull.default_branch == null ? null : String(pull.default_branch) },
    actor: actorFrom(reviewer, names),
    pull: observedFrom(detail, String(pull.head_sha)),
    settings,
  }));
  await q.query(
    `INSERT INTO maintainer_handoffs (
       handoff_id, repository_id, pull_id, issue_number, kind, cli, head_sha,
       user_id, github_user_id, github_login, acting_as, guild_key, skill_book_id,
       requested_by_admin, task_markdown, created_at)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, pull.repository_id, pull.pull_id, body.kind, body.cli, pull.head_sha,
      reviewer.user_id, reviewer.github_user_id, reviewer.github_login, reviewer.acting_as, reviewer.guild_key, reviewer.skill_book_id,
      requestedByAdmin, markdown, now],
  );
  return responseOf(id, body.kind, body.cli, markdown, now);
}

export async function recordIssueHandoff(
  q: PoolClient,
  repository: { repository_id: string; full_name: string; default_branch: string | null; installation_state: string; mode: string },
  reviewer: IdentityRow,
  names: { guild_name: string | null; skill_book_title: string | null },
  body: IssueHandoffBody,
  requestedByAdmin: string | null,
  now = new Date(),
): Promise<HandoffResponse> {
  requireCondition(repository.installation_state === 'active' && repository.mode !== 'off', 409, 'maintainer_handoff_unavailable', HANDOFF_REPO_UNAVAILABLE);
  const id = randomUUID();
  const markdown = guardTask(() => buildHandoffTask({
    id, now, kind: 'issue',
    repository: { full_name: repository.full_name, default_branch: repository.default_branch },
    actor: actorFrom(reviewer, names),
    issue_number: body.issue_number,
  }));
  await q.query(
    `INSERT INTO maintainer_handoffs (
       handoff_id, repository_id, pull_id, issue_number, kind, cli, head_sha,
       user_id, github_user_id, github_login, acting_as, guild_key, skill_book_id,
       requested_by_admin, task_markdown, created_at)
     VALUES ($1,$2,NULL,$3,'issue',$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, repository.repository_id, body.issue_number, body.cli,
      reviewer.user_id, reviewer.github_user_id, reviewer.github_login, reviewer.acting_as, reviewer.guild_key, reviewer.skill_book_id,
      requestedByAdmin, markdown, now],
  );
  return responseOf(id, 'issue', body.cli, markdown, now);
}

export const HANDOFF_AUDIT_REASON = AUDIT_REASON;
