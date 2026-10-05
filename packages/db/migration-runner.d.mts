import type { Pool } from 'pg';
import type { MigrationSource, LegacyMigrationProfile, DagMigrationProfile } from './migration-plan.mjs';
export interface MigrationTarget { database: string; role: string; schema: string }
export function runMigrationPlan(pool: Pool, input: { sources: MigrationSource[]; profile: LegacyMigrationProfile | DagMigrationProfile; target?: MigrationTarget }): Promise<Readonly<{
  format: 'freedom.migration-run/v1'; profile: string; plan_digest: string; ledger_digest: string;
  before_ledger_digest: string; applied: readonly string[]; observed_ledger_digest: string; deployment_authorized: false;
}>>;
