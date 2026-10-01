import type { ExecutionContext, ExportedHandler, ScheduledController } from '@cloudflare/workers-types';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createRequestPool } from '../../../packages/db/index.js';
import type { MaintainerWrites } from '../../../modules/repo-maintainer/claims.js';
import { runMaintainerTick, type MaintainerSummary, type MaintainerTickConfig } from '../../../modules/repo-maintainer/tick.js';

/**
 * Cron Worker for the repository maintainer mirror. Bindings contract
 * (see wrangler.maintainer.jsonc):
 * - HYPERDRIVE: the same caching-disabled configuration that environment's
 *   platform Worker uses. One configuration per database. This file never
 *   logs the connection string.
 * - GITHUB_MAINTAINER_APP_ID: numeric GitHub App id. The committed "0" is
 *   rejected here so an unprepared deploy makes no GitHub call.
 * - GITHUB_MAINTAINER_ORG: organization login. Installations for any other
 *   account are ignored.
 * - GITHUB_MAINTAINER_PRIVATE_KEY: PKCS#8 PEM secret, uploaded out of band.
 *   A PKCS#1 key is rejected. The key is passed into the tick and never logged.
 * - GITHUB_MAINTAINER_WRITES: exactly "off" or "requested_reviewers".
 *   Anything else, including a missing value, is reported as writes "invalid"
 *   and the requested-reviewer jobs skip the GitHub call. The committed value
 *   is off. A review, comment, label or merge is never posted.
 * No fetch handler is exported. A route added later would put the private key
 * on the Internet; the export list is the guard.
 */
export interface MaintainerEnv {
  HYPERDRIVE?: { readonly connectionString?: string };
  GITHUB_MAINTAINER_APP_ID?: string;
  GITHUB_MAINTAINER_ORG?: string;
  GITHUB_MAINTAINER_PRIVATE_KEY?: string;
  GITHUB_MAINTAINER_WRITES?: string;
}
export type ScheduledContext = { readonly scheduledTime?: number | Date; readonly cron?: string; noRetry?: () => void };
export type SyncContext = { waitUntil(promise: Promise<unknown>): void };
type Satisfies<T extends true> = T;
export type OfficialScheduledFit = Satisfies<ScheduledController extends ScheduledContext ? ExecutionContext extends SyncContext ? true : false : false>;
export type MaintainerDependencies = {
  createPool?: (env: MaintainerEnv) => Pool;
  run?: typeof runMaintainerTick;
  fetcher?: typeof fetch;
};

/** Thrown for a tick failure. Fixed text: the runtime records this message. */
export const MAINTAINER_TICK_FAILURE = 'Maintainer synchronization failed; the next minute retries.';

const APP_ID = z.string().regex(/^[1-9][0-9]{0,18}$/);
const ORG = z.string().regex(/^[A-Za-z0-9-]{1,39}$/);

function setting(name: string, value: unknown): string {
  if (value === undefined || value === null || value === '') throw new Error(`Missing ${name}.`);
  if (typeof value !== 'string') throw new Error(`${name} is invalid.`);
  return value;
}
function shaped(name: string, value: unknown, schema: z.ZodType<string>): string {
  const text = setting(name, value);
  if (!schema.safeParse(text).success) throw new Error(`${name} is invalid.`);
  return text;
}
function privateKey(value: unknown): string {
  let text = setting('GITHUB_MAINTAINER_PRIVATE_KEY', value);
  if (text.includes('\\n')) text = text.replace(/\\n/g, '\n');
  if (text.includes('BEGIN RSA PRIVATE KEY')) throw new Error('GITHUB_MAINTAINER_PRIVATE_KEY is PKCS#1. Convert it with openssl pkcs8 -topk8 -nocrypt.');
  if (!text.includes('BEGIN PRIVATE KEY') || !text.includes('END PRIVATE KEY')) throw new Error('GITHUB_MAINTAINER_PRIVATE_KEY is invalid.');
  return text;
}

function writesMode(value: unknown): MaintainerWrites {
  if (value === 'off' || value === 'requested_reviewers') return value;
  return 'invalid';
}

/** Validates bindings without I/O. Errors name the setting and never echo a value. */
export function readMaintainerConfig(env: MaintainerEnv): MaintainerTickConfig {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (typeof connectionString !== 'string' || connectionString.trim() === '') throw new Error('Missing HYPERDRIVE.');
  return {
    appId: shaped('GITHUB_MAINTAINER_APP_ID', env.GITHUB_MAINTAINER_APP_ID, APP_ID),
    organization: shaped('GITHUB_MAINTAINER_ORG', env.GITHUB_MAINTAINER_ORG, ORG),
    privateKey: privateKey(env.GITHUB_MAINTAINER_PRIVATE_KEY),
    writes: writesMode(env.GITHUB_MAINTAINER_WRITES),
  };
}

function errorLabel(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? name : 'unknown';
}
function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('maintainer_result_invalid');
  return value;
}
// The thrown message is the only alert. The original error is not attached:
// its message can carry a key, a token or a connection string.
function failure(error: unknown): Error {
  console.error('maintainer_tick_failed', errorLabel(error));
  return new Error(MAINTAINER_TICK_FAILURE);
}
function logSummary(summary: MaintainerSummary): void {
  const stopped = summary.stopped;
  if (stopped !== null && !/^[a-z0-9_]{1,40}$/.test(stopped)) throw new Error('maintainer_result_invalid');
  const writes = summary.writes;
  if (writes !== 'off' && writes !== 'requested_reviewers' && writes !== 'invalid') {
    const error = new Error('maintainer_result_invalid');
    error.name = 'maintainer_result_invalid';
    throw error;
  }
  console.log(JSON.stringify({
    deliveries_deleted: count(summary.deliveries_deleted), jobs_deleted: count(summary.jobs_deleted), rederived: count(summary.rederived),
    ignored_accounts: count(summary.ignored_accounts), suspended_installations: count(summary.suspended_installations),
    repositories_upserted: count(summary.repositories_upserted),
    repositories_removed: count(summary.repositories_removed), sweeps: count(summary.sweeps), jobs_done: count(summary.jobs_done),
    jobs_failed: count(summary.jobs_failed), jobs_released: count(summary.jobs_released), github_requests: count(summary.github_requests),
    claims_expired: count(summary.claims_expired), claims_released: count(summary.claims_released), claims_completed: count(summary.claims_completed),
    repositories_adopted: count(summary.repositories_adopted),
    writes, stopped,
  }));
}

export function createMaintainerHandler(deps: MaintainerDependencies = {}) {
  const createPool = deps.createPool ?? (env => createRequestPool(env.HYPERDRIVE?.connectionString ?? ''));
  const run = deps.run ?? runMaintainerTick;
  const fetcher = deps.fetcher ?? fetch;
  return {
    async scheduled(_controller: ScheduledContext, env: MaintainerEnv, ctx: SyncContext): Promise<void> {
      const config = readMaintainerConfig(env);
      let pool: Pool;
      try { pool = createPool(env); } catch (error) { throw failure(error); }
      const work = (async () => {
        try {
          logSummary(await run(pool, config, { fetcher }));
        } catch (error) {
          throw failure(error);
        } finally {
          await pool.end().catch(() => { console.error('pool_end_failed'); });
        }
      })();
      ctx.waitUntil(work.then(() => undefined, () => undefined));
      await work;
    },
  };
}

const maintainerWorker: ExportedHandler<MaintainerEnv> = createMaintainerHandler();
export default maintainerWorker;
