import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import type { AssetObjectKey, ObjectRange, ObjectStore, PreparedRepresentation } from '../../packages/asset-storage/index.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_tw_fix_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c statement_timeout=30000`, max: 12 });
const ABC = new TextEncoder().encode('abc');

class BarrierStore implements ObjectStore {
  readonly inner = new FakeObjectStore();
  getEntered: Promise<void> = Promise.resolve();
  private getsHeld = 0;
  private signalGet: (() => void) | null = null;
  private getWaiting: Promise<void> = Promise.resolve();
  private releaseGet: (() => void) | null = null;
  holdGets() {
    this.getsHeld = 0;
    this.getEntered = new Promise(resolve => { this.signalGet = resolve; });
    this.getWaiting = new Promise(resolve => { this.releaseGet = resolve; });
  }
  release() {
    this.releaseGet?.();
    this.releaseGet = null;
    this.getWaiting = Promise.resolve();
  }
  async putImmutable(key: AssetObjectKey, value: PreparedRepresentation) {
    return this.inner.putImmutable(key, value);
  }
  async get(key: AssetObjectKey, range?: ObjectRange) {
    const object = await this.inner.get(key, range);
    if (this.releaseGet) {
      this.getsHeld += 1;
      if (this.getsHeld === 1) this.signalGet?.();
      await this.getWaiting;
    }
    return object;
  }
  head(key: AssetObjectKey) { return this.inner.head(key); }
  delete(key: AssetObjectKey) { return this.inner.delete(key); }
}

const store = new BarrierStore();
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store });
type Session = { cookie: string; csrf: string; user: { user_id: string; display_name: string; email: string } };
type Reply = { status: number; data: any; response: Response; bytes: Uint8Array };

before(async () => {
  assert.match(schema, /^fp_tw_fix_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  store.release();
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
  await pool.query(`INSERT INTO tenant_capacity_policies(
      policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
      max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
    SELECT $1, 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1', 10, 3, 2, 1000, 104857600, 4, NULL, 'active'
    WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`, [randomUUID()]);
});

function sha(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
async function call(method: string, path: string, session?: Session, body?: BodyInit | Uint8Array, headers: Record<string, string> = {}): Promise<Reply> {
  const sent: Record<string, string> = { Origin: origin, ...headers };
  if (session) { sent.Cookie = session.cookie; sent['X-CSRF-Token'] = session.csrf; }
  const payload = body instanceof Uint8Array ? new Uint8Array(body) : body;
  const response = await app.request(origin + '/api/v1' + path, { method, headers: sent, body: payload });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? '';
  const data = type.includes('application/json') && bytes.byteLength ? JSON.parse(Buffer.from(bytes).toString('utf8')) : null;
  return { status: response.status, data, response, bytes };
}
function jsonHeaders(key?: string, version?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  if (version !== undefined) headers['If-Match'] = version;
  return headers;
}
async function post(path: string, session: Session | undefined, body: unknown, version?: string, key = randomUUID()) {
  return call('POST', path, session, JSON.stringify(body), jsonHeaders(key, version));
}
async function patch(path: string, session: Session, body: unknown, version?: string, key = randomUUID()) {
  return call('PATCH', path, session, JSON.stringify(body), jsonHeaders(key, version));
}
const sessionOf = (r: Reply): Session => ({
  cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf_token, user: r.data.user,
});
async function signIn(email: string): Promise<Session> {
  const r = await post('/auth/login', undefined, { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return sessionOf(r);
}
async function person(name: string) {
  const id = randomUUID(), email = `tenant-${id}@example.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
  [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
  return { id, email, session: await signIn(email) };
}
async function createTenant(owner: Session, display_name: string) {
  const made = await post('/tenants', owner, { display_name, workspace_name: '櫃檯' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return { tenantId: made.data.tenant.tenant_id as string, workspaceId: made.data.workspace.workspace_id as string };
}
async function guildKeys() {
  const rows = (await pool.query<{ guild_key: string }>('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 3')).rows;
  assert.equal(rows.length, 3);
  return rows.map(row => row.guild_key);
}
async function fullMember(userId: string, guildKey: string) {
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, userId, guildKey]);
}
async function enable(session: Session, tenantId: string, workspaceId: string, guildKey: string, key = randomUUID(), body: Record<string, unknown> = {}) {
  return post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, session, { guild_key: guildKey, ...body }, undefined, key);
}
const workBody = (title: string) => ({ title, objective: '把這件事做完', progress: 'todo' as const });
async function createWork(session: Session, tenantId: string, workspaceId: string, title: string) {
  return post(`/tenants/${tenantId}/workspaces/${workspaceId}/works`, session, workBody(title));
}
async function prepareUpload(session: Session, tenantId: string, workId: string, name: string, bytes: Uint8Array, expected: string) {
  return post(`/tenants/${tenantId}/works/${workId}/results/uploads`, session, {
    content_type: 'text/plain', byte_size: bytes.byteLength, sha256: sha(bytes), display_name: name, expected_work_version: expected,
  });
}
async function writeUpload(session: Session, tenantId: string, workId: string, uploadId: string, bytes: Uint8Array, version: string) {
  return call('PUT', `/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}/content`, session, bytes, {
    'Idempotency-Key': randomUUID(), 'If-Match': `"${version}"`,
  });
}
async function finalizeUpload(session: Session, tenantId: string, workId: string, uploadId: string, workVersion: string, uploadVersion: string) {
  return post(`/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}/finalize`, session, { expected_work_version: workVersion }, `"${uploadVersion}"`);
}

async function openHolder(lockSql: string, params: unknown[]) {
  assert.match(schema, /^fp_tw_fix_[0-9]+_[0-9]+$/);
  const client: PoolClient = await admin.connect();
  await client.query(`SET search_path TO ${schema}`);
  await client.query('BEGIN');
  const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const locked = await client.query(lockSql, params);
  assert.equal(locked.rowCount, 1, lockSql);
  let closed = false;
  return {
    pid,
    commit: async () => {
      if (closed) return;
      closed = true;
      try {
        await client.query('COMMIT');
        client.release();
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release(error instanceof Error ? error : new Error('holder commit failed'));
        throw error;
      }
    },
    release: async () => {
      if (closed) return;
      closed = true;
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    },
  };
}
async function blockedQueries(holderPid: number) {
  return (await admin.query<{ pid: number; query: string }>(
    `SELECT pid, query FROM pg_stat_activity WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
    [holderPid])).rows.map(row => ({ pid: Number(row.pid), query: row.query ?? '' }));
}
async function waitForBlockedQuery(holderPid: number, parts: string[]) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const hit = (await blockedQueries(holderPid)).find(row => parts.every(part => row.query.includes(part)));
    if (hit) return hit;
    await delay(40);
  }
  const seen = await blockedQueries(holderPid);
  assert.fail(`no backend blocked by ${holderPid} matching ${parts.join(' & ')}; saw ${JSON.stringify(seen)}`);
}
async function waitForBlockedBy(holderPids: number[]) {
  let seen: { holderPid: number; waiting: { pid: number; query: string }[] }[] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    seen = [];
    for (const holderPid of holderPids) {
      const waiting = await blockedQueries(holderPid);
      seen.push({ holderPid, waiting });
      if (waiting.length > 0) return { holderPid, waiting: waiting[0] };
    }
    await delay(40);
  }
  assert.fail(`no backend blocked by ${holderPids.join(' or ')}; saw ${JSON.stringify(seen)}`);
}
async function waitForReturnOrBlocked(pending: Promise<Reply>, blockerPid: number) {
  let settled = false;
  let result: Reply | undefined;
  let failure: unknown;
  pending.then(value => { result = value; settled = true; }, error => { failure = error; settled = true; });
  let waiting: { pid: number; query: string }[] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (settled) {
      if (failure !== undefined) throw failure;
      return { returned: true as const, result: result! };
    }
    waiting = await blockedQueries(blockerPid);
    if (waiting.length > 0) return { returned: false as const, waiting: waiting[0] };
    await delay(40);
  }
  assert.fail(`request neither returned nor blocked on ${blockerPid}; saw ${JSON.stringify(waiting)}`);
}
async function waitForBlockedCount(holderPid: number, parts: string[], count: number) {
  let hits: { pid: number; query: string }[] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    hits = (await blockedQueries(holderPid)).filter(row => parts.every(part => row.query.includes(part)));
    if (hits.length >= count) return hits;
    await delay(40);
  }
  assert.fail(`expected ${count} backends blocked by ${holderPid} matching ${parts.join(' & ')}; saw ${JSON.stringify(hits)}`);
}
/** A held FOR UPDATE lives in the tuple header. pg_locks shows that row only while some other backend waits. */
async function holdsWorkUpdate(workId: string) {
  assert.match(schema, /^fp_tw_fix_[0-9]+_[0-9]+$/);
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT 1 FROM ${schema}.work_items WHERE work_item_id=$1 FOR KEY SHARE NOWAIT`, [workId]);
      return false;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03') return true;
      throw error;
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}
async function holdsGrantedAdvisory(pid: number) {
  const row = (await admin.query(
    `SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted`,
    [pid])).rows[0];
  return Number(row.n) > 0;
}
async function crossExpiry(deadline: Date) {
  const remaining = Number((await admin.query(
    'SELECT GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) * 1000)::float8 AS remaining',
    [deadline])).rows[0].remaining);
  await delay(remaining + 50);
  assert.equal((await admin.query('SELECT clock_timestamp() > $1::timestamptz AS expired', [deadline])).rows[0].expired, true);
}
async function appointMaster(userId: string, guildKey: string) {
  await fullMember(userId, guildKey);
  await pool.query(`INSERT INTO positioning_guild_officers(community_id, guild_key, user_id)
    VALUES($1,$2,$3)
    ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id = EXCLUDED.user_id`,
  [DEMO_COMMUNITY, guildKey, userId]);
}
async function membershipVersion(userId: string, guildKey: string) {
  const row = (await pool.query<{ aggregate_version: string }>(
    `SELECT aggregate_version::text AS aggregate_version FROM positioning_profession_memberships
     WHERE community_id=$1 AND user_id=$2 AND guild_key=$3`,
    [DEMO_COMMUNITY, userId, guildKey])).rows[0];
  assert.ok(row);
  return row.aggregate_version;
}
async function demote(master: Session, guildKey: string, userId: string) {
  const version = await membershipVersion(userId, guildKey);
  return post(`/guilds/${guildKey}/members/${userId}/tier`, master, { member_tier: 'intern' }, `"${version}"`);
}
async function workspaceReady(session: Session) {
  const [guild] = await guildKeys();
  const made = await createTenant(session, '品牌甲');
  await fullMember(session.user.user_id, guild);
  const enabled = await enable(session, made.tenantId, made.workspaceId, guild);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.reused, false);
  return { guild, ...made, instanceId: enabled.data.instance_id as string };
}
async function counts() {
  const row = (await pool.query(`SELECT
    (SELECT count(*)::int FROM module_instances) AS instances,
    (SELECT count(*)::int FROM deployment_bindings) AS deployments,
    (SELECT count(*)::int FROM workspace_module_bindings) AS bindings,
    (SELECT count(*)::int FROM work_items) AS works,
    (SELECT count(*)::int FROM tenant_work_results) AS results,
    (SELECT count(*)::int FROM scoped_transition_journal WHERE operation='manual.work.enable') AS enable_facts,
    (SELECT count(*)::int FROM asset_upload_intents WHERE purpose='work.tenant-result' AND state='finalized'
       AND NOT EXISTS (SELECT 1 FROM tenant_work_results r WHERE r.intent_id=asset_upload_intents.intent_id)) AS intents_without_result,
    (SELECT count(*)::int FROM tenant_work_results r
       WHERE NOT EXISTS (SELECT 1 FROM asset_upload_intents i WHERE i.intent_id=r.intent_id AND i.state='finalized')) AS results_without_intent
  `)).rows[0];
  return row;
}

test('demotion committed while enable waits on the workspace leaves no instance', { timeout: 45_000 }, async () => {
  const [guild] = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, guild);
  const master = await person('公會長');
  await appointMaster(master.id, guild);
  const holder = await openHolder(
    'SELECT workspace_id FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE',
    [made.tenantId, made.workspaceId],
  );
  const key = randomUUID();
  const pending = enable(owner, made.tenantId, made.workspaceId, guild, key);
  try {
    const waiting = await waitForBlockedQuery(holder.pid, ['INSERT INTO module_launch_plans']);
    assert.equal(waiting.query.includes('INSERT INTO module_launch_plans'), true);
    const demoted = await Promise.race([
      demote(master.session, guild, owner.user.user_id),
      delay(8_000).then(() => ({ status: 0, data: { code: 'demotion_blocked' }, bytes: new Uint8Array(), response: new Response() })),
    ]);
    assert.equal(demoted.status, 200, JSON.stringify(demoted.data));
    assert.equal(demoted.data.member_tier, 'intern');
    assert.equal(demoted.data.changed, true);
    await holder.release();
    const enabled = await pending;
    assert.equal(enabled.status, 403, JSON.stringify(enabled.data));
    assert.equal(enabled.data.code, 'guild_full_member_required');
    const after = await counts();
    assert.equal(after.instances, 0);
    assert.equal(after.deployments, 0);
    assert.equal(after.bindings, 0);
    assert.equal(after.enable_facts, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM scoped_command_receipts WHERE idempotency_key=$1', [key])).rows[0].n, 0);
  } finally {
    await holder.release();
    await pending.catch(() => undefined);
  }
});

test('a full member can enable and reuse, and a later demotion keeps existing work', async () => {
  const owner = await signIn(DEMO_USERS[0].email);
  const ready = await workspaceReady(owner);
  const again = await enable(owner, ready.tenantId, ready.workspaceId, ready.guild);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.reused, true);
  assert.equal(again.data.instance_id, ready.instanceId);
  const work = await createWork(owner, ready.tenantId, ready.workspaceId, '降級後仍在的工作');
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const workId = work.data.resource_ref.resource_id as string;
  const master = await person('另一位公會長');
  await appointMaster(master.id, ready.guild);
  const demoted = await demote(master.session, ready.guild, owner.user.user_id);
  assert.equal(demoted.status, 200, JSON.stringify(demoted.data));
  const replay = await enable(owner, ready.tenantId, ready.workspaceId, ready.guild, randomUUID());
  assert.equal(replay.status, 403, JSON.stringify(replay.data));
  assert.equal(replay.data.code, 'guild_full_member_required');
  const detail = await call('GET', `/tenants/${ready.tenantId}/works/${workId}`, owner);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.title, '降級後仍在的工作');
  assert.equal(detail.data.state, 'draft');
  const instance = (await pool.query<{ status: string }>('SELECT status FROM module_instances WHERE instance_id=$1', [ready.instanceId])).rows[0];
  assert.equal(instance.status, 'active');
  assert.equal((await counts()).instances, 1);
});

test('suspended and archived instances reject new work writes and keep reads', { timeout: 45_000 }, async () => {
  for (const status of ['suspended', 'archived'] as const) {
    const owner = await signIn(DEMO_USERS[0].email);
    const ready = await workspaceReady(owner);
    const kept = await createWork(owner, ready.tenantId, ready.workspaceId, `仍可讀的工作-${status}`);
    assert.equal(kept.status, 201, JSON.stringify(kept.data));
    const keptId = kept.data.resource_ref.resource_id as string;
    const publishedName = `已發布-${status}.txt`;
    const prepared = await prepareUpload(owner, ready.tenantId, keptId, publishedName, ABC, '1');
    assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
    const uploadId = prepared.data.resource_ref.resource_id as string;
    assert.equal((await writeUpload(owner, ready.tenantId, keptId, uploadId, ABC, '1')).status, 200);
    const finished = await finalizeUpload(owner, ready.tenantId, keptId, uploadId, '1', '2');
    assert.equal(finished.status, 200, JSON.stringify(finished.data));
    const resultId = finished.data.resource_ref.resource_id as string;
    const draft = await createWork(owner, ready.tenantId, ready.workspaceId, `待改的工作-${status}`);
    assert.equal(draft.status, 201);
    const draftId = draft.data.resource_ref.resource_id as string;
    const pendingUpload = await prepareUpload(owner, ready.tenantId, draftId, `未定稿-${status}.txt`, new TextEncoder().encode('pending'), '1');
    assert.equal(pendingUpload.status, 201, JSON.stringify(pendingUpload.data));
    const pendingId = pendingUpload.data.resource_ref.resource_id as string;
    assert.equal((await writeUpload(owner, ready.tenantId, draftId, pendingId, new TextEncoder().encode('pending'), '1')).status, 200);
    await pool.query(`UPDATE module_instances SET status=$2 WHERE instance_id=$1`, [ready.instanceId, status]);
    const placement = (await pool.query<{ tenant_status: string; workspace_status: string }>(
      `SELECT t.status AS tenant_status, w.status AS workspace_status
       FROM tenants t JOIN workspaces w ON w.tenant_id=t.tenant_id
       WHERE t.tenant_id=$1 AND w.workspace_id=$2`, [ready.tenantId, ready.workspaceId])).rows[0];
    assert.equal(placement.tenant_status, 'active');
    assert.equal(placement.workspace_status, 'active');
    const before = await counts();
    const created = await createWork(owner, ready.tenantId, ready.workspaceId, `不該出現-${status}`);
    const saved = await patch(`/tenants/${ready.tenantId}/works/${draftId}`, owner, workBody(`改過-${status}`), '"1"');
    const another = await prepareUpload(owner, ready.tenantId, keptId, `另一份-${status}.txt`, new TextEncoder().encode('nope'), '2');
    const finalized = await finalizeUpload(owner, ready.tenantId, draftId, pendingId, '1', '2');
    for (const reply of [created, saved, another, finalized]) {
      assert.equal(reply.status, 409, JSON.stringify(reply.data));
      assert.equal(reply.data.code, 'work_instance_unavailable');
    }
    const archived = await post(`/tenants/${ready.tenantId}/works/${draftId}/archive`, owner, {}, '"1"');
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    const detail = await call('GET', `/tenants/${ready.tenantId}/works/${keptId}`, owner);
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal(detail.data.title, `仍可讀的工作-${status}`);
    const result = await call('GET', `/tenants/${ready.tenantId}/works/${keptId}/results/${resultId}`, owner);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.display_name, publishedName);
    const after = await counts();
    assert.equal(after.works, before.works);
    assert.equal(after.results, before.results);
    assert.equal(after.results_without_intent, 0);
    assert.equal(after.intents_without_result, 0);
    await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
    await seedLocal(pool);
    await pool.query(`INSERT INTO tenant_capacity_policies(
        policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
        max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
      SELECT $1, 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1', 10, 3, 2, 1000, 104857600, 4, NULL, 'active'
      WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`, [randomUUID()]);
  }
});

test('a suspended deployment rejects new work writes', async () => {
  const owner = await signIn(DEMO_USERS[0].email);
  const ready = await workspaceReady(owner);
  const work = await createWork(owner, ready.tenantId, ready.workspaceId, '部署停用前的工作');
  assert.equal(work.status, 201);
  const workId = work.data.resource_ref.resource_id as string;
  await pool.query(`UPDATE deployment_bindings SET state='suspended' WHERE instance_id=$1`, [ready.instanceId]);
  assert.equal((await pool.query<{ status: string }>('SELECT status FROM module_instances WHERE instance_id=$1', [ready.instanceId])).rows[0].status, 'active');
  const created = await createWork(owner, ready.tenantId, ready.workspaceId, '不該建立');
  assert.equal(created.status, 409, JSON.stringify(created.data));
  assert.equal(created.data.code, 'work_instance_unavailable');
  const detail = await call('GET', `/tenants/${ready.tenantId}/works/${workId}`, owner);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.title, '部署停用前的工作');
});

test('prepare and finalize that cross on the capacity policy do not deadlock', { timeout: 45_000 }, async () => {
  const owner = await signIn(DEMO_USERS[0].email);
  const ready = await workspaceReady(owner);
  const work = await createWork(owner, ready.tenantId, ready.workspaceId, '同一份草稿');
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const workId = work.data.resource_ref.resource_id as string;
  const first = new TextEncoder().encode('first-note');
  const prepared = await prepareUpload(owner, ready.tenantId, workId, 'first.txt', first, '1');
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const uploadId = prepared.data.resource_ref.resource_id as string;
  assert.equal((await writeUpload(owner, ready.tenantId, workId, uploadId, first, '1')).status, 200);
  store.holdGets();
  const finishing = finalizeUpload(owner, ready.tenantId, workId, uploadId, '1', '2');
  let preparing: Promise<Reply> | undefined;
  let parked: Awaited<ReturnType<typeof openHolder>> | undefined;
  try {
    await store.getEntered;
    // Verify runs outside a transaction. Park the policy row before that read returns,
    // so publication takes the capacity advisory and then waits on FOR SHARE.
    parked = await openHolder(
      `SELECT policy_id FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL FOR UPDATE`,
      [],
    );
    store.release();
    const publication = await waitForBlockedQuery(parked.pid, ['tenant_capacity_policies', 'FOR SHARE']);
    assert.equal(await holdsGrantedAdvisory(publication.pid), true);
    const second = new TextEncoder().encode('second-note');
    preparing = prepareUpload(owner, ready.tenantId, workId, 'second.txt', second, '1');
    const waiter = await waitForBlockedQuery(publication.pid, ['pg_advisory_xact_lock']);
    const shape = {
      publication: publication.query,
      prepare: waiter.query,
      prepareHoldsWork: await holdsWorkUpdate(workId),
    };
    await parked.release();
    const [finished, next] = await Promise.all([finishing, preparing]);
    assert.equal(finished.status === 500 || next.status === 500, false,
      `deadlock shape ${JSON.stringify(shape)} finalize=${finished.status}:${JSON.stringify(finished.data)} prepare=${next.status}:${JSON.stringify(next.data)}`);
    assert.equal(shape.prepareHoldsWork, false, JSON.stringify(shape));
    assert.equal(finished.status, 200, JSON.stringify(finished.data));
    assert.equal(next.status, 412, JSON.stringify(next.data));
    assert.equal(next.data.code, 'version_conflict');
    const after = await counts();
    assert.equal(after.results, 1);
    assert.equal(after.results_without_intent, 0);
    assert.equal(after.intents_without_result, 0);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM asset_upload_intents WHERE purpose='work.tenant-result' AND state<>'finalized'`)).rows[0].n, 0);
  } finally {
    store.release();
    await parked?.release();
    await Promise.allSettled([finishing, preparing]);
  }
});

test('an active instance still saves, continues an upload, and finalizes', async () => {
  const owner = await signIn(DEMO_USERS[0].email);
  const ready = await workspaceReady(owner);
  const work = await createWork(owner, ready.tenantId, ready.workspaceId, '可繼續的工作');
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const workId = work.data.resource_ref.resource_id as string;
  const saved = await patch(`/tenants/${ready.tenantId}/works/${workId}`, owner, { title: '可繼續的工作', objective: '補上目標', progress: 'in_progress' }, '"1"');
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const first = new TextEncoder().encode('round-one');
  const prepared = await prepareUpload(owner, ready.tenantId, workId, 'one.txt', first, '2');
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const uploadId = prepared.data.resource_ref.resource_id as string;
  assert.equal((await writeUpload(owner, ready.tenantId, workId, uploadId, first, '1')).status, 200);
  const finished = await finalizeUpload(owner, ready.tenantId, workId, uploadId, '2', '2');
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  const second = new TextEncoder().encode('round-two');
  const again = await prepareUpload(owner, ready.tenantId, workId, 'two.txt', second, '3');
  assert.equal(again.status, 201, JSON.stringify(again.data));
  const secondId = again.data.resource_ref.resource_id as string;
  assert.equal((await writeUpload(owner, ready.tenantId, workId, secondId, second, '1')).status, 200);
  const done = await finalizeUpload(owner, ready.tenantId, workId, secondId, '3', '2');
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const detail = await call('GET', `/tenants/${ready.tenantId}/works/${workId}`, owner);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.version, '4');
  assert.equal((await counts()).results_without_intent, 0);
});

async function expireWhileWaiting(path: string, session: Session, secret: string) {
  const visible = await call('GET', path, session);
  assert.equal(visible.status, 200, JSON.stringify(visible.data));
  assert.equal(Buffer.from(visible.bytes).toString('utf8').includes(secret), true);
  const deadline = (await pool.query<{ expires_at: Date }>(
    `UPDATE sessions SET expires_at=clock_timestamp()+interval '12 seconds' WHERE user_id=$1 RETURNING expires_at`,
    [session.user.user_id])).rows[0].expires_at;
  const tenantId = path.split('/')[2];
  const holder = await openHolder('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
  const pending = call('GET', path, session);
  try {
    await waitForBlockedQuery(holder.pid, ['tenants', 'FOR SHARE']);
    await crossExpiry(deadline);
    await holder.release();
    const hidden = await pending;
    assert.equal(hidden.status, 401, JSON.stringify(hidden.data));
    assert.equal(hidden.data.code, 'session_expired');
    assert.equal(Buffer.from(hidden.bytes).toString('utf8').includes(secret), false);
  } finally {
    await holder.release();
    await pending.catch(() => undefined);
  }
}

test('a session that expires while the work list waits on the tenant row returns 401', { timeout: 45_000 }, async () => {
  const owner = await signIn(DEMO_USERS[0].email);
  const ready = await workspaceReady(owner);
  const title = 'SessionWaitTitleToken';
  assert.equal((await createWork(owner, ready.tenantId, ready.workspaceId, title)).status, 201);
  await expireWhileWaiting(`/tenants/${ready.tenantId}/workspaces/${ready.workspaceId}/works`, owner, title);
});

test('a session that expires while result metadata waits on the tenant row returns 401', { timeout: 45_000 }, async () => {
  const owner = await signIn(DEMO_USERS[0].email);
  const ready = await workspaceReady(owner);
  const work = await createWork(owner, ready.tenantId, ready.workspaceId, '有成果的工作');
  const workId = work.data.resource_ref.resource_id as string;
  const name = 'SessionWaitResultToken.txt';
  const prepared = await prepareUpload(owner, ready.tenantId, workId, name, ABC, '1');
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const uploadId = prepared.data.resource_ref.resource_id as string;
  assert.equal((await writeUpload(owner, ready.tenantId, workId, uploadId, ABC, '1')).status, 200);
  const finished = await finalizeUpload(owner, ready.tenantId, workId, uploadId, '1', '2');
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  const resultId = finished.data.resource_ref.resource_id as string;
  await expireWhileWaiting(`/tenants/${ready.tenantId}/works/${workId}/results/${resultId}`, owner, name);
});

function definedOutcome(result: Reply) {
  assert.notEqual(result.status, 500, JSON.stringify(result.data));
  assert.notEqual(result.data?.code, 'internal_error');
  assert.notEqual(result.data?.state, 'failed');
}

async function capacityReusePlan(owner: Session, ready: { tenantId: string; workspaceId: string; guild: string; instanceId: string }, label: string) {
  const work = await createWork(owner, ready.tenantId, ready.workspaceId, label);
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const version = (await pool.query<{ version: string }>(
    'SELECT version::text AS version FROM module_instances WHERE instance_id=$1',
    [ready.instanceId],
  )).rows[0].version;
  const other = await post(`/tenants/${ready.tenantId}/workspaces`, owner, { name: `${label}櫃` });
  assert.equal(other.status, 201, JSON.stringify(other.data));
  const planned = await post(`/tenants/${ready.tenantId}/application-launch-plans`, owner, {
    guild_key: ready.guild,
    workspace_id: other.data.workspace_id,
    application_key: 'manual-workspace',
    release_ref: 'manual-workspace@1.0.0',
    installation_choice: 'create_new',
    dependencies: [{ requirement_key: 'work', choice: 'reuse', instance_id: ready.instanceId, expected_version: version }],
    configuration: {},
  });
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  return {
    workId: work.data.resource_ref.resource_id as string,
    launch: () => post(`/tenants/${ready.tenantId}/application-installations`, owner, {
      plan_id: planned.data.plan_id,
      expected_plan_version: planned.data.version,
      configuration_digest: planned.data.configuration_digest,
    }),
  };
}

test('upload prepare and a capacity-reserving launch do not deadlock when prepare arrives first', { timeout: 45_000 }, async () => {
  const owner = await signIn(DEMO_USERS[0].email);
  const ready = await workspaceReady(owner);
  const planned = await capacityReusePlan(owner, ready, '準備先到');
  const holder = await openHolder(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`tenant.capacity/v1/${ready.tenantId}/policy`],
  );
  const pending: Promise<Reply>[] = [];
  try {
    const preparing = prepareUpload(owner, ready.tenantId, planned.workId, 'prepare-first.txt', ABC, '1');
    pending.push(preparing);
    await waitForBlockedQuery(holder.pid, ['pg_advisory_xact_lock']);
    const launching = planned.launch();
    pending.push(launching);
    const waiting = await waitForBlockedCount(holder.pid, ['pg_advisory_xact_lock'], 2);
    assert.equal(waiting.length, 2);
    await holder.release();
    const prepared = await preparing;
    const launched = await launching;
    definedOutcome(prepared);
    definedOutcome(launched);
    assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
    assert.equal(launched.status, 200, JSON.stringify(launched.data));
  } finally {
    await holder.release();
    await Promise.allSettled(pending);
  }
});

test('upload prepare and a capacity-reserving launch do not deadlock when launch arrives first', { timeout: 45_000 }, async () => {
  const owner = await signIn(DEMO_USERS[0].email);
  const ready = await workspaceReady(owner);
  const planned = await capacityReusePlan(owner, ready, '啟動先到');
  const holder = await openHolder(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`tenant.capacity/v1/${ready.tenantId}/policy`],
  );
  const pending: Promise<Reply>[] = [];
  try {
    const launching = planned.launch();
    pending.push(launching);
    await waitForBlockedQuery(holder.pid, ['pg_advisory_xact_lock']);
    const preparing = prepareUpload(owner, ready.tenantId, planned.workId, 'launch-first.txt', ABC, '1');
    pending.push(preparing);
    const waiting = await waitForBlockedCount(holder.pid, ['pg_advisory_xact_lock'], 2);
    assert.equal(waiting.length, 2);
    await holder.release();
    const launched = await launching;
    const prepared = await preparing;
    definedOutcome(launched);
    definedOutcome(prepared);
    assert.equal(launched.status, 200, JSON.stringify(launched.data));
    assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  } finally {
    await holder.release();
    await Promise.allSettled(pending);
  }
});

type DbFault = { code: string; message: string; detail: string; pid: number | null; query: string };
const dbFaults: DbFault[] = [];
let captureDbFaults = false;
const watchedClients = new WeakSet<PoolClient>();

function watchClient(client: PoolClient) {
  if (watchedClients.has(client)) return;
  watchedClients.add(client);
  const run = client.query.bind(client) as (...args: unknown[]) => unknown;
  client.query = ((...args: unknown[]) => {
    const pending = run(...args);
    if (typeof pending === 'object' && pending !== null && typeof (pending as { then?: unknown }).then === 'function') {
      return (pending as Promise<unknown>).catch((error: unknown) => {
        if (captureDbFaults && typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
          const fault = error as { code: string; message?: string; detail?: string };
          const first = args[0];
          const text = typeof first === 'string'
            ? first
            : first && typeof first === 'object' && 'text' in first && typeof first.text === 'string' ? first.text : '';
          const pid = (client as { processID?: unknown }).processID;
          dbFaults.push({
            code: fault.code,
            message: fault.message ?? '',
            detail: fault.detail ?? '',
            pid: typeof pid === 'number' ? pid : null,
            query: text.replace(/\s+/g, ' ').slice(0, 220),
          });
        }
        throw error;
      });
    }
    return pending;
  }) as PoolClient['query'];
}

async function databaseDeadlocks() {
  const row = (await admin.query<{ deadlocks: string | number }>(
    'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()',
  )).rows[0];
  return Number(row.deadlocks);
}

async function enableRaceRows() {
  return (await pool.query<{
    instances: number; installations: number; plans: number; consumptions: number;
    enable_facts: number; works: number; bindings: number;
  }>(`SELECT
    (SELECT count(*)::int FROM module_instances) AS instances,
    (SELECT count(*)::int FROM application_installations) AS installations,
    (SELECT count(*)::int FROM module_launch_plans) AS plans,
    (SELECT count(*)::int FROM module_launch_plan_consumptions) AS consumptions,
    (SELECT count(*)::int FROM scoped_transition_journal WHERE operation='manual.work.enable') AS enable_facts,
    (SELECT count(*)::int FROM work_items) AS works,
    (SELECT count(*)::int FROM workspace_module_bindings) AS bindings
  `)).rows[0];
}

test('manual enable and Work create on one workspace do not deadlock when a binding commits during the enable', { timeout: 45_000 }, async () => {
  const owner = await signIn(DEMO_USERS[0].email);
  const ready = await workspaceReady(owner);
  const second = await post(`/tenants/${ready.tenantId}/workspaces`, owner, { name: '未綁定櫃' });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  const workspaceId = second.data.workspace_id as string;
  const before = await enableRaceRows();
  const deadlocksBefore = await databaseDeadlocks();
  const onAcquire = (client: PoolClient) => { watchClient(client); };
  pool.on('acquire', onAcquire);
  dbFaults.length = 0;
  captureDbFaults = true;
  // Plan insert FK (application_key, release_ref) references this definition row.
  // migrations/126_module_registry.sql. Work create does not reference it.
  const h2 = await openHolder(
    `SELECT application_key FROM application_definitions
     WHERE application_key = 'manual-workspace' AND release_ref = 'manual-workspace@1.0.0'
     FOR UPDATE`,
    [],
  );
  // Stands in for a work:create binder outside this enable's installation fingerprint.
  const h1 = await openHolder(
    `INSERT INTO workspace_module_bindings(tenant_id, workspace_id, entry_capability, instance_id)
     VALUES ($1, $2, 'work:create', $3)`,
    [ready.tenantId, workspaceId, ready.instanceId],
  );
  const pending: Promise<Reply>[] = [];
  const key = randomUUID();
  try {
    const enabling = enable(owner, ready.tenantId, workspaceId, ready.guild, key, { choice: { kind: 'create_new' } });
    pending.push(enabling);
    const first = await waitForBlockedBy([h1.pid, h2.pid]);
    const enablePid = first.waiting.pid;
    await h1.commit();
    const onPlan = await waitForBlockedQuery(h2.pid, ['module_launch_plans']);
    assert.equal(onPlan.pid, enablePid, JSON.stringify({ first, onPlan }));
    const creating = createWork(owner, ready.tenantId, workspaceId, '綁定期間的工作');
    pending.push(creating);
    const workWait = await waitForReturnOrBlocked(creating, enablePid);
    await h2.commit();
    const enabled = await enabling;
    const created = workWait.returned ? workWait.result : await creating;
    const after = await enableRaceRows();
    const enableReceipts = Number((await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM scoped_command_receipts WHERE idempotency_key=$1',
      [key],
    )).rows[0].n);
    const deadlockDelta = (await databaseDeadlocks()) - deadlocksBefore;
    const observed = {
      firstHolder: first.holderPid,
      firstQuery: first.waiting.query,
      enablePid,
      workWait: workWait.returned
        ? { returned: true, status: workWait.result.status, code: workWait.result.data?.code ?? null }
        : { returned: false, pid: workWait.waiting.pid, query: workWait.waiting.query },
      enable: { status: enabled.status, code: enabled.data?.code ?? null, state: enabled.data?.state ?? null },
      created: { status: created.status, code: created.data?.code ?? null, state: created.data?.state ?? null },
      dbFaults: dbFaults.map(fault => ({ ...fault })),
      deadlockDelta,
      enableReceipts,
      before,
      after,
    };
    const snapshot = JSON.stringify(observed);
    assert.equal(deadlockDelta, 0, snapshot);
    assert.equal(dbFaults.some(fault => fault.code === '40P01'), false, snapshot);
    definedOutcome(enabled);
    definedOutcome(created);
    assert.equal(created.status, 201, snapshot);
    assert.equal(enabled.status, 409, snapshot);
    assert.equal(enabled.data.code, 'workspace_binding_conflict', snapshot);
    assert.equal(after.instances, before.instances, snapshot);
    assert.equal(after.installations, before.installations, snapshot);
    assert.equal(after.plans, before.plans, snapshot);
    assert.equal(after.consumptions, before.consumptions, snapshot);
    assert.equal(after.enable_facts, before.enable_facts, snapshot);
    assert.equal(enableReceipts, 0, snapshot);
    assert.equal(after.works, before.works + 1, snapshot);
    assert.equal(after.bindings, before.bindings + 1, snapshot);
  } finally {
    captureDbFaults = false;
    pool.off('acquire', onAcquire);
    await h1.release();
    await h2.release();
    await Promise.allSettled(pending);
  }
});
