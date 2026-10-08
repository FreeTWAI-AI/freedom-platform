// Real coordinator -> sealed archive -> quarantine restore proves complete tenant
// rows, references, bytes and restored runtime isolation after migration 125.
// Synthetic local data only; production backup role grants are not verified.
// T-046 copy/backup cleanup is not_run: OPEN-07 values are decided, no executor exists.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rename, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { Pool, Client, type PoolClient } from 'pg';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrate } from '../../scripts/database.js';
import { bindPrincipalContext, bindTenantContext, isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { createAssetMaintenance } from '../../modules/assets/maintenance.js';
import { createR2ObjectStore, type AssetR2Binding } from '../../packages/asset-storage/r2.js';
import { objectKey, sha256, writeVerifiedObject, readVerifiedObject, type ObjectStore, type ObjectMetadata } from '../../packages/asset-storage/index.js';
import { createConsistentAssetBackup, ConsistentBackupError, type ConsistentBackup } from '../../packages/media-migration/backup-coordinator.js';
import { collectSchemaEvidence, compareEvidence, type SchemaEvidence } from '../../packages/media-migration/backup-evidence.js';
import { createFileArchiveStore } from '../../packages/media-migration/backup-archive-fs.js';
import { sealRecoverySet, readbackRecoverySet, restoreRecoverySet, restoredReferenceAuthorization, type RecoverySetRestore } from '../../packages/media-migration/backup-archive.js';
import { lockdownRestoredMediaAcl } from '../../packages/media-migration/restore-acl-lockdown.js';

// Admit the exact pinned fixture before constructing any database connection.
const configured = process.env.TEST_DATABASE_URL;
const container = process.env.TEST_POSTGRES_CONTAINER_ID;
assert(configured && container, 'Explicit TEST_DATABASE_URL and TEST_POSTGRES_CONTAINER_ID required');
assert.match(container, /^[0-9a-f]{64}$/);
const url = new URL(configured);
assert.match(url.pathname, /^\/fp_[a-z0-9_]+$/);
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.notEqual(url.port, '54339', 'Shared database port is forbidden');
const details = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 }))[0];
assert.equal(details.Id, container);
assert.equal(details.Config.Image, 'postgres:18-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd');
const runnerOwned = details.Config.Labels?.['freedom.task'] === 'media-restore-drill'
  && details.Config.Labels?.['freedom.owner'] === 'run-media-restore-test'
  && details.HostConfig.NetworkMode === 'none'
  && Object.keys(details.HostConfig.PortBindings ?? {}).length === 0
  && Boolean(details.HostConfig.Tmpfs?.['/var/lib/postgresql']);
const localServer = /^\/fp-[a-z0-9-]+$/.test(details.Name)
  && JSON.stringify(details.HostConfig.PortBindings?.['5432/tcp']) === JSON.stringify([{ HostIp: '127.0.0.1', HostPort: url.port }])
  && !url.searchParams.has('host') && url.pathname.startsWith('/fp_job_');
assert.equal(Number(runnerOwned) + Number(localServer), 1, 'Exactly one isolated container shape required');
if (localServer) assert.deepEqual(details.HostConfig.PortBindings['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: url.port }]);
const database = url.pathname.slice(1);
const superuser = decodeURIComponent(url.username);
const stamp = `${process.pid}_${Date.now()}`;
const schema = `fp_j6s_${stamp}`;
const migrator = `fp_j6m_${stamp}`;
const runtimeRole = `fp_j6a_${stamp}`;
const backupRole = `fp_j6b_${stamp}`;
const readerRole = `fp_j6r_${stamp}`;
function assertIdent(value: string) { assert.match(value, /^[a-z_][a-z0-9_]*$/); assert(value.length < 63); }
for (const name of [schema, migrator, runtimeRole, backupRole, readerRole]) assertIdent(name);
function roleUrl(role: string, target = database) {
  const connection = new URL(url);
  connection.username = role; connection.password = ''; connection.pathname = '/' + target;
  return connection.href;
}
const pools: { pool: Pool; closed: Promise<void>[] }[] = [];
function poolFor(role: string, target = database, max = 2) {
  const pool = new Pool({ connectionString: roleUrl(role, target), options: `-c search_path=${schema} -c statement_timeout=30000`, max });
  const closed: Promise<void>[] = [];
  pool.on('connect', client => closed.push(new Promise<void>(resolve => client.once('end', resolve))));
  pools.push({ pool, closed });
  return pool;
}
const admin = poolFor(superuser);
const owner = poolFor(migrator);
const backupPool = poolFor(backupRole);
const readerPool = poolFor(readerRole);
let restoredPool: Pool;
let runtimePool: Pool;
let restoredDatabase = '';
let createdSchema = false;
const createdRoles: string[] = [];
let mf: Miniflare | undefined;
let root: string | undefined;
let outbound = 0;
let source: ObjectStore;
let backupObjects: ObjectStore;
let restoredObjects: ObjectStore;
let maintenance: ReturnType<typeof createAssetMaintenance>;
let backup: ConsistentBackup;
let ownerEvidence: SchemaEvidence;
let recovered: RecoverySetRestore;
let snapshotAssets = 0;
let defaultDump: Awaited<ReturnType<typeof pgTool>>;
let visibleDump: Awaited<ReturnType<typeof pgTool>>;
let visibleCounts: Record<string, number>;
const started = performance.now();

// Diagnostics are bounded and retained only for assertions, never printed.
async function pgTool(tool: 'pg_dump' | 'pg_restore', role: string, args: string[], input?: Uint8Array): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const child = spawn('docker', ['exec', ...(input ? ['-i'] : []), container!, tool, '-U', role, ...args], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const chunks: Buffer[] = [], errors: Buffer[] = [];
  let size = 0, errorSize = 0, failed = false;
  const stop = () => { failed = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} };
  const timer = setTimeout(stop, 30000);
  child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024 * 1024) stop(); else chunks.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { const kept = chunk.subarray(0, Math.max(0, 64 * 1024 - errorSize)); errors.push(kept); errorSize += kept.length; });
  child.stdin.on('error', () => undefined); child.stdin.end(input);
  try {
    const code = await new Promise<number | null>(resolve => {
      child.once('error', () => { failed = true; resolve(-1); });
      child.once('close', resolve);
    });
    return { code: failed ? -1 : code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors).toString('utf8') };
  } finally { clearTimeout(timer); }
}

function copyCounts(dump: Buffer): Record<string, number> {
  const counts: Record<string, number> = {};
  let table: string | undefined;
  for (const line of dump.toString('utf8').split('\n')) {
    if (table) { if (line === '\\.') table = undefined; else counts[table]++; }
    else {
      const match = /^COPY ([a-z0-9_]+)\.([a-z0-9_]+) \(.*\) FROM stdin;$/.exec(line);
      if (match?.[1] === schema) { table = match[2]; assert.equal(counts[table], undefined); counts[table] = 0; }
    }
  }
  assert.equal(table, undefined, 'COPY block must be complete');
  return counts;
}

const RLS_TABLES = [
  'tenants', 'tenant_memberships', 'tenant_invitations', 'workspaces', 'tenant_authority_audit', 'module_instances',
  'tenant_high_risk_verifications', 'tenant_ownership_transfers', 'tenant_recovery_cases', 'tenant_module_permissions',
  'deployment_bindings', 'workspace_module_bindings', 'tenant_work_results', 'tenant_work_result_targets',
  'tenant_capacity_policies', 'work_items', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox',
  'application_installations', 'application_module_links', 'module_dependencies', 'module_launch_plans',
  'module_launch_plan_consumptions', 'module_provision_operations', 'module_provision_steps', 'capacity_reservations', 'capacity_ledger',
];
const sha = 'ab'.repeat(32);

interface Person { userId: string; principalId: string; personalScopeId: string }
interface ResultObject {
  assetId: string; representationId: string; intentId: string;
  key: ReturnType<typeof objectKey>; bytes: Uint8Array; metadata: ObjectMetadata;
}
interface Space {
  tenantId: string; scopeId: string; workspaceId: string; instanceId: string; bindingId: string;
  workId: string; resultId: string; invitationId: string; auditId: string; receiptKey: string;
  transitionId: string; eventId: string; policyId: string;
  object?: ResultObject;
}
const people: { p1: Person; p2: Person; p3: Person } = {
  p1: { userId: '', principalId: '', personalScopeId: '' },
  p2: { userId: '', principalId: '', personalScopeId: '' },
  p3: { userId: '', principalId: '', personalScopeId: '' },
};
const spaces = { a: blankSpace(), b: blankSpace(), c: blankSpace() };
let personalWorkId = '';
let personalReceiptKey = '';
let personalTransitionId = '';
let personalEventId = '';
let defaultPolicyId = '';

function blankSpace(): Space {
  return {
    tenantId: randomUUID(), scopeId: randomUUID(), workspaceId: randomUUID(), instanceId: randomUUID(),
    bindingId: randomUUID(), workId: randomUUID(), resultId: randomUUID(), invitationId: randomUUID(),
    auditId: randomUUID(), receiptKey: `receipt${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    transitionId: randomUUID(), eventId: randomUUID(), policyId: randomUUID(),
  };
}
function log(check: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({ check, ...payload }));
}
async function column(q: Pool | PoolClient, sql: string, params: unknown[] = []): Promise<string[]> {
  const rows = (await q.query<{ id: string }>(sql, params)).rows;
  return rows.map(row => row.id).sort();
}
async function backend(q: PoolClient): Promise<number> {
  return Number((await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
}
async function bindSpace(q: PoolClient, person: Person, space: Space) {
  await bindPrincipalContext(q, person.principalId);
  await bindTenantContext(q, { tenantId: space.tenantId, tenantScopeId: space.scopeId });
}
async function person(email: string): Promise<Person> {
  const userId = randomUUID();
  const principalId = randomUUID();
  const personalScopeId = randomUUID();
  await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,(SELECT community_id FROM communities LIMIT 1),$2,$3,'not-a-login',$4)`,
  [userId, email, email, randomUUID()]);
  await owner.query(`INSERT INTO principals(principal_id,kind,user_ref) VALUES($1,'person',$2)`, [principalId, userId]);
  await owner.query(`INSERT INTO resource_scopes(scope_id,kind,owner_principal_id) VALUES($1,'personal',$2)`, [personalScopeId, principalId]);
  return { userId, principalId, personalScopeId };
}

async function publishResult(q: PoolClient, space: Space, author: Person) {
  const assetId = randomUUID();
  const representationId = randomUUID();
  const intentId = randomUUID();
  const label = space === spaces.a ? 'A' : space === spaces.b ? 'B' : 'C';
  const bytes = new TextEncoder().encode(`tenant ${label} result\n`);
  const digest = await sha256(bytes);
  const metadata: ObjectMetadata = { contentType: 'text/plain', byteSize: bytes.length, sha256: digest,
    transformVersion: 'private-text.utf8.v1', policyRevision: 'synthetic.r1' };
  const key = objectKey({ scopeId: space.scopeId, assetId, representationId });
  await writeVerifiedObject(source, key, { bytes, metadata }, { revision: 'synthetic.r1', platformPersistenceAllowed: true });
  space.object = { assetId, representationId, intentId, key, bytes, metadata };
  await q.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,purpose,scope_kind,tenant_ref)
    VALUES($1,$2,$3,$4,'synthetic.r1',$5,'work.tenant-result','tenant',$6)`,
  [assetId, space.scopeId, author.principalId, author.userId, representationId, space.tenantId]);
  await q.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,expires_at,purpose,reserved_bytes,target_kind,target_work_id,target_tenant_id,display_name)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic.r1',$7,$8,'text/plain',$12,$9,1,clock_timestamp()+interval '2 hours','work.tenant-result',262144,'work.tenant-result',$10,$11,'note.txt')`,
  [intentId, assetId, representationId, space.scopeId, author.principalId, author.userId, `prepare${intentId.replaceAll('-', '').slice(0, 12)}`, sha, digest, space.workId, space.tenantId, bytes.length]);
  await q.query(`UPDATE asset_upload_intents SET state='processing', fence=1, lease_token=$2, lease_expires_at=expires_at WHERE intent_id=$1`, [intentId, randomUUID()]);
  await q.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision,purpose,variant)
    VALUES($1,$2,$3,'text/plain',$5,$4,'private-text.utf8.v1','synthetic.r1','work.tenant-result','draft')`,
  [assetId, space.scopeId, representationId, digest, bytes.length]);
  await q.query(`UPDATE assets SET state='ready', ready_at=clock_timestamp() WHERE asset_id=$1`, [assetId]);
  await q.query(`UPDATE asset_upload_intents SET state='stored' WHERE intent_id=$1`, [intentId]);
  await q.query(`INSERT INTO tenant_work_results(result_id,intent_id) VALUES($1,$2)`, [space.resultId, intentId]);
  await q.query(`UPDATE asset_upload_intents SET state='finalized', finalized_at=clock_timestamp() WHERE intent_id=$1`, [intentId]);
}

async function installSpace(space: Space, author: Person, invitee: Person) {
  const guild = (await owner.query<{ guild_key: string }>('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key;
  const q = await owner.connect();
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO tenants(tenant_id,community_id,display_name,created_by_principal_id)
      VALUES($1,(SELECT community_id FROM communities LIMIT 1),'Same Guild',$2)`, [space.tenantId, author.principalId]);
    await q.query(`INSERT INTO resource_scopes(scope_id,kind,tenant_ref) VALUES($1,'tenant',$2)`, [space.scopeId, space.tenantId]);
    await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
      VALUES($1,$2,'owner','active',clock_timestamp())`, [space.tenantId, author.principalId]);
    await q.query(`INSERT INTO workspaces(workspace_id,tenant_id,name,is_default) VALUES($1,$2,'Counter',true)`, [space.workspaceId, space.tenantId]);
    await q.query(`INSERT INTO tenant_authority_audit(event_id,tenant_id,actor_principal_id,action,target_principal_id,old_revision,new_revision,reason_code)
      VALUES($1,$2,$3,'tenant.create',$3,1,1,'tenant.created')`, [space.auditId, space.tenantId, author.principalId]);
    await q.query(`INSERT INTO module_instances(instance_id,tenant_id,module_key,application_release_ref,module_release_ref,data_schema_version,contract_ref,status,binding_id,created_by_principal_id,origin_guild_key)
      SELECT $1,$2,'work','manual-workspace@1.0.0','work@1.0.0','1',contract_ref,'active',$3,$4,$5
      FROM module_definitions WHERE module_key='work' AND release_ref='work@1.0.0'`,
    [space.instanceId, space.tenantId, space.bindingId, author.principalId, guild]);
    await q.query(`INSERT INTO deployment_bindings(binding_id,tenant_id,instance_id,mode,environment,endpoint_ref,service_principal_id,contract_ref,state)
      SELECT $1,$2,$3,'hosted','hosted-shared',NULL,NULL,contract_ref,'active'
      FROM module_definitions WHERE module_key='work' AND release_ref='work@1.0.0'`, [space.bindingId, space.tenantId, space.instanceId]);
    await q.query(`INSERT INTO workspace_module_bindings(tenant_id,workspace_id,entry_capability,instance_id)
      VALUES($1,$2,'work:create',$3)`, [space.tenantId, space.workspaceId, space.instanceId]);
    await q.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_ref,owner_principal_id,community_id,title,objective,state,tenant_id,instance_id,workspace_id,created_by_principal_id,progress,updated_at,participation_terms_revision)
      VALUES($1,'tenant_execution',$2,$3,NULL,NULL,$4,'Keep this note','draft',$5,$6,$7,$8,'todo',clock_timestamp(),NULL)`,
    [space.workId, space.scopeId, author.userId, `note-${space.tenantId}`, space.tenantId, space.instanceId, space.workspaceId, author.principalId]);
    await publishResult(q, space, author);
    await q.query(`INSERT INTO tenant_invitations(invitation_id,tenant_id,invitee_principal_id,role,instance_capabilities,expires_at,state,created_by_principal_id)
      VALUES($1,$2,$3,'viewer','[]'::jsonb,clock_timestamp()+interval '3 days','pending',$4)`,
    [space.invitationId, space.tenantId, invitee.principalId, author.principalId]);
    await q.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,max_model_budget,status)
      VALUES($1,1,$2,'synthetic-F-GUILD-TWO-TENANTS-v1',10,3,2,1000,104857600,4,NULL,'active')`, [space.policyId, space.tenantId]);
    await q.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,principal_kind,scope_kind,target_kind,target_id,request_sha256,response)
      VALUES($1,'member_session',$2,'tenant.fixture',$3,'person','tenant','tenant',$4,$5,'{}'::jsonb)`,
    [author.principalId, space.scopeId, space.receiptKey, space.tenantId, sha]);
    await q.query(`INSERT INTO scoped_transition_journal(transition_id,scope_id,scope_kind,principal_id,principal_kind,authn_kind,aggregate_type,aggregate_id,aggregate_version,operation,data)
      VALUES($1,$2,'tenant',$3,'person','member_session','tenant',$4,1,'tenant.fixture','{}'::jsonb)`,
    [space.transitionId, space.scopeId, author.principalId, space.tenantId]);
    await q.query(`INSERT INTO scoped_outbox(event_id,transition_id,scope_id,scope_kind,event_type,payload)
      VALUES($1,$2,$3,'tenant','freedom.tenant.fixture.v1','{}'::jsonb)`,
    [space.eventId, space.transitionId, space.scopeId]);
    await q.query('COMMIT');
  } catch (error) {
    try { await q.query('ROLLBACK'); } catch { /* keep the fixture error */ }
    throw error;
  } finally { q.release(); }
}

async function visible(q: PoolClient) {
  return {
    verifications: await column(q, 'SELECT verification_id AS id FROM tenant_high_risk_verifications'),
    transfers: await column(q, 'SELECT transfer_id AS id FROM tenant_ownership_transfers'),
    recovery: await column(q, 'SELECT case_id AS id FROM tenant_recovery_cases'),
    tenants: await column(q, 'SELECT tenant_id AS id FROM tenants'),
    memberships: await column(q, `SELECT tenant_id::text || ':' || principal_id::text AS id FROM tenant_memberships`),
    invitations: await column(q, 'SELECT invitation_id AS id FROM tenant_invitations'),
    workspaces: await column(q, 'SELECT workspace_id AS id FROM workspaces'),
    audit: await column(q, 'SELECT event_id AS id FROM tenant_authority_audit'),
    instances: await column(q, 'SELECT instance_id AS id FROM module_instances'),
    deployments: await column(q, 'SELECT binding_id AS id FROM deployment_bindings'),
    bindings: await column(q, `SELECT tenant_id::text || ':' || workspace_id::text AS id FROM workspace_module_bindings`),
    results: await column(q, 'SELECT result_id AS id FROM tenant_work_results'),
    targets: await column(q, 'SELECT work_item_id AS id FROM tenant_work_result_targets'),
    capacity: await column(q, 'SELECT policy_id AS id FROM tenant_capacity_policies'),
    work: await column(q, 'SELECT work_item_id AS id FROM work_items'),
    receipts: await column(q, 'SELECT idempotency_key AS id FROM scoped_command_receipts'),
    journal: await column(q, 'SELECT transition_id AS id FROM scoped_transition_journal'),
    outbox: await column(q, 'SELECT event_id AS id FROM scoped_outbox'),
  };
}
function pair(tenantId: string, principalId: string) { return `${tenantId}:${principalId}`; }
function tenantSlice(space: Space) {
  return {
    verifications: [], transfers: [], recovery: [],
    tenants: [space.tenantId],
    memberships: space === spaces.a
      ? [pair(space.tenantId, people.p1.principalId)]
      : [pair(space.tenantId, people.p1.principalId), pair(space.tenantId, people.p2.principalId)].sort(),
    invitations: [space.invitationId],
    workspaces: [space.workspaceId],
    audit: [space.auditId],
    instances: [space.instanceId],
    deployments: [space.bindingId],
    bindings: [`${space.tenantId}:${space.workspaceId}`],
    results: [space.resultId],
    targets: [space.workId],
    capacity: [defaultPolicyId, space.policyId].sort(),
    work: [personalWorkId, space.workId].sort(),
    receipts: [personalReceiptKey, space.receiptKey].sort(),
    journal: [personalTransitionId, space.transitionId].sort(),
    outbox: [personalEventId, space.eventId].sort(),
  };
}
const personalOnly = () => ({
  verifications: [], transfers: [], recovery: [],
  tenants: [], memberships: [], invitations: [], workspaces: [], audit: [], instances: [], deployments: [],
  bindings: [], results: [], targets: [], capacity: [defaultPolicyId], work: [personalWorkId],
  receipts: [personalReceiptKey], journal: [personalTransitionId], outbox: [personalEventId],
});

const EXPECTED: Record<string, number> = {
  tenants: 2, tenant_memberships: 3, tenant_invitations: 2, workspaces: 2,
  tenant_authority_audit: 2, module_instances: 2, deployment_bindings: 2, workspace_module_bindings: 2,
  tenant_high_risk_verifications: 0, tenant_ownership_transfers: 0, tenant_recovery_cases: 0,
  // This fixture has no explicit instance grants; verify the new table survives empty.
  tenant_module_permissions: 0,
  tenant_work_results: 2, tenant_work_result_targets: 2, tenant_capacity_policies: 3,
  work_items: 3, scoped_command_receipts: 3, scoped_transition_journal: 3, scoped_outbox: 3,
  // This fixture inserts existing Work directly; no registry launch is performed.
  application_installations: 0, application_module_links: 0, module_dependencies: 0, module_launch_plans: 0,
  module_launch_plan_consumptions: 0, module_provision_operations: 0, module_provision_steps: 0, capacity_reservations: 0, capacity_ledger: 0,
};
function evidenceCount(evidence: SchemaEvidence, table: string) {
  const found = evidence.tables.find(row => row.table === table);
  assert(found, table); return Number(found.count);
}
async function counts(pool: Pool) {
  const result: Record<string, number> = {};
  for (const table of RLS_TABLES) result[table] = (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
  return result;
}
async function applyTemplate(pool: Pool) {
  assertIdent(schema); assertIdent(runtimeRole);
  const source = (await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8'))
    .replace(/^\\set .*$/mg, '').replaceAll('SCHEMA public', 'SCHEMA ' + schema)
    .replaceAll("n.nspname='public'", "n.nspname='" + schema + "'")
    .replaceAll("'public','CREATE'", "'" + schema + "','CREATE'")
    .replaceAll(':"runtime"', '"' + runtimeRole + '"').replaceAll(":'runtime'", "'" + runtimeRole + "'");
  const q = await pool.connect();
  try {
    const pieces = source.split('\\gexec');
    for (let i = 0; i < pieces.length; i++) {
      const result = await q.query(pieces[i]);
      if (i < pieces.length - 1) {
        const last = Array.isArray(result) ? result[result.length - 1] : result;
        for (const row of last.rows) await q.query(Object.values(row)[0] as string);
      }
    }
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
}

before(async () => {
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^18/);
  assert.equal((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper, true);
  for (const role of [migrator, runtimeRole, backupRole, readerRole]) {
    // Backup mirrors production backup role attributes; its real grants are
    // operator-managed outside this repository and are not verified here.
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${role === backupRole ? 'BYPASSRLS' : 'NOBYPASSRLS'} NOINHERIT`);
    createdRoles.push(role);
  }
  await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}`); createdSchema = true;
  await migrate(owner);
  for (const role of [backupRole, readerRole]) {
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role};
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  }
  root = await mkdtemp(join(tmpdir(), 'fp-j6-restore-'));
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null,{status:503})}}',
    compatibilityDate: '2026-09-21', r2Buckets: ['SOURCE', 'BACKUP', 'RESTORED'],
    outboundService: () => { outbound++; return new Response(null, { status: 503 }); } }));
  await mf.ready;
  const store = async (name: string) => createR2ObjectStore(await mf!.getR2Bucket(name) as unknown as AssetR2Binding);
  source = await store('SOURCE'); backupObjects = await store('BACKUP'); restoredObjects = await store('RESTORED');
  await owner.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-j6',orphan_retention_seconds=1,
    retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=120,pin_seconds=120,max_capture_objects=10`);
  const community = randomUUID();
  await owner.query(`INSERT INTO communities VALUES($1,'Synthetic two tenants')`, [community]);
  people.p1 = await person('p1@example.test');
  people.p2 = await person('p2@example.test');
  people.p3 = await person('p3@example.test');
  defaultPolicyId = randomUUID();
  await owner.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,max_model_budget,status)
    VALUES($1,1,NULL,'synthetic-F-GUILD-TWO-TENANTS-v1',10,3,2,1000,104857600,4,NULL,'active')`, [defaultPolicyId]);
  await installSpace(spaces.a, people.p1, people.p3);
  await installSpace(spaces.b, people.p2, people.p1);
  await owner.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
    VALUES($1,$2,'viewer','active',clock_timestamp())`, [spaces.b.tenantId, people.p1.principalId]);
  personalWorkId = randomUUID();
  await owner.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
    VALUES($1,'personal_execution',$2,$3,$4,'Personal note','Visible without a tenant','draft',NULL)`,
  [personalWorkId, people.p1.personalScopeId, people.p1.principalId, people.p1.userId]);
  personalReceiptKey = `personal${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  personalTransitionId = randomUUID();
  personalEventId = randomUUID();
  await owner.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,principal_kind,scope_kind,target_kind,target_id,request_sha256,response)
    VALUES($1,'member_session',$2,'tenant.fixture',$3,'person','personal','work',$4,$5,'{}'::jsonb)`,
  [people.p1.principalId, people.p1.personalScopeId, personalReceiptKey, personalWorkId, sha]);
  await owner.query(`INSERT INTO scoped_transition_journal(transition_id,scope_id,scope_kind,principal_id,principal_kind,authn_kind,aggregate_type,aggregate_id,aggregate_version,operation,data)
    VALUES($1,$2,'personal',$3,'person','member_session','work',$4,1,'tenant.fixture','{}'::jsonb)`,
  [personalTransitionId, people.p1.personalScopeId, people.p1.principalId, personalWorkId]);
  await owner.query(`INSERT INTO scoped_outbox(event_id,transition_id,scope_id,scope_kind,event_type,payload)
    VALUES($1,$2,$3,'personal','freedom.tenant.fixture.v1','{}'::jsonb)`,
  [personalEventId, personalTransitionId, people.p1.personalScopeId]);
  maintenance = createAssetMaintenance(owner, { store: source, enabled: true });
  const dumpPath = join(root, 'captured.dump');
  backup = await createConsistentAssetBackup(backupPool, { enabled: true,
    target: { database, sourceSchema: schema, sourceRelease: 'a'.repeat(40) },
    maintenance, source, destination: backupObjects, snapshotEvidence: true, databaseSnapshot: { async write(input) {
      // C commits after the exported snapshot; no row, evidence or object from C may enter this set.
      await installSpace(spaces.c, people.p3, people.p2);
      assert.equal((await owner.query('SELECT count(*)::int n FROM tenants')).rows[0].n, 3);
      assert.match(input.snapshotId, /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/);
      const q = await owner.connect();
      try {
        await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await q.query(`SET TRANSACTION SNAPSHOT '${input.snapshotId}'`);
        ownerEvidence = await collectSchemaEvidence(q, schema);
        // The collector sets search_path=pg_catalog; qualify this last snapshot read.
        snapshotAssets = (await q.query(`SELECT count(*)::int n FROM ${schema}.assets WHERE purpose='work.tenant-result'`)).rows[0].n;
        await q.query('COMMIT');
      } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
      const dump = await pgTool('pg_dump', backupRole, ['--dbname', input.database, '--schema', input.schema,
        '--snapshot', input.snapshotId, '--format=custom', '--no-owner', '--no-privileges']);
      assert.equal(dump.code, 0);
      const partial = dumpPath + '.partial', file = await open(partial, 'wx', 0o600);
      try { await file.writeFile(dump.stdout); await file.sync(); } finally { await file.close(); }
      await rename(partial, dumpPath);
      const directory = await open(root!, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      return { sha256: createHash('sha256').update(dump.stdout).digest('hex'), byteSize: dump.stdout.length };
    } } });
  assert(backup.evidence);

  // Default row_security=off refuses a restricted reader instead of filtering the backup.
  defaultDump = await pgTool('pg_dump', readerRole, ['--dbname', database, '--format=custom', '--no-owner', '--no-privileges', '--schema', schema]);
  // Opting into RLS makes pg_dump succeed with silently missing tenant rows; never use it as a backup.
  visibleDump = await pgTool('pg_dump', readerRole, ['--dbname', database, '--enable-row-security', '--data-only', '--format=plain', '--schema', schema]);
  visibleCounts = copyCounts(visibleDump.stdout);

  // Setup checks fail before the todo: these revocations must really commit in the source.
  const membership = await owner.query(`UPDATE tenant_memberships SET status='revoked',revoked_at=clock_timestamp()
    WHERE tenant_id=$1 AND principal_id=$2 AND role='viewer' RETURNING status`, [spaces.b.tenantId, people.p1.principalId]);
  const invitation = await owner.query(`UPDATE tenant_invitations SET state='revoked',revoked_reason='Synthetic post-backup revocation'
    WHERE invitation_id=$1 AND state='pending' RETURNING state`, [spaces.a.invitationId]);
  assert.equal(membership.rowCount, 1); assert.equal(invitation.rowCount, 1);
  assert.equal((await owner.query('SELECT status FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2', [spaces.b.tenantId, people.p1.principalId])).rows[0].status, 'revoked');
  assert.equal((await owner.query('SELECT state FROM tenant_invitations WHERE invitation_id=$1', [spaces.a.invitationId])).rows[0].state, 'revoked');

  const archive = await createFileArchiveStore(root), setId = randomUUID();
  const sealed = await sealRecoverySet({ backup, setId, environment: 'local', createdAt: new Date().toISOString(),
    dump: { async open() { return Readable.toWeb(createReadStream(dumpPath)) as ReadableStream<Uint8Array>; } }, archive, backupObjects });
  assert.equal(sealed.status, 'recovery_set_verified');
  const readback = await readbackRecoverySet({ archive, setId, backupObjects, verifiedAt: new Date().toISOString(), writeReceipt: true });
  assert.equal(readback.objects.count, 2); assert.equal(readback.manifestSha256, sealed.manifestSha256);
  const target = (await admin.query('SELECT current_database() AS database')).rows[0].database + '_r' + randomUUID().replaceAll('-', '').slice(0, 8);
  assertIdent(target); await admin.query(`CREATE DATABASE ${target}`); restoredDatabase = target;
  restoredPool = poolFor(superuser, restoredDatabase);
  recovered = await restoreRecoverySet({ archive, setId, backupObjects, destinationObjects: restoredObjects, restoredPool, restoredDatabase,
    database: { async restore({ database: targetDatabase, archive: stream }) {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      const result = await pgTool('pg_restore', superuser, ['--dbname', targetDatabase, '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges'], bytes);
      assert.equal(result.code, 0);
    } }, objectAuthority: restoredReferenceAuthorization(restoredPool, { database: restoredDatabase, schema, current: { mode: 'quarantine' } }) });

  // Operator order: schema USAGE is the equivalent of 10-create-roles.psql:27.
  await restoredPool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
  await assert.rejects(applyTemplate(restoredPool), (error: unknown) => {
    const pg = error as { code?: string; message?: string };
    return pg.code === 'P0001' && pg.message === 'Unsafe runtime operator media privileges';
  });
  await lockdownRestoredMediaAcl(restoredPool, { target: { environment: 'local', database: restoredDatabase, schema, role: superuser, releaseSha: 'a'.repeat(40) }, runtimeRole });
  await applyTemplate(restoredPool);
  // No runtime session exists during lockdown. Open it only after grants succeed.
  runtimePool = poolFor(runtimeRole, restoredDatabase, 1);
}, { timeout: 90000 });

after(async () => {
  let firstError: unknown;
  const attempt = async (step: () => Promise<unknown>) => { try { await step(); } catch (error) { firstError ??= error; } };
  // Pool.end removes clients before their sockets close; await each actual end event.
  for (const record of pools) {
    await attempt(() => record.pool.end());
    await attempt(() => Promise.all(record.closed));
  }
  // Cleanup uses a fresh source superuser client after all pools have closed.
  const cleanup = new Client({ connectionString: configured });
  const closed = new Promise<void>(resolve => cleanup.once('end', resolve));
  await attempt(() => cleanup.connect());
  await attempt(async () => { if (restoredDatabase) await cleanup.query(`DROP DATABASE ${restoredDatabase} WITH (FORCE)`); });
  await attempt(async () => { assert.equal(outbound, 0); });
  await attempt(async () => { await mf?.dispose(); });
  await attempt(async () => { if (createdSchema) await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); });
  for (const role of createdRoles) await attempt(() => cleanup.query(`DROP ROLE ${role}`));
  await attempt(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  await attempt(async () => { await cleanup.end(); await closed; });
  await attempt(async () => { assert(performance.now() - started < 90000, 'Whole drill must stay under 90 seconds'); });
  if (firstError) throw firstError;
});

async function roleReadback(pool: Pool, role: string) {
  return (await pool.query(`SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) memberships FROM pg_roles r WHERE rolname=$1`, [role])).rows[0];
}
async function ownedRelations(pool: Pool, role: string) {
  return (await pool.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND pg_get_userbyid(c.relowner)=$2`, [schema, role])).rows[0].n;
}

test('J6-R1 BYPASSRLS backup role is read-only, unprivileged and owns no source relation', async () => {
  assert.deepEqual(await roleReadback(admin, backupRole), {
    rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: true, rolinherit: false, memberships: 0,
  });
  assert.equal(await ownedRelations(admin, backupRole), 0);
  const privileges = (await admin.query(`SELECT c.relname,p.privilege,has_table_privilege($1,c.oid,p.privilege) allowed
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p(privilege)
    WHERE n.nspname=$2 AND c.relkind IN ('r','p')`, [backupRole, schema])).rows;
  assert(privileges.length > 0);
  for (const row of privileges) assert.equal(row.allowed, false, `${row.relname} ${row.privilege}`);
});

test('J6-R1 negative restricted dump fails closed, visible dump is incomplete, and coordinator refuses capture', async () => {
  assert.notEqual(defaultDump.code, 0); assert.match(defaultDump.stderr, /row-level security/);
  assert.equal(visibleDump.code, 0);
  let ownerTotal = 0, readerTotal = 0;
  const mixed = new Set(['tenant_capacity_policies', 'work_items', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']);
  for (const table of RLS_TABLES) {
    assert.equal(typeof visibleCounts[table], 'number', table);
    const ownerCount = evidenceCount(ownerEvidence, table), readerCount = visibleCounts[table];
    if (ownerCount > 0) assert(readerCount < ownerCount, table);
    if (!mixed.has(table)) assert.equal(readerCount, 0, table);
    ownerTotal += ownerCount; readerTotal += readerCount;
  }
  assert(readerTotal < ownerTotal);
  // Evidence SET LOCAL row_security=off refuses filtered counts before any dump writer can run.
  let writes = 0;
  await assert.rejects(createConsistentAssetBackup(readerPool, { enabled: true,
    target: { database, sourceSchema: schema, sourceRelease: 'a'.repeat(40) }, maintenance, source, destination: backupObjects,
    snapshotEvidence: true, databaseSnapshot: { async write() { writes++; throw Error('reader writer must never run'); } } }),
  (error: unknown) => error instanceof ConsistentBackupError && error.code === 'backup_capture_failed');
  assert.equal(writes, 0);
});

test('J6-R2 owner and backup counts and full-row fingerprints agree at the same snapshot; late C is excluded', () => {
  assert(backup.evidence);
  assert.deepEqual(ownerEvidence.tables, backup.evidence.tables);
  assert.doesNotThrow(() => compareEvidence(backup.evidence!, ownerEvidence));
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...RLS_TABLES].sort());
  for (const table of RLS_TABLES) assert.equal(evidenceCount(backup.evidence, table), EXPECTED[table], table);
  assert.equal(snapshotAssets, 2);
  assert.deepEqual(backup.objects.objects.map(object => object.key).sort(), [spaces.a.object!.key, spaces.b.object!.key].sort());
});

async function foreignKeys(pool: Pool) {
  return (await pool.query(`SELECT c.relname AS table,k.conname,pg_get_constraintdef(k.oid) definition,k.convalidated
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND k.contype='f' ORDER BY c.relname,k.conname`, [schema])).rows;
}
async function rowSecurity(pool: Pool) {
  return (await pool.query(`SELECT c.relname AS table,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname`, [schema])).rows;
}
async function policies(pool: Pool) {
  return (await pool.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check
    FROM pg_policies WHERE schemaname=$1 ORDER BY tablename,policyname`, [schema])).rows;
}

test('J6-R3 sealed quarantine restore preserves tenant references, validated FKs, row security and exact object digests', async () => {
  assert.equal(recovered.status, 'database_and_objects_restored');
  assert.equal(recovered.evidence.status, 'matched'); assert.equal(recovered.objects.objectCount, 2);
  assert.equal(recovered.exposure, 'quarantine_not_approved_for_exposure');
  assert.deepEqual(recovered.remainingOperatorSteps, ['apply_pending_migrations', 'restore_acl_lockdown', 'runtime_and_backup_grants',
    'fence_restored_sessions_and_external_authority', 'role_login_checks', 'drain_writers_before_cutover']);
  const restoredCounts = await counts(restoredPool);
  for (const table of RLS_TABLES) assert.equal(restoredCounts[table], evidenceCount(ownerEvidence, table), table);
  for (const [table, column] of [['tenants', 'tenant_id'], ['work_items', 'tenant_id'], ['assets', 'tenant_ref']]) {
    assert.equal((await restoredPool.query(`SELECT count(*)::int n FROM ${table} WHERE ${column}=$1`, [spaces.c.tenantId])).rows[0].n, 0);
  }
  const restoredKeys = await foreignKeys(restoredPool);
  assert(restoredKeys.length > 0); assert.deepEqual(restoredKeys, await foreignKeys(owner));
  for (const key of restoredKeys) assert.equal(key.convalidated, true);
  for (const space of [spaces.a, spaces.b]) {
    const object = space.object!;
    const chain = (await restoredPool.query(`SELECT r.result_id,t.result_id target_result,t.asset_id target_asset,w.work_item_id,
      i.intent_id,a.asset_id,o.representation_id,s.scope_id,n.tenant_id,o.byte_size,o.content_sha256
      FROM tenant_work_results r
      JOIN tenant_work_result_targets t ON t.result_id=r.result_id AND t.tenant_id=r.tenant_id AND t.work_item_id=r.work_item_id AND t.asset_id=r.asset_id
      JOIN work_items w ON w.work_item_id=t.work_item_id AND w.tenant_id=t.tenant_id AND w.scope_id=r.scope_id
      JOIN asset_upload_intents i ON i.intent_id=r.intent_id AND i.target_work_id=w.work_item_id AND i.target_tenant_id=w.tenant_id
      JOIN assets a ON a.asset_id=i.asset_id AND a.asset_id=r.asset_id AND a.purpose='work.tenant-result' AND a.scope_kind='tenant' AND a.tenant_ref=r.tenant_id
      JOIN asset_objects o ON o.asset_id=a.asset_id AND o.scope_id=a.scope_id AND o.representation_id=r.representation_id
      JOIN resource_scopes s ON s.scope_id=a.scope_id AND s.kind='tenant' AND s.tenant_ref=r.tenant_id
      JOIN tenants n ON n.tenant_id=s.tenant_ref
      WHERE r.tenant_id=$1`, [space.tenantId])).rows;
    assert.deepEqual(chain, [{ result_id: space.resultId, target_result: space.resultId, target_asset: object.assetId,
      work_item_id: space.workId, intent_id: object.intentId, asset_id: object.assetId, representation_id: object.representationId,
      scope_id: space.scopeId, tenant_id: space.tenantId, byte_size: object.bytes.length, content_sha256: object.metadata.sha256 }]);
    assert.deepEqual((await readVerifiedObject(restoredObjects, object.key, object.metadata)).bytes, object.bytes);
  }
  assert.equal(await restoredObjects.head(spaces.c.object!.key), null);
  const flags = await rowSecurity(restoredPool); assert.deepEqual(flags, await rowSecurity(owner));
  assert.deepEqual(flags.filter(row => row.relrowsecurity).map(row => row.table).sort(), [...RLS_TABLES].sort());
  for (const row of flags) assert.equal(row.relforcerowsecurity, false, row.table);
  assert.deepEqual(await policies(restoredPool), await policies(owner));
  assert.equal(outbound, 0);
  log('J6-counts', { tables: Object.fromEntries(RLS_TABLES.map(table => [table, {
    owner: evidenceCount(ownerEvidence, table), backup: evidenceCount(backup.evidence!, table), restored: restoredCounts[table], reader: visibleCounts[table],
  }])) });
});

test('J6-R4 lockdown precedes grants; one restored runtime connection cycles A, B, no context and A', async () => {
  const who = (await runtimePool.query('SELECT current_user,session_user')).rows[0];
  assert.deepEqual(who, { current_user: runtimeRole, session_user: runtimeRole });
  assert.deepEqual(await roleReadback(restoredPool, runtimeRole), {
    rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolinherit: false, memberships: 0,
  });
  assert.equal(await ownedRelations(restoredPool, runtimeRole), 0);
  assert.deepEqual((await restoredPool.query(`SELECT DISTINCT pg_get_userbyid(c.relowner) owner
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p')`, [schema])).rows, [{ owner: superuser }]);
  assert.equal((await runtimePool.query("SELECT has_schema_privilege(current_user,$1,'CREATE') allowed", [schema])).rows[0].allowed, false);
  let pid = 0;
  for (const space of [spaces.a, spaces.b, null, spaces.a]) {
    await isolatedTransaction(runtimePool, async q => {
      const currentPid = await backend(q);
      if (pid) assert.equal(currentPid, pid); else pid = currentPid;
      if (space) await bindSpace(q, space === spaces.a ? people.p1 : people.p2, space);
      else {
        for (const name of ['freedom.principal_id', 'freedom.tenant_id', 'freedom.tenant_scope_id', 'freedom.platform_admin_id']) {
          const value = (await q.query('SELECT current_setting($1,true) value', [name])).rows[0].value;
          assert(value == null || value === '', name);
        }
      }
      assert.deepEqual(await visible(q), space ? tenantSlice(space) : personalOnly());
    });
  }
});

// Tenant tables have no recovery generation, epoch floor, tombstone or revocation
// watermark: SP-06 §6.3 proposals are not built; catalog policy_undecided, OPEN-07.
// work.tenant-result is never GC-claimed, so asset tombstones never apply.
// Only quarantine and the remaining operator steps stand between resurrected rows and serving.
test('T-047 post-backup membership and invitation revocations survive restore before serving', { todo: 'T-047 finding: tenant tables have no recovery generation / epoch floor / tombstone; revoked rows come back on restore' }, async () => {
  const status = (await restoredPool.query('SELECT status FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2', [spaces.b.tenantId, people.p1.principalId])).rows[0].status;
  const state = (await restoredPool.query('SELECT state FROM tenant_invitations WHERE invitation_id=$1', [spaces.a.invitationId])).rows[0].state;
  const active = await isolatedTransaction(runtimePool, async q => {
    await bindPrincipalContext(q, people.p1.principalId);
    await bindTenantContext(q, { tenantId: spaces.b.tenantId, tenantScopeId: spaces.b.scopeId });
    return (await q.query(`SELECT count(*)::int n FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 AND status='active'`, [spaces.b.tenantId, people.p1.principalId])).rows[0].n;
  });
  // Run all three desired assertions so diagnostics show both states and runtime visibility.
  const failures: Error[] = [];
  for (const check of [() => assert.equal(status, 'revoked'), () => assert.equal(state, 'revoked'), () => assert.equal(active, 0)]) {
    try { check(); } catch (error) { failures.push(error as Error); }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
});
