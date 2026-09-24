import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { checkVersion, command, digest, journal, transaction, type Command } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { tokenHash, type Actor } from '../identity-membership/service.js';
import { authRateLimit } from '../identity-membership/members.js';
import { importProjectWithinTransaction } from '../opensource-marketing/service.js';
import type { NormalizedSubmission } from './payload.js';

export const GRANT_PREFIX = 'fpg_';
export const KEY_PREFIX = 'fpk_';
export const GRANT_MINUTES = 60;
export const MAX_ACTIVE_KEYS = 10;
export const MAX_ACTIVE_DRAFTS = 30;
const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,128}$/;
const MEMBER_READY = 'active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)';
const SUBMISSION_COLUMNS = `submission_id,status,aggregate_version,payload,project_id,image_bytes IS NOT NULL AS has_image,
  LEAST(grant_expires_at,(SELECT k.expires_at FROM skill_upload_keys k WHERE k.key_id=skill_submissions.grant_key_id)) AS grant_expires_at,
  COALESCE(grant_revoked_at,(SELECT k.revoked_at FROM skill_upload_keys k WHERE k.key_id=skill_submissions.grant_key_id)) AS grant_revoked_at,
  grant_consumed_at,created_at,updated_at`;
const KEY_COLUMNS = 'key_id,label,scope,expires_at,revoked_at,created_at,last_used_at';

const empty = z.object({}).strict();
const keyInput = z.object({
  label: z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value), { message: '名稱不能包含換行或控制字元。' }),
  expires_in_days: z.number().int().min(1).max(90).default(30),
}).strict();
const publishInput = z.object({ consent_to_share: z.literal(true, { message: '公開前需勾選同意分享。' }) }).strict();

type Queryable = Pool | PoolClient;
type Owner = { user_id: string; community_id: string };
// journal() only reads user_id/community_id; agent requests have no browser session.
const journalActor = (owner: Owner) => ({ user_id: owner.user_id, community_id: owner.community_id }) as unknown as Actor;
export interface UploadGrant { token: string; expires_at: string; submit_url: string }

// 32 random bytes → 43 base64url characters after the scope prefix.
const newSecret = (prefix: string) => prefix + randomBytes(32).toString('base64url');
export const publicPath = (id: string) => `/development/submissions/${id}`;
const ownerIllustrationUrl = (id: string) => `/api/v1/me/skill-submissions/${id}/illustration`;
export const submitUrl = (origin: string, id: string) => `${new URL(origin).origin}/agent-api/v1/skill-submissions/${id}`;
export const reviewUrl = (origin: string) => `${new URL(origin).origin}/#skills`;
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const uuidOrNotFound = (id: string) => {
  requireCondition(z.uuid().safeParse(id).success, 404, 'not_found', '找不到這份技能投稿。');
  return id.toLowerCase();
};

function submissionView(row: any) {
  return {
    submission_id: row.submission_id, status: row.status, aggregate_version: String(row.aggregate_version),
    payload: row.payload ?? null, project_id: row.project_id ?? null,
    public_path: row.status === 'published' ? publicPath(row.submission_id) : null,
    illustration_url: row.has_image ? ownerIllustrationUrl(row.submission_id) : null,
    grant_expires_at: iso(row.grant_expires_at), grant_consumed_at: iso(row.grant_consumed_at), grant_revoked_at: iso(row.grant_revoked_at),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
}
export type SkillSubmissionView = ReturnType<typeof submissionView>;
function keyView(row: any) {
  return {
    key_id: row.key_id, label: row.label, scope: 'skill:submit' as const, expires_at: iso(row.expires_at),
    revoked_at: iso(row.revoked_at), created_at: iso(row.created_at), last_used_at: iso(row.last_used_at),
  };
}

async function requireReadyMember(q: Queryable, owner: Owner) {
  const allowed = await q.query(`SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND ${MEMBER_READY}`, [owner.user_id, owner.community_id]);
  requireCondition(allowed.rowCount === 1, 403, 'onboarding_required', '請先完成定位並選擇主要公會。');
}
async function ownedSubmission(q: Queryable, actor: Owner, id: string, lock = false) {
  const row = (await q.query(`SELECT ${SUBMISSION_COLUMNS} FROM skill_submissions WHERE submission_id=$1 AND community_id=$2 AND owner_ref=$3${lock ? ' FOR UPDATE' : ''}`,
    [id, actor.community_id, actor.user_id])).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這份技能投稿。');
  return row;
}
async function requireDraftCapacity(q: PoolClient, owner: Owner) {
  // Serialises concurrent issuing from browser and agent for the same member.
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`skill-submissions/${owner.user_id}`]);
  const active = Number((await q.query(`SELECT count(*) FROM skill_submissions WHERE community_id=$1 AND owner_ref=$2
    AND status IN ('awaiting_upload','ready_for_review')`, [owner.community_id, owner.user_id])).rows[0].count);
  requireCondition(active < MAX_ACTIVE_DRAFTS, 409, 'draft_limit', `最多保留 ${MAX_ACTIVE_DRAFTS} 份未公開的技能草稿；請先公開或撤回不再需要的草稿。`);
}
async function insertDraft(q: PoolClient, owner: Owner, grantHash: string, keyId: string | null) {
  const id = randomUUID();
  const row = (await q.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,origin_key_id,grant_hash,grant_key_id,grant_expires_at)
    VALUES($1,$2,$3,$4,$5,$4,now()+make_interval(mins=>$6)) RETURNING ${SUBMISSION_COLUMNS}`,
    [id, owner.community_id, owner.user_id, keyId, grantHash, GRANT_MINUTES])).rows[0];
  await journal(q, journalActor(owner), 'skill_submission', id, 1, 'issue_upload_grant', { source: keyId ? 'agent_key' : 'browser', key_id: keyId });
  return row;
}
const grantFor = (origin: string, submission: SkillSubmissionView, token: string | undefined): UploadGrant | null =>
  token ? { token, expires_at: submission.grant_expires_at!, submit_url: submitUrl(origin, submission.submission_id) } : null;

// ---------- Browser (owner session) ----------

export async function listSubmissions(pool: Pool, actor: Actor) {
  return (await pool.query(`SELECT ${SUBMISSION_COLUMNS} FROM skill_submissions WHERE community_id=$1 AND owner_ref=$2
    ORDER BY created_at DESC,submission_id LIMIT 100`, [actor.community_id, actor.user_id])).rows.map(submissionView);
}
export async function readSubmission(pool: Pool, actor: Actor, id: string) {
  return submissionView(await ownedSubmission(pool, actor, uuidOrNotFound(id)));
}
export async function readOwnIllustration(pool: Pool, actor: Actor, id: string) {
  const row = (await pool.query(`SELECT image_bytes FROM skill_submissions WHERE submission_id=$1 AND community_id=$2 AND owner_ref=$3 AND image_bytes IS NOT NULL`,
    [uuidOrNotFound(id), actor.community_id, actor.user_id])).rows[0];
  requireCondition(row, 404, 'illustration_not_found', '這份投稿沒有示意圖。');
  return row.image_bytes as Buffer;
}

// Raw grant secrets are created inside the transaction but kept outside the
// cached command response; an idempotent replay returns upload_grant:null.
export async function issueSubmission(pool: Pool, input: Command, origin: string) {
  empty.parse(input.body);
  await authRateLimit(pool, 'skill-submission-issue', input.actor.user_id, 30, 3600);
  let secret: string | undefined;
  const result = await command(pool, input, q => requireReadyMember(q, input.actor), async q => {
    await requireDraftCapacity(q, input.actor);
    const token = newSecret(GRANT_PREFIX);
    const row = await insertDraft(q, input.actor, tokenHash(token), null);
    secret = token;
    return { submission: submissionView(row), upload_grant: null };
  });
  return { submission: result.submission, upload_grant: grantFor(origin, result.submission, secret) };
}

export async function rotateGrant(pool: Pool, input: Command, id: string, origin: string) {
  empty.parse(input.body);
  id = uuidOrNotFound(id);
  await authRateLimit(pool, 'skill-submission-issue', input.actor.user_id, 30, 3600);
  let secret: string | undefined;
  const result = await command(pool, input, async q => { await requireReadyMember(q, input.actor); await ownedSubmission(q, input.actor, id); }, async q => {
    const current = await ownedSubmission(q, input.actor, id, true);
    checkVersion(current.aggregate_version, input.expected);
    requireCondition(current.status === 'awaiting_upload', 409, 'submission_not_awaiting_upload', '這份草稿已上傳或已結束，不能再發上傳授權。');
    const token = newSecret(GRANT_PREFIX);
    // Replacing the hash invalidates the previous grant immediately.
    const row = (await q.query(`UPDATE skill_submissions SET grant_hash=$2,grant_key_id=NULL,grant_expires_at=now()+make_interval(mins=>$3),
      grant_revoked_at=NULL,aggregate_version=aggregate_version+1,updated_at=now() WHERE submission_id=$1 RETURNING ${SUBMISSION_COLUMNS}`,
      [id, tokenHash(token), GRANT_MINUTES])).rows[0];
    await journal(q, input.actor, 'skill_submission', id, row.aggregate_version, 'rotate_upload_grant', { source: 'browser' });
    secret = token;
    return { submission: submissionView(row), upload_grant: null };
  });
  return { submission: result.submission, upload_grant: grantFor(origin, result.submission, secret) };
}

export async function revokeSubmission(pool: Pool, input: Command, id: string) {
  empty.parse(input.body);
  id = uuidOrNotFound(id);
  return command(pool, input, q => ownedSubmission(q, input.actor, id), async q => {
    const current = await ownedSubmission(q, input.actor, id, true);
    checkVersion(current.aggregate_version, input.expected);
    requireCondition(current.status !== 'published', 409, 'submission_published', '已公開的投稿不能在這裡撤回。');
    requireCondition(current.status !== 'revoked', 409, 'submission_revoked', '這份草稿已撤回。');
    const row = (await q.query(`UPDATE skill_submissions SET status='revoked',revoked_at=now(),
      grant_revoked_at=CASE WHEN grant_hash IS NULL THEN grant_revoked_at ELSE COALESCE(grant_revoked_at,now()) END,
      aggregate_version=aggregate_version+1,updated_at=now() WHERE submission_id=$1 RETURNING ${SUBMISSION_COLUMNS}`, [id])).rows[0];
    await journal(q, input.actor, 'skill_submission', id, row.aggregate_version, 'revoke_draft', {});
    return submissionView(row);
  });
}

export async function publishSubmission(pool: Pool, input: Command, id: string) {
  publishInput.parse(input.body);
  id = uuidOrNotFound(id);
  await authRateLimit(pool, 'skill-submission-publish', input.actor.user_id, 20, 3600);
  return command(pool, input, async q => { await requireReadyMember(q, input.actor); await ownedSubmission(q, input.actor, id); }, async q => {
    // The draft stays locked while the import runs and until publication is
    // recorded, so no concurrent publish/revoke can interleave.
    const current = await ownedSubmission(q, input.actor, id, true);
    checkVersion(current.aggregate_version, input.expected);
    requireCondition(current.status === 'ready_for_review', 409, 'submission_not_ready', current.status === 'published' ? '這份投稿已公開。' : '這份草稿尚未上傳完成或已撤回，不能公開。');
    const payload = current.payload;
    // Source facts and publication share this transaction and its user lock.
    // A failed publication rolls the import back as well; command replay reads
    // the single committed receipt without fetching GitHub again.
    const project: any = await importProjectWithinTransaction(q, input, {
        repository_url: payload.repository_url, title: payload.title, description: payload.description, use_notes: payload.use_notes,
        demo_url: payload.demo_url ?? null, relationship: payload.relationship, consent_to_share: true,
    }, { reuseOwned: true });
    requireCondition(project?.project_id && project?.current_version?.version_id && project.official === false && project.relationship_verification === 'self_declared',
      502, 'import_unverified', '作品匯入結果無法確認，這次沒有公開；請稍後重試。');
    const row = (await q.query(`UPDATE skill_submissions SET status='published',consent_to_share=true,project_id=$2,project_version_id=$3,
      published_at=now(),aggregate_version=aggregate_version+1,updated_at=now() WHERE submission_id=$1 AND status='ready_for_review'
      RETURNING ${SUBMISSION_COLUMNS}`, [id, project.project_id, project.current_version.version_id])).rows[0];
    requireCondition(row, 409, 'submission_not_ready', '這份草稿狀態已變更，請重新整理。');
    await journal(q, input.actor, 'skill_submission', id, row.aggregate_version, 'publish_with_consent',
      { project_id: project.project_id, version_id: project.current_version.version_id, commit_sha: project.current_version.commit_sha,
        payload_sha256: digest(payload), relationship_verification: 'self_declared', official: false });
    return submissionView(row);
  });
}

export async function listKeys(pool: Pool, actor: Actor) {
  return (await pool.query(`SELECT ${KEY_COLUMNS} FROM skill_upload_keys WHERE community_id=$1 AND user_id=$2
    ORDER BY created_at DESC,key_id LIMIT 100`, [actor.community_id, actor.user_id])).rows.map(keyView);
}
export async function createKey(pool: Pool, input: Command) {
  const body = keyInput.parse(input.body);
  await authRateLimit(pool, 'skill-upload-key-issue', input.actor.user_id, 20, 3600);
  let secret: string | undefined;
  const result = await command(pool, input, q => requireReadyMember(q, input.actor), async q => {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`skill-upload-keys/${input.actor.user_id}`]);
    const active = Number((await q.query('SELECT count(*) FROM skill_upload_keys WHERE community_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',
      [input.actor.community_id, input.actor.user_id])).rows[0].count);
    requireCondition(active < MAX_ACTIVE_KEYS, 409, 'upload_key_limit', `最多保留 ${MAX_ACTIVE_KEYS} 把有效的上傳金鑰；請先撤銷不再使用的金鑰。`);
    const token = newSecret(KEY_PREFIX), id = randomUUID();
    const row = (await q.query(`INSERT INTO skill_upload_keys(key_id,community_id,user_id,label,token_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+make_interval(days=>$6)) RETURNING ${KEY_COLUMNS}`,
      [id, input.actor.community_id, input.actor.user_id, body.label, tokenHash(token), body.expires_in_days])).rows[0];
    await journal(q, input.actor, 'skill_upload_key', id, 1, 'issue_upload_key', { scope: 'skill:submit', expires_in_days: body.expires_in_days });
    secret = token;
    return { key: keyView(row), token: null };
  });
  return { key: result.key, token: secret ?? null };
}
export async function revokeKey(pool: Pool, input: Command, id: string) {
  empty.parse(input.body);
  requireCondition(z.uuid().safeParse(id).success, 404, 'not_found', '找不到這把上傳金鑰。');
  return command(pool, input, async () => {}, async q => {
    const current = (await q.query(`SELECT ${KEY_COLUMNS} FROM skill_upload_keys WHERE key_id=$1 AND community_id=$2 AND user_id=$3 FOR UPDATE`,
      [id, input.actor.community_id, input.actor.user_id])).rows[0];
    requireCondition(current, 404, 'not_found', '找不到這把上傳金鑰。');
    if (current.revoked_at) return keyView(current);
    // Grants minted by this key are rejected at upload because the key is no longer current.
    const row = (await q.query(`UPDATE skill_upload_keys SET revoked_at=now() WHERE key_id=$1 RETURNING ${KEY_COLUMNS}`, [id])).rows[0];
    await journal(q, input.actor, 'skill_upload_key', id, 2, 'revoke_upload_key', {});
    return keyView(row);
  });
}

// ---------- Agent (bearer credentials, no cookies) ----------

function bearerHash(header: string | undefined, prefix: string, code: string, message: string) {
  const match = header?.match(/^Bearer ((?:fpk|fpg)_[A-Za-z0-9_-]{43})$/);
  requireCondition(match && match[1].startsWith(prefix), 401, code, message);
  return tokenHash(match[1]);
}
const keyInvalid = () => new Problem(401, 'upload_key_invalid', '上傳金鑰無效、已過期或已撤銷；請到自由工坊網站重新建立。');
const grantInvalid = () => new Problem(401, 'upload_grant_invalid', '上傳授權無效、已過期、已撤銷或不屬於這份草稿；請建立新的草稿或到網站重新發授權。');

export async function findUploadKey(pool: Pool, authorization: string | undefined): Promise<Owner & { key_hash: string }> {
  const hash = bearerHash(authorization, KEY_PREFIX, 'upload_key_invalid', '需要有效的技能上傳金鑰（Bearer fpk_…）。');
  const row = (await pool.query('SELECT user_id,community_id FROM skill_upload_keys WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [hash])).rows[0];
  if (!row) throw keyInvalid();
  return { ...row, key_hash: hash };
}
export async function findUploadGrant(pool: Pool, authorization: string | undefined, id: string): Promise<Owner & { grant_hash: string; submission_id: string }> {
  const hash = bearerHash(authorization, GRANT_PREFIX, 'upload_grant_invalid', '上傳需要這份草稿的一次性上傳授權（Bearer fpg_…）；長期金鑰不能直接上傳。');
  if (!z.uuid().safeParse(id).success) throw grantInvalid();
  const row = (await pool.query(`SELECT owner_ref AS user_id,community_id FROM skill_submissions WHERE grant_hash=$1 AND submission_id=$2
    AND grant_revoked_at IS NULL AND grant_expires_at>now() AND status<>'revoked'`, [hash, id.toLowerCase()])).rows[0];
  if (!row) throw grantInvalid();
  return { ...row, grant_hash: hash, submission_id: id.toLowerCase() };
}

// Member (FOR SHARE) before credential rows, matching administrative disable.
async function lockAgentOwner(q: PoolClient, owner: Owner, invalid: () => Problem) {
  const member = (await q.query(`SELECT ${MEMBER_READY} AS ready,active FROM users WHERE user_id=$1 AND community_id=$2 FOR SHARE`, [owner.user_id, owner.community_id])).rows[0];
  if (!member?.active) throw invalid();
  requireCondition(member.ready, 403, 'onboarding_required', '帳號尚未完成定位與主要公會選擇，暫時不能上傳技能。');
}

export async function agentCreateSubmission(pool: Pool, key: Owner & { key_hash: string }, idempotencyKey: string | undefined, origin: string) {
  requireCondition(idempotencyKey && IDEMPOTENCY.test(idempotencyKey), 400, 'idempotency_required', '請提供有效的 Idempotency-Key。');
  const operation = 'POST /agent-api/v1/skill-submissions', requestHash = digest({ body: {} });
  let secret: string | undefined;
  const response = await transaction(pool, async q => {
    await lockAgentOwner(q, key, keyInvalid);
    const current = (await q.query(`SELECT key_id FROM skill_upload_keys WHERE token_hash=$1 AND user_id=$2 AND community_id=$3
      AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`, [key.key_hash, key.user_id, key.community_id])).rows[0];
    if (!current) throw keyInvalid();
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`skill-agent/${current.key_id}/${operation}/${idempotencyKey}`]);
    const prior = (await q.query('SELECT request_sha256,response FROM skill_agent_receipts WHERE key_id=$1 AND operation=$2 AND idempotency_key=$3',
      [current.key_id, operation, idempotencyKey])).rows[0];
    if (prior) {
      requireCondition(prior.request_sha256 === requestHash, 409, 'idempotency_conflict', '同一操作識別碼不可搭配不同內容。');
      return prior.response;
    }
    await requireDraftCapacity(q, key);
    const token = newSecret(GRANT_PREFIX);
    const row = await insertDraft(q, key, tokenHash(token), current.key_id);
    await q.query('UPDATE skill_upload_keys SET last_used_at=now() WHERE key_id=$1', [current.key_id]);
    const view = submissionView(row);
    const stored = { submission: { submission_id: view.submission_id, status: view.status, grant_expires_at: view.grant_expires_at, created_at: view.created_at }, review_url: reviewUrl(origin) };
    await q.query('INSERT INTO skill_agent_receipts(key_id,operation,idempotency_key,request_sha256,response) VALUES($1,$2,$3,$4,$5)',
      [current.key_id, operation, idempotencyKey, requestHash, JSON.stringify(stored)]);
    secret = token;
    return stored;
  });
  const submission = response.submission;
  return {
    submission, review_url: response.review_url,
    upload_grant: secret ? { token: secret, expires_at: submission.grant_expires_at, submit_url: submitUrl(origin, submission.submission_id) } : null,
  };
}

export async function agentUploadSubmission(pool: Pool, grant: Owner & { grant_hash: string; submission_id: string }, normalized: NormalizedSubmission, origin: string) {
  return transaction(pool, async q => {
    await lockAgentOwner(q, grant, grantInvalid);
    const peek = (await q.query('SELECT grant_key_id FROM skill_submissions WHERE submission_id=$1 AND grant_hash=$2', [grant.submission_id, grant.grant_hash])).rows[0];
    if (!peek) throw grantInvalid();
    if (peek.grant_key_id) {
      // A grant minted by an agent key dies with that key (revoked or expired).
      const key = await q.query(`SELECT 1 FROM skill_upload_keys WHERE key_id=$1 AND user_id=$2 AND community_id=$3 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`,
        [peek.grant_key_id, grant.user_id, grant.community_id]);
      if (key.rowCount !== 1) throw grantInvalid();
    }
    const row = (await q.query(`SELECT submission_id,status,grant_key_id,grant_revoked_at,grant_expires_at>now() AS grant_live,grant_consumed_at,payload_sha256
      FROM skill_submissions WHERE submission_id=$1 AND grant_hash=$2 AND owner_ref=$3 AND community_id=$4 FOR UPDATE`,
      [grant.submission_id, grant.grant_hash, grant.user_id, grant.community_id])).rows[0];
    // Revoked, rotated, expired or re-bound grants are rejected even for identical replays.
    if (!row || row.grant_revoked_at || !row.grant_live || row.status === 'revoked' || row.grant_key_id !== peek.grant_key_id) throw grantInvalid();
    const ack = (status: string, consumedAt: Date | string) => ({ submission_id: row.submission_id, status, grant_consumed_at: iso(consumedAt), review_url: reviewUrl(origin) });
    if (row.grant_consumed_at) {
      requireCondition(row.payload_sha256 === normalized.payload_sha256, 409, 'upload_grant_consumed', '這份上傳授權已使用；內容不同的上傳需要新的草稿。');
      return ack(row.status, row.grant_consumed_at);
    }
    requireCondition(row.status === 'awaiting_upload', 409, 'submission_not_awaiting_upload', '這份草稿目前不能上傳。');
    const saved = (await q.query(`UPDATE skill_submissions SET status='ready_for_review',payload=$2,payload_sha256=$3,image_bytes=$4,grant_consumed_at=now(),
      aggregate_version=aggregate_version+1,updated_at=now() WHERE submission_id=$1 RETURNING aggregate_version,grant_consumed_at`,
      [row.submission_id, JSON.stringify(normalized.payload), normalized.payload_sha256, normalized.image])).rows[0];
    if (peek.grant_key_id) await q.query('UPDATE skill_upload_keys SET last_used_at=now() WHERE key_id=$1', [peek.grant_key_id]);
    await journal(q, journalActor(grant), 'skill_submission', row.submission_id, saved.aggregate_version, 'upload_private_draft',
      { payload_sha256: normalized.payload_sha256, has_cover_image: Boolean(normalized.image), via: peek.grant_key_id ? 'agent_key_grant' : 'browser_grant' });
    return ack('ready_for_review', saved.grant_consumed_at);
  });
}
