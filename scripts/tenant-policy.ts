import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { PoolClient } from 'pg';
import { createPool } from '../packages/db/index.js';

// Bounded operator policy replacement. Defaults to a read-only plan; --execute writes.
// Requires an explicit database URL and refuses production and the shared local database.
// Raising a ceiling needs a reviewed change.
export const CEILINGS = Object.freeze({
  max_active_instances: 50,
  max_instances_per_module: 10,
  max_concurrent_provisions: 5,
  max_work_items: 10000,
  max_retained_bytes: 1073741824,
  max_concurrent_jobs: 10,
});
// NULL means unlimited and is refused; private AI budgets need a later reviewed change.
export const REQUIRED_MODEL_BUDGET = 0;

export function policyLockKey(tenantId: string | null): string {
  // Match tenant-capacity.ts: in-flight tenant writes finish before the swap,
  // and later writes for that tenant see the new row.
  return `tenant.capacity/v1/${tenantId ?? 'default'}/policy`;
}

const FORMAT = 'freedom.tenant-capacity-policy/v1' as const;
type Limit = keyof typeof CEILINGS;
type Limits = Record<Exclude<Limit, 'max_retained_bytes'>, number> & { max_retained_bytes: string };
type PolicyInsert = Limits & {
  revision: string; tenant_id: string | null; plan_ref: string; max_model_budget: '0'; status: 'active';
};
export type PolicyRow = Limits & {
  policy_id: string; revision: string; tenant_id: string | null; plan_ref: string;
  max_model_budget: string | null; status: 'active' | 'retired'; created_at: string;
};
type Target = { database: string; role: string };
type Scope = { kind: 'default' | 'tenant'; tenant_id: string | null };
type Report =
  | { format: typeof FORMAT; status: 'refused'; code: string; flag?: string; ceiling?: number }
  | { format: typeof FORMAT; status: 'failed'; code: string; sqlstate?: string }
  | { format: typeof FORMAT; command: 'status'; executed: false; target: Target;
      default: PolicyRow | null; overrides: PolicyRow[]; retired: PolicyRow[]; retired_total: number }
  | { format: typeof FORMAT; command: 'plan' | 'apply'; executed: false; target: Target;
      scope: Scope; retire: PolicyRow | null; insert: PolicyInsert }
  | { format: typeof FORMAT; command: 'apply'; executed: true; target: Target;
      scope: Scope; retired: PolicyRow | null; inserted: PolicyRow; active_rows_for_scope: 1 };
type Result = { exitCode: 0 | 1 | 2; report: Report };

class Refusal extends Error {
  constructor(readonly code: string, readonly details: { flag?: string; ceiling?: number } = {}) { super(code); }
}
class ScopeVerificationFailure extends Error {}

const limitFlags = Object.keys(CEILINGS).map(key => `--${key.replaceAll('_', '-')}`);
const requiredFlags = ['--plan-ref', ...limitFlags, '--max-model-budget'];
function validate(argv: readonly string[], env: NodeJS.ProcessEnv): {
  command: 'status' | 'plan' | 'apply'; databaseUrl: string; execute: boolean;
  tenantId: string | null; policy: (Limits & { plan_ref: string }) | null;
} {
  const command = argv[0];
  if (command !== 'status' && command !== 'plan' && command !== 'apply') throw new Refusal('invalid_arguments');
  const values = new Map<string, string>();
  let execute = false;
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--execute') {
      if (command !== 'apply' || execute) throw new Refusal('invalid_arguments');
      execute = true;
      continue;
    }
    if (!['--database-url', '--tenant', ...requiredFlags].includes(flag) || values.has(flag)
      || (command === 'status' && flag !== '--database-url')
      || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Refusal('invalid_arguments');
    values.set(flag, argv[++i]);
  }
  if (env.NODE_ENV === 'production') throw new Refusal('production_refused');
  const databaseUrl = values.get('--database-url');
  if (!databaseUrl) throw new Refusal('database_url_required');
  let url: URL;
  let database: string;
  try {
    url = new URL(databaseUrl);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { throw new Refusal('invalid_database_url'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Refusal('invalid_database_url');
  // pg also accepts a query-string port override; neither spelling may reach the shared port.
  if (Number(url.port) === 54339 || url.searchParams.getAll('port').some(port => parseInt(port, 10) === 54339)
    || database === 'freedom_local') throw new Refusal('shared_local_database_refused');
  if (command === 'status') return { command, databaseUrl, execute, tenantId: null, policy: null };
  for (const flag of requiredFlags) if (!values.has(flag)) throw new Refusal('missing_flag', { flag });
  const planRef = values.get('--plan-ref')!;
  if ([...planRef].length < 1 || [...planRef].length > 120) throw new Refusal('invalid_plan_ref');
  const limits = {} as Limits;
  for (const key of Object.keys(CEILINGS) as Limit[]) {
    const flag = `--${key.replaceAll('_', '-')}`;
    const value = values.get(flag)!;
    if (!/^(0|[1-9][0-9]*)$/.test(value) || value.trim() !== value) throw new Refusal('invalid_integer', { flag });
    if (BigInt(value) > BigInt(CEILINGS[key])) throw new Refusal('over_ceiling', { flag, ceiling: CEILINGS[key] });
    if (key === 'max_retained_bytes') limits[key] = value;
    else limits[key] = Number(value);
  }
  if (values.get('--max-model-budget') !== String(REQUIRED_MODEL_BUDGET)) throw new Refusal('model_budget_must_be_zero');
  const tenantId = values.get('--tenant') ?? null;
  if (tenantId !== null && (tenantId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenantId))) {
    throw new Refusal('invalid_tenant_id');
  }
  return { command, databaseUrl, execute, tenantId, policy: { ...limits, plan_ref: planRef } };
}

const ROW_COLUMNS = `policy_id, revision::text AS revision, tenant_id, plan_ref,
  max_active_instances, max_instances_per_module, max_concurrent_provisions, max_work_items,
  max_retained_bytes::text AS max_retained_bytes, max_concurrent_jobs,
  max_model_budget::text AS max_model_budget, status, created_at`;
type DatabaseRow = Omit<PolicyRow, 'created_at'> & { created_at: Date };
function row(value: DatabaseRow): PolicyRow { return { ...value, created_at: value.created_at.toISOString() }; }
async function rows(client: PoolClient, suffix: string, params: unknown[] = []): Promise<PolicyRow[]> {
  return (await client.query<DatabaseRow>(`SELECT ${ROW_COLUMNS} FROM tenant_capacity_policies ${suffix}`, params)).rows.map(row);
}

export async function runTenantPolicy(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Result> {
  try {
    const input = validate(argv, env);
    const pool = createPool(input.databaseUrl);
    try {
      const client = await pool.connect();
      try {
        const write = input.command === 'apply' && input.execute;
        await client.query(write ? 'BEGIN' : 'BEGIN READ ONLY');
        if (write) {
          await client.query("SET LOCAL lock_timeout = '10s'");
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [policyLockKey(input.tenantId)]);
        }
        const target = (await client.query<Target>('SELECT current_database() AS database, current_user AS role')).rows[0];
        let report: Report;
        if (input.command === 'status') {
          report = { format: FORMAT, command: 'status', executed: false, target,
            default: (await rows(client, "WHERE status='active' AND tenant_id IS NULL"))[0] ?? null,
            overrides: await rows(client, "WHERE status='active' AND tenant_id IS NOT NULL ORDER BY tenant_id"),
            retired: await rows(client, "WHERE status='retired' ORDER BY created_at DESC, tenant_capacity_policies.revision DESC LIMIT 20"),
            retired_total: Number((await client.query("SELECT count(*)::text AS total FROM tenant_capacity_policies WHERE status='retired'")).rows[0].total),
          };
        } else {
          if (input.tenantId !== null && (await client.query('SELECT 1 FROM tenants WHERE tenant_id=$1', [input.tenantId])).rowCount !== 1) {
            throw new Refusal('tenant_not_found');
          }
          const scope: Scope = { kind: input.tenantId === null ? 'default' : 'tenant', tenant_id: input.tenantId };
          const current = (await rows(client, `WHERE status='active' AND tenant_id IS NOT DISTINCT FROM $1::uuid${write ? ' FOR UPDATE' : ''}`, [input.tenantId]))[0] ?? null;
          const revision = (await client.query<{ revision: string }>(`SELECT (COALESCE(max(revision), 0) + 1)::text AS revision
            FROM tenant_capacity_policies WHERE tenant_id IS NOT DISTINCT FROM $1::uuid`, [input.tenantId])).rows[0].revision;
          const insert: PolicyInsert = { ...input.policy!, revision, tenant_id: input.tenantId, max_model_budget: '0', status: 'active' };
          if (!write) {
            report = { format: FORMAT, command: input.command, executed: false, target, scope, retire: current, insert };
          } else {
            let retired: PolicyRow | null = null;
            if (current) {
              const update = await client.query<DatabaseRow>(`UPDATE tenant_capacity_policies SET status='retired'
                WHERE policy_id=$1 RETURNING ${ROW_COLUMNS}`, [current.policy_id]);
              if (update.rowCount !== 1) throw new ScopeVerificationFailure();
              retired = row(update.rows[0]);
            }
            const inserted = row((await client.query<DatabaseRow>(`INSERT INTO tenant_capacity_policies
              (policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
               max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active') RETURNING ${ROW_COLUMNS}`,
            [randomUUID(), revision, input.tenantId, insert.plan_ref, insert.max_active_instances, insert.max_instances_per_module,
              insert.max_concurrent_provisions, insert.max_work_items, insert.max_retained_bytes, insert.max_concurrent_jobs, REQUIRED_MODEL_BUDGET])).rows[0]);
            const active = await rows(client, "WHERE status='active' AND tenant_id IS NOT DISTINCT FROM $1::uuid", [input.tenantId]);
            if (active.length !== 1 || active[0].policy_id !== inserted.policy_id) throw new ScopeVerificationFailure();
            report = { format: FORMAT, command: 'apply', executed: true, target, scope, retired, inserted, active_rows_for_scope: 1 };
          }
        }
        await client.query('COMMIT');
        return { exitCode: 0, report };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    } finally { await pool.end(); }
  } catch (error) {
    if (error instanceof Refusal) return { exitCode: 2, report: { format: FORMAT, status: 'refused', code: error.code, ...error.details } };
    const state = (error as { code?: unknown } | null)?.code;
    const sqlstate = typeof state === 'string' && /^[0-9A-Z]{5}$/.test(state) ? state : undefined;
    const code = error instanceof ScopeVerificationFailure ? 'scope_verification_failed'
      : sqlstate === '55P03' ? 'lock_timeout' : sqlstate === '42501' ? 'operator_privilege_required' : 'database_error';
    return { exitCode: 1, report: { format: FORMAT, status: 'failed', code, ...(sqlstate ? { sqlstate } : {}) } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runTenantPolicy(process.argv.slice(2));
  (result.exitCode === 0 ? process.stdout : process.stderr).write(JSON.stringify(result.report) + '\n');
  process.exitCode = result.exitCode;
}
