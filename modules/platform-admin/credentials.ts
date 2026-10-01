import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool} from 'pg';
import {requireCondition} from '../../packages/shared/problem.js';
import {adminCommand, audit, type AdminCommand} from './service.js';

export type CredentialKey = 'github_metrics_token' | 'cloudflare_deploy_token';
export type CredentialStatus = 'ok' | 'rejected' | 'unknown';
export type CredentialLevel = 'expired' | 'danger' | 'warning' | 'ok' | 'unknown';
export type RenewalState = 'pending' | 'processing' | 'done' | 'failed';
export type CredentialRequest = {
  request_id: string;
  state: RenewalState;
  requested_at: string;
  processed_at: string | null;
  result_expires_at: string | null;
  error_code: string | null;
};
export type CredentialView = {
  credential_key: CredentialKey;
  label: string;
  status: CredentialStatus;
  expires_at: string | null;
  days_left: number | null;
  checked_at: string | null;
  source: 'github_response' | 'local_executor' | null;
  level: CredentialLevel;
  renewable: boolean;
  open_request: CredentialRequest | null;
  last_request: CredentialRequest | null;
  renew_hint: string;
};

const DAY_MS = 86_400_000;
const KEYS: {credential_key: CredentialKey; label: string; renewable: boolean; renew_hint: string}[] = [
  {credential_key: 'github_metrics_token', label: 'GitHub 讀取權杖', renewable: false, renew_hint: '請到 GitHub 重新產生讀取權杖，再由維護者更新 Worker 密鑰。'},
  {credential_key: 'cloudflare_deploy_token', label: 'Cloudflare 部署權杖', renewable: true, renew_hint: '按下續期會請維護者的電腦延長這張部署權杖。'},
];

/** GitHub sends `YYYY-MM-DD HH:mm:ss UTC`. Anything else, including a rolled-over date, is no expiry. */
export function parseGitHubTokenExpiration(header: string | null | undefined): Date | null {
  if (!header) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/.exec(header.trim());
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== iso) return null;
  return date;
}

/** Whole 24-hour periods remaining. Past expiry is negative. No date is null. */
export function classifyCredential(status: CredentialStatus | null, expiresAt: Date | null, now: Date): {level: CredentialLevel; days_left: number | null} {
  if (!status || status === 'unknown') return {level: 'unknown', days_left: null};
  const days = expiresAt ? Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return {level: 'expired', days_left: days};
  if (status === 'rejected' || (days !== null && days <= 7)) return {level: 'danger', days_left: days};
  if (days !== null && days <= 30) return {level: 'warning', days_left: days};
  return {level: 'ok', days_left: days};
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
type RequestRow = {request_id: string; state: RenewalState; requested_at: Date | string; processed_at: Date | string | null; result_expires_at: Date | string | null; error_code: string | null};
function requestView(row: RequestRow): CredentialRequest {
  return {
    request_id: row.request_id, state: row.state, requested_at: iso(row.requested_at) ?? new Date(0).toISOString(),
    processed_at: iso(row.processed_at), result_expires_at: iso(row.result_expires_at), error_code: row.error_code,
  };
}

/** GitHub sync writes this at most once per run. A failure here must not fail the sync. */
export async function recordGitHubMetricsCredential(pool: Pool, status: CredentialStatus, expiresAt: Date | null): Promise<void> {
  await pool.query(`INSERT INTO platform_credential_status(credential_key, status, expires_at, checked_at, source, note)
    VALUES ('github_metrics_token', $1, $2, now(), 'github_response', NULL)
    ON CONFLICT (credential_key) DO UPDATE SET status=EXCLUDED.status, expires_at=EXCLUDED.expires_at,
      checked_at=EXCLUDED.checked_at, source=EXCLUDED.source, note=EXCLUDED.note`, [status, expiresAt]);
}

export async function listCredentials(pool: Pool, now = new Date()): Promise<{items: CredentialView[]}> {
  const status = await pool.query<{credential_key: CredentialKey; status: CredentialStatus; expires_at: Date | null; checked_at: Date; source: 'github_response' | 'local_executor'}>('SELECT credential_key, status, expires_at, checked_at, source FROM platform_credential_status');
  const requests = await pool.query<RequestRow & {credential_key: string}>(`SELECT request_id, credential_key, state, requested_at, processed_at, result_expires_at, error_code
    FROM platform_credential_renewal_requests ORDER BY requested_at DESC, request_id DESC`);
  const byKey = new Map(status.rows.map(row => [row.credential_key, row]));
  return {items: KEYS.map(meta => {
    const row = byKey.get(meta.credential_key);
    const classified = classifyCredential(row?.status ?? null, asDate(row?.expires_at), now);
    const mine = requests.rows.filter(request => request.credential_key === meta.credential_key);
    const open = mine.find(request => request.state === 'pending' || request.state === 'processing') ?? null;
    // Newest finished attempt. An open request stays on open_request so the panel can show both.
    const finished = mine.find(request => request.state === 'done' || request.state === 'failed') ?? null;
    return {
      credential_key: meta.credential_key, label: meta.label, renewable: meta.renewable, renew_hint: meta.renew_hint,
      status: row?.status ?? 'unknown', expires_at: iso(row?.expires_at), days_left: classified.days_left,
      checked_at: iso(row?.checked_at), source: row?.source ?? null, level: classified.level,
      open_request: open ? requestView(open) : null,
      last_request: finished ? requestView(finished) : null,
    };
  })};
}

const renewalBody = z.object({}).strict();
/** Inserts one pending Cloudflare renewal, or returns the open one. requested_by is the admin's same-email member. */
export async function requestCloudflareRenewal(pool: Pool, input: AdminCommand): Promise<{created: boolean; request: CredentialRequest}> {
  renewalBody.parse(input.body);
  return adminCommand(pool, input, async () => {}, async q => {
    const member = await q.query<{user_id: string}>('SELECT user_id FROM users WHERE community_id=$1 AND lower(email)=$2 AND active', [input.admin.community_id, input.admin.email]);
    requireCondition(member.rowCount === 1, 422, 'member_account_required', '請先用這個管理員信箱建立啟用中的會員帳號，才能送出續期。');
    const inserted = await q.query<RequestRow>(`INSERT INTO platform_credential_renewal_requests(request_id, credential_key, requested_by)
      VALUES ($1, 'cloudflare_deploy_token', $2)
      ON CONFLICT (credential_key) WHERE state IN ('pending', 'processing') DO NOTHING
      RETURNING request_id, state, requested_at, processed_at, result_expires_at, error_code`, [randomUUID(), member.rows[0].user_id]);
    if (inserted.rowCount === 1) {
      const request = requestView(inserted.rows[0]);
      await audit(q, input.admin, 'credential_renewal_request', 'platform_credential', 'cloudflare_deploy_token', '送出 Cloudflare 部署權杖續期請求。', null, request);
      return {created: true, request};
    }
    const open = await q.query<RequestRow>(`SELECT request_id, state, requested_at, processed_at, result_expires_at, error_code
      FROM platform_credential_renewal_requests WHERE credential_key='cloudflare_deploy_token' AND state IN ('pending', 'processing')`);
    requireCondition(open.rowCount === 1, 409, 'renewal_conflict', '續期請求狀態已變更，請重新整理。');
    return {created: false, request: requestView(open.rows[0])};
  });
}
