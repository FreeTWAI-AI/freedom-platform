import type { Pool, PoolClient } from 'pg';
import type { ApplyOutcome, AsyncModuleProvider, LookupResult, ModuleProviderMap, ProvisionEffect } from '../../modules/module-registry/providers.js';

export type SyntheticFault =
  | 'ack_lost'
  | 'timeout'
  | 'crash_before'
  | 'crash_after'
  | 'lookup_unreachable'
  | 'foreign_owner'
  | 'fail_known'
  | 'member_data';

const FOREIGN_TENANT = '00000000-0000-4000-8000-000000000099';
const FOREIGN_DIGEST = 'ab'.repeat(32);

/** Durable effect tables live in the test schema. Never add them to a migration. */
export async function ensureSyntheticModuleTables(q: Pool | PoolClient) {
  await q.query(`CREATE TABLE IF NOT EXISTS synthetic_module_effects (
    effect_key text PRIMARY KEY,
    tenant_id uuid NOT NULL,
    instance_id uuid NOT NULL,
    module_key text NOT NULL,
    effect_digest text NOT NULL,
    outcome text NOT NULL,
    member_data boolean NOT NULL DEFAULT false
  )`);
  await q.query(`CREATE TABLE IF NOT EXISTS synthetic_module_faults (
    module_key text PRIMARY KEY,
    fault text NOT NULL
  )`);
}

export async function setSyntheticFault(pool: Pool, moduleKey: string, fault: SyntheticFault | null) {
  if (!fault) {
    await pool.query('DELETE FROM synthetic_module_faults WHERE module_key=$1', [moduleKey]);
    return;
  }
  await pool.query(
    `INSERT INTO synthetic_module_faults(module_key, fault) VALUES($1,$2)
     ON CONFLICT (module_key) DO UPDATE SET fault=EXCLUDED.fault`,
    [moduleKey, fault],
  );
}

let holdNextApply = false;
let holdGate: Promise<void> = Promise.resolve();
let releaseHold: (() => void) | null = null;
let enteredHold: (() => void) | null = null;
let enteredPromise: Promise<void> = Promise.resolve();

/** Block the next apply so a second worker can overlap it. Later applies do not wait. */
export function holdSyntheticApply() {
  holdNextApply = true;
  enteredPromise = new Promise(resolve => { enteredHold = resolve; });
  holdGate = new Promise(resolve => { releaseHold = resolve; });
}

export function syntheticApplyEntered() {
  return enteredPromise;
}

export function releaseSyntheticApply() {
  holdNextApply = false;
  releaseHold?.();
  releaseHold = null;
  holdGate = Promise.resolve();
  enteredHold = null;
}

async function waitIfHeld() {
  if (!holdNextApply) return;
  holdNextApply = false;
  const gate = holdGate;
  enteredHold?.();
  await gate;
}

function providerFor(pool: Pool, moduleKey: string): AsyncModuleProvider {
  return {
    kind: 'async',
    async apply(effect: ProvisionEffect): Promise<ApplyOutcome> {
      await waitIfHeld();
      const existing = (await pool.query<{ outcome: ApplyOutcome }>(
        'SELECT outcome FROM synthetic_module_effects WHERE effect_key=$1',
        [effect.effect_key],
      )).rows[0];
      if (existing) return existing.outcome;
      const fault = (await pool.query<{ fault: SyntheticFault }>(
        'SELECT fault FROM synthetic_module_faults WHERE module_key=$1',
        [moduleKey],
      )).rows[0]?.fault;
      if (fault === 'crash_before') throw new Error('synthetic_crash_before');
      if (fault === 'timeout') return 'unknown';
      const outcome: ApplyOutcome = fault === 'fail_known' ? 'failed_known' : 'confirmed';
      const member = fault === 'member_data';
      const inserted = fault === 'foreign_owner'
        ? await pool.query(
          `INSERT INTO synthetic_module_effects(effect_key, tenant_id, instance_id, module_key, effect_digest, outcome, member_data)
           VALUES($1,$2,$3,$4,$5,'unknown',false)
           ON CONFLICT (effect_key) DO NOTHING
           RETURNING outcome`,
          [effect.effect_key, FOREIGN_TENANT, effect.instance_id, moduleKey, FOREIGN_DIGEST],
        )
        : await pool.query(
          `INSERT INTO synthetic_module_effects(effect_key, tenant_id, instance_id, module_key, effect_digest, outcome, member_data)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (effect_key) DO NOTHING
           RETURNING outcome`,
          [effect.effect_key, effect.tenant_id, effect.instance_id, moduleKey, effect.effect_digest, outcome, member],
        );
      if (inserted.rowCount !== 1) {
        const stored = (await pool.query<{ outcome: ApplyOutcome }>(
          'SELECT outcome FROM synthetic_module_effects WHERE effect_key=$1',
          [effect.effect_key],
        )).rows[0];
        return stored.outcome;
      }
      if (fault === 'crash_after') throw new Error('synthetic_crash_after');
      if (fault === 'ack_lost' || fault === 'foreign_owner') return 'unknown';
      return outcome;
    },
    async lookup(effectKey: string): Promise<LookupResult> {
      const fault = (await pool.query<{ fault: SyntheticFault }>(
        'SELECT fault FROM synthetic_module_faults WHERE module_key=$1',
        [moduleKey],
      )).rows[0]?.fault;
      if (fault === 'lookup_unreachable') return { status: 'unreachable' };
      const row = (await pool.query<{ tenant_id: string; effect_digest: string }>(
        'SELECT tenant_id, effect_digest FROM synthetic_module_effects WHERE effect_key=$1',
        [effectKey],
      )).rows[0];
      if (!row) return { status: 'absent' };
      return { status: 'found', owner_tenant_id: row.tenant_id, effect_digest: row.effect_digest };
    },
    async hasMemberData(q: PoolClient, instanceId: string) {
      const found = await q.query(
        'SELECT 1 FROM synthetic_module_effects WHERE instance_id=$1 AND member_data=true LIMIT 1',
        [instanceId],
      );
      return found.rowCount === 1;
    },
  };
}

/** Async providers for the synthetic storefront application. Not used by the worker sweep. */
export function syntheticModuleProviders(pool: Pool): ModuleProviderMap {
  return {
    'synthetic-inventory': providerFor(pool, 'synthetic-inventory'),
    'synthetic-storefront': providerFor(pool, 'synthetic-storefront'),
  };
}
