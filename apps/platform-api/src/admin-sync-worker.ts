import type { ExecutionContext, ExportedHandler, ScheduledController } from '@cloudflare/workers-types';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createRequestPool } from '../../../packages/db/index.js';
import { syncAdminAccess, type AccessSyncConfig } from '../../../modules/platform-admin/access-sync.js';

/**
 * Cron Worker for the administrator Access allowlist. Bindings contract
 * (see wrangler.admin-sync.jsonc):
 * - HYPERDRIVE: the same binding the platform Worker uses, one configuration
 *   per database, created with caching disabled. Settings come from the
 *   Worker env argument. This file never logs the connection string.
 * - CF_ACCOUNT_ID, FREEDOM_ADMIN_SYNC_APP_ID, FREEDOM_ADMIN_SYNC_POLICY_ID,
 *   FREEDOM_ADMIN_SYNC_DOMAIN: the four values scripts/sync-admin-access.ts
 *   reads. Plain vars. The all-zero account id and nil UUIDs are the
 *   committed placeholders; they are rejected here so a deploy that only
 *   replaces the Hyperdrive id still makes no provider call.
 * - CF_API_TOKEN: secret, uploaded out of band. It is passed into
 *   syncAdminAccess and never logged.
 * No fetch handler is exported. A route added later would publish this token
 * on the Internet; the export list is the guard.
 */
export interface AdminSyncEnv {
  HYPERDRIVE?: { readonly connectionString?: string };
  CF_ACCOUNT_ID?: string;
  FREEDOM_ADMIN_SYNC_APP_ID?: string;
  FREEDOM_ADMIN_SYNC_POLICY_ID?: string;
  FREEDOM_ADMIN_SYNC_DOMAIN?: string;
  CF_API_TOKEN?: string;
}
export type ScheduledContext = { readonly scheduledTime?: number | Date; readonly cron?: string; noRetry?: () => void };
export type SyncContext = { waitUntil(promise: Promise<unknown>): void };
type Satisfies<T extends true> = T;
export type OfficialScheduledFit = Satisfies<ScheduledController extends ScheduledContext ? ExecutionContext extends SyncContext ? true : false : false>;
export type AdminSyncDependencies = {
  createPool?: (env: AdminSyncEnv) => Pool;
  sync?: typeof syncAdminAccess;
  fetcher?: typeof fetch;
};

/** Thrown for a sync failure. Fixed text: the runtime records this message. */
export const ADMIN_SYNC_FAILURE = 'Administrator access synchronization failed; pending changes will be retried.';

const ACCOUNT_ID = z.string().regex(/^[a-f0-9]{32}$/);
const RESOURCE_ID = z.uuid();
const DOMAIN = z.string().regex(/^[a-z0-9.-]+\/admin$/);
const ZERO_ACCOUNT = '0'.repeat(32);
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
// Millisecond timestamps for this century are above this. A smaller finite
// number is seconds; treating seconds as milliseconds sticks the UTC minute
// and can skip every forced re-verification.
const MILLISECOND_CLOCK = 1e12;

function setting(name: string, value: unknown): string {
  if (value === undefined || value === null || value === '') throw new Error(`Missing ${name}.`);
  if (typeof value !== 'string') throw new Error(`${name} is invalid.`);
  return value;
}
function shaped(name: string, value: unknown, schema: z.ZodType<string>, placeholder: (text: string) => boolean): string {
  const text = setting(name, value);
  if (!schema.safeParse(text).success || placeholder(text)) throw new Error(`${name} is invalid.`);
  return text;
}

/** Validates bindings without I/O. Errors name the setting and never echo a value. */
export function readAdminSyncConfig(env: AdminSyncEnv): AccessSyncConfig {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (typeof connectionString !== 'string' || connectionString.trim() === '') throw new Error('Missing HYPERDRIVE.');
  const token = setting('CF_API_TOKEN', env.CF_API_TOKEN);
  if (/\s/.test(token)) throw new Error('CF_API_TOKEN is invalid.');
  return {
    accountId: shaped('CF_ACCOUNT_ID', env.CF_ACCOUNT_ID, ACCOUNT_ID, text => text === ZERO_ACCOUNT),
    appId: shaped('FREEDOM_ADMIN_SYNC_APP_ID', env.FREEDOM_ADMIN_SYNC_APP_ID, RESOURCE_ID, text => text.toLowerCase() === NIL_UUID),
    policyId: shaped('FREEDOM_ADMIN_SYNC_POLICY_ID', env.FREEDOM_ADMIN_SYNC_POLICY_ID, RESOURCE_ID, text => text.toLowerCase() === NIL_UUID),
    domain: shaped('FREEDOM_ADMIN_SYNC_DOMAIN', env.FREEDOM_ADMIN_SYNC_DOMAIN, DOMAIN, () => false),
    token,
  };
}

/**
 * Force a provider read-back on UTC minutes 0, 15, 30 and 45 of the scheduled
 * slot (not the wall clock: a late invocation must still force). That is the
 * Castle timer's --force cadence. A missing or non-finite time forces too, so
 * the re-verification cannot be turned off by omitting a binding.
 */
export function adminSyncShouldForce(scheduledTime: number | Date | undefined): boolean {
  let instant: number | undefined;
  if (scheduledTime instanceof Date) instant = scheduledTime.getTime();
  else if (typeof scheduledTime === 'number' && Number.isFinite(scheduledTime)) instant = scheduledTime < MILLISECOND_CLOCK ? scheduledTime * 1000 : scheduledTime;
  if (instant === undefined || !Number.isFinite(instant)) return true;
  return new Date(instant).getUTCMinutes() % 15 === 0;
}

function errorLabel(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? name : 'unknown';
}
// The thrown message is the only alert: Cloudflare marks the cron invocation
// failed when scheduled() rejects. noRetry() is never called, so that failure
// stays retryable and the next minute is a new invocation. The original error
// is not attached as cause, because the runtime logs the thrown value and
// that message can carry an address or a provider body. syncAdminAccess rolls
// back unless the read-back matched, so a rejection leaves revisions pending.
function failure(error: unknown): Error {
  console.error('admin_sync_failed', errorLabel(error));
  return new Error(ADMIN_SYNC_FAILURE);
}
function logChecked(result: { checked: boolean; updated: boolean; active_admins: number }): void {
  if (!result.checked) return;
  const count = result.active_admins;
  if (typeof count !== 'number' || !Number.isFinite(count)) throw new Error('admin_sync_result_invalid');
  console.log(JSON.stringify({ checked: true, updated: result.updated === true, active_admins: count }));
}

export function createAdminSyncHandler(deps: AdminSyncDependencies = {}) {
  const createPool = deps.createPool ?? (env => createRequestPool(env.HYPERDRIVE?.connectionString ?? ''));
  const sync = deps.sync ?? syncAdminAccess;
  return {
    async scheduled(controller: ScheduledContext, env: AdminSyncEnv, ctx: SyncContext): Promise<void> {
      const config = readAdminSyncConfig(env);
      let pool: Pool;
      try { pool = createPool(env); } catch (error) { throw failure(error); }
      const work = (async () => {
        try {
          const result = await sync(pool, config, { force: adminSyncShouldForce(controller.scheduledTime), fetcher: deps.fetcher });
          logChecked(result);
        } catch (error) {
          throw failure(error);
        } finally {
          await pool.end().catch(() => { console.error('pool_end_failed'); });
        }
      })();
      // waitUntil keeps the pool release and the provider read-back alive if
      // the runtime stops waiting on the returned promise. Awaiting the same
      // work is what rejects this handler.
      ctx.waitUntil(work.then(() => undefined, () => undefined));
      await work;
    },
  };
}

const adminSyncWorker: ExportedHandler<AdminSyncEnv> = createAdminSyncHandler();
export default adminSyncWorker;
