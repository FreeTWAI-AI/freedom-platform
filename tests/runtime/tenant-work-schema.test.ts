import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_tws_${process.pid}_${Date.now()}`;
const runtimeRole = `fp_twr_${process.pid}_${Date.now()}`;
let capacityGrantQuery = '';
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const store = new FakeObjectStore();
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store });
const ABC = new TextEncoder().encode('abc');
const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
type Session = { cookie: string; csrf: string; user: { user_id: string } };

before(async () => {
  assert.ok(runtimeRole.length < 63);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await admin.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`);
  await admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtimeRole}`);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  capacityGrantQuery = template.split('-- BEGIN TENANT CAPACITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const grant = (await pool.query(capacityGrantQuery)).rows;
  assert.equal(grant.length, 1);
  await pool.query(Object.values(grant[0])[0] as string);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP OWNED BY ${runtimeRole}`);
  await admin.query(`DROP ROLE ${runtimeRole}`);
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
  await ensurePolicy(pool);
});

async function ensurePolicy(target: Pool) {
  await target.query(`INSERT INTO tenant_capacity_policies(
      policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
      max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
    SELECT $1, 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1', 10, 3, 2, 1000, 104857600, 4, NULL, 'active'
    WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`, [randomUUID()]);
}
async function call(method: string, path: string, session: Session | undefined, body?: unknown, headers: Record<string, string> = {}, target = app) {
  const sent: Record<string, string> = { Origin: origin, ...headers };
  if (session) { sent.Cookie = session.cookie; sent['X-CSRF-Token'] = session.csrf; }
  if (body !== undefined) sent['Content-Type'] = 'application/json';
  const response = await target.request(origin + '/api/v1' + path, {
    method, headers: sent, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json() : null;
  return { status: response.status, data };
}
async function post(path: string, session: Session | undefined, body: unknown, version?: string, key = randomUUID(), target = app) {
  const headers: Record<string, string> = { 'Idempotency-Key': key };
  if (version !== undefined) headers['If-Match'] = version;
  return call('POST', path, session, body, headers, target);
}
async function sessionFrom(email: string, target = app): Promise<Session> {
  const response = await target.request(origin + '/api/v1/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  const data = await response.json() as { csrf_token: string; user: { user_id: string } };
  assert.equal(response.status, 200, JSON.stringify(data));
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token, user: data.user };
}

async function openTenant(target = app) {
  const owner = await sessionFrom(DEMO_USERS[0].email, target);
  const guild = (await pool.query<{ guild_key: string }>('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key;
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, owner.user.user_id, guild]);
  const made = await post('/tenants', owner, { display_name: '品牌甲', workspace_name: '櫃檯' }, undefined, randomUUID(), target);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const tenantId = made.data.tenant.tenant_id as string;
  const workspaceId = made.data.workspace.workspace_id as string;
  const enabled = await post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, owner, { guild_key: guild }, undefined, randomUUID(), target);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const work = await post(`/tenants/${tenantId}/workspaces/${workspaceId}/works`, owner, {
    title: '結構工作', objective: '用來證明約束', progress: 'todo',
  }, undefined, randomUUID(), target);
  assert.equal(work.status, 201, JSON.stringify(work.data));
  return { owner, tenantId, workspaceId, workId: work.data.resource_ref.resource_id as string, guild, instanceId: enabled.data.instance_id as string };
}
function sha(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
async function upload(ctx: Awaited<ReturnType<typeof openTenant>>, name: string, bytes: Uint8Array, expected: string) {
  const prepared = await post(`/tenants/${ctx.tenantId}/works/${ctx.workId}/results/uploads`, ctx.owner, {
    content_type: 'text/plain', byte_size: bytes.byteLength, sha256: sha(bytes), display_name: name, expected_work_version: expected,
  });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const uploadId = prepared.data.resource_ref.resource_id as string;
  const written = await app.request(origin + `/api/v1/tenants/${ctx.tenantId}/works/${ctx.workId}/results/uploads/${uploadId}/content`, {
    method: 'PUT', headers: {
      Origin: origin, Cookie: ctx.owner.cookie, 'X-CSRF-Token': ctx.owner.csrf, 'Idempotency-Key': randomUUID(), 'If-Match': '"1"',
    }, body: new Uint8Array(bytes),
  });
  const writtenBody = await written.json();
  assert.equal(written.status, 200, JSON.stringify(writtenBody));
  const done = await post(`/tenants/${ctx.tenantId}/works/${ctx.workId}/results/uploads/${uploadId}/finalize`, ctx.owner, { expected_work_version: expected }, '"2"');
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return done.data.resource_ref.resource_id as string;
}
async function writableColumns(table: string) {
  return (await pool.query<{ attname: string }>(`SELECT a.attname FROM pg_attribute a
    JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated=''
    ORDER BY a.attnum`, [table])).rows.map(row => row.attname);
}
async function rejectCode(code: string, run: (q: PoolClient) => Promise<unknown>) {
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    await assert.rejects(run(q), (error: { code?: string }) => error.code === code);
  } finally {
    await q.query('ROLLBACK');
    q.release();
  }
}
async function blockers(pid: number) {
  const row = (await admin.query('SELECT pg_blocking_pids($1) AS pids', [pid])).rows[0].pids as Array<number | string>;
  return (row ?? []).map(Number);
}
async function waitBlocked(pid: number) {
  for (let i = 0; i < 200; i++) {
    if ((await blockers(pid)).length > 0) return;
    await delay(20);
  }
  assert.fail(`pid ${pid} was not blocked`);
}

test('intent work_mode stays personal, and tenant_work_mode is the new generated column', async () => {
  const expr = async (column: string) => (await pool.query<{ expr: string }>(`SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname='asset_upload_intents' AND a.attname=$1`, [column])).rows[0].expr;
  const personal = await expr('work_mode');
  assert.match(personal, /work\.private-result/);
  assert.match(personal, /work\.model-result/);
  assert.equal(personal.includes('tenant'), false);
  assert.match(await expr('tenant_work_mode'), /work\.tenant-result/);
});

test('tenant placement, archive, results, bindings, and typed uploads reject illegal writes', async () => {
  const ctx = await openTenant();
  const other = await sessionFrom(DEMO_USERS[1].email);
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, other.user.user_id, ctx.guild]);
  const made = await post('/tenants', other, { display_name: '品牌乙', workspace_name: '乙櫃' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const otherTenant = made.data.tenant.tenant_id as string;
  await rejectCode('23514', q => q.query('UPDATE work_items SET tenant_id=$2 WHERE work_item_id=$1', [ctx.workId, otherTenant]));
  await rejectCode('23514', q => q.query('UPDATE work_items SET instance_id=$2 WHERE work_item_id=$1', [ctx.workId, randomUUID()]));
  await rejectCode('23514', q => q.query('UPDATE work_items SET workspace_id=$2 WHERE work_item_id=$1', [ctx.workId, randomUUID()]));
  await rejectCode('23514', q => q.query('UPDATE work_items SET created_by_principal_id=$2 WHERE work_item_id=$1', [ctx.workId, randomUUID()]));
  await rejectCode('23514', q => q.query('DELETE FROM module_instances WHERE instance_id=$1', [ctx.instanceId]));
  await rejectCode('23514', q => q.query('UPDATE workspace_module_bindings SET instance_id=$2 WHERE tenant_id=$1', [ctx.tenantId, randomUUID()]));
  await rejectCode('23514', q => q.query('DELETE FROM workspace_module_bindings WHERE tenant_id=$1', [ctx.tenantId]));
  const first = await upload(ctx, 'one.txt', ABC, '1');
  const secondBytes = new TextEncoder().encode('second');
  const second = await upload(ctx, 'two.txt', secondBytes, '2');
  await rejectCode('23514', q => q.query('UPDATE tenant_work_results SET display_name=$2 WHERE result_id=$1', [first, 'renamed.txt']));
  await rejectCode('23514', q => q.query('DELETE FROM tenant_work_results WHERE result_id=$1', [first]));
  await rejectCode('23514', q => q.query('UPDATE tenant_work_result_targets SET result_id=$2 WHERE work_item_id=$1', [ctx.workId, first]));
  const archived = await post(`/tenants/${ctx.tenantId}/works/${ctx.workId}/archive`, ctx.owner, {}, '"3"');
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  await rejectCode('23514', q => q.query(`UPDATE work_items SET title='改封存' WHERE work_item_id=$1`, [ctx.workId]));
  const principal = (await pool.query<{ principal_id: string }>('SELECT principal_id FROM principals WHERE user_ref=$1', [ctx.owner.user.user_id])).rows[0].principal_id;
  const personal = (await pool.query<{ scope_id: string }>('SELECT scope_id FROM resource_scopes WHERE owner_principal_id=$1 AND kind=$2', [principal, 'personal'])).rows[0].scope_id;
  const personalWork = randomUUID();
  await pool.query(`INSERT INTO work_items(work_item_id,owner_ref,title,objective,state,work_mode,scope_id,owner_principal_id,participation_terms_revision)
    VALUES($1,$2,'Personal','Personal objective','draft','personal_execution',$3,$4,NULL)`, [personalWork, ctx.owner.user.user_id, personal, principal]);
  const communityWork = randomUUID();
  await pool.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,
      participation_terms,participation_terms_sha256,claim_window_expires_at,due_at)
    VALUES($1,$2,$3,'Community','Shared','Criteria','Gain','open','{}',$4,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day')`,
  [communityWork, DEMO_COMMUNITY, ctx.owner.user.user_id, ABC_SHA]);
  const assetNames = await writableColumns('assets');
  const intentNames = await writableColumns('asset_upload_intents');
  const sampleAsset = (await pool.query(`SELECT ${assetNames.map(name => `"${name}"`).join(',')} FROM assets WHERE purpose='work.tenant-result' LIMIT 1`)).rows[0];
  const sampleIntent = (await pool.query(`SELECT ${intentNames.map(name => `"${name}"`).join(',')} FROM asset_upload_intents WHERE purpose='work.tenant-result' LIMIT 1`)).rows[0];
  async function attempt(overrides: Record<string, unknown>, code: string) {
    await rejectCode(code, async q => {
      const assetId = randomUUID();
      const representationId = randomUUID();
      const asset = {
        ...sampleAsset, asset_id: assetId, representation_id: representationId,
        state: 'pending', ready_at: null, retired_at: null,
      };
      await q.query(`INSERT INTO assets(${assetNames.join(',')}) VALUES(${assetNames.map((_, i) => `$${i + 1}`).join(',')})`, assetNames.map(name => asset[name]));
      const intent = {
        ...sampleIntent, ...overrides, intent_id: randomUUID(), asset_id: assetId, representation_id: representationId, prepare_key: randomUUID(),
        state: 'prepared', fence: 0, lease_token: null, lease_expires_at: null, finalized_at: null,
      };
      await q.query(`INSERT INTO asset_upload_intents(${intentNames.join(',')}) VALUES(${intentNames.map((_, i) => `$${i + 1}`).join(',')})`, intentNames.map(name => intent[name]));
    });
  }
  await attempt({ display_name: 'a/b.txt' }, '23514');
  await attempt({ target_work_id: personalWork }, '23503');
  await attempt({ target_work_id: communityWork }, '23503');
  await attempt({ target_tenant_id: otherTenant }, '23503');
  await rejectCode('23503', async q => {
    const assetId = randomUUID();
    const representationId = randomUUID();
    await q.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,policy_revision,representation_id,scope_kind)
      VALUES($1,$2,$3,$4,'work.private-draft','synthetic-text-v1',$5,'personal')`,
    [assetId, personal, principal, ctx.owner.user.user_id, representationId]);
    await q.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,target_kind,target_work_id,purpose,policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,reserved_bytes,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'work.private-result',$7,'work.private-draft','synthetic-text-v1',$8,$9,'text/plain',3,$9,'1',262144,$10)`,
    [randomUUID(), assetId, representationId, personal, principal, ctx.owner.user.user_id, ctx.workId, randomUUID(), ABC_SHA, new Date(Date.now() + 3600000)]);
  });
  const pointer = (await pool.query<{ result_id: string }>('SELECT result_id FROM tenant_work_result_targets WHERE work_item_id=$1', [ctx.workId])).rows[0].result_id;
  assert.equal(pointer, second);
});

test('share holders do not block each other, and revocation waits behind an in-flight share', async () => {
  const ctx = await openTenant();
  const adminUserId = randomUUID();
  const email = `tenant-${adminUserId}@example.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,'管理員',password_hash,$4,true,false FROM users WHERE email=$5`,
  [adminUserId, DEMO_COMMUNITY, email, randomUUID(), DEMO_USERS[0].email]);
  const admin = await sessionFrom(email);
  const found = await call('GET', `/tenants/invite-candidates?user_id=${adminUserId}`, ctx.owner);
  assert.equal(found.status, 200, JSON.stringify(found.data));
  const principalId = found.data.principal_id as string;
  const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const invitation = await post(`/tenants/${ctx.tenantId}/invitations`, ctx.owner, {
    invitee_principal_id: principalId, role: 'admin', instance_capabilities: [], expires_at: soon,
  });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
  assert.equal((await post(`/tenants/${ctx.tenantId}/invitations/${invitation.data.invitation_id}/accept`, admin, {}, `"${invitation.data.version}"`)).status, 200);
  const ownerPrincipal = (await pool.query<{ principal_id: string }>('SELECT principal_id FROM principals WHERE user_ref=$1', [ctx.owner.user.user_id])).rows[0].principal_id;
  const a = await pool.connect();
  const b = await pool.connect();
  const c = await pool.connect();
  const d = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    const pidA = Number((await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const pidB = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await a.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR SHARE', [ctx.tenantId]);
    await a.query('SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE', [ctx.tenantId, ownerPrincipal]);
    await b.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR SHARE', [ctx.tenantId]);
    await b.query('SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE', [ctx.tenantId, principalId]);
    assert.equal((await blockers(pidA)).includes(pidB), false);
    assert.equal((await blockers(pidB)).includes(pidA), false);
    await c.query('BEGIN');
    const pidC = Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const waiting = c.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [ctx.tenantId]);
    await waitBlocked(pidC);
    assert.ok((await blockers(pidC)).includes(pidA) || (await blockers(pidC)).includes(pidB));
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
    await waiting;
    await c.query('ROLLBACK');

    await d.query('BEGIN');
    const pidD = Number((await d.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await d.query('SELECT work_item_id FROM work_items WHERE work_item_id=$1 FOR UPDATE', [ctx.workId]);
    await a.query('BEGIN');
    await b.query('BEGIN');
    const sharePid = Number((await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await a.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR SHARE', [ctx.tenantId]);
    await a.query('SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE', [ctx.tenantId, principalId]);
    const workWait = a.query('SELECT work_item_id FROM work_items WHERE work_item_id=$1 FOR UPDATE', [ctx.workId]);
    await waitBlocked(sharePid);
    assert.equal((await blockers(pidD)).includes(sharePid), false);
    const revokePid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const revokeWait = b.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [ctx.tenantId]);
    await waitBlocked(revokePid);
    assert.ok((await blockers(revokePid)).includes(sharePid));
    await d.query('ROLLBACK');
    await workWait;
    await a.query('COMMIT');
    await revokeWait;
    await b.query(`UPDATE tenant_memberships SET status='revoked', revoked_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2`, [ctx.tenantId, principalId]);
    await b.query('COMMIT');
  } finally {
    for (const client of [a, b, c, d]) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
  const denied = await call('PATCH', `/tenants/${ctx.tenantId}/works/${ctx.workId}`, admin, {
    title: '撤銷後', objective: '不該寫入', progress: 'todo',
  }, { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' });
  assert.equal(denied.status, 404, JSON.stringify(denied.data));
  assert.equal(denied.data.code, 'tenant_not_found');
});

test('a restricted runtime role can enable and create, and cannot change capacity limits', async () => {
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = runtimeRole;
  runtimeUrl.password = '';
  const runtime = new Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${schema}`, max: 4 });
  const runtimeApp = createApp(runtime, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store });
  try {
    await assert.rejects(runtime.query(`INSERT INTO tenant_capacity_policies(
      policy_id, revision, plan_ref, max_active_instances, max_instances_per_module, max_concurrent_provisions,
      max_work_items, max_retained_bytes, max_concurrent_jobs, status)
      VALUES($1,1,'synthetic',1,1,1,1,262144,1,'retired')`, [randomUUID()]), (error: { code?: string }) => error.code === '42501');
    await assert.rejects(runtime.query(`UPDATE tenant_capacity_policies SET max_work_items=1 WHERE tenant_id IS NULL`), (error: { code?: string }) => error.code === '42501');
    await assert.rejects(runtime.query(`DELETE FROM tenant_capacity_policies WHERE tenant_id IS NULL`), (error: { code?: string }) => error.code === '42501');
    await runtime.query(`UPDATE tenant_capacity_policies SET policy_lock=DEFAULT WHERE tenant_id IS NULL`);
    const ctx = await openTenant(runtimeApp);
    assert.equal(ctx.workId.length, 36);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`GRANT UPDATE (max_work_items) ON tenant_capacity_policies TO PUBLIC`);
      const poisoned = (await client.query(capacityGrantQuery)).rows;
      assert.equal(poisoned.length, 1);
      await assert.rejects(
        client.query(Object.values(poisoned[0])[0] as string),
        (error: Error) => error.message === 'Unsafe runtime tenant capacity policy privileges',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await runtime.end();
  }
});
