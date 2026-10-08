import type { PoolClient } from 'pg';
import { digestOf } from './canonical.js';

export interface ProvisionEffect {
  effect_key: string;
  tenant_id: string;
  instance_id: string;
  module_key: string;
  effect_digest: string;
}

export type ApplyOutcome = 'confirmed' | 'failed_known' | 'unknown';
export type LookupResult =
  | { status: 'found'; owner_tenant_id: string; effect_digest: string }
  | { status: 'absent' }
  | { status: 'unreachable' };

/** Runs inside the launch transaction and may only read or write its own module tables. */
export interface TransactionalModuleProvider {
  kind: 'transactional';
  initialise(q: PoolClient, effect: ProvisionEffect): Promise<void>;
  hasMemberData(q: PoolClient, instanceId: string): Promise<boolean>;
}

/** Called only after commit, never while a database lock is held. */
export interface AsyncModuleProvider {
  kind: 'async';
  apply(effect: ProvisionEffect): Promise<ApplyOutcome>;
  lookup(effect_key: string): Promise<LookupResult>;
  hasMemberData(q: PoolClient, instanceId: string): Promise<boolean>;
}

export type ModuleProvider = TransactionalModuleProvider | AsyncModuleProvider;
export type ModuleProviderMap = Record<string, ModuleProvider>;

export function effectDigest(effect: Omit<ProvisionEffect, 'effect_digest'>): string {
  return digestOf({
    effect_key: effect.effect_key,
    tenant_id: effect.tenant_id,
    instance_id: effect.instance_id,
    module_key: effect.module_key,
  });
}

/**
 * Work provisioning creates no work item. The initialiser lives here, not in the work module,
 * so the registry does not import a downstream business service. Member data is a SQL read of
 * work_items and never an insert.
 */
export const hostedWorkProvider: TransactionalModuleProvider = {
  kind: 'transactional',
  async initialise() {},
  async hasMemberData(q, instanceId) {
    const found = await q.query(
      `SELECT 1 FROM work_items WHERE instance_id=$1 AND work_mode='tenant_execution' LIMIT 1`,
      [instanceId],
    );
    return found.rowCount === 1;
  },
};

export function defaultModuleProviders(): ModuleProviderMap {
  return { work: hostedWorkProvider };
}

export function resolveProviders(injected?: ModuleProviderMap): ModuleProviderMap {
  return { ...defaultModuleProviders(), ...injected };
}
