import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../modules/identity-membership/service.js';
import { requireCondition } from '../shared/problem.js';
import { digest } from './legacy-digest.js';
import { runCommandCore } from './command-core.js';

export interface Command {
  actor: Actor; operation: string; key: string; body: unknown; expected?: string;
  // Acquire the final lock strength before the domain lock when a command updates users.
  lockUser?: boolean;
}

export async function memberCommand<T>(pool: Pool, input: Command,
  authorize: (q: PoolClient) => Promise<unknown>, run: (q: PoolClient) => Promise<T>): Promise<T> {
  requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(input.key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
  return runCommandCore(pool, {
    async authenticateAndLock(q) {
      // Administration locks users before revoking sessions. Keep that order and
      // choose the final user lock strength now, never upgrade after session lock.
      const activeUser=await q.query(`SELECT user_id FROM users WHERE user_id=$1 AND community_id=$2 AND active
        ${input.lockUser ? 'FOR UPDATE' : 'FOR SHARE'}`,[input.actor.user_id,input.actor.community_id]);
      requireCondition(activeUser.rowCount===1,401,'session_expired','請重新登入。');
      const active=await q.query(`SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2
        AND revoked_at IS NULL AND expires_at>now() FOR SHARE`,[input.actor.session_hash,input.actor.user_id]);
      requireCondition(active.rowCount===1,401,'session_expired','請重新登入。');
    },
    async lockReceipt(q) {
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${input.actor.user_id}/${input.operation}/${input.key}`]);
    },
    requestDigest: () => digest({body: input.body, expected: input.expected ?? null}),
    async readReceipt(q) {
      const prior = await q.query('SELECT * FROM command_receipts WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3', [input.actor.user_id,input.operation,input.key]);
      return prior.rowCount ? { request_sha256: prior.rows[0].request_sha256, response: prior.rows[0].response as T } : null;
    },
    async writeReceipt(q, hash, response) {
      await q.query('INSERT INTO command_receipts(user_id,operation,idempotency_key,request_sha256,response) VALUES($1,$2,$3,$4,$5)',[input.actor.user_id,input.operation,input.key,hash,JSON.stringify(response)]);
    },
  }, authorize, run);
}
