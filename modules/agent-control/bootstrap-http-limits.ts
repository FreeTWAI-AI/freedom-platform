import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../packages/db/transaction.js';
import { Problem } from '../../packages/shared/problem.js';
import type { RuntimeEnvironment } from '../../contracts/execution/v1/runtime-registration.js';

export type BootstrapHttpOperation = 'begin' | 'token' | 'nonce' | 'status' | 'member' | 'execution_member' | 'execution_machine';
const limits = Object.freeze({ begin: [20, 400], token: [90, 600], nonce: [90, 600], status: [120, 1200], member: [60, 600], execution_member: [60, 600], execution_machine: [60, 600] } as const);

/** Independent committed anti-abuse charge. No caller clock or raw secret key. */
export async function chargeBootstrapHttp(pool: Pool, environment: RuntimeEnvironment, clientId: string,
  operation: BootstrapHttpOperation, network: string): Promise<void> {
  const hash = (kind: string, key: string) => createHash('sha256')
    .update(JSON.stringify(['freedom.bootstrap-http/v1', environment, clientId, operation, kind, key])).digest('hex');
  let blocked: boolean;
  try {
    blocked = await transaction(pool, async q => {
      await q.query("SET LOCAL statement_timeout='5s'"); await q.query("SET LOCAL lock_timeout='5s'");
      let denied = false;
      // Global before network, for every request: fixed order and bounded creation.
      for (const [bucket, limit] of [[hash('global', 'global'), limits[operation][1]], [hash('network', network), limits[operation][0]]] as const) {
        // DO UPDATE locks an existing row, so the scheduled prune cannot delete it before the SELECT below.
        await q.query('INSERT INTO auth_rate_limits(bucket) VALUES($1) ON CONFLICT (bucket) DO UPDATE SET bucket = excluded.bucket', [bucket]);
        const row = (await q.query<{ attempts: number; expired: boolean }>(`SELECT attempts,
          window_start<=clock_timestamp()-interval '60 seconds' AS expired FROM auth_rate_limits WHERE bucket=$1 FOR UPDATE`, [bucket])).rows[0];
        if (!row.expired && row.attempts >= limit) { denied = true; break; }
        await q.query(`UPDATE auth_rate_limits SET attempts=CASE WHEN $2 THEN 1 ELSE attempts+1 END,
          window_start=CASE WHEN $2 THEN clock_timestamp() ELSE window_start END WHERE bucket=$1`, [bucket, row.expired]);
      }
      return denied;
    });
  } catch { throw new Problem(503, 'bootstrap_http_unavailable', 'Request unavailable.'); }
  if (blocked) throw new Problem(429, 'bootstrap_http_rate_limited', 'Request rate limited.', 60);
}
