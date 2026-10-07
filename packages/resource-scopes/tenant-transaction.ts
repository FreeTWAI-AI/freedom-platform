import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { Problem } from '../shared/problem.js';

/**
 * Trust model. `freedom.principal_id`, `freedom.tenant_id` and
 * `freedom.tenant_scope_id` are transaction-local settings, not authentication.
 * `freedom.platform_admin_id` is the same kind of setting. Recovery case-id
 * routes set it only after the admin session and capability check, and only
 * to peek the case tenant. Any code that can run arbitrary SQL as the runtime
 * role can set them.
 * Row-level security only limits the blast radius of a forgotten tenant
 * predicate and of a pooled connection reused by the next request.
 * Membership, capability and target checks stay in application code.
 * Settings are written only with `set_config(name, value, true)` inside an
 * explicit transaction. A session-level SET would leak across Hyperdrive's
 * transaction pooling.
 */

const CONTEXT_UNAVAILABLE = '租戶交易內容目前無法使用。';

function contextUnavailable(): never {
  throw new Problem(500, 'tenant_context_unavailable', CONTEXT_UNAVAILABLE);
}

function requireUuid(value: string): string {
  if (!OpaqueId.safeParse(value).success) contextUnavailable();
  return value;
}

type TransactionRunner = <T>(pool: Pool, run: (q: PoolClient) => Promise<T>) => Promise<T>;

/** Same shape as `transaction`, except a failed ROLLBACK destroys the client.
 * The original error is rethrown. The rollback error is attached as `cause`
 * only when the original error does not already have one.
 */
export const isolatedTransaction: TransactionRunner = async (pool, run) => {
  const q = await pool.connect();
  // pg-pool listens for client errors only while the client is idle. A
  // terminated backend emits `error` on the checked-out client as well as
  // rejecting the query. Absorb that duplicate so it cannot escape as an
  // unhandled error event; the caller still receives the query error.
  // Keep the listener when the client is destroyed: the socket close can
  // arrive after release(error).
  const absorbDisconnect = () => undefined;
  q.on('error', absorbDisconnect);
  const releaseHealthy = () => {
    q.removeListener('error', absorbDisconnect);
    q.release();
  };
  try {
    await q.query('BEGIN');
    const result = await run(q);
    await q.query('COMMIT');
    releaseHealthy();
    return result;
  } catch (error) {
    let rollbackError: unknown;
    try {
      await q.query('ROLLBACK');
    } catch (rollback) {
      rollbackError = rollback;
    }
    if (rollbackError !== undefined) {
      const destroy = rollbackError instanceof Error ? rollbackError : new Error('Transaction rollback failed.');
      q.release(destroy);
      if (error instanceof Error && error.cause === undefined) error.cause = rollbackError;
      throw error;
    }
    releaseHealthy();
    throw error;
  }
};

/** Prove this client is inside a transaction: the local value must read back. */
export async function bindPrincipalContext(q: PoolClient, principalId: string): Promise<void> {
  const id = requireUuid(principalId);
  await q.query(`SELECT pg_catalog.set_config('freedom.principal_id', $1, true)`, [id]);
  const back = (await q.query<{ value: string | null }>(
    `SELECT pg_catalog.current_setting('freedom.principal_id', true) AS value`)).rows[0]?.value ?? '';
  if (back !== id) contextUnavailable();
}

/** One transaction serves one tenant. A different tenant already bound here is refused. */
export async function bindTenantContext(q: PoolClient, input: { tenantId: string; tenantScopeId: string }): Promise<void> {
  const tenantId = requireUuid(input.tenantId);
  const tenantScopeId = requireUuid(input.tenantScopeId);
  const current = (await q.query<{ tenant_id: string | null }>(
    `SELECT pg_catalog.current_setting('freedom.tenant_id', true) AS tenant_id`)).rows[0]?.tenant_id ?? '';
  if (current !== '' && current !== tenantId) contextUnavailable();
  await q.query(
    `SELECT pg_catalog.set_config('freedom.tenant_id', $1, true), pg_catalog.set_config('freedom.tenant_scope_id', $2, true)`,
    [tenantId, tenantScopeId]);
  const back = (await q.query<{ tenant_id: string | null; tenant_scope_id: string | null }>(
    `SELECT pg_catalog.current_setting('freedom.tenant_id', true) AS tenant_id,
            pg_catalog.current_setting('freedom.tenant_scope_id', true) AS tenant_scope_id`)).rows[0];
  if ((back?.tenant_id ?? '') !== tenantId || (back?.tenant_scope_id ?? '') !== tenantScopeId) contextUnavailable();
}

/** Bound only by the recovery admin path, after the capability check. */
export async function bindPlatformAdminContext(q: PoolClient, adminId: string): Promise<void> {
  const id = requireUuid(adminId);
  const current = (await q.query<{ value: string | null }>(
    `SELECT pg_catalog.current_setting('freedom.platform_admin_id', true) AS value`)).rows[0]?.value ?? '';
  if (current !== '' && current !== id) contextUnavailable();
  await q.query(`SELECT pg_catalog.set_config('freedom.platform_admin_id', $1, true)`, [id]);
  const back = (await q.query<{ value: string | null }>(
    `SELECT pg_catalog.current_setting('freedom.platform_admin_id', true) AS value`)).rows[0]?.value ?? '';
  if (back !== id) contextUnavailable();
}

/** Drop the principal, tenant and platform-admin settings before a verification failure leaves this transaction. */
export async function clearTenantContext(q: PoolClient): Promise<void> {
  await q.query(`SELECT pg_catalog.set_config('freedom.principal_id', '', true),
                        pg_catalog.set_config('freedom.tenant_id', '', true),
                        pg_catalog.set_config('freedom.tenant_scope_id', '', true),
                        pg_catalog.set_config('freedom.platform_admin_id', '', true)`);
}
