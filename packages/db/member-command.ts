import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../modules/identity-membership/service.js';
import { requireCondition } from '../shared/problem.js';
import { digest } from './legacy-digest.js';
import { runCommandCore, type CommandPorts } from './command-core.js';
import { lockMemberSession } from './member-session.js';

export interface Command {
  actor: Actor; operation: string; key: string; body: unknown; expected?: string;
  // Acquire the final lock strength before the domain lock when a command updates users.
  lockUser?: boolean;
}

export async function memberCommand<T>(pool: Pool, input: Command,
  authorize: (q: PoolClient) => Promise<unknown>, run: (q: PoolClient) => Promise<T>): Promise<T> {
  requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(input.key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
  return runCommandCore(pool, {
    authenticateAndLock: q => lockMemberSession(q, input.actor, input.lockUser),
    ...legacyMemberReceiptPorts<T>(input),
  }, authorize, run);
}

/** Internal server ports only, not an authentication API or caller-selectable
 * receipt profile. Historical SQL, advisory key and digest are shared verbatim
 * with the narrowly reviewed avatar compatibility adapter. Not a public index
 * export; callers must authenticate and authorize through runCommandCore. */
export function legacyMemberReceiptPorts<T>(input: Command): Omit<CommandPorts<T>, 'authenticateAndLock'> {
  return {
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
  };
}
