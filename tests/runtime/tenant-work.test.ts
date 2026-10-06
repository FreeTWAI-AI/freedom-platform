import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import type { AssetObjectKey, ObjectRange, ObjectStore, PreparedRepresentation } from '../../packages/asset-storage/index.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_tenant_work_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const ABC = new TextEncoder().encode('abc');
const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

class BarrierStore implements ObjectStore {
  readonly inner = new FakeObjectStore();
  entered: Promise<void> = Promise.resolve();
  private signalEntered: (() => void) | null = null;
  private waiting: Promise<void> = Promise.resolve();
  private releaseWait: (() => void) | null = null;
  holdNextPut() {
    this.entered = new Promise(resolve => { this.signalEntered = resolve; });
    this.waiting = new Promise(resolve => { this.releaseWait = resolve; });
  }
  release() {
    this.releaseWait?.();
    this.releaseWait = null;
    this.waiting = Promise.resolve();
  }
  async putImmutable(key: AssetObjectKey, value: PreparedRepresentation) {
    const outcome = await this.inner.putImmutable(key, value);
    this.signalEntered?.();
    await this.waiting;
    return outcome;
  }
  get(key: AssetObjectKey, range?: ObjectRange) { return this.inner.get(key, range); }
  head(key: AssetObjectKey) { return this.inner.head(key); }
  delete(key: AssetObjectKey) { return this.inner.delete(key); }
}

const store = new BarrierStore();
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store });
const closed = createApp(pool, origin, 'local');
const unstored = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true });
type Session = { cookie: string; csrf: string; user: { user_id: string; display_name: string; email: string } };
type Reply = { status: number; data: any; response: Response; bytes: Uint8Array };

before(async () => {
  assert.match(schema, /^fp_tenant_work_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
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
async function call(method: string, path: string, session?: Session, body?: BodyInit | Uint8Array, headers: Record<string, string> = {}, target = app): Promise<Reply> {
  const sent: Record<string, string> = { Origin: origin, ...headers };
  if (session) { sent.Cookie = session.cookie; sent['X-CSRF-Token'] = session.csrf; }
  const payload = body instanceof Uint8Array ? new Uint8Array(body) : body;
  const response = await target.request(origin + '/api/v1' + path, { method, headers: sent, body: payload });
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
async function post(path: string, session: Session | undefined, body: unknown, version?: string, key = randomUUID(), target = app) {
  return call('POST', path, session, JSON.stringify(body), jsonHeaders(key, version), target);
}
async function patch(path: string, session: Session, body: unknown, version?: string, key = randomUUID()) {
  return call('PATCH', path, session, JSON.stringify(body), jsonHeaders(key, version));
}
const sessionOf = (r: Reply): Session => ({
  cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf_token, user: r.data.user,
});
async function signIn(email: string, target = app): Promise<Session> {
  const r = await post('/auth/login', undefined, { email, password: DEMO_PASSWORD }, undefined, randomUUID(), target);
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
async function createTenant(owner: Session, display_name: string, workspace_name = '櫃檯') {
  const made = await post('/tenants', owner, { display_name, workspace_name });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return { tenantId: made.data.tenant.tenant_id as string, workspaceId: made.data.workspace.workspace_id as string };
}
async function candidate(actor: Session, userId: string) {
  const found = await call('GET', `/tenants/invite-candidates?user_id=${userId}`, actor);
  assert.equal(found.status, 200, JSON.stringify(found.data));
  return found.data.principal_id as string;
}
async function invite(actor: Session, tenantId: string, principalId: string, role: 'admin' | 'operator' | 'viewer') {
  const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  return post(`/tenants/${tenantId}/invitations`, actor, {
    invitee_principal_id: principalId, role, instance_capabilities: [], expires_at: soon,
  });
}
async function accept(invitee: Session, tenantId: string, invitation: Reply) {
  const accepted = await post(`/tenants/${tenantId}/invitations/${invitation.data.invitation_id}/accept`, invitee, {}, `"${invitation.data.version}"`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
}
async function membership(actor: Session, tenantId: string, principalId: string) {
  const page = await call('GET', `/tenants/${tenantId}/members?limit=100`, actor);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  return page.data.items.find((item: { principal_id: string }) => item.principal_id === principalId);
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
async function enable(session: Session, tenantId: string, workspaceId: string, guildKey: string, choice?: unknown, key = randomUUID()) {
  return post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, session, choice ? { guild_key: guildKey, choice } : { guild_key: guildKey }, undefined, key);
}
const workBody = (title: string, objective = '把這件事做完', progress: 'todo' | 'in_progress' | 'done' = 'todo') => ({ title, objective, progress });
async function createWork(session: Session, tenantId: string, workspaceId: string, title: string, key = randomUUID()) {
  return post(`/tenants/${tenantId}/workspaces/${workspaceId}/works`, session, workBody(title), undefined, key);
}
async function prepareUpload(session: Session, tenantId: string, workId: string, name: string, type: 'text/plain' | 'text/markdown', bytes: Uint8Array, expected: string, key = randomUUID()) {
  return post(`/tenants/${tenantId}/works/${workId}/results/uploads`, session, {
    content_type: type, byte_size: bytes.byteLength, sha256: sha(bytes), display_name: name, expected_work_version: expected,
  }, undefined, key);
}
async function writeUpload(session: Session, tenantId: string, workId: string, uploadId: string, bytes: Uint8Array, version: string, key = randomUUID()) {
  return call('PUT', `/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}/content`, session, bytes, {
    'Idempotency-Key': key, 'If-Match': `"${version}"`,
  });
}
async function finalizeUpload(session: Session, tenantId: string, workId: string, uploadId: string, workVersion: string, uploadVersion: string, key = randomUUID()) {
  return post(`/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}/finalize`, session, { expected_work_version: workVersion }, `"${uploadVersion}"`, key);
}
async function modelCounts() {
  const names = (await pool.query<{ relname: string }>(`SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind='r' AND (c.relname LIKE '%model%' OR c.relname LIKE 'execution_%')
    ORDER BY c.relname`)).rows.map(row => row.relname);
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (await pool.query(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n;
  return counts;
}

test('three catalog guilds can enable manual work, and a human note plus text attachment round-trips after logout', async () => {
  const keys = await guildKeys();
  assert.equal(new Set(keys).size, 3);
  const beforeModels = await modelCounts();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, keys[0]);
  const enabled = await enable(owner, made.tenantId, made.workspaceId, keys[0]);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.reused, false);
  assert.equal(enabled.data.entry_capability, 'work:create');
  assert.equal(enabled.data.version, '1');
  assert.equal(enabled.response.headers.get('cache-control'), 'private, no-store');
  const again = await enable(owner, made.tenantId, made.workspaceId, keys[0]);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.reused, true);
  assert.equal(again.data.instance_id, enabled.data.instance_id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM module_instances')).rows[0].n, 1);
  const listed = await call('GET', `/tenants/${made.tenantId}/module-instances?limit=20`, owner);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal(listed.data.items.length, 1);
  assert.equal(listed.data.items[0].application_release_ref, 'manual-workspace@1.0.0');
  assert.equal(listed.data.items[0].data_schema_version, '1');
  assert.equal(listed.data.items[0].status, 'active');
  assert.equal(Object.hasOwn(listed.data.items[0], 'contract_ref'), false);
  const created = await createWork(owner, made.tenantId, made.workspaceId, 'WorkTitleTokenZed');
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.state, 'succeeded');
  assert.equal(created.data.version, '1');
  assert.equal(created.data.resource_ref.resource_type, 'work.work');
  const workId = created.data.resource_ref.resource_id as string;
  const detail = await call('GET', `/tenants/${made.tenantId}/works/${workId}`, owner);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.version, '1');
  assert.equal(detail.data.state, 'draft');
  assert.equal(detail.data.current_result_id, undefined);
  assert.equal(detail.response.headers.get('etag'), '"1"');
  const note = new TextEncoder().encode('A-only-note');
  const prepared = await prepareUpload(owner, made.tenantId, workId, 'NoteNameTokenZed.md', 'text/markdown', note, '1');
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal(prepared.data.resource_ref.resource_type, 'work.upload');
  const uploadId = prepared.data.resource_ref.resource_id as string;
  const meta = await call('GET', `/tenants/${made.tenantId}/works/${workId}/results/uploads/${uploadId}`, owner);
  assert.equal(meta.status, 200, JSON.stringify(meta.data));
  assert.equal(meta.data.version, '1');
  assert.equal(meta.data.phase, 'prepared');
  assert.equal(meta.data.display_name, 'NoteNameTokenZed.md');
  assert.equal(meta.response.headers.get('etag'), '"1"');
  const writeKey = randomUUID();
  const written = await writeUpload(owner, made.tenantId, workId, uploadId, note, '1', writeKey);
  assert.equal(written.status, 200, JSON.stringify(written.data));
  assert.equal(written.data.verified, true);
  assert.equal(written.data.version, '2');
  const replayedWrite = await writeUpload(owner, made.tenantId, workId, uploadId, note, '1', writeKey);
  assert.deepEqual(replayedWrite.data, written.data);
  const finished = await finalizeUpload(owner, made.tenantId, workId, uploadId, '1', '2');
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  assert.equal(finished.data.resource_ref.resource_type, 'work.result');
  const resultId = finished.data.resource_ref.resource_id as string;
  const result = await call('GET', `/tenants/${made.tenantId}/works/${workId}/results/${resultId}`, owner);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.revision, '1');
  assert.equal(result.data.work_version, '2');
  assert.equal(result.data.provenance, 'human');
  assert.equal(result.data.display_name, 'NoteNameTokenZed.md');
  assert.equal(result.response.headers.get('etag'), '"2"');
  const attachPrep = await prepareUpload(owner, made.tenantId, workId, 'attach.txt', 'text/plain', ABC, '2');
  assert.equal(attachPrep.status, 201, JSON.stringify(attachPrep.data));
  const attachId = attachPrep.data.resource_ref.resource_id as string;
  const attachWrite = await writeUpload(owner, made.tenantId, workId, attachId, ABC, '1');
  assert.equal(attachWrite.status, 200, JSON.stringify(attachWrite.data));
  assert.equal(attachWrite.data.version, '2');
  const attachDone = await finalizeUpload(owner, made.tenantId, workId, attachId, '2', '2');
  assert.equal(attachDone.status, 200, JSON.stringify(attachDone.data));
  const latestId = attachDone.data.resource_ref.resource_id as string;
  const after = await call('GET', `/tenants/${made.tenantId}/works/${workId}`, owner);
  assert.equal(after.data.version, '3');
  assert.equal(after.data.current_result_id, latestId);
  assert.equal(after.response.headers.get('etag'), '"3"');
  const page = await call('GET', `/tenants/${made.tenantId}/works/${workId}/results?limit=20`, owner);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.deepEqual(page.data.items.map((item: { revision: string }) => item.revision), ['2', '1']);
  const loggedOut = await post('/auth/logout', owner, {});
  assert.equal(loggedOut.status, 200, JSON.stringify(loggedOut.data));
  const returned = await signIn(DEMO_USERS[0].email);
  const content = await call('GET', `/tenants/${made.tenantId}/works/${workId}/results/${resultId}/content`, returned);
  assert.equal(content.status, 200, JSON.stringify(content.data));
  assert.deepEqual(Buffer.from(content.bytes), Buffer.from(note));
  assert.match(content.response.headers.get('content-type') ?? '', /^text\/markdown; charset=utf-8$/);
  assert.match(content.response.headers.get('content-disposition') ?? '', /attachment;/);
  assert.match(content.response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
  assert.equal(content.response.headers.get('cache-control'), 'private, no-store');
  const attachment = await call('GET', `/tenants/${made.tenantId}/works/${workId}/results/${latestId}/content`, returned);
  assert.deepEqual(Buffer.from(attachment.bytes), Buffer.from(ABC));
  assert.equal(sha(attachment.bytes), ABC_SHA);
  const leaked = (await pool.query(`SELECT count(*)::int AS n FROM scoped_transition_journal
    WHERE data::text LIKE '%WorkTitleTokenZed%' OR data::text LIKE '%NoteNameTokenZed%' OR data::text LIKE '%A-only-note%'`)).rows[0].n;
  assert.equal(leaked, 0);
  assert.deepEqual(await modelCounts(), beforeModels);
  const second = await person('第二位負責人');
  const other = await createTenant(second.session, '品牌乙');
  await fullMember(second.id, keys[1]);
  assert.equal((await enable(second.session, other.tenantId, other.workspaceId, keys[1])).status, 200);
  const third = await person('第三位負責人');
  const thirdSpace = await createTenant(third.session, '品牌丙');
  await fullMember(third.id, keys[2]);
  const thirdEnable = await enable(third.session, thirdSpace.tenantId, thirdSpace.workspaceId, keys[2]);
  assert.equal(thirdEnable.status, 200, JSON.stringify(thirdEnable.data));
  assert.equal((await createWork(third.session, thirdSpace.tenantId, thirdSpace.workspaceId, '第三個工作')).status, 201);
});

test('a second guild reuses the workspace binding, and a second workspace must choose the instance', async () => {
  const keys = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, keys[0]);
  await fullMember(owner.user.user_id, keys[1]);
  const first = await enable(owner, made.tenantId, made.workspaceId, keys[0]);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const same = await enable(owner, made.tenantId, made.workspaceId, keys[1]);
  assert.equal(same.status, 200, JSON.stringify(same.data));
  assert.equal(same.data.reused, true);
  assert.equal(same.data.instance_id, first.data.instance_id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM module_instances')).rows[0].n, 1);
  const space = await post(`/tenants/${made.tenantId}/workspaces`, owner, { name: '第二櫃' });
  assert.equal(space.status, 201, JSON.stringify(space.data));
  const blocked = await enable(owner, made.tenantId, space.data.workspace_id, keys[1]);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
  assert.equal(blocked.data.code, 'instance_selection_required');
  assert.equal(blocked.data.candidates[0].instance_id, first.data.instance_id);
  const reused = await enable(owner, made.tenantId, space.data.workspace_id, keys[1], {
    kind: 'reuse', instance_id: first.data.instance_id, expected_version: first.data.version,
  });
  assert.equal(reused.status, 200, JSON.stringify(reused.data));
  assert.equal(reused.data.instance_id, first.data.instance_id);
  const work = await createWork(owner, made.tenantId, made.workspaceId, '共用工作');
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const visible = await call('GET', `/tenants/${made.tenantId}/workspaces/${space.data.workspace_id}/works`, owner);
  assert.equal(visible.status, 200, JSON.stringify(visible.data));
  assert.equal(visible.data.items.length, 0);
  const fromFirst = await call('GET', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/works`, owner);
  assert.equal(fromFirst.data.items.length, 1);
  const read = await call('GET', `/tenants/${made.tenantId}/works/${work.data.resource_ref.resource_id}`, owner);
  assert.equal(read.status, 200);
  await pool.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key) VALUES($1,$2,$3)`,
    [DEMO_COMMUNITY, owner.user.user_id, keys[0]]);
  const preference = await enable(owner, made.tenantId, made.workspaceId, keys[1]);
  assert.equal(preference.status, 200, JSON.stringify(preference.data));
  assert.equal(preference.data.instance_id, first.data.instance_id);
});

test('interns, operators, viewers, and other tenants cannot use manual work', async () => {
  const [guild] = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const stranger = await signIn(DEMO_USERS[1].email);
  const made = await createTenant(owner, '品牌甲');
  const other = await createTenant(stranger, '品牌乙');
  await fullMember(owner.user.user_id, guild);
  await fullMember(stranger.user.user_id, guild);
  assert.equal((await enable(owner, made.tenantId, made.workspaceId, guild)).status, 200);
  const work = await createWork(owner, made.tenantId, made.workspaceId, '只有甲看得到');
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const workId = work.data.resource_ref.resource_id as string;
  const intern = await person('實習夥伴');
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','intern')`, [randomUUID(), DEMO_COMMUNITY, intern.id, guild]);
  const internTenant = await createTenant(intern.session, '實習空間');
  const internDenied = await enable(intern.session, internTenant.tenantId, internTenant.workspaceId, guild);
  assert.equal(internDenied.status, 403, JSON.stringify(internDenied.data));
  assert.equal(internDenied.data.code, 'guild_full_member_required');
  const missingGuild = await enable(owner, made.tenantId, made.workspaceId, 'guild_not_in_catalog');
  assert.equal(missingGuild.status, 404);
  assert.equal(missingGuild.data.code, 'guild_not_found');
  for (const role of ['operator', 'viewer'] as const) {
    const member = await person(role);
    const principalId = await candidate(owner, member.id);
    const invitation = await invite(owner, made.tenantId, principalId, role);
    assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
    await accept(member.session, made.tenantId, invitation);
    for (const [method, path, body, version] of [
      ['POST', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/manual-work`, { guild_key: guild }, undefined],
      ['POST', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/works`, workBody('越權'), undefined],
      ['GET', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/works`, undefined, undefined],
      ['GET', `/tenants/${made.tenantId}/works/${workId}`, undefined, undefined],
      ['GET', `/tenants/${made.tenantId}/module-instances`, undefined, undefined],
      ['GET', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/launchpad-context?guild_key=${guild}`, undefined, undefined],
    ] as const) {
      const denied = method === 'GET'
        ? await call('GET', path, member.session)
        : await post(path, member.session, body, version);
      assert.equal(denied.status, 403, role + path + JSON.stringify(denied.data));
      assert.equal(denied.data.code, 'capability_denied');
    }
  }
  const hidden = await call('GET', `/tenants/${made.tenantId}/works/${workId}`, stranger);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.data.code, 'tenant_not_found');
  const crossed = await call('GET', `/tenants/${other.tenantId}/works/${workId}`, stranger);
  assert.equal(crossed.status, 404);
  assert.equal(crossed.data.code, 'not_found');
  const guessed = await call('GET', `/tenants/${made.tenantId}/works/${workId}/results/${randomUUID()}/content`, owner);
  assert.equal(guessed.status, 404);
  assert.equal(guessed.data.code, 'not_found');
  const launch = await call('GET', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/launchpad-context?guild_key=${guild}`, owner);
  assert.equal(launch.status, 200, JSON.stringify(launch.data));
  assert.equal(launch.data.work_page.items.length, 1);
  assert.equal(launch.data.connection_summary[0].status, 'hosted_active');
  assert.equal(launch.data.capacity_summary.policy_revision, '1');
});

test('bad keys, versions, cursors, forged fields, and archive stay closed', async () => {
  const [guild] = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, guild);
  assert.equal((await enable(owner, made.tenantId, made.workspaceId, guild)).status, 200);
  const key = randomUUID();
  const created = await createWork(owner, made.tenantId, made.workspaceId, '第一個工作', key);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const replay = await createWork(owner, made.tenantId, made.workspaceId, '第一個工作', key);
  assert.deepEqual(replay.data, created.data);
  const conflict = await createWork(owner, made.tenantId, made.workspaceId, '另一個工作', key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'idempotency_conflict');
  const workId = created.data.resource_ref.resource_id as string;
  const missingKey = await call('POST', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/works`, owner, JSON.stringify(workBody('沒有鍵')), { 'Content-Type': 'application/json' });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.data.code, 'idempotency_required');
  const unexpected = await post(`/tenants/${made.tenantId}/workspaces/${made.workspaceId}/works`, owner, workBody('不該有版本'), '"1"');
  assert.equal(unexpected.status, 400);
  assert.equal(unexpected.data.code, 'invalid_version');
  const forged = await post(`/tenants/${made.tenantId}/workspaces/${made.workspaceId}/works`, owner, { ...workBody('偽造'), tenant_id: made.tenantId, owner: owner.user.user_id });
  assert.equal(forged.status, 422);
  assert.equal(forged.data.code, 'validation_failed');
  const slash = await post(`/tenants/${made.tenantId}/works/${workId}/results/uploads`, owner, {
    content_type: 'text/plain', byte_size: 3, sha256: ABC_SHA, display_name: 'a/b.txt', expected_work_version: '1',
  });
  assert.equal(slash.status, 422);
  assert.equal(slash.data.code, 'validation_failed');
  const duplicate = await call('GET', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/works?limit=1&limit=2`, owner);
  assert.equal(duplicate.status, 422);
  assert.equal(duplicate.data.code, 'validation_failed');
  const cursor = await call('GET', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/works?cursor=abc`, owner);
  assert.equal(cursor.status, 422);
  assert.equal(cursor.data.code, 'invalid_cursor');
  const noVersion = await patch(`/tenants/${made.tenantId}/works/${workId}`, owner, workBody('改標題'));
  assert.equal(noVersion.status, 428);
  assert.equal(noVersion.data.code, 'version_required');
  const badVersion = await call('PATCH', `/tenants/${made.tenantId}/works/${workId}`, owner, JSON.stringify(workBody('改標題')), jsonHeaders(randomUUID(), '1'));
  assert.equal(badVersion.status, 400);
  assert.equal(badVersion.data.code, 'invalid_version');
  const stale = await patch(`/tenants/${made.tenantId}/works/${workId}`, owner, workBody('改標題'), '"9"');
  assert.equal(stale.status, 412);
  assert.equal(stale.data.code, 'version_conflict');
  const updated = await patch(`/tenants/${made.tenantId}/works/${workId}`, owner, workBody('改過的標題', '新的目的', 'in_progress'), '"1"');
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  const archiveKey = randomUUID();
  const archived = await post(`/tenants/${made.tenantId}/works/${workId}/archive`, owner, {}, '"2"', archiveKey);
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  const archiveReplay = await post(`/tenants/${made.tenantId}/works/${workId}/archive`, owner, {}, '"2"', archiveKey);
  assert.deepEqual(archiveReplay.data, archived.data);
  assert.equal((await call('GET', `/tenants/${made.tenantId}/works/${workId}`, owner)).status, 404);
  const hidden = await call('GET', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/works`, owner);
  assert.equal(hidden.data.items.length, 0);
  const editArchived = await patch(`/tenants/${made.tenantId}/works/${workId}`, owner, workBody('還想改'), '"3"');
  assert.equal(editArchived.status, 409);
  assert.equal(editArchived.data.code, 'work_archived');
  const archiveAgain = await post(`/tenants/${made.tenantId}/works/${workId}/archive`, owner, {}, '"3"');
  assert.equal(archiveAgain.status, 409);
  assert.equal(archiveAgain.data.code, 'work_archived');
  const absent = await enable(owner, made.tenantId, randomUUID(), guild);
  assert.equal(absent.status, 404);
  assert.equal(absent.data.code, 'not_found');
  const space = await post(`/tenants/${made.tenantId}/workspaces`, owner, { name: '未啟用' });
  assert.equal(space.status, 201, JSON.stringify(space.data));
  const needed = await createWork(owner, made.tenantId, space.data.workspace_id, '還沒啟用');
  assert.equal(needed.status, 409);
  assert.equal(needed.data.code, 'work_instance_required');
});

test('upload metadata is readable by another admin, while content writes stay with the preparer', async () => {
  const [guild] = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, guild);
  assert.equal((await enable(owner, made.tenantId, made.workspaceId, guild)).status, 200);
  const work = await createWork(owner, made.tenantId, made.workspaceId, '共同工作');
  const workId = work.data.resource_ref.resource_id as string;
  const prepared = await prepareUpload(owner, made.tenantId, workId, 'note.md', 'text/markdown', new TextEncoder().encode('A-only-note'), '1');
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const uploadId = prepared.data.resource_ref.resource_id as string;
  const adminUser = await person('另一位管理員');
  const principalId = await candidate(owner, adminUser.id);
  const invitation = await invite(owner, made.tenantId, principalId, 'admin');
  await accept(adminUser.session, made.tenantId, invitation);
  const seen = await call('GET', `/tenants/${made.tenantId}/works/${workId}/results/uploads/${uploadId}`, adminUser.session);
  assert.equal(seen.status, 200, JSON.stringify(seen.data));
  assert.equal(seen.data.upload_id, uploadId);
  const denied = await writeUpload(adminUser.session, made.tenantId, workId, uploadId, new TextEncoder().encode('A-only-note'), '1');
  assert.equal(denied.status, 404, JSON.stringify(denied.data));
  assert.equal(denied.data.code, 'not_found');
  const finalizeDenied = await finalizeUpload(adminUser.session, made.tenantId, workId, uploadId, '1', '1');
  assert.equal(finalizeDenied.status, 404);
  assert.equal(finalizeDenied.data.code, 'not_found');
});

test('content methods reject range, head, encoding, mismatched bytes, and an oversized length', async () => {
  const [guild] = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, guild);
  assert.equal((await enable(owner, made.tenantId, made.workspaceId, guild)).status, 200);
  const work = await createWork(owner, made.tenantId, made.workspaceId, '內容邊界');
  const workId = work.data.resource_ref.resource_id as string;
  const prepared = await prepareUpload(owner, made.tenantId, workId, 'attach.txt', 'text/plain', ABC, '1');
  const uploadId = prepared.data.resource_ref.resource_id as string;
  const mismatch = await writeUpload(owner, made.tenantId, workId, uploadId, new TextEncoder().encode('ab'), '1');
  assert.equal(mismatch.status, 422, JSON.stringify(mismatch.data));
  assert.equal(mismatch.data.code, 'validation_failed');
  const encoded = await call('PUT', `/tenants/${made.tenantId}/works/${workId}/results/uploads/${uploadId}/content`, owner, ABC, {
    'Idempotency-Key': randomUUID(), 'If-Match': '"1"', 'Content-Encoding': 'gzip',
  });
  assert.equal(encoded.status, 415);
  assert.equal(encoded.data.code, 'encoding_rejected');
  const before = (await pool.query('SELECT count(*)::int AS n FROM asset_objects')).rows[0].n as number;
  const huge = await call('PUT', `/tenants/${made.tenantId}/works/${workId}/results/uploads/${uploadId}/content`, owner, Buffer.alloc(262145, 1), {
    'Idempotency-Key': randomUUID(), 'If-Match': '"1"',
  });
  assert.equal(huge.status, 413, JSON.stringify(huge.data));
  assert.equal(huge.data.code, 'payload_too_large');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_objects')).rows[0].n, before);
  const writeKey = randomUUID();
  const written = await writeUpload(owner, made.tenantId, workId, uploadId, ABC, '1', writeKey);
  assert.equal(written.status, 200, JSON.stringify(written.data));
  const replayed = await writeUpload(owner, made.tenantId, workId, uploadId, ABC, '1', writeKey);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.data));
  assert.equal(replayed.data.verified, true);
  assert.deepEqual(replayed.data, written.data);
  const moved = await call('PUT', `/tenants/${made.tenantId}/works/${workId}/results/uploads/${uploadId}/content`, owner, ABC, {
    'Idempotency-Key': randomUUID(), 'If-Match': '"1"',
  });
  assert.equal(moved.status, 412, JSON.stringify(moved.data));
  const done = await finalizeUpload(owner, made.tenantId, workId, uploadId, '1', '2');
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const resultId = done.data.resource_ref.resource_id as string;
  const head = await call('HEAD', `/tenants/${made.tenantId}/works/${workId}/results/${resultId}/content`, owner);
  assert.equal(head.status, 405);
  assert.equal(head.data, null);
  const range = await call('GET', `/tenants/${made.tenantId}/works/${workId}/results/${resultId}/content`, owner, undefined, { Range: 'bytes=0-0' });
  assert.equal(range.status, 405);
  assert.equal(range.data.code, 'method_not_allowed');
  const off = await post(`/tenants/${made.tenantId}/works/${workId}/results/uploads`, owner, {
    content_type: 'text/plain', byte_size: 3, sha256: ABC_SHA, display_name: 'x.txt', expected_work_version: '2',
  }, undefined, randomUUID(), closed);
  assert.equal(off.status, 404);
  assert.equal(off.data.code, 'not_found');
  const unavailable = await post(`/tenants/${made.tenantId}/works/${workId}/results/uploads`, owner, {
    content_type: 'text/plain', byte_size: 3, sha256: ABC_SHA, display_name: 'y.txt', expected_work_version: '2',
  }, undefined, randomUUID(), unstored);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.data.code, 'object_unavailable');
});

test('one of two finalizes prepared at the same work version wins, and the other leaves no result', async () => {
  const [guild] = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, guild);
  assert.equal((await enable(owner, made.tenantId, made.workspaceId, guild)).status, 200);
  const work = await createWork(owner, made.tenantId, made.workspaceId, '競態工作');
  const workId = work.data.resource_ref.resource_id as string;
  const first = await prepareUpload(owner, made.tenantId, workId, 'one.md', 'text/markdown', new TextEncoder().encode('A-only-note'), '1');
  const second = await prepareUpload(owner, made.tenantId, workId, 'two.md', 'text/markdown', new TextEncoder().encode('B-only-note'), '1');
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(second.status, 201, JSON.stringify(second.data));
  const firstId = first.data.resource_ref.resource_id as string;
  const secondId = second.data.resource_ref.resource_id as string;
  assert.equal((await writeUpload(owner, made.tenantId, workId, firstId, new TextEncoder().encode('A-only-note'), '1')).status, 200);
  assert.equal((await writeUpload(owner, made.tenantId, workId, secondId, new TextEncoder().encode('B-only-note'), '1')).status, 200);
  const [left, right] = await Promise.all([
    finalizeUpload(owner, made.tenantId, workId, firstId, '1', '2'),
    finalizeUpload(owner, made.tenantId, workId, secondId, '1', '2'),
  ]);
  const statuses = [left.status, right.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 412], JSON.stringify([left.data, right.data]));
  assert.equal([left, right].find(item => item.status === 412)?.data.code, 'version_conflict');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_work_results WHERE work_item_id=$1', [workId])).rows[0].n, 1);
});

test('work, instance, and retained-byte limits reject the request that would pass them', async () => {
  const [guild] = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, guild);
  const policy = (await pool.query<{ max_active_instances: number; max_work_items: number; max_retained_bytes: string; max_concurrent_provisions: number }>(
    `SELECT max_active_instances, max_work_items, max_retained_bytes::text AS max_retained_bytes, max_concurrent_provisions
     FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL`)).rows[0];
  assert.equal((await enable(owner, made.tenantId, made.workspaceId, guild)).status, 200);
  try {
    await pool.query(`UPDATE tenant_capacity_policies SET max_work_items=1 WHERE status='active' AND tenant_id IS NULL`);
    const [raceA, raceB] = await Promise.all([
      createWork(owner, made.tenantId, made.workspaceId, '競態甲'),
      createWork(owner, made.tenantId, made.workspaceId, '競態乙'),
    ]);
    const statuses = [raceA.status, raceB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 429], JSON.stringify([raceA.data, raceB.data]));
    assert.equal([raceA, raceB].find(item => item.status === 429)?.data.code, 'quota_exceeded');
    assert.equal([raceA, raceB].find(item => item.status === 429)?.response.headers.get('retry-after'), null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM work_items WHERE tenant_id=$1 AND state<>'archived'`, [made.tenantId])).rows[0].n, 1);
  } finally {
    await pool.query(`UPDATE tenant_capacity_policies SET max_work_items=$1 WHERE status='active' AND tenant_id IS NULL`, [policy.max_work_items]);
  }
  const racer = await person('實例競態');
  const raceTenant = await createTenant(racer.session, '實例品牌');
  await fullMember(racer.id, guild);
  const extra = await post(`/tenants/${raceTenant.tenantId}/workspaces`, racer.session, { name: '第二櫃' });
  assert.equal(extra.status, 201, JSON.stringify(extra.data));
  try {
    await pool.query(`UPDATE tenant_capacity_policies SET max_active_instances=1 WHERE status='active' AND tenant_id IS NULL`);
    const [kept, rejected] = await Promise.all([
      enable(racer.session, raceTenant.tenantId, raceTenant.workspaceId, guild, { kind: 'create_new' }),
      enable(racer.session, raceTenant.tenantId, extra.data.workspace_id, guild, { kind: 'create_new' }),
    ]);
    const enableStatuses = [kept.status, rejected.status].sort((a, b) => a - b);
    assert.deepEqual(enableStatuses, [200, 429], JSON.stringify([kept.data, rejected.data]));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM module_instances WHERE tenant_id=$1', [raceTenant.tenantId])).rows[0].n, 1);
  } finally {
    await pool.query(`UPDATE tenant_capacity_policies SET max_active_instances=$1 WHERE status='active' AND tenant_id IS NULL`, [policy.max_active_instances]);
  }
  const fresh = await person('新的負責人');
  const freshTenant = await createTenant(fresh.session, '新品牌');
  await fullMember(fresh.id, guild);
  try {
    await pool.query(`UPDATE tenant_capacity_policies SET max_concurrent_provisions=0 WHERE status='active' AND tenant_id IS NULL`);
    const provisions = await enable(fresh.session, freshTenant.tenantId, freshTenant.workspaceId, guild, { kind: 'create_new' });
    assert.equal(provisions.status, 429, JSON.stringify(provisions.data));
    assert.equal(provisions.data.code, 'quota_exceeded');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM module_instances WHERE tenant_id=$1', [freshTenant.tenantId])).rows[0].n, 0);
  } finally {
    await pool.query(`UPDATE tenant_capacity_policies SET max_concurrent_provisions=$1 WHERE status='active' AND tenant_id IS NULL`, [policy.max_concurrent_provisions]);
  }
  const byteTenant = await createTenant(owner, '容量品牌');
  await enable(owner, byteTenant.tenantId, byteTenant.workspaceId, guild);
  const byteWork = await createWork(owner, byteTenant.tenantId, byteTenant.workspaceId, '容量工作');
  const otherWork = await createWork(owner, byteTenant.tenantId, byteTenant.workspaceId, '另一個容量工作');
  const workId = byteWork.data.resource_ref.resource_id as string;
  const otherId = otherWork.data.resource_ref.resource_id as string;
  try {
    await pool.query(`UPDATE tenant_capacity_policies SET max_retained_bytes=262144 WHERE status='active' AND tenant_id IS NULL`);
    const [uploaded, blocked] = await Promise.all([
      prepareUpload(owner, byteTenant.tenantId, workId, 'one.txt', 'text/plain', ABC, '1'),
      prepareUpload(owner, byteTenant.tenantId, otherId, 'two.txt', 'text/plain', ABC, '1'),
    ]);
    const uploadStatuses = [uploaded.status, blocked.status].sort((a, b) => a - b);
    assert.deepEqual(uploadStatuses, [201, 429], JSON.stringify([uploaded.data, blocked.data]));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM assets WHERE tenant_ref=$1 AND purpose='work.tenant-result'`, [byteTenant.tenantId])).rows[0].n, 1);
  } finally {
    await pool.query(`UPDATE tenant_capacity_policies SET max_retained_bytes=$1 WHERE status='active' AND tenant_id IS NULL`, [policy.max_retained_bytes]);
  }
});

test('a missing capacity row blocks writes and leaves existing reads available', async () => {
  const [guild] = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, guild);
  assert.equal((await enable(owner, made.tenantId, made.workspaceId, guild)).status, 200);
  const work = await createWork(owner, made.tenantId, made.workspaceId, '仍可讀');
  const workId = work.data.resource_ref.resource_id as string;
  await pool.query(`DELETE FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL`);
  try {
    const read = await call('GET', `/tenants/${made.tenantId}/works/${workId}`, owner);
    assert.equal(read.status, 200, JSON.stringify(read.data));
    const launch = await call('GET', `/tenants/${made.tenantId}/workspaces/${made.workspaceId}/launchpad-context?guild_key=${guild}`, owner);
    assert.equal(launch.status, 200, JSON.stringify(launch.data));
    assert.equal(launch.data.capacity_summary.policy_revision, null);
    assert.equal(launch.data.capacity_summary.limit, null);
    assert.equal(launch.data.capacity_summary.used, '0');
    assert.equal(launch.data.capacity_summary.reserved, '0');
    const denied = await enable(owner, made.tenantId, made.workspaceId, guild);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'policy_unconfigured');
    const created = await createWork(owner, made.tenantId, made.workspaceId, '不該建立');
    assert.equal(created.status, 403);
    assert.equal(created.data.code, 'policy_unconfigured');
    const upload = await prepareUpload(owner, made.tenantId, workId, 'x.txt', 'text/plain', ABC, '1');
    assert.equal(upload.status, 403);
    assert.equal(upload.data.code, 'policy_unconfigured');
  } finally {
    await pool.query(`INSERT INTO tenant_capacity_policies(
        policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
        max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
      SELECT $1, 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1', 10, 3, 2, 1000, 104857600, 4, NULL, 'active'
      WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`, [randomUUID()]);
  }
});

test('a revoked admin is denied on the next save, and a storage wait lets revocation win before the object row', async () => {
  const [guild] = await guildKeys();
  const owner = await signIn(DEMO_USERS[0].email);
  const made = await createTenant(owner, '品牌甲');
  await fullMember(owner.user.user_id, guild);
  assert.equal((await enable(owner, made.tenantId, made.workspaceId, guild)).status, 200);
  const adminUser = await person('會被撤銷的管理員');
  const principalId = await candidate(owner, adminUser.id);
  const invitation = await invite(owner, made.tenantId, principalId, 'admin');
  await accept(adminUser.session, made.tenantId, invitation);
  const work = await createWork(adminUser.session, made.tenantId, made.workspaceId, '管理員的工作');
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const workId = work.data.resource_ref.resource_id as string;
  const prepared = await prepareUpload(adminUser.session, made.tenantId, workId, 'wait.txt', 'text/plain', ABC, '1');
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const uploadId = prepared.data.resource_ref.resource_id as string;
  const objectsBefore = (await pool.query('SELECT count(*)::int AS n FROM asset_objects')).rows[0].n as number;
  store.holdNextPut();
  const pending = writeUpload(adminUser.session, made.tenantId, workId, uploadId, ABC, '1');
  await Promise.race([
    store.entered,
    delay(20000).then(() => assert.fail('put did not reach the storage barrier')),
  ]);
  const row = await membership(owner, made.tenantId, principalId);
  const revoked = await post(`/tenants/${made.tenantId}/members/${principalId}/change`, owner, {
    role: 'admin', status: 'revoked', instance_capabilities: [], reason: '撤銷這位管理員',
  }, `"${row.version}"`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  store.release();
  const written = await pending;
  assert.equal(written.status, 404, JSON.stringify(written.data));
  assert.equal(written.data.code, 'tenant_not_found');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_objects')).rows[0].n, objectsBefore);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_work_results')).rows[0].n, 0);
  const next = await patch(`/tenants/${made.tenantId}/works/${workId}`, adminUser.session, workBody('撤銷後'), '"1"');
  assert.equal(next.status, 404);
  assert.equal(next.data.code, 'tenant_not_found');
});

test('one pooled connection alternates two tenants without mixing their work', async () => {
  const narrow = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 });
  const narrowApp = createApp(narrow, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store });
  try {
    const [guild] = await guildKeys();
    const alpha = await signIn(DEMO_USERS[0].email, narrowApp);
    const beta = await signIn(DEMO_USERS[1].email, narrowApp);
    const brandA = await (async () => {
      const made = await post('/tenants', alpha, { display_name: '品牌甲', workspace_name: '櫃檯甲' }, undefined, randomUUID(), narrowApp);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      return { tenantId: made.data.tenant.tenant_id as string, workspaceId: made.data.workspace.workspace_id as string };
    })();
    const brandB = await (async () => {
      const made = await post('/tenants', beta, { display_name: '品牌乙', workspace_name: '櫃檯乙' }, undefined, randomUUID(), narrowApp);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      return { tenantId: made.data.tenant.tenant_id as string, workspaceId: made.data.workspace.workspace_id as string };
    })();
    await fullMember(alpha.user.user_id, guild);
    await fullMember(beta.user.user_id, guild);
    assert.equal((await post(`/tenants/${brandA.tenantId}/workspaces/${brandA.workspaceId}/manual-work`, alpha, { guild_key: guild }, undefined, randomUUID(), narrowApp)).status, 200);
    assert.equal((await post(`/tenants/${brandB.tenantId}/workspaces/${brandB.workspaceId}/manual-work`, beta, { guild_key: guild }, undefined, randomUUID(), narrowApp)).status, 200);
    assert.equal((await post(`/tenants/${brandA.tenantId}/workspaces/${brandA.workspaceId}/works`, alpha, workBody('甲的工作'), undefined, randomUUID(), narrowApp)).status, 201);
    assert.equal((await post(`/tenants/${brandB.tenantId}/workspaces/${brandB.workspaceId}/works`, beta, workBody('乙的工作'), undefined, randomUUID(), narrowApp)).status, 201);
    const first = await call('GET', `/tenants/${brandA.tenantId}/workspaces/${brandA.workspaceId}/works`, alpha, undefined, {}, narrowApp);
    const second = await call('GET', `/tenants/${brandB.tenantId}/workspaces/${brandB.workspaceId}/works`, beta, undefined, {}, narrowApp);
    const third = await call('GET', `/tenants/${brandA.tenantId}/workspaces/${brandA.workspaceId}/works`, alpha, undefined, {}, narrowApp);
    assert.deepEqual(first.data.items.map((item: { title: string }) => item.title), ['甲的工作']);
    assert.deepEqual(second.data.items.map((item: { title: string }) => item.title), ['乙的工作']);
    assert.deepEqual(third.data.items.map((item: { title: string }) => item.title), ['甲的工作']);
  } finally {
    await narrow.end();
  }
});
