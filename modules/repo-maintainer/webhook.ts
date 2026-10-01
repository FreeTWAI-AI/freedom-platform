import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { enqueueReconcilePull } from './queue.js';

const BODY_LIMIT = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type WebhookResult = { duplicate: true } | { accepted: true; outcome: 'queued' | 'ignored' };

function githubId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return null;
}
function sha40(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function pullNumber(value: unknown): number | null {
  const record = asRecord(value);
  const number = record?.number;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number <= 1_000_000_000 ? number : null;
}
function listedPulls(payload: Record<string, unknown>): Array<{ number: number; baseRepoId: string | null }> {
  const buckets = [payload.pull_requests, asRecord(payload.check_suite)?.pull_requests, asRecord(payload.check_run)?.pull_requests];
  const found: Array<{ number: number; baseRepoId: string | null }> = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      const number = pullNumber(item);
      if (number === null) continue;
      const base = asRecord(asRecord(item)?.base);
      found.push({ number, baseRepoId: githubId(asRecord(base?.repo)?.id) });
    }
  }
  return found;
}
async function readBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) requireCondition(/^\d+$/.test(declared) && Number(declared) <= BODY_LIMIT, 413, 'body_too_large', '內容過長。');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw new Problem(413, 'body_too_large', '內容過長。');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
function signed(secret: string, body: Uint8Array, header: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const got = header.slice('sha256='.length);
  const left = Buffer.from(expected), right = Buffer.from(got);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function receiveMaintainerWebhook(pool: Pool, request: Request, secret: string | undefined): Promise<WebhookResult> {
  requireCondition(secret && secret.length >= 32, 503, 'maintainer_webhook_unavailable', '維護者 Webhook 尚未設定。');
  requireCondition(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json', 415, 'json_required', '操作需要 JSON。');
  const raw = await readBody(request);
  const event = request.headers.get('x-github-event') ?? '';
  const delivery = (request.headers.get('x-github-delivery') ?? '').toLowerCase();
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  requireCondition(/^[a-z_]{1,64}$/.test(event) && UUID.test(delivery) && /^sha256=[0-9a-f]{64}$/.test(signature), 400, 'webhook_malformed', 'Webhook 標頭不完整。');
  if (!signed(secret, raw, signature)) {
    console.error('maintainer_webhook_rejected signature');
    throw new Problem(401, 'webhook_signature_invalid', 'Webhook 簽章不正確。');
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    const record = asRecord(parsed);
    if (!record) throw new Error('json');
    payload = record;
  } catch {
    throw new Problem(400, 'invalid_json', 'JSON 格式不正確。');
  }
  const action = typeof payload.action === 'string' && /^[a-z_]{1,80}$/.test(payload.action) ? payload.action : null;
  const installationId = githubId(asRecord(payload.installation)?.id);
  const repositoryId = githubId(asRecord(payload.repository)?.id);
  const headSha = sha40(asRecord(payload.pull_request)?.head && asRecord(asRecord(asRecord(payload.pull_request)?.head))?.sha)
    ?? sha40(asRecord(payload.check_suite)?.head_sha)
    ?? sha40(asRecord(payload.check_run)?.head_sha)
    ?? sha40(payload.sha);
  return transaction(pool, async q => {
    const inserted = await q.query(
      `INSERT INTO maintainer_webhook_deliveries
        (delivery_id, github_event, action, installation_id, github_repository_id, target_number, head_sha, outcome, payload_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING RETURNING delivery_id`,
      [delivery, event, action, installationId, repositoryId, null, headSha, 'ignored', createHash('sha256').update(raw).digest('hex')],
    );
    if (inserted.rowCount !== 1) return { duplicate: true as const };
    const finish = async (outcome: 'queued' | 'ignored', target: number | null) => {
      if (outcome !== 'ignored' || target !== null) {
        await q.query('UPDATE maintainer_webhook_deliveries SET outcome=$2, target_number=$3 WHERE delivery_id=$1', [delivery, outcome, target]);
      }
      return { accepted: true as const, outcome };
    };
    if (event === 'ping') return finish('ignored', null);
    if (event === 'installation' || event === 'installation_repositories') {
      await q.query('UPDATE maintainer_worker_state SET next_installation_sync_at=now() WHERE singleton');
      return finish('queued', null);
    }
    if (!repositoryId) return finish('ignored', null);
    const repo = (await q.query(
      `SELECT repository_id, installation_id, installation_state, mode FROM maintainer_repositories WHERE github_repository_id=$1`,
      [repositoryId],
    )).rows[0] as { repository_id: string; installation_id: string; installation_state: string; mode: string } | undefined;
    if (!repo || (installationId !== null && repo.installation_id !== installationId) || repo.installation_state !== 'active' || repo.mode === 'off') return finish('ignored', null);
    const numbers = new Set<number>();
    if (event === 'pull_request' || event === 'pull_request_review') {
      const number = pullNumber(payload.pull_request) ?? pullNumber(payload);
      if (number !== null) numbers.add(number);
    } else if (event === 'check_suite' || event === 'check_run' || event === 'status') {
      if (headSha) {
        const open = await q.query(
          `SELECT number FROM maintainer_pull_requests WHERE repository_id=$1 AND state='open' AND head_sha=$2`,
          [repo.repository_id, headSha],
        );
        for (const row of open.rows) numbers.add(row.number as number);
      }
      for (const pull of listedPulls(payload)) if (pull.baseRepoId === repositoryId) numbers.add(pull.number);
    } else return finish('ignored', null);
    const runAfter = new Date();
    for (const number of numbers) await enqueueReconcilePull(q, repo.repository_id, number, runAfter);
    // A job that was already queued still counts: the hint was accepted.
    const outcome = numbers.size > 0 ? 'queued' : 'ignored';
    return finish(outcome, numbers.size === 1 ? [...numbers][0] : null);
  });
}
