import { Pool, type PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { Problem, requireCondition } from '../shared/problem.js';
import type { Actor } from '../../modules/identity-membership/service.js';

export const LOCAL_DATABASE_URL = 'postgresql://freedom_local:local-development-only@127.0.0.1:54339/freedom_local';
export function createPool(connectionString = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL) {
  return new Pool({ connectionString, max: 12, connectionTimeoutMillis: 5000 });
}
export function digest(value: unknown): string {
  function stable(v: any): any {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k,stable(v[k])]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export async function transaction<T>(pool: Pool, run: (q: PoolClient) => Promise<T>): Promise<T> {
  const q = await pool.connect();
  try { await q.query('BEGIN'); const result = await run(q); await q.query('COMMIT'); return result; }
  catch (error) { await q.query('ROLLBACK'); throw error; }
  finally { q.release(); }
}
export interface Command {
  actor: Actor; operation: string; key: string; body: unknown; expected?: string;
  // Acquire the final lock strength before the domain lock when a command updates users.
  lockUser?: boolean;
}
export async function command<T>(pool: Pool, input: Command,
  authorize: (q: PoolClient) => Promise<unknown>, run: (q: PoolClient) => Promise<T>): Promise<T> {
  requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(input.key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
  return transaction(pool, async q => {
    const active = await q.query(`SELECT s.token_hash FROM sessions s JOIN users u USING(user_id)
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active
      ${input.lockUser ? 'FOR UPDATE OF u FOR SHARE OF s' : 'FOR SHARE OF s,u'}`,[input.actor.session_hash]);
    requireCondition(active.rowCount === 1,401,'session_expired','請重新登入。');
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${input.actor.user_id}/${input.operation}/${input.key}`]);
    await authorize(q); // Current authority is checked even for a replay.
    const hash = digest({body: input.body, expected: input.expected ?? null});
    const prior = await q.query('SELECT * FROM command_receipts WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3', [input.actor.user_id,input.operation,input.key]);
    if (prior.rowCount) {
      requireCondition(prior.rows[0].request_sha256===hash,409,'idempotency_conflict','同一操作識別碼不可搭配不同內容。');
      return prior.rows[0].response as T;
    }
    const response = await run(q);
    await q.query('INSERT INTO command_receipts(user_id,operation,idempotency_key,request_sha256,response) VALUES($1,$2,$3,$4,$5)',[input.actor.user_id,input.operation,input.key,hash,JSON.stringify(response)]);
    return response;
  });
}
export async function journal(q: PoolClient, actor: Actor, type: string, id: string, version: string | number, operation: string, data: unknown = {}, eventType?: string) {
  const transition = randomUUID();
  await q.query('INSERT INTO transition_journal VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())',[transition,actor.community_id,type,id,version,operation,actor.user_id,JSON.stringify(data)]);
  if (eventType) await q.query('INSERT INTO outbox VALUES($1,$2,$3,$4,now())',[randomUUID(),transition,eventType,JSON.stringify({aggregate_id:id,aggregate_version:String(version),community_id:actor.community_id,data})]);
}
export function checkVersion(actual: string, expected?: string) {
  if (!expected) throw new Problem(428,'version_required','請提供 If-Match 版本。');
  requireCondition(actual===expected,412,'version_conflict','資料已更新，請重新整理後再操作。');
}
