import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

// Bounded operator policy replacement. Defaults to a read-only plan; --execute writes.
// Requires a URL with user, host, port and database (no PG* or .pgpass fallback), plus an
// expected name checked against current_database() before any other query; refuses shared local targets on connected values.
// Refuses a NODE_ENV=production process: a client-process guard, not server-environment detection.
// Raising a ceiling needs a reviewed change.
// Expected-revision guard and operation-ID replay protect applies; remote TLS requires verify-full.
// Revisions advance globally under a transaction advisory lock.
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

export function operationPolicyId(operationId: string): string {
  const bytes = createHash('sha256').update(`freedom.tenant-capacity-policy/v1/operation/${operationId}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  | { format: typeof FORMAT; status: 'refused'; code: string; flag?: string; ceiling?: number; expected?: string; connected?: string; current?: string }
  | { format: typeof FORMAT; status: 'failed'; code: string; sqlstate?: string }
  | { format: typeof FORMAT; command: 'status'; executed: false; target: Target;
      default: PolicyRow | null; overrides: PolicyRow[]; retired: PolicyRow[]; retired_total: number }
  | { format: typeof FORMAT; command: 'plan' | 'apply'; executed: false; target: Target;
      scope: Scope; retire: PolicyRow | null; insert: PolicyInsert; expect_revision: string; provisional_revision: true }
  | { format: typeof FORMAT; command: 'apply'; executed: true; target: Target;
      scope: Scope; replayed: false; retired: PolicyRow | null; inserted: PolicyRow; active_rows_for_scope: 1 }
  | { format: typeof FORMAT; command: 'apply'; executed: true; target: Target;
      scope: Scope; replayed: true; inserted: PolicyRow; active_rows_for_scope: number };
type Result = { exitCode: 0 | 1 | 2; report: Report };

class Refusal extends Error {
  constructor(readonly code: string, readonly details: { flag?: string; ceiling?: number; expected?: string; connected?: string; current?: string } = {}) { super(code); }
}
class ScopeVerificationFailure extends Error {}

const limitFlags = Object.keys(CEILINGS).map(key => `--${key.replaceAll('_', '-')}`);
const requiredFlags = ['--plan-ref', ...limitFlags, '--max-model-budget'];
function databaseConfig(databaseUrl: string): PoolConfig {
  let url: URL;
  let database: string, user: string, password: string;
  try {
    url = new URL(databaseUrl);
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { throw new Refusal('invalid_database_url'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Refusal('invalid_database_url');
  const port = Number(url.port);
  // Preserve the shared-port refusal even for a query override that is otherwise invalid.
  if (port === 54339 || url.searchParams.getAll('port').some(port => parseInt(port, 10) === 54339)
    || database === 'freedom_local') throw new Refusal('shared_local_database_refused');
  const keys = [...url.searchParams.keys()];
  const sslmode = url.searchParams.get('sslmode'), options = url.searchParams.get('options');
  if (!url.hostname || url.hostname.includes('%') || !url.port || !Number.isInteger(port) || port < 1 || port > 65535
    || !user || !database || database.includes('/') || url.hash
    || keys.some(key => !['sslmode', 'options'].includes(key) || url.searchParams.getAll(key).length !== 1)
    || (sslmode !== null && !['verify-full', 'disable'].includes(sslmode)) || options === '') {
    throw new Refusal('invalid_database_url');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1'
    || (/^127(?:\.[0-9]{1,3}){3}$/.test(host) && host.split('.').every(part => Number(part) <= 255));
  if (!loopback && sslmode !== 'verify-full') throw new Refusal('tls_required');
  return {
    host, port, database, user, password: () => password,
    ssl: sslmode === 'verify-full' ? { rejectUnauthorized: true } : false,
    sslnegotiation: 'postgres', client_encoding: 'UTF8', application_name: 'freedom-tenant-policy',
    // A truthy default blocks PGOPTIONS (including search_path) and only repeats the application name.
    options: options ?? '-c application_name=freedom-tenant-policy', max: 1, connectionTimeoutMillis: 5000,
  };
}
function validate(argv: readonly string[], env: NodeJS.ProcessEnv): {
  command: 'status' | 'plan' | 'apply'; config: PoolConfig; expectedDatabase: string; execute: boolean;
  tenantId: string | null; policy: (Limits & { plan_ref: string }) | null;
  expectedRevision?: string; operationId?: string;
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
    if (!['--database-url', '--expect-database', '--expect-revision', '--operation-id', '--tenant', ...requiredFlags].includes(flag) || values.has(flag)
      || (command === 'status' && !['--database-url', '--expect-database'].includes(flag))
      || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Refusal('invalid_arguments');
    values.set(flag, argv[++i]);
  }
  if (values.has('--operation-id') && (command !== 'apply' || !execute)) throw new Refusal('invalid_arguments');
  if (env.NODE_ENV === 'production') throw new Refusal('production_refused');
  const databaseUrl = values.get('--database-url');
  if (!databaseUrl) throw new Refusal('database_url_required');
  const config = databaseConfig(databaseUrl);
  if (!values.has('--expect-database')) throw new Refusal('missing_flag', { flag: '--expect-database' });
  const expectedDatabase = values.get('--expect-database')!;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(expectedDatabase) || expectedDatabase.trim() !== expectedDatabase) {
    throw new Refusal('invalid_expected_database');
  }
  if (command === 'status') return { command, config, expectedDatabase, execute, tenantId: null, policy: null };
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
  const expectedRevision = values.get('--expect-revision'), operationId = values.get('--operation-id');
  if (execute && expectedRevision === undefined) throw new Refusal('missing_flag', { flag: '--expect-revision' });
  if (expectedRevision !== undefined && (!/^(none|[1-9][0-9]{0,18})$/.test(expectedRevision) || expectedRevision.trim() !== expectedRevision)) {
    throw new Refusal('invalid_expected_revision');
  }
  if (execute && operationId === undefined) throw new Refusal('missing_flag', { flag: '--operation-id' });
  if (operationId !== undefined && (!/^[a-z0-9][a-z0-9._-]{7,63}$/.test(operationId) || operationId.trim() !== operationId)) {
    throw new Refusal('invalid_operation_id');
  }
  return { command, config, expectedDatabase, execute, tenantId, expectedRevision, operationId, policy: { ...limits, plan_ref: planRef } };
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
    const pool = new Pool(input.config);
    try {
      const client = await pool.connect();
      try {
        const write = input.command === 'apply' && input.execute;
        await client.query(write ? 'BEGIN' : 'BEGIN READ ONLY');
        const target = (await client.query<Target>('SELECT current_database() AS database, current_user AS role')).rows[0];
        if (target.database !== input.expectedDatabase) {
          throw new Refusal('database_mismatch', { expected: input.expectedDatabase, connected: target.database });
        }
        if (write) {
          await client.query("SET LOCAL lock_timeout = '10s'");
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [policyLockKey(input.tenantId)]);
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant.capacity/v1/policy-revisions', 0))");
        }
        let report: Report;
        if (input.command === 'status') {
          report = { format: FORMAT, command: 'status', executed: false, target,
            default: (await rows(client, "WHERE status='active' AND tenant_id IS NULL"))[0] ?? null,
            overrides: await rows(client, "WHERE status='active' AND tenant_id IS NOT NULL ORDER BY tenant_id"),
            retired: await rows(client, "WHERE status='retired' ORDER BY created_at DESC, tenant_capacity_policies.revision DESC LIMIT 20"),
            retired_total: Number((await client.query("SELECT count(*)::text AS total FROM tenant_capacity_policies WHERE status='retired'")).rows[0].total),
          };
        } else {
          const scope: Scope = { kind: input.tenantId === null ? 'default' : 'tenant', tenant_id: input.tenantId };
          const policyId = write ? operationPolicyId(input.operationId!) : null;
          if (write) {
            const replay = (await rows(client, 'WHERE policy_id=$1', [policyId]))[0];
            if (replay) {
              if (replay.tenant_id !== input.tenantId || replay.plan_ref !== input.policy!.plan_ref
                || replay.max_model_budget !== '0'
                || (Object.keys(CEILINGS) as Limit[]).some(key => replay[key] !== input.policy![key])) {
                throw new Refusal('operation_id_conflict');
              }
              const activeCount = Number((await client.query(`SELECT count(*)::text AS total FROM tenant_capacity_policies
                WHERE status='active' AND tenant_id IS NOT DISTINCT FROM $1::uuid`, [input.tenantId])).rows[0].total);
              await client.query('COMMIT');
              return { exitCode: 0, report: { format: FORMAT, command: 'apply', executed: true, replayed: true,
                target, scope, inserted: replay, active_rows_for_scope: activeCount } };
            }
          }
          if (input.tenantId !== null && (await client.query('SELECT 1 FROM tenants WHERE tenant_id=$1', [input.tenantId])).rowCount !== 1) {
            throw new Refusal('tenant_not_found');
          }
          const current = (await rows(client, `WHERE status='active' AND tenant_id IS NOT DISTINCT FROM $1::uuid${write ? ' FOR UPDATE' : ''}`, [input.tenantId]))[0] ?? null;
          const currentRevision = current?.revision ?? 'none';
          if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
            throw new Refusal('revision_conflict', { expected: input.expectedRevision, current: currentRevision });
          }
          const revision = (await client.query<{ revision: string }>(`SELECT (COALESCE(max(revision), 0) + 1)::text AS revision
            FROM tenant_capacity_policies`)).rows[0].revision;
          const insert: PolicyInsert = { ...input.policy!, revision, tenant_id: input.tenantId, max_model_budget: '0', status: 'active' };
          if (!write) {
            report = { format: FORMAT, command: input.command, executed: false, target, scope, retire: current, insert,
              expect_revision: currentRevision, provisional_revision: true };
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
            [policyId, revision, input.tenantId, insert.plan_ref, insert.max_active_instances, insert.max_instances_per_module,
              insert.max_concurrent_provisions, insert.max_work_items, insert.max_retained_bytes, insert.max_concurrent_jobs, REQUIRED_MODEL_BUDGET])).rows[0]);
            const active = await rows(client, "WHERE status='active' AND tenant_id IS NOT DISTINCT FROM $1::uuid", [input.tenantId]);
            if (active.length !== 1 || active[0].policy_id !== inserted.policy_id) throw new ScopeVerificationFailure();
            report = { format: FORMAT, command: 'apply', executed: true, replayed: false, target, scope, retired, inserted, active_rows_for_scope: 1 };
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
