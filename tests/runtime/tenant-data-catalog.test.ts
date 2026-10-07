import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { TENANT_DATA_CATALOG } from '../../modules/module-data/catalog.js';
import {
  admitsTenantScopeKind, checkTenantCatalog, introspectTenantSchema, tenantIsolationImportFindings, tenantPurposesFromConstraint,
  type TenantDataCatalog, type TenantSchemaSnapshot,
} from '../../modules/module-data/catalog-check.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Tenant catalog requires explicit disposable fp_* TEST_DATABASE_URL.');
}
const schema = `e1cat_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 });
const ENABLED = [
  'deployment_bindings', 'module_instances', 'scoped_command_receipts', 'scoped_outbox', 'scoped_transition_journal',
  'tenant_authority_audit', 'tenant_capacity_policies', 'tenant_high_risk_verifications', 'tenant_invitations', 'tenant_memberships',
  'tenant_ownership_transfers', 'tenant_recovery_cases',
  'tenant_work_result_targets', 'tenant_work_results', 'tenants', 'work_items', 'workspace_module_bindings', 'workspaces',
];
const EXEMPT = ['assets', 'asset_upload_intents', 'asset_objects', 'resource_scopes', 'users', 'sessions', 'principals'];

async function walk(dir: string, match: (name: string) => boolean): Promise<{ path: string; source: string }[]> {
  const found: { path: string; source: string }[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path, match));
    else if (match(entry.name)) found.push({ path, source: await readFile(path, 'utf8') });
  }
  return found;
}

async function liveSnapshot(q: PoolClient): Promise<TenantSchemaSnapshot> {
  return introspectTenantSchema(q, schema);
}

async function rolled<T>(run: (q: PoolClient, snapshot: TenantSchemaSnapshot) => Promise<T>): Promise<T> {
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    const result = await run(q, await liveSnapshot(q));
    await q.query('ROLLBACK');
    return result;
  } catch (error) {
    try { await q.query('ROLLBACK'); } catch { /* the original error is the assertion */ }
    throw error;
  } finally {
    q.release();
  }
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test('T-021 CHECK parser accepts PostgreSQL equality, ANY arrays, parentheses, IN and AND/OR', () => {
  // These cast-bearing literals are pg_get_constraintdef output from PG18.
  for (const definition of [
    "CHECK ((scope_kind = 'tenant'::text))",
    "CHECK ((scope_kind = ANY (ARRAY['personal'::text, 'tenant'::text])))",
    "CHECK ((scope_kind = ANY (ARRAY['personal', 'tenant'])))",
    "CHECK (((((scope_kind)) = ANY ((ARRAY[(('personal'))::text, (('tenant'))::text])))))",
    "CHECK (scope_kind IN ('personal', 'tenant'))",
    "CHECK (((scope_kind <> 'tenant'::text) OR (scope_kind = 'tenant'::text)))",
    "CHECK (((scope_kind = 'tenant'::text) AND (scope_id IS NOT NULL)))",
  ]) assert.equal(admitsTenantScopeKind(definition), true, definition);
  assert.deepEqual(tenantPurposesFromConstraint("CHECK ((((scope_kind = 'personal'::text) AND (purpose = ANY (ARRAY['member.avatar'::text, 'work.private-draft'::text]))) OR ((scope_kind = 'tenant'::text) AND (purpose = ANY (ARRAY['work.tenant-result'::text, 'tenant.crm-note'::text])))))"), ['tenant.crm-note', 'work.tenant-result']);
  assert.deepEqual(tenantPurposesFromConstraint("CHECK (((scope_kind = 'tenant') AND purpose IN ('work.tenant-result', 'tenant.crm-note')) OR ((scope_kind = 'personal') AND purpose = 'member.avatar'))"), ['tenant.crm-note', 'work.tenant-result']);
  assert.deepEqual(tenantPurposesFromConstraint("CHECK ((((scope_kind)) = 'tenant'::text AND ((purpose)) = ANY ((ARRAY[(('work.tenant-result'))::text, 'tenant.crm-note']))))"), ['tenant.crm-note', 'work.tenant-result']);
});

test('T-021 CHECK parser excludes negative tenant branches and fails closed on unknown forms', () => {
  for (const definition of [
    "CHECK ((scope_kind <> ALL (ARRAY['personal'::text, 'tenant'::text])))",
    "CHECK ((scope_kind <> 'tenant'::text))",
    "CHECK (scope_kind NOT IN ('personal', 'tenant'))",
    "CHECK (((scope_kind <> 'tenant'::text) AND (scope_id IS NOT NULL)))",
    "CHECK (((scope_kind = 'personal'::text) OR (scope_kind <> 'tenant'::text)))",
  ]) {
    assert.equal(admitsTenantScopeKind(definition), false, definition);
    assert.deepEqual(tenantPurposesFromConstraint(`${definition.slice(0, -1)} AND purpose = 'tenant.crm-note')`), []);
  }
  assert.equal(admitsTenantScopeKind("CHECK ((lower(scope_kind) = 'tenant'::text))"), true);
  assert.equal(admitsTenantScopeKind("CHECK ((scope_kind LIKE 'tenant'::text))"), true);
  assert.equal(admitsTenantScopeKind("CHECK ((scope_kind = 'personal'::text))"), false);
});

test('T-021 PostgreSQL IN scope checks expose an unregistered tenant table', async () => {
  assert.deepEqual(await rolled(async q => {
    await q.query("CREATE TABLE private_cache (cache_id uuid PRIMARY KEY, scope_kind text CHECK (scope_kind IN ('personal', 'tenant')))");
    const definition = (await q.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='private_cache'::regclass AND contype='c'`)).rows[0].definition;
    assert.equal(definition, "CHECK ((scope_kind = ANY (ARRAY['personal'::text, 'tenant'::text])))");
    const snapshot = await liveSnapshot(q);
    assert.ok(snapshot.detected.includes('private_cache'));
    return checkTenantCatalog(snapshot, TENANT_DATA_CATALOG);
  }), [{ code: 'unregistered_table', subject: 'private_cache' }]);
});

test('T-021 PostgreSQL IN tenant-purpose checks expose an unregistered asset purpose', async () => {
  assert.deepEqual(await rolled(async q => {
    const definition = (await q.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='assets'::regclass AND conname='asset_scope_purpose'`)).rows[0].definition;
    const extended = definition.replace("purpose = 'work.tenant-result'::text", "purpose IN ('work.tenant-result', 'tenant.crm-note')");
    assert.notEqual(extended, definition);
    await q.query('ALTER TABLE assets DROP CONSTRAINT asset_scope_purpose');
    await q.query(`ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose ${extended}`);
    const snapshot = await liveSnapshot(q);
    assert.deepEqual(snapshot.asset_purposes, ['tenant.crm-note', 'work.tenant-result']);
    return checkTenantCatalog(snapshot, TENANT_DATA_CATALOG);
  }), [{ code: 'unregistered_asset_purpose', subject: 'tenant.crm-note' }]);
});

test('T-021 installed schema matches the frozen tenant data catalog', async () => {
  const q = await pool.connect();
  try {
    const findings = checkTenantCatalog(await liveSnapshot(q), TENANT_DATA_CATALOG);
    assert.deepEqual(findings, []);
  } finally {
    q.release();
  }
  assert.equal(Object.isFrozen(TENANT_DATA_CATALOG), true);
  assert.deepEqual(TENANT_DATA_CATALOG.datasets.map(dataset => dataset.dataset_key), ['DC-04', 'DC-06', 'DC-13', 'DC-14']);
  const flags = (await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2::text[])
      ORDER BY c.relname`, [schema, [...ENABLED, ...EXEMPT]])).rows;
  for (const name of ENABLED) {
    const row = flags.find(item => item.relname === name);
    assert.equal(row?.relrowsecurity, true, name);
    assert.equal(row?.relforcerowsecurity, false, name);
  }
  for (const name of EXEMPT) {
    const row = flags.find(item => item.relname === name);
    assert.equal(row?.relrowsecurity, false, name);
    assert.equal(row?.relforcerowsecurity, false, name);
    const entry = TENANT_DATA_CATALOG.exemptions.find(item => item.table === name);
    assert.equal(typeof entry?.reason, 'string');
    assert.ok(entry && entry.reason.length > 0);
  }
});

test('T-021 catalog checker rejects unregistered columns, tables, policy drift, force, and unbounded retention', async () => {
  assert.deepEqual(await rolled(async q => checkTenantCatalog(await liveSnapshot(q), TENANT_DATA_CATALOG)), []);
  assert.deepEqual(await rolled(async q => {
    await q.query('ALTER TABLE work_items ADD COLUMN crm_note text');
    return checkTenantCatalog(await liveSnapshot(q), TENANT_DATA_CATALOG);
  }), [{ code: 'unregistered_column', subject: 'work_items.crm_note' }]);
  assert.deepEqual(await rolled(async q => {
    await q.query('CREATE TABLE tenant_crm_notes (note_id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants(tenant_id))');
    return checkTenantCatalog(await liveSnapshot(q), TENANT_DATA_CATALOG);
  }), [{ code: 'unregistered_table', subject: 'tenant_crm_notes' }]);
  assert.deepEqual(await rolled(async q => {
    await q.query(`CREATE TABLE crm_shadow (shadow_id uuid PRIMARY KEY, workspace_ref uuid NOT NULL REFERENCES workspaces(workspace_id))`);
    return checkTenantCatalog(await liveSnapshot(q), TENANT_DATA_CATALOG);
  }), [{ code: 'unregistered_table', subject: 'crm_shadow' }]);
  assert.deepEqual(await rolled(async q => {
    await q.query('ALTER TABLE module_instances DISABLE ROW LEVEL SECURITY');
    return checkTenantCatalog(await liveSnapshot(q), TENANT_DATA_CATALOG);
  }), [{ code: 'rls_mismatch', subject: 'module_instances' }]);
  assert.deepEqual(await rolled(async q => {
    await q.query('ALTER TABLE tenant_work_results FORCE ROW LEVEL SECURITY');
    return checkTenantCatalog(await liveSnapshot(q), TENANT_DATA_CATALOG);
  }), [{ code: 'force_rls_set', subject: 'tenant_work_results' }]);
  assert.deepEqual(await rolled(async q => {
    await q.query('DROP POLICY work_items_tenant ON work_items');
    return checkTenantCatalog(await liveSnapshot(q), TENANT_DATA_CATALOG);
  }), [{ code: 'policy_mismatch', subject: 'work_items' }]);
  const cloned = structuredClone(TENANT_DATA_CATALOG);
  const forever: TenantDataCatalog = {
    ...cloned,
    datasets: cloned.datasets.map(dataset => dataset.dataset_key === 'DC-14'
      ? { ...dataset, central_retention: 'forever' }
      : dataset),
  };
  const q = await pool.connect();
  try {
    assert.deepEqual(checkTenantCatalog(await liveSnapshot(q), forever), [{ code: 'retention_unbounded', subject: 'DC-14' }]);
    const snapshot = await liveSnapshot(q);
    const missing: TenantSchemaSnapshot = {
      schema: snapshot.schema,
      tables: snapshot.tables.filter(table => table.name !== 'agent_connections'),
      detected: snapshot.detected.filter(name => name !== 'agent_connections'),
      asset_purposes: snapshot.asset_purposes,
    };
    assert.deepEqual(checkTenantCatalog(missing, TENANT_DATA_CATALOG), [{ code: 'stale_location', subject: 'agent_connections' }]);
  } finally {
    q.release();
  }
});

test('T-021 tenant modules do not import the legacy transaction helper or call pool.query', async () => {
  const files = [
    ...await walk('modules/tenant-workspaces', name => name.endsWith('.ts')),
    ...await walk('modules/module-registry', name => name.endsWith('.ts')),
    ...await walk('modules/opportunity-project-work', name => name.startsWith('tenant-') && name.endsWith('.ts')),
    ...await walk('modules/autopilot-work', name => name === 'tenant-results.ts'),
    ...await walk('modules/assets', name => name === 'tenant-lifecycle-authority.ts'),
  ];
  assert.ok(files.length >= 5);
  assert.deepEqual(tenantIsolationImportFindings(files), []);
  const commented = `// import { transaction } from '../../packages/db/transaction.js'\n// pool.query('select 1')\nexport const ok = 1;\n`;
  assert.deepEqual(tenantIsolationImportFindings([{ path: 'commented.ts', source: commented }]), []);
  assert.deepEqual(tenantIsolationImportFindings([{
    path: 'synthetic.ts',
    source: `import { transaction } from '../../packages/db/transaction.js';\nawait pool.query('select 1');\n`,
  }]), [
    { path: 'synthetic.ts', kind: 'db_transaction_import' },
    { path: 'synthetic.ts', kind: 'pool_query' },
  ]);
});
