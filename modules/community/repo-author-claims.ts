import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool, PoolClient} from 'pg';
import {command, journal, type Command} from '../../packages/db/index.js';
import {Problem, requireCondition} from '../../packages/shared/problem.js';
import {externalHttpsUrl, githubCoordinate, publicJson} from '../opensource-marketing/github.js';
import {adminCommand, audit, type AdminCommand} from '../platform-admin/service.js';
import {authRateLimit} from '../identity-membership/members.js';
import {communityCatalog, type SkillBook} from './catalog.js';

export const CLAIM_ROLES = ['original_author', 'co_original_author', 'maintainer'] as const;
export type ClaimRole = typeof CLAIM_ROLES[number];
export const CLAIM_STATES = ['pending', 'verified', 'rejected', 'withdrawn', 'disputed', 'revoked'] as const;
export type ClaimState = typeof CLAIM_STATES[number];
const ACTIVE = ['pending', 'verified', 'disputed'] as const;
const CACHE_MS = 24 * 60 * 60 * 1000;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;

export const ROLE_LABEL: Record<ClaimRole, string> = {
  original_author: '原創作者', co_original_author: '共同原創作者', maintainer: '維護者',
};
export const STATE_LABEL: Record<ClaimState, string> = {
  pending: '認領審核中', verified: '已核實', rejected: '未通過', withdrawn: '已撤回', disputed: '有爭議', revoked: '已撤銷',
};
export const PUBLIC_STATUS_LABEL = {
  unclaimed: '尚未認領',
  pending: '認領審核中',
  verified_original_author: '已核實原作者',
  verified_maintainer: '已核實維護者',
  disputed: '有爭議',
} as const;
export type PublicClaimStatus = keyof typeof PUBLIC_STATUS_LABEL;
export type PublicVerifiedPerson = {role: ClaimRole; role_label: string; github_login: string; display_name: string};
export type PublicAuthorClaim = {
  book_id: string; status: PublicClaimStatus; label: string;
  verified: PublicVerifiedPerson[]; attributed_author: string | null;
};

/** The only SQL the public skill page may run for claims. No private columns. */
export const PUBLIC_AUTHOR_CLAIM_SQL = `SELECT c.state, c.role, c.github_login, u.display_name FROM catalog_repo_observations o JOIN canonical_repositories r ON r.provider = o.provider AND r.provider_repo_id = o.provider_repo_id JOIN repo_credit_claims c ON c.repo_id = r.repo_id AND c.state IN ('pending', 'verified', 'disputed') JOIN users u ON u.user_id = c.user_id WHERE o.book_id = $1`;

const SubmitBody = z.object({
  role: z.enum(CLAIM_ROLES),
  evidence_url: z.union([z.string().trim().min(1).max(2000), z.null()]).optional(),
  statement: z.string().trim().min(10).max(1000),
  declared: z.literal(true),
}).strict();
const AppealBody = z.object({appeal: z.string().trim().min(10).max(1000)}).strict();
const ReviewBody = z.object({
  decision: z.enum(['verify', 'reject', 'dispute', 'revoke']),
  reason: z.string().trim().min(3).max(1000),
}).strict();
const ReasonBody = z.object({reason: z.string().trim().min(3).max(1000)}).strict();
const RepoBody = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  full_name: z.string().regex(namePattern),
  private: z.boolean(),
  visibility: z.string().optional(),
  fork: z.boolean().optional(),
  source: z.object({id: z.number().int().positive(), full_name: z.string()}).partial().optional(),
  parent: z.object({id: z.number().int().positive(), full_name: z.string()}).partial().optional(),
});

type ResolvedRepo = {id: string; full_name: string; url: string; source_repo_id: string | null; source_full_name: string | null};
type StatusRow = {state: string; role: string; github_login: string; display_name: string};

const roleOrder: Record<string, number> = {original_author: 0, co_original_author: 1, maintainer: 2};
export function authorClaimStatus(rows: StatusRow[]): Pick<PublicAuthorClaim, 'status' | 'label' | 'verified'> {
  const active = rows.filter(row => (ACTIVE as readonly string[]).includes(row.state));
  const verified = active.filter(row => row.state === 'verified').map(person).sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.github_login.localeCompare(b.github_login));
  if (active.some(row => row.state === 'disputed')) return {status: 'disputed', label: PUBLIC_STATUS_LABEL.disputed, verified};
  if (verified.some(row => row.role === 'original_author' || row.role === 'co_original_author')) return {status: 'verified_original_author', label: PUBLIC_STATUS_LABEL.verified_original_author, verified};
  const pending = active.some(row => row.state === 'pending');
  if (verified.some(row => row.role === 'maintainer') && !pending) return {status: 'verified_maintainer', label: PUBLIC_STATUS_LABEL.verified_maintainer, verified};
  if (pending) return {status: 'pending', label: PUBLIC_STATUS_LABEL.pending, verified};
  return {status: 'unclaimed', label: PUBLIC_STATUS_LABEL.unclaimed, verified: []};
}
function person(row: StatusRow): PublicVerifiedPerson {
  const role = row.role as ClaimRole;
  return {role, role_label: ROLE_LABEL[role], github_login: row.github_login, display_name: row.display_name};
}
function bookOrThrow(id: string): SkillBook {
  const book = communityCatalog.skill_books.find(item => item.id === id);
  requireCondition(book, 404, 'skill_book_not_found', '找不到這本技能書。');
  return book;
}
function upstreamCoordinate(book: SkillBook) {
  try { return githubCoordinate(book.upstream_url); }
  catch { throw new Problem(422, 'claim_repository_unavailable', '這本技能書的原作不是可認領的公開 GitHub Repo。'); }
}
function iso(value: unknown) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function duplicateClaim(error: unknown) {
  const pg = error as {code?: string; constraint?: string};
  return pg.code === '23505' && pg.constraint === 'repo_credit_claims_one_active_role';
}

async function resolvePublicRepo(coordinate: string, fetcher: typeof fetch): Promise<ResolvedRepo> {
  let raw: unknown;
  try { raw = await publicJson(`/repos/${coordinate}`, AbortSignal.timeout(8000), fetcher); }
  catch (error) {
    if (error instanceof Problem && (error.status === 503 || error.code === 'github_rate_limited')) {
      throw new Problem(503, error.code, '暫時無法向 GitHub 確認原作 Repo，申請尚未送出。請稍後再試。');
    }
    if (error instanceof Problem) throw new Problem(422, 'claim_repository_unavailable', '這本技能書的原作不是可認領的公開 GitHub Repo。');
    throw error;
  }
  const parsed = RepoBody.safeParse(raw);
  requireCondition(parsed.success, 422, 'claim_repository_unavailable', '這本技能書的原作不是可認領的公開 GitHub Repo。');
  const visibility = parsed.data.visibility ?? (parsed.data.private ? 'private' : 'public');
  requireCondition(!parsed.data.private && visibility === 'public', 422, 'claim_repository_unavailable', '只能認領可公開讀取的 GitHub 原作 Repo。');
  const source = parsed.data.fork ? (parsed.data.source?.id ? parsed.data.source : parsed.data.parent) : undefined;
  return {
    id: String(parsed.data.id), full_name: parsed.data.full_name, url: `https://github.com/${parsed.data.full_name}`,
    source_repo_id: source?.id ? String(source.id) : null, source_full_name: source?.full_name ?? null,
  };
}

async function upsertCanonical(q: PoolClient, repo: ResolvedRepo) {
  return (await q.query(`INSERT INTO canonical_repositories (repo_id, provider, provider_repo_id, full_name, current_url, source_repo_id, source_full_name, observed_at)
    VALUES ($1,'github',$2,$3,$4,$5,$6,now())
    ON CONFLICT (provider, provider_repo_id) DO UPDATE SET full_name=EXCLUDED.full_name, current_url=EXCLUDED.current_url,
      source_repo_id=EXCLUDED.source_repo_id, source_full_name=EXCLUDED.source_full_name, observed_at=now()
    RETURNING *`, [randomUUID(), repo.id, repo.full_name, repo.url, repo.source_repo_id, repo.source_full_name])).rows[0];
}

/** Resolve and cache the catalog upstream by provider id. Claims are never moved when the id changes. */
export async function observeCatalogRepo(q: PoolClient, book: SkillBook, fetcher: typeof fetch, options: {force: boolean; actorUserId?: string; actorAdminId?: string}) {
  const coordinate = upstreamCoordinate(book);
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog-repo/${book.id}`]);
  const existing = (await q.query('SELECT * FROM catalog_repo_observations WHERE book_id=$1 FOR UPDATE', [book.id])).rows[0];
  const fresh = existing && String(existing.requested_full_name).toLowerCase() === coordinate.toLowerCase() && Date.now() - new Date(existing.observed_at).getTime() < CACHE_MS;
  if (fresh && !options.force) {
    const canonical = (await q.query('SELECT * FROM canonical_repositories WHERE provider=$1 AND provider_repo_id=$2', ['github', existing.provider_repo_id])).rows[0];
    requireCondition(canonical, 503, 'github_unavailable', '暫時無法向 GitHub 確認原作 Repo，申請尚未送出。請稍後再試。');
    return {observation: existing, canonical, fetched: false as const};
  }
  const resolved = await resolvePublicRepo(coordinate, fetcher);
  const canonical = await upsertCanonical(q, resolved);
  const observation = (await q.query(`INSERT INTO catalog_repo_observations
    (book_id, provider, provider_repo_id, requested_full_name, full_name, current_url, source_repo_id, previous_provider_repo_id, needs_recheck, observed_at)
    VALUES ($1,'github',$2,$3,$4,$5,$6,NULL,false,now())
    ON CONFLICT (book_id) DO UPDATE SET provider=EXCLUDED.provider, provider_repo_id=EXCLUDED.provider_repo_id,
      requested_full_name=EXCLUDED.requested_full_name, full_name=EXCLUDED.full_name, current_url=EXCLUDED.current_url,
      source_repo_id=EXCLUDED.source_repo_id,
      previous_provider_repo_id=CASE WHEN catalog_repo_observations.provider_repo_id IS DISTINCT FROM EXCLUDED.provider_repo_id THEN catalog_repo_observations.provider_repo_id ELSE catalog_repo_observations.previous_provider_repo_id END,
      needs_recheck=CASE WHEN catalog_repo_observations.provider_repo_id IS DISTINCT FROM EXCLUDED.provider_repo_id THEN true ELSE catalog_repo_observations.needs_recheck END,
      observed_at=now()
    RETURNING *`, [book.id, resolved.id, coordinate, resolved.full_name, resolved.url, resolved.source_repo_id])).rows[0];
  if (existing && existing.provider_repo_id !== resolved.id) {
    requireCondition(Boolean(options.actorUserId || options.actorAdminId), 500, 'internal_error', '操作未完成，請重新整理並查看目前狀態。');
    await q.query(`INSERT INTO catalog_repo_identity_events (event_id, book_id, provider, previous_provider_repo_id, provider_repo_id, full_name, actor_user_id, actor_admin_id, action)
      VALUES ($1,$2,'github',$3,$4,$5,$6,$7,'identity_changed')`, [randomUUID(), book.id, existing.provider_repo_id, resolved.id, resolved.full_name, options.actorUserId ?? null, options.actorAdminId ?? null]);
  }
  return {observation, canonical, fetched: true as const};
}

function publicFromRows(book: SkillBook, rows: StatusRow[]): PublicAuthorClaim {
  return {book_id: book.id, ...authorClaimStatus(rows), attributed_author: book.guide?.author_name ?? null};
}
export async function publicAuthorClaimForBook(pool: Pool, bookId: string): Promise<PublicAuthorClaim> {
  const book = bookOrThrow(bookId);
  const rows = (await pool.query(PUBLIC_AUTHOR_CLAIM_SQL, [book.id])).rows as StatusRow[];
  return publicFromRows(book, rows);
}
export async function publicAuthorClaims(pool: Pool) {
  const rows = (await pool.query(`SELECT o.book_id, c.state, c.role, c.github_login, u.display_name
    FROM catalog_repo_observations o
    JOIN canonical_repositories r ON r.provider=o.provider AND r.provider_repo_id=o.provider_repo_id
    JOIN repo_credit_claims c ON c.repo_id=r.repo_id AND c.state IN ('pending','verified','disputed')
    JOIN users u ON u.user_id=c.user_id`)).rows as (StatusRow & {book_id: string})[];
  const grouped = new Map<string, StatusRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.book_id) ?? [];
    list.push(row);
    grouped.set(row.book_id, list);
  }
  return {items: communityCatalog.skill_books.map(book => publicFromRows(book, grouped.get(book.id) ?? []))};
}

function memberClaim(row: any) {
  const state = row.state as ClaimState, role = row.role as ClaimRole;
  return {
    claim_id: row.claim_id, role, role_label: ROLE_LABEL[role], state, state_label: STATE_LABEL[state],
    evidence_url: row.evidence_url, statement: row.statement, appeal_text: row.appeal_text, reason: row.reason,
    version: Number(row.version), appeal_count: Number(row.appeal_count),
    submitted_at: iso(row.submitted_at), reviewed_at: iso(row.reviewed_at),
    github_login: row.github_login, github_user_id: row.github_user_id,
    can_withdraw: state === 'pending', can_appeal: (state === 'rejected' || state === 'revoked') && Number(row.appeal_count) === 0,
    repo: {provider: 'github', provider_repo_id: row.provider_repo_id, full_name: row.full_name, current_url: row.current_url},
  };
}
export async function memberAuthorClaim(pool: Pool, actor: Command['actor'], bookId: string) {
  const book = bookOrThrow(bookId);
  const github = (await pool.query('SELECT github_user_id, github_login FROM github_social_connections WHERE user_id=$1 AND community_id=$2', [actor.user_id, actor.community_id])).rows[0];
  const claims = (await pool.query(`SELECT c.*, r.provider_repo_id, r.full_name, r.current_url
    FROM repo_credit_claims c JOIN canonical_repositories r ON r.repo_id=c.repo_id
    WHERE c.community_id=$1 AND c.user_id=$2 AND c.source_snapshot->>'book_id'=$3
    ORDER BY c.submitted_at, c.claim_id`, [actor.community_id, actor.user_id, book.id])).rows;
  const visible = claims.length ? claims : [];
  const status = await publicAuthorClaimForBook(pool, book.id);
  return {book_id: book.id, github_connected: Boolean(github), github_login: github?.github_login ?? null, public: status, claims: visible.map(memberClaim)};
}

async function recordEvent(q: PoolClient, claim: {claim_id: string; community_id: string}, action: string, previous: string | null, next: string, reason: string | null, actor: {user_id?: string; admin_id?: string}) {
  await q.query(`INSERT INTO repo_credit_claim_events (event_id, claim_id, community_id, actor_user_id, actor_admin_id, action, previous_state, new_state, reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), claim.claim_id, claim.community_id, actor.user_id ?? null, actor.admin_id ?? null, action, previous, next, reason]);
}
function requireClaimVersion(actual: number, expected?: string) {
  requireCondition(expected, 428, 'version_required', '請提供 If-Match 版本。');
  requireCondition(String(actual) === expected, 409, 'claim_version_conflict', '這筆認領已更新，請重新整理後再操作。');
}

export async function submitAuthorClaim(pool: Pool, input: Command, bookId: string, fetcher: typeof fetch) {
  const book = bookOrThrow(bookId);
  upstreamCoordinate(book);
  const body = SubmitBody.parse(input.body);
  const evidence = body.evidence_url ? externalHttpsUrl(body.evidence_url) : null;
  await authRateLimit(pool, 'repo-claim-member', input.actor.user_id, 12, 3600);
  await authRateLimit(pool, 'repo-claim-global', 'global', 300, 3600);
  return command(pool, input, async () => undefined, async q => {
    const github = (await q.query('SELECT github_user_id, github_login FROM github_social_connections WHERE user_id=$1 AND community_id=$2 FOR SHARE', [input.actor.user_id, input.actor.community_id])).rows[0];
    requireCondition(github, 409, 'github_link_required', '請先連結 GitHub 帳號，再認領原作。');
    const observed = await observeCatalogRepo(q, book, fetcher, {force: false, actorUserId: input.actor.user_id});
    const repoId = observed.canonical.repo_id as string;
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`repo-claim/${repoId}/${input.actor.user_id}/${body.role}`]);
    const active = await q.query(`SELECT 1 FROM repo_credit_claims WHERE repo_id=$1 AND user_id=$2 AND role=$3 AND state IN ('pending','verified','disputed')`, [repoId, input.actor.user_id, body.role]);
    requireCondition(active.rowCount === 0, 409, 'duplicate_active_claim', '你已經有同一原作、同一角色的進行中認領。');
    const claimId = randomUUID();
    const snapshot = {
      provider: 'github', provider_repo_id: observed.canonical.provider_repo_id, full_name: observed.canonical.full_name,
      url: observed.canonical.current_url, source_repo_id: observed.canonical.source_repo_id, book_id: book.id,
      catalog_upstream_url: book.upstream_url, catalog_repository_url: book.repository_url, observed_at: new Date().toISOString(),
    };
    let row: any;
    try {
      row = (await q.query(`INSERT INTO repo_credit_claims (claim_id, community_id, repo_id, user_id, github_user_id, github_login, role, state, evidence_url, statement, source_snapshot, version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,1) RETURNING *`, [claimId, input.actor.community_id, repoId, input.actor.user_id, github.github_user_id, github.github_login, body.role, evidence, body.statement, JSON.stringify(snapshot)])).rows[0];
    } catch (error) {
      if (duplicateClaim(error)) throw new Problem(409, 'duplicate_active_claim', '你已經有同一原作、同一角色的進行中認領。');
      throw error;
    }
    await recordEvent(q, row, 'submit', null, 'pending', null, {user_id: input.actor.user_id});
    await journal(q, input.actor, 'repo_credit_claim', row.claim_id, 1, 'submit', {role: body.role, previous_state: null, new_state: 'pending'});
    return memberClaim({...row, provider_repo_id: observed.canonical.provider_repo_id, full_name: observed.canonical.full_name, current_url: observed.canonical.current_url});
  });
}

async function ownClaim(q: PoolClient, actor: Command['actor'], claimId: string, lock: boolean) {
  const row = (await q.query(`SELECT c.*, r.provider_repo_id, r.full_name, r.current_url FROM repo_credit_claims c JOIN canonical_repositories r ON r.repo_id=c.repo_id
    WHERE c.claim_id=$1 AND c.community_id=$2 AND c.user_id=$3${lock ? ' FOR UPDATE OF c' : ''}`, [claimId, actor.community_id, actor.user_id])).rows[0];
  requireCondition(row, 404, 'claim_not_found', '找不到這筆認領。');
  return row;
}
export async function withdrawAuthorClaim(pool: Pool, input: Command, claimId: string) {
  z.uuid().parse(claimId);
  z.object({}).strict().parse(input.body);
  await authRateLimit(pool, 'repo-claim-member', input.actor.user_id, 12, 3600);
  await authRateLimit(pool, 'repo-claim-global', 'global', 300, 3600);
  return command(pool, input, async q => { await ownClaim(q, input.actor, claimId, false); }, async q => {
    const current = await ownClaim(q, input.actor, claimId, true);
    requireClaimVersion(Number(current.version), input.expected);
    requireCondition(current.state === 'pending', 409, 'claim_not_withdrawable', '只有審核中的認領可以撤回。');
    const updated = (await q.query(`UPDATE repo_credit_claims SET state='withdrawn', version=version+1 WHERE claim_id=$1 AND version=$2 RETURNING *`, [claimId, current.version])).rows[0];
    requireCondition(updated, 409, 'claim_version_conflict', '這筆認領已更新，請重新整理後再操作。');
    await recordEvent(q, updated, 'withdraw', 'pending', 'withdrawn', null, {user_id: input.actor.user_id});
    await journal(q, input.actor, 'repo_credit_claim', updated.claim_id, updated.version, 'withdraw', {role: updated.role, previous_state: 'pending', new_state: 'withdrawn'});
    return memberClaim({...updated, provider_repo_id: current.provider_repo_id, full_name: current.full_name, current_url: current.current_url});
  });
}
export async function appealAuthorClaim(pool: Pool, input: Command, claimId: string) {
  z.uuid().parse(claimId);
  const body = AppealBody.parse(input.body);
  await authRateLimit(pool, 'repo-claim-member', input.actor.user_id, 12, 3600);
  await authRateLimit(pool, 'repo-claim-global', 'global', 300, 3600);
  return command(pool, input, async q => { await ownClaim(q, input.actor, claimId, false); }, async q => {
    const current = await ownClaim(q, input.actor, claimId, true);
    requireClaimVersion(Number(current.version), input.expected);
    requireCondition(Number(current.appeal_count) === 0, 409, 'appeal_already_used', '這筆認領已經申訴過，請等待審核。');
    requireCondition(current.state === 'rejected' || current.state === 'revoked', 409, 'claim_not_appealable', '只有被駁回或撤銷的認領可以申訴一次。');
    const updated = (await q.query(`UPDATE repo_credit_claims SET state='pending', appeal_count=1, appeal_text=$3, version=version+1 WHERE claim_id=$1 AND version=$2 RETURNING *`, [claimId, current.version, body.appeal])).rows[0];
    requireCondition(updated, 409, 'claim_version_conflict', '這筆認領已更新，請重新整理後再操作。');
    await recordEvent(q, updated, 'appeal', current.state, 'pending', body.appeal, {user_id: input.actor.user_id});
    await journal(q, input.actor, 'repo_credit_claim', updated.claim_id, updated.version, 'appeal', {role: updated.role, previous_state: current.state, new_state: 'pending'});
    return memberClaim({...updated, provider_repo_id: current.provider_repo_id, full_name: current.full_name, current_url: current.current_url});
  });
}

const transitions: Record<string, {from: ClaimState[]; to: ClaimState; action: string}> = {
  verify: {from: ['pending', 'disputed'], to: 'verified', action: 'verify'},
  reject: {from: ['pending', 'disputed'], to: 'rejected', action: 'reject'},
  dispute: {from: ['pending', 'verified'], to: 'disputed', action: 'dispute'},
  revoke: {from: ['verified'], to: 'revoked', action: 'revoke'},
};
async function assertNotSelfReview(q: PoolClient, admin: AdminCommand['admin'], claim: {user_id: string; github_user_id: string}) {
  const member = (await q.query('SELECT user_id FROM users WHERE community_id=$1 AND lower(email)=lower($2)', [admin.community_id, admin.email])).rows[0];
  if (!member) return;
  const sameUser = member.user_id === claim.user_id;
  const github = (await q.query('SELECT github_user_id FROM github_social_connections WHERE user_id=$1 AND community_id=$2', [member.user_id, admin.community_id])).rows[0];
  requireCondition(!sameUser && github?.github_user_id !== claim.github_user_id, 403, 'self_review_forbidden', '不能審核自己提交的認領，也不能審核連結到自己 GitHub 帳號的認領。');
}
interface AdminClaimView {
  claim_id: string; community_id: string; user_id: string; display_name: string;
  github_user_id: string; github_login: string; role: ClaimRole; role_label: string;
  state: ClaimState; state_label: string; evidence_url: string | null; statement: string;
  appeal_text: string | null; appeal_count: number; reason: string | null;
  reviewed_at: string | null; submitted_at: string | null; version: number; source_snapshot: unknown;
  repo: {provider: 'github'; provider_repo_id: string; full_name: string; current_url: string; source_repo_id: string | null};
  related_claims: AdminClaimView[];
}
function adminClaim(row: any, related: any[] = []): AdminClaimView {
  const state = row.state as ClaimState, role = row.role as ClaimRole;
  return {
    claim_id: row.claim_id, community_id: row.community_id, user_id: row.user_id, display_name: row.display_name,
    github_user_id: row.github_user_id, github_login: row.github_login, role, role_label: ROLE_LABEL[role],
    state, state_label: STATE_LABEL[state], evidence_url: row.evidence_url, statement: row.statement,
    appeal_text: row.appeal_text, appeal_count: Number(row.appeal_count), reason: row.reason,
    reviewed_at: iso(row.reviewed_at), submitted_at: iso(row.submitted_at), version: Number(row.version),
    source_snapshot: row.source_snapshot, repo: {provider: 'github' as const, provider_repo_id: row.provider_repo_id, full_name: row.full_name, current_url: row.current_url, source_repo_id: row.source_repo_id},
    related_claims: related.filter(item => item.claim_id !== row.claim_id).map(item => adminClaim(item)),
  };
}
const claimSelect = `SELECT c.*, u.display_name, r.provider_repo_id, r.full_name, r.current_url, r.source_repo_id
  FROM repo_credit_claims c JOIN users u ON u.user_id=c.user_id JOIN canonical_repositories r ON r.repo_id=c.repo_id`;
export async function adminAuthorClaims(pool: Pool, admin: AdminCommand['admin'], queue: 'review' | 'verified') {
  const states = queue === 'verified' ? ['verified'] : ['pending', 'disputed'];
  const items = (await pool.query(`${claimSelect} WHERE c.community_id=$1 AND c.state = ANY($2::text[]) ORDER BY c.submitted_at, c.claim_id`, [admin.community_id, states])).rows;
  const repoIds = [...new Set(items.map(item => item.repo_id))];
  const related = repoIds.length ? (await pool.query(`${claimSelect} WHERE c.community_id=$1 AND c.repo_id = ANY($2::uuid[])`, [admin.community_id, repoIds])).rows : [];
  const changes = (await pool.query(`SELECT book_id, provider_repo_id, previous_provider_repo_id, full_name, requested_full_name, current_url, observed_at
    FROM catalog_repo_observations WHERE needs_recheck ORDER BY observed_at DESC, book_id`)).rows.map(row => ({
    book_id: row.book_id, book_title: communityCatalog.skill_books.find(book => book.id === row.book_id)?.title ?? row.book_id,
    provider_repo_id: row.provider_repo_id, previous_provider_repo_id: row.previous_provider_repo_id,
    full_name: row.full_name, requested_full_name: row.requested_full_name, current_url: row.current_url, observed_at: iso(row.observed_at),
  }));
  return {queue, items: items.map(item => adminClaim(item, related.filter(relatedItem => relatedItem.repo_id === item.repo_id))), identity_changes: changes};
}
export async function reviewAuthorClaim(pool: Pool, input: AdminCommand, claimId: string) {
  z.uuid().parse(claimId);
  const body = ReviewBody.parse(input.body);
  const rule = transitions[body.decision];
  return adminCommand(pool, input, async q => {
    requireCondition((await q.query('SELECT 1 FROM repo_credit_claims WHERE claim_id=$1 AND community_id=$2', [claimId, input.admin.community_id])).rowCount === 1, 404, 'claim_not_found', '找不到這筆認領。');
  }, async q => {
    const current = (await q.query(`${claimSelect} WHERE c.claim_id=$1 AND c.community_id=$2 FOR UPDATE OF c`, [claimId, input.admin.community_id])).rows[0];
    requireCondition(current, 404, 'claim_not_found', '找不到這筆認領。');
    requireClaimVersion(Number(current.version), input.expected);
    await assertNotSelfReview(q, input.admin, current);
    requireCondition(rule.from.includes(current.state), 409, 'claim_transition_invalid', '這筆認領目前的狀態不能做這個決定。');
    const updated = (await q.query(`UPDATE repo_credit_claims SET state=$3, reason=$4, reviewed_by=$5, reviewed_at=now(), version=version+1
      WHERE claim_id=$1 AND version=$2 RETURNING *`, [claimId, current.version, rule.to, body.reason, input.admin.admin_id])).rows[0];
    requireCondition(updated, 409, 'claim_version_conflict', '這筆認領已更新，請重新整理後再操作。');
    await recordEvent(q, updated, rule.action, current.state, rule.to, body.reason, {admin_id: input.admin.admin_id});
    await audit(q, input.admin, `author_claim_${rule.action}`, 'repo_credit_claim', claimId, body.reason,
      {state: current.state, version: Number(current.version), role: current.role},
      {state: rule.to, version: Number(updated.version), role: updated.role});
    return adminClaim({...updated, display_name: current.display_name, provider_repo_id: current.provider_repo_id, full_name: current.full_name, current_url: current.current_url, source_repo_id: current.source_repo_id});
  });
}
export async function refreshAuthorClaimObservation(pool: Pool, input: AdminCommand, bookId: string, fetcher: typeof fetch) {
  const book = bookOrThrow(bookId);
  z.object({}).strict().parse(input.body);
  return adminCommand(pool, input, async () => undefined, async q => {
    const observed = await observeCatalogRepo(q, book, fetcher, {force: true, actorAdminId: input.admin.admin_id});
    await audit(q, input.admin, 'author_claim_observation', 'catalog_repo_observation', book.id, '重新讀取原作 Repo 身分。',
      {}, {provider_repo_id: observed.observation.provider_repo_id, needs_recheck: observed.observation.needs_recheck, full_name: observed.observation.full_name});
    return wireObservation(observed.observation);
  });
}
export async function acknowledgeAuthorClaimIdentity(pool: Pool, input: AdminCommand, bookId: string) {
  const book = bookOrThrow(bookId);
  const body = ReasonBody.parse(input.body);
  return adminCommand(pool, input, async q => {
    requireCondition((await q.query('SELECT 1 FROM catalog_repo_observations WHERE book_id=$1 AND needs_recheck', [book.id])).rowCount === 1, 409, 'identity_already_current', '這本技能書的原作 Repo 沒有待複核的身分變更。');
  }, async q => {
    const updated = (await q.query(`UPDATE catalog_repo_observations SET needs_recheck=false WHERE book_id=$1 AND needs_recheck RETURNING *`, [book.id])).rows[0];
    requireCondition(updated, 409, 'identity_already_current', '這本技能書的原作 Repo 沒有待複核的身分變更。');
    await q.query(`INSERT INTO catalog_repo_identity_events (event_id, book_id, provider, previous_provider_repo_id, provider_repo_id, full_name, actor_admin_id, action, reason)
      VALUES ($1,$2,'github',$3,$4,$5,$6,'acknowledged',$7)`, [randomUUID(), book.id, updated.previous_provider_repo_id, updated.provider_repo_id, updated.full_name, input.admin.admin_id, body.reason]);
    await audit(q, input.admin, 'author_claim_identity_acknowledged', 'catalog_repo_observation', book.id, body.reason,
      {needs_recheck: true, provider_repo_id: updated.provider_repo_id}, {needs_recheck: false, provider_repo_id: updated.provider_repo_id});
    return wireObservation(updated);
  });
}
function wireObservation(row: any) {
  return {
    book_id: row.book_id, provider: row.provider, provider_repo_id: row.provider_repo_id,
    previous_provider_repo_id: row.previous_provider_repo_id, requested_full_name: row.requested_full_name,
    full_name: row.full_name, current_url: row.current_url, source_repo_id: row.source_repo_id,
    needs_recheck: row.needs_recheck, observed_at: iso(row.observed_at),
  };
}
