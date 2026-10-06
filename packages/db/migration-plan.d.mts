export const LEGACY_MIGRATIONS: 'freedom.migrations/legacy-v1';
export const DAG_MIGRATIONS: 'freedom.migrations/dag-v2';
export const MIGRATION_LIMITS: Readonly<{ files: number; fileBytes: number; totalBytes: number; metadataBytes: number; dependencies: number }>;
export const MIGRATION_V2_GUARD: string;
export interface MigrationSource { name: string; sql: string }
export interface MigrationLedgerRow { name: string; sha256: string }
export interface LegacyMigrationProfile { format: typeof LEGACY_MIGRATIONS; first: number; last: number; known_gaps: number[] }
export interface DagMigrationProfile { format: typeof DAG_MIGRATIONS; legacy: LegacyMigrationProfile; legacy_ledger: MigrationLedgerRow[] }
export class MigrationPlanError extends Error { readonly code: string; constructor(code: string, detail?: string) }
export function migrationDigest(sql: string): string;
export function migrationLedgerDigest(ledger: readonly MigrationLedgerRow[]): string;
export function legacyMigrationProfile(expected: { first: number; last: number; known_gaps: number[]; format?: string }): LegacyMigrationProfile;
export function resolveMigrationPlan(sources: MigrationSource[], profile: LegacyMigrationProfile | DagMigrationProfile, applied?: MigrationLedgerRow[]): Readonly<{
  format: 'freedom.migration-plan/v1'; profile: string;
  ledger: readonly Readonly<MigrationLedgerRow>[]; dependencies: readonly Readonly<{ name: string; depends_on: readonly string[] }>[];
  execution_order: readonly string[]; pending: readonly string[]; ledger_digest: string; plan_digest: string;
  known_gaps: readonly number[]; sql: Readonly<Record<string, string>>;
}>;
