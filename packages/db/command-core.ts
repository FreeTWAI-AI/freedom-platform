import type { Pool, PoolClient } from 'pg';
import { requireCondition } from '../shared/problem.js';
import { transaction } from './transaction.js';

export interface CommandReceipt<T> { request_sha256: string; response: T }

/** Server-owned ports, not caller JSON or proof of credential verification.
 * An adapter must validate its current backing records on this same transaction
 * and define a collision-free receipt namespace and serialization lock.
 * No network I/O belongs in these callbacks. No machine adapter is enabled yet.
 */
export interface CommandPorts<T> {
  authenticateAndLock(q: PoolClient): Promise<void>;
  lockReceipt(q: PoolClient): Promise<void>;
  requestDigest(): string;
  readReceipt(q: PoolClient): Promise<CommandReceipt<T> | null>;
  writeReceipt(q: PoolClient, requestDigest: string, response: T): Promise<void>;
}

/** Internal orchestration only; this is not an API authorization entrypoint.
 * `runner` defaults to the legacy transaction helper. Tenant commands pass the
 * isolated runner; this function does not choose one for them.
 */
export async function runCommandCore<T>(pool: Pool, ports: CommandPorts<T>,
  authorize: (q: PoolClient) => Promise<unknown>, run: (q: PoolClient) => Promise<T>,
  runner: <R>(pool: Pool, run: (q: PoolClient) => Promise<R>) => Promise<R> = transaction): Promise<T> {
  return runner(pool, async q => {
    await ports.authenticateAndLock(q);
    await ports.lockReceipt(q);
    await authorize(q); // Never return even an existing receipt before current authority.
    const hash = ports.requestDigest();
    const prior = await ports.readReceipt(q);
    if (prior) {
      requireCondition(prior.request_sha256 === hash, 409, 'idempotency_conflict', '同一操作識別碼不可搭配不同內容。');
      return prior.response;
    }
    const response = await run(q);
    await ports.writeReceipt(q, hash, response);
    return response;
  });
}
