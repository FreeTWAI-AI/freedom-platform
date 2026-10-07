import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createAdminAccessVerifier } from '../../modules/platform-admin/access.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { objectKey, type AssetObjectKey, type PreparedRepresentation } from '../../packages/asset-storage/index.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS, seedLocal } from '../../packages/testing/seed.js';
import { migrate } from '../../scripts/database.js';
import {
  LaunchpadContextSchema, ManualWorkBindingSchema, OperationSchema, ResultPageSchema, ResultSchema,
  UploadSchema, UploadVerifiedSchema, WorkPageSchema, WorkSchema, type ResultView, type WorkView,
} from '../../contracts/guild-launchpad/v1/tenant-work.js';
import { BackfillReport, CATEGORY_ORDER, PreferenceView } from '../../contracts/guild-launchpad/v1/guild-preferences.js';
import { TenantPageSchema, TenantViewSchema, WorkspacePageSchema, WorkspaceViewSchema } from '../../contracts/guild-launchpad/v1/tenant.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Guild journey requires explicit disposable fp_* TEST_DATABASE_URL.');
}
const origin = 'http://127.0.0.1:4366';
const stamp = `${process.pid}_${Date.now()}`;
const schema = `fp_m1j_${stamp}`;
const migrator = `m1jm_${stamp}`;
const runtimeRole = `m1jr_${stamp}`;
const admin = new Pool({ connectionString, max: 1 });
function roleUrl(role: string) {
  const url = new URL(connectionString!);
  url.username = role;
  url.password = '';
  return url.toString();
}
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=20000`, max: 1 });

// FakeObjectStore stands in for an independent storage service, not R2. It survives
// the app/pool replacement; this proves HTTP/PG continuity, not process or R2 durability.
// Observe its public interface so exact object counts include stray, unfinalized writes.
class JourneyStore extends FakeObjectStore {
  readonly keys = new Set<AssetObjectKey>();
  override async putImmutable(key: AssetObjectKey, value: PreparedRepresentation) {
    const result = await super.putImmutable(key, value);
    this.keys.add(key);
    return result;
  }
  override async delete(key: AssetObjectKey) {
    const result = await super.delete(key);
    this.keys.delete(key);
    return result;
  }
}
const store = new JourneyStore();
// The verifier requires this issuer shape; the injected local JWK set performs no HTTP.
const issuer = 'https://synthetic-m1-journey.cloudflareaccess.com';
const audience = 'synthetic-m1-journey';
const adminEmail = 'journey-admin@example.test';
const pair = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey);
const accessOptions = {
  issuer, audience, csrfSecret: randomUUID(),
  keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: 'journey', alg: 'RS256' }] }),
};
let runtime: Pool;
let app: ReturnType<typeof createApp>;
let created = false;
const instances: Array<{ pool: Pool; pids: Set<number>; requests: number; closed: boolean }> = [];
function startApp() {
  runtime = new Pool({
    connectionString: roleUrl(runtimeRole), options: `-c search_path=${schema} -c statement_timeout=20000`,
    max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 8000,
  });
  app = createApp(runtime, origin, 'local', {
    guildLaunchpadEnabled: true, tenantWorkAssetStore: store, adminVerifier: createAdminAccessVerifier(accessOptions),
  });
  instances.push({ pool: runtime, pids: new Set(), requests: 0, closed: false });
}

// Apply every grant/revocation block in the production template, including its
// guards. Only the public schema and psql runtime variable are substituted.
async function applyGrants() {
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const sql = template.slice(template.indexOf('BEGIN;'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`)
    .replaceAll("n.nspname='public'", `n.nspname='${schema}'`)
    .replaceAll(':"runtime"', `"${runtimeRole}"`).replaceAll(":'runtime'", `'${runtimeRole}'`);
  const blocks = [...sql.matchAll(/^-- BEGIN (.+)\n([\s\S]*?)\n\\gexec\n-- END \1/gm)];
  assert.equal(blocks.length, [...sql.matchAll(/^-- BEGIN /gm)].length, 'all production grant blocks must be applied');
  const q = await owner.connect();
  try {
    await q.query(sql.slice(0, sql.indexOf('-- BEGIN PRIVATE POLICY GRANTS')));
    for (const block of blocks) {
      const statements = await q.query(block[2]);
      assert.ok(statements.rowCount! > 0, `${block[1]} must resolve installed objects`);
      for (const row of statements.rows) await q.query(Object.values(row)[0] as string);
    }
    await q.query('COMMIT');
  } catch (error) {
    await q.query('ROLLBACK');
    throw error;
  } finally { q.release(); }
}

before(async () => {
  assert.match(schema, /^fp_m1j_[0-9]+_[0-9]+$/);
  assert.ok(migrator.length < 63 && runtimeRole.length < 63 && schema.length < 63);
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator};
    GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
  created = true;
  await migrate(owner);
  await applyGrants();
  await seedLocal(owner);
  // Operator fixture: main has no API for provisioning the initial capacity policy.
  await owner.query(`INSERT INTO tenant_capacity_policies(
      policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
      max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
    SELECT $1, 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1', 10, 3, 2, 1000, 104857600, 4, NULL, 'active'
    WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`, [randomUUID()]);
  // Bootstrap fixture: appointing an admin requires an existing admin. The local
  // signed Access identity avoids external Access; officer appointment and both
  // ordinary members' tier promotions below still use the real HTTP APIs.
  await owner.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',
    [randomUUID(), DEMO_COMMUNITY, adminEmail, '合成管理員']);
  startApp();
});
after(async () => {
  for (const instance of instances) if (!instance.closed) await instance.pool.end();
  await owner.end();
  try {
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtimeRole}; DROP ROLE ${migrator}`);
  } finally { await admin.end(); }
});

type Session = { cookie: string; csrf: string; user: { user_id: string } };
type Reply = { status: number; data: any; bytes: Uint8Array; headers: Headers };
type Space = { tenantId: string; workspaceId: string; instanceId: string; workId: string };
const note = new TextEncoder().encode('# A-only-note\n場勘筆記：明天繼續確認投影分區。\n');
const attachment = new TextEncoder().encode('A-only-attachment\n確認投影分區與備援電源。\n');
const otherNote = new TextEncoder().encode('B-only-note\n另一個業務空間的私人紀錄。\n');
const title = 'A-only-work 場勘紀錄';
const initialObjective = 'A-only-objective 記錄場地的投影分區';
const editedObjective = 'A-only-edited-objective 確認分區後再補備援步驟';
const continuedObjective = 'A-only-continued-objective 已補上備援步驟';
let memberA: Session;
let officer: Session;
let legacyGuildKey: string;
let legacyOfficerVersion: string;
let memberB: Session;
let spaceB: Space;
let spaceA: Space;
let noteResult: ResultView;
let attachmentResult: ResultView;
let beforeSignOut: WorkView;
let finalWork: WorkView;

function sha(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
async function quiet(label: string) {
  const row = (await runtime.query(`SELECT pg_backend_pid() AS pid,
    current_setting('freedom.tenant_id', true) AS tenant,
    current_setting('freedom.principal_id', true) AS principal,
    current_setting('freedom.tenant_scope_id', true) AS scope,
    current_setting('freedom.platform_admin_id', true) AS admin,
    (SELECT count(*)::int FROM tenants) AS visible_tenants`)).rows[0];
  for (const key of ['tenant', 'principal', 'scope', 'admin']) {
    assert.ok(row[key] === null || row[key] === '', `${label}: ${key} context remained in the pool`);
  }
  assert.equal(row.visible_tenants, 0, `${label}: tenant rows visible without context`);
  instances.at(-1)!.pids.add(Number(row.pid));
  assert.equal(instances.at(-1)!.pids.size, 1, `${label}: app used more than one backend`);
  return Number(row.pid);
}
async function call(method: string, path: string, session?: Session, body?: string | Uint8Array, headers: Record<string, string> = {}): Promise<Reply> {
  const sent = new Headers({ Origin: origin, Accept: 'application/json', ...headers });
  if (session) {
    sent.set('Cookie', session.cookie);
    if (method !== 'GET') sent.set('X-CSRF-Token', session.csrf);
  }
  await quiet(`before ${method} ${path}`);
  instances.at(-1)!.requests += 1;
  try {
    const response = await app.request(origin + (path.startsWith('/admin/') ? path : '/api/v1' + path), {
      method, headers: sent, body: body instanceof Uint8Array ? new Uint8Array(body) : body,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const data = response.headers.get('content-type')?.includes('application/json') && bytes.byteLength
      ? JSON.parse(Buffer.from(bytes).toString('utf8')) : null;
    return { status: response.status, data, bytes, headers: response.headers };
  } finally { await quiet(`after ${method} ${path}`); }
}
function jsonHeaders(key: string, version?: string) {
  return { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...(version ? { 'If-Match': `"${version}"` } : {}) };
}
function post(path: string, session: Session | undefined, body: unknown, version?: string, key = randomUUID()) {
  return call('POST', path, session, JSON.stringify(body), jsonHeaders(key, version));
}
function expectStatus(reply: Reply, status = 200) { assert.equal(reply.status, status, JSON.stringify(reply.data)); }
function privateReply(reply: Reply, version?: string) {
  expectStatus(reply);
  assert.equal(reply.headers.get('cache-control'), 'private, no-store');
  if (version !== undefined) assert.equal(reply.headers.get('etag'), `"${version}"`);
}
function operation(reply: Reply, kind: 'work.work' | 'work.upload' | 'work.result', space: Space, status = 200) {
  expectStatus(reply, status);
  assert.equal(reply.headers.get('cache-control'), 'private, no-store');
  const value = OperationSchema.parse(reply.data);
  assert.equal(value.state, 'succeeded');
  assert.equal(value.version, '1'); // Operation version is independent of the Work version.
  assert.equal(value.resource_ref.resource_type, kind);
  assert.equal(value.resource_ref.tenant_id, space.tenantId);
  assert.equal(value.resource_ref.instance_id, space.instanceId);
  return value;
}
async function signIn(email: string): Promise<Session> {
  const reply = await post('/auth/login', undefined, { email, password: DEMO_PASSWORD });
  expectStatus(reply);
  assert.ok(reply.headers.get('set-cookie'));
  return { cookie: reply.headers.get('set-cookie')!.split(';')[0], csrf: reply.data.csrf_token, user: reply.data.user };
}
async function adminPost(path: string, body: unknown, version?: string) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ type: 'app', email: adminEmail, sub: 'synthetic-journey-admin', iss: issuer,
    aud: audience, iat: now, nbf: now, exp: now + 600 })
    .setProtectedHeader({ alg: 'RS256', kid: 'journey' }).sign(pair.privateKey);
  const identity = await createAdminAccessVerifier(accessOptions)(new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }));
  return call('POST', `/admin/api${path}`, undefined, JSON.stringify(body),
    { ...jsonHeaders(randomUUID(), version), 'Cf-Access-Jwt-Assertion': jwt, 'X-Admin-CSRF': identity.csrfToken });
}
async function appointOfficer(guildKey: string, version?: string) {
  const appointed = await adminPost(`/guilds/${guildKey}/master`,
    { user_id: DEMO_USERS[2].user_id, reason: '任命合成公會長以驗證正式成員流程。' }, version);
  expectStatus(appointed);
  assert.equal(appointed.data.user_id, DEMO_USERS[2].user_id);
  officer = await signIn(DEMO_USERS[2].email);
  return String(appointed.data.aggregate_version);
}
async function chooseGuild(session: Session, guildKey: string) {
  const joined = await post(`/guilds/${guildKey}/join`, session, {});
  expectStatus(joined);
  assert.equal(joined.data.state, 'active');
  assert.equal(joined.data.member_tier, 'intern');
  const preferences = await call('GET', '/me/guild-preferences', session);
  expectStatus(preferences);
  const chosen = await post(`/guilds/${guildKey}/primary`, session, {},
    preferences.data.aggregate_version == null ? undefined : String(preferences.data.aggregate_version));
  expectStatus(chosen);
  assert.equal(chosen.data.primary_guild_key, guildKey);
  const promoted = await post(`/guilds/${guildKey}/members/${session.user.user_id}/tier`, officer,
    { member_tier: 'full' }, String(joined.data.aggregate_version));
  expectStatus(promoted);
  assert.equal(promoted.data.member_tier, 'full');
  assert.equal(promoted.data.changed, true);
  assert.equal(promoted.data.aggregate_version, joined.data.aggregate_version + 1);
  const launchpad = await call('GET', `/guilds/${guildKey}/launchpad`, session);
  expectStatus(launchpad);
  assert.deepEqual(launchpad.data.membership, { state: 'active', member_tier: 'full' });
  assert.ok(launchpad.data.config.body.blocks.some((block: { kind: string; enabled: boolean }) => block.kind === 'my_work' && block.enabled));
}
const workspacePath = (space: Space) => `/tenants/${space.tenantId}/workspaces/${space.workspaceId}`;
const workPath = (space: Space) => `/tenants/${space.tenantId}/works/${space.workId}`;
const contextPath = (space: Space, guildKey: string) => `${workspacePath(space)}/launchpad-context?guild_key=${guildKey}`;
async function context(session: Session, space: Space, enabled: boolean, guildKey: string) {
  const reply = await call('GET', contextPath(space, guildKey), session);
  privateReply(reply);
  const value = LaunchpadContextSchema.parse(reply.data);
  assert.equal(value.tenant_id, space.tenantId);
  assert.equal(value.workspace_id, space.workspaceId);
  assert.deepEqual(value.instances.map(item => item.instance_id), enabled ? [space.instanceId] : []);
  assert.deepEqual(value.connection_summary, enabled ? [{ instance_id: space.instanceId, status: 'hosted_active' }] : []);
  if (enabled) {
    assert.equal(value.instances[0].module_key, 'work');
    assert.equal(value.instances[0].status, 'active');
  }
  return value;
}
async function loadSpace(session: Session, space: Space) {
  const tenant = await call('GET', `/tenants/${space.tenantId}`, session);
  privateReply(tenant);
  const view = TenantViewSchema.parse(tenant.data);
  assert.equal(view.tenant_id, space.tenantId);
  assert.equal(view.version, '1');
  assert.equal(view.my_membership.role, 'owner');
  const workspaces = await call('GET', `/tenants/${space.tenantId}/workspaces?limit=100`, session);
  privateReply(workspaces);
  const page = WorkspacePageSchema.parse(workspaces.data);
  assert.deepEqual(page.items.map(item => item.workspace_id), [space.workspaceId]);
  assert.equal(page.items[0].tenant_id, space.tenantId);
}
async function createSpace(session: Session, name: string, guildKey: string): Promise<Space> {
  const made = await post('/tenants', session, { display_name: name, workspace_name: '場勘工作區' });
  expectStatus(made, 201);
  const tenant = TenantViewSchema.parse(made.data.tenant);
  const workspace = WorkspaceViewSchema.parse(made.data.workspace);
  assert.equal(workspace.tenant_id, tenant.tenant_id);
  assert.equal(tenant.default_workspace_id, workspace.workspace_id);
  const space = { tenantId: tenant.tenant_id, workspaceId: workspace.workspace_id, instanceId: '', workId: '' };
  await loadSpace(session, space);
  const before = await context(session, space, false, guildKey);
  assert.deepEqual(before.work_page.items, []);
  const key = randomUUID();
  const enabled = await post(`${workspacePath(space)}/manual-work`, session, { guild_key: guildKey }, undefined, key);
  privateReply(enabled);
  const binding = ManualWorkBindingSchema.parse(enabled.data);
  assert.equal(binding.tenant_id, space.tenantId);
  assert.equal(binding.workspace_id, space.workspaceId);
  assert.equal(binding.reused, false);
  assert.equal(binding.version, '1');
  space.instanceId = binding.instance_id;
  await context(session, space, true, guildKey);
  const replay = await post(`${workspacePath(space)}/manual-work`, session, { guild_key: guildKey }, undefined, key);
  privateReply(replay);
  assert.deepEqual(replay.data, enabled.data);
  return space;
}
async function readWork(session: Session, space: Space, version: string, resultId?: string) {
  const reply = await call('GET', workPath(space), session);
  privateReply(reply, version);
  const work = WorkSchema.parse(reply.data);
  assert.equal(work.work_id, space.workId);
  assert.equal(work.tenant_id, space.tenantId);
  assert.equal(work.workspace_id, space.workspaceId);
  assert.equal(work.instance_id, space.instanceId);
  assert.equal(work.version, version);
  assert.equal(work.current_result_id, resultId);
  return work;
}
async function readResults(session: Session, space: Space, expected: ResultView[]) {
  const reply = await call('GET', `${workPath(space)}/results?limit=20`, session);
  privateReply(reply);
  const page = ResultPageSchema.parse(reply.data);
  assert.deepEqual(page.items, expected);
  assert.equal(page.next_cursor, null);
}
async function readContent(session: Session, space: Space, result: ResultView, expected: Uint8Array, workVersion: string) {
  const reply = await call('GET', `${workPath(space)}/results/${result.result_id}/content`, session, undefined,
    { Accept: 'text/plain, text/markdown;q=0.9' });
  // Content is fenced by the current Work version; Result metadata retains its save version.
  privateReply(reply, workVersion);
  assert.equal(reply.headers.get('content-type'), `${result.content_type}; charset=utf-8`);
  assert.match(reply.headers.get('content-disposition') ?? '', /^attachment; /);
  assert.ok(reply.headers.get('content-disposition')?.includes(`filename*=UTF-8''${encodeURIComponent(result.display_name)}`));
  assert.deepEqual(reply.bytes, expected);
  assert.equal(sha(reply.bytes), sha(expected));
  assert.equal(result.sha256, sha(expected));
}
async function saveResult(session: Session, space: Space, workVersion: string, name: string,
  contentType: 'text/plain' | 'text/markdown', bytes: Uint8Array, prior: ResultView[]): Promise<ResultView> {
  // The portal reuses one key across the three separately namespaced commands.
  const key = randomUUID();
  const prepared = await post(`${workPath(space)}/results/uploads`, session, {
    content_type: contentType, byte_size: bytes.byteLength, sha256: sha(bytes), display_name: name, expected_work_version: workVersion,
  }, undefined, key);
  const uploadId = operation(prepared, 'work.upload', space, 201).resource_ref.resource_id;
  const uploadPath = `${workPath(space)}/results/uploads/${uploadId}`;
  const metadata = await call('GET', uploadPath, session);
  privateReply(metadata, '1');
  const upload = UploadSchema.parse(metadata.data);
  assert.equal(upload.upload_id, uploadId);
  assert.equal(upload.work_id, space.workId);
  assert.equal(upload.version, '1');
  assert.equal(upload.phase, 'prepared');
  assert.equal(upload.display_name, name);
  assert.equal(upload.content_type, contentType);
  assert.equal(upload.byte_size, bytes.byteLength);
  assert.equal(upload.sha256, sha(bytes));
  await readWork(session, space, workVersion, prior[0]?.result_id);
  await readResults(session, space, prior);
  const written = await call('PUT', `${uploadPath}/content`, session, bytes, {
    Accept: 'application/json', 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength),
    'Idempotency-Key': key, 'If-Match': '"1"',
  });
  privateReply(written);
  assert.deepEqual(UploadVerifiedSchema.parse(written.data), { upload_id: uploadId, verified: true, version: '2' });
  const stored = await call('GET', uploadPath, session);
  privateReply(stored, '2');
  assert.equal(UploadSchema.parse(stored.data).phase, 'stored');
  await readWork(session, space, workVersion, prior[0]?.result_id);
  await readResults(session, space, prior);
  const finished = await post(`${uploadPath}/finalize`, session, { expected_work_version: workVersion }, '2', key);
  const resultId = operation(finished, 'work.result', space).resource_ref.resource_id;
  const nextVersion = String(BigInt(workVersion) + 1n);
  const detail = await call('GET', `${workPath(space)}/results/${resultId}`, session);
  privateReply(detail, nextVersion);
  const result = ResultSchema.parse(detail.data);
  assert.equal(result.result_id, resultId);
  assert.equal(result.work_id, space.workId);
  assert.equal(result.asset_id, upload.asset_id);
  assert.equal(result.revision, String(prior.length + 1));
  assert.equal(result.work_version, nextVersion);
  assert.equal(result.provenance, 'human');
  assert.equal(result.display_name, name);
  assert.equal(result.content_type, contentType);
  assert.equal(result.byte_size, bytes.byteLength);
  assert.equal(result.sha256, sha(bytes));
  await readWork(session, space, nextVersion, resultId);
  await readResults(session, space, [result, ...prior]);
  await readContent(session, space, result, bytes, nextVersion);
  return result;
}
async function editWork(session: Session, space: Space, current: WorkView, objective: string, progress: WorkView['progress']) {
  const edited = await call('PATCH', workPath(space), session,
    JSON.stringify({ title: current.title, objective, progress }), jsonHeaders(randomUUID(), current.version));
  operation(edited, 'work.work', space);
  const work = await readWork(session, space, String(BigInt(current.version) + 1n), current.current_result_id);
  assert.equal(work.title, current.title);
  assert.equal(work.objective, objective);
  assert.equal(work.progress, progress);
  return work;
}
async function objectSnapshot() {
  const snapshot = [];
  for (const key of [...store.keys].sort()) {
    const object = await store.get(key);
    assert.ok(object);
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    assert.equal(sha(bytes), object.metadata.sha256);
    snapshot.push({ key, sha256: sha(bytes), byte_size: bytes.byteLength, metadata: object.metadata, etag: object.etag });
  }
  return snapshot;
}
async function evidence(space: Space) {
  // Read-only owner evidence bypasses RLS solely to inspect persisted identities.
  const work = (await owner.query(`SELECT work_item_id,tenant_id,workspace_id,instance_id,scope_id,
    aggregate_version::text AS version,title,objective,progress FROM work_items WHERE work_item_id=$1`, [space.workId])).rows[0];
  const results = (await owner.query(`SELECT result_id,tenant_id,work_item_id,scope_id,asset_id,representation_id,
    revision::text,work_version::text,content_sha256,byte_size FROM tenant_work_results WHERE work_item_id=$1 ORDER BY revision DESC`, [space.workId])).rows;
  const uploads = (await owner.query(`SELECT intent_id,state FROM asset_upload_intents WHERE target_work_id=$1 ORDER BY intent_id`, [space.workId])).rows;
  const target = (await owner.query(`SELECT result_id FROM tenant_work_result_targets WHERE work_item_id=$1`, [space.workId])).rows[0];
  return { work, results, uploads, target, objects: await objectSnapshot() };
}
async function spaceIdentity(space: Space) {
  const tenant = (await owner.query(`SELECT tenant_id,version::text,authorization_revision::text,status
    FROM tenants WHERE tenant_id=$1`, [space.tenantId])).rows[0];
  const workspace = (await owner.query(`SELECT tenant_id,workspace_id,version::text,status,is_default
    FROM workspaces WHERE workspace_id=$1`, [space.workspaceId])).rows[0];
  const instance = (await owner.query(`SELECT tenant_id,instance_id,version::text,module_key,status,origin_guild_key
    FROM module_instances WHERE instance_id=$1`, [space.instanceId])).rows[0];
  return { tenant, workspace, instance };
}

test('T-005 M1 journey before the three-category switch: a member goes from guild to business space, saves Work notes and Results, and continues after signing in again (runtime role)', { concurrency: false }, async () => {
  memberA = await signIn(DEMO_USERS[0].email);
  const directory = await call('GET', '/guilds/directory', memberA);
  expectStatus(directory);
  assert.ok(directory.data.items.length > 0);
  const categories = await call('GET', '/guild-categories', memberA);
  expectStatus(categories);
  const approved = new Set(categories.data.categories.flatMap((group: { items: { guild_key: string; active: boolean; category_review: string }[] }) =>
    group.items.filter(item => item.active && item.category_review === 'approved').map(item => item.guild_key)));
  const selected = directory.data.items.find((item: { guild_key: string }) => approved.has(item.guild_key));
  assert.ok(selected, 'the legacy primary must have an approved active classification for a clean switch');
  legacyGuildKey = selected.guild_key;
  legacyOfficerVersion = await appointOfficer(legacyGuildKey);
  await chooseGuild(memberA, legacyGuildKey);
  spaceA = await createSpace(memberA, 'A-only-tenant 場勘業務', legacyGuildKey);
  const made = await post(`${workspacePath(spaceA)}/works`, memberA, { title, objective: initialObjective, progress: 'todo' });
  spaceA.workId = operation(made, 'work.work', spaceA, 201).resource_ref.resource_id;
  const initial = await readWork(memberA, spaceA, '1');
  assert.equal(initial.title, title);
  assert.equal(initial.objective, initialObjective);
  assert.equal(initial.progress, 'todo');
  assert.equal(initial.state, 'draft');
  await readResults(memberA, spaceA, []);
  noteResult = await saveResult(memberA, spaceA, '1', 'A-only-note.md', 'text/markdown', note, []);
  const saved = await readWork(memberA, spaceA, '2', noteResult.result_id);
  beforeSignOut = await editWork(memberA, spaceA, saved, editedObjective, 'in_progress');
  assert.equal(beforeSignOut.version, '3');
  await readResults(memberA, spaceA, [noteResult]);
  await readContent(memberA, spaceA, noteResult, note, '3');

  const oldSession = memberA;
  expectStatus(await post('/auth/logout', oldSession, {}));
  for (const path of [workPath(spaceA), `${workPath(spaceA)}/results/${noteResult.result_id}/content`]) {
    const refused = await call('GET', path, oldSession);
    expectStatus(refused, 401);
    assert.equal(Buffer.from(refused.bytes).includes(Buffer.from(note)), false);
  }
  const firstPid = await quiet('before restart');
  await runtime.end();
  instances.at(-1)!.closed = true;
  startApp();
  const secondPid = await quiet('after restart');
  assert.notEqual(secondPid, firstPid);
  memberA = await signIn(DEMO_USERS[0].email);
  assert.notEqual(memberA.cookie, oldSession.cookie);
  assert.equal(memberA.user.user_id, oldSession.user.user_id);

  const tenants = await call('GET', '/tenants?limit=100', memberA);
  privateReply(tenants);
  assert.deepEqual(TenantPageSchema.parse(tenants.data).items.map(item => item.tenant_id), [spaceA.tenantId]);
  await loadSpace(memberA, spaceA);
  const resumed = await context(memberA, spaceA, true, legacyGuildKey);
  assert.deepEqual(resumed.work_page.items, [beforeSignOut]);
  const works = await call('GET', `${workspacePath(spaceA)}/works?limit=50`, memberA);
  privateReply(works);
  assert.deepEqual(WorkPageSchema.parse(works.data).items, [beforeSignOut]);
  assert.deepEqual(await readWork(memberA, spaceA, '3', noteResult.result_id), beforeSignOut);
  await readContent(memberA, spaceA, noteResult, note, '3');
  const continued = await editWork(memberA, spaceA, beforeSignOut, continuedObjective, 'done');
  assert.equal(continued.version, '4');
  await readResults(memberA, spaceA, [noteResult]);
  await readContent(memberA, spaceA, noteResult, note, '4');
  attachmentResult = await saveResult(memberA, spaceA, '4', 'A-only-attachment.txt', 'text/plain', attachment, [noteResult]);
  finalWork = await readWork(memberA, spaceA, '5', attachmentResult.result_id);
  assert.equal(finalWork.objective, continuedObjective);
  assert.equal(finalWork.progress, 'done');
  await readResults(memberA, spaceA, [attachmentResult, noteResult]);
  await readContent(memberA, spaceA, noteResult, note, '5');
  await readContent(memberA, spaceA, attachmentResult, attachment, '5');
  const stale = await call('PATCH', workPath(spaceA), memberA,
    JSON.stringify({ title, objective: '不應保存的舊版本', progress: 'todo' }), jsonHeaders(randomUUID(), beforeSignOut.version));
  expectStatus(stale, 412);
  assert.equal(stale.data.code, 'version_conflict');
  assert.deepEqual(await readWork(memberA, spaceA, '5', attachmentResult.result_id), finalWork);

  const persisted = await evidence(spaceA);
  assert.equal(persisted.work.tenant_id, spaceA.tenantId);
  assert.equal(persisted.work.version, finalWork.version);
  assert.equal(persisted.work.workspace_id, spaceA.workspaceId);
  assert.equal(persisted.work.instance_id, spaceA.instanceId);
  assert.equal(persisted.results.length, 2);
  assert.deepEqual(persisted.results.map(row => row.result_id), [attachmentResult.result_id, noteResult.result_id]);
  assert.deepEqual(persisted.results.map(row => row.tenant_id), [spaceA.tenantId, spaceA.tenantId]);
  assert.deepEqual(persisted.results.map(row => row.content_sha256), [sha(attachment), sha(note)]);
  assert.deepEqual(persisted.uploads.map(row => row.state), ['finalized', 'finalized']);
  assert.equal(persisted.target.result_id, attachmentResult.result_id);
  assert.equal(persisted.objects.length, 2);
  const keys = persisted.results.map(row => objectKey({ scopeId: row.scope_id, assetId: row.asset_id, representationId: row.representation_id }));
  assert.deepEqual([...store.keys].sort(), keys.sort());
  for (const result of persisted.results) {
    const stored = persisted.objects.find(item => item.key === objectKey({ scopeId: result.scope_id, assetId: result.asset_id, representationId: result.representation_id }));
    assert.ok(stored);
    assert.equal(stored.sha256, result.content_sha256);
    assert.equal(stored.byte_size, result.byte_size);
  }
  const journal = (await owner.query('SELECT data::text AS data FROM scoped_transition_journal')).rows;
  for (const row of journal) for (const marker of [title, initialObjective, editedObjective, continuedObjective, 'A-only-note', 'A-only-attachment', Buffer.from(note).toString('utf8')]) {
    assert.equal(row.data.includes(marker), false, 'private Work/Result text leaked into the journal');
  }
  console.log(JSON.stringify({ check: 'T-005 M1 journey', guild_key: legacyGuildKey, member_id: memberA.user.user_id,
    tenant_id: spaceA.tenantId, workspace_id: spaceA.workspaceId, instance_id: spaceA.instanceId, work_id: spaceA.workId,
    versions: { created: initial.version, note_saved: saved.version, before_sign_out: beforeSignOut.version, continued: continued.version, final: finalWork.version },
    results: [noteResult, attachmentResult].map(result => ({ result_id: result.result_id, asset_id: result.asset_id,
      revision: result.revision, work_version: result.work_version, sha256: result.sha256, byte_size: result.byte_size })),
    backend_pids: [firstPid, secondPid], finalized_object_count: persisted.objects.length }));
});

test("T-022 M1 journey: another tenant's owner gets the same answers as for random IDs (runtime role)", { concurrency: false }, async () => {
  assert.ok(finalWork, 'T-005 must complete before cross-tenant evidence');
  memberB = await signIn(DEMO_USERS[1].email);
  await chooseGuild(memberB, legacyGuildKey);
  spaceB = await createSpace(memberB, 'B-only-tenant 場勘業務', legacyGuildKey);
  const made = await post(`${workspacePath(spaceB)}/works`, memberB, { title: 'B-only-work', objective: 'B-only-objective', progress: 'todo' });
  spaceB.workId = operation(made, 'work.work', spaceB, 201).resource_ref.resource_id;
  const otherResult = await saveResult(memberB, spaceB, '1', 'B-only-note.txt', 'text/plain', otherNote, []);
  const before = await evidence(spaceA);
  const randomSpace = { tenantId: randomUUID(), workspaceId: randomUUID(), instanceId: randomUUID(), workId: randomUUID() };
  const randomResult = randomUUID();
  const reads: Array<(space: Space, resultId: string) => string> = [
    space => `/tenants/${space.tenantId}`,
    space => `/tenants/${space.tenantId}/workspaces?limit=100`,
    space => contextPath(space, legacyGuildKey),
    space => `${workspacePath(space)}/works?limit=50`,
    space => workPath(space),
    space => `${workPath(space)}/results?limit=20`,
    (space, resultId) => `${workPath(space)}/results/${resultId}`,
    (space, resultId) => `${workPath(space)}/results/${resultId}/content`,
  ];
  const markers = [spaceA.tenantId, spaceA.workspaceId, spaceA.instanceId, spaceA.workId, noteResult.result_id, attachmentResult.result_id,
    noteResult.asset_id, attachmentResult.asset_id, noteResult.sha256, attachmentResult.sha256, 'A-only-tenant', title,
    initialObjective, editedObjective, continuedObjective, 'A-only-note', 'A-only-attachment'];
  function sameAsRandom(label: string, hidden: Reply, missing: Reply) {
    expectStatus(hidden, 404);
    assert.equal(hidden.status, missing.status, label);
    assert.deepEqual(hidden.data, missing.data, label);
    assert.deepEqual(hidden.bytes, missing.bytes, `${label}: complete raw response`);
    assert.equal(hidden.headers.get('cache-control'), missing.headers.get('cache-control'), label);
    assert.equal(hidden.headers.get('cache-control'), 'private, no-store', label);
    for (const reply of [hidden, missing]) {
      assert.equal(reply.headers.has('etag'), false, label);
      assert.equal(reply.headers.has('location'), false, label);
      const raw = Buffer.from(reply.bytes).toString('utf8') + JSON.stringify(Object.fromEntries(reply.headers));
      for (const marker of markers) assert.equal(raw.includes(marker), false, `${label}: leaked ${marker}`);
    }
  }
  for (const path of reads) {
    const actual = path(spaceA, attachmentResult.result_id);
    sameAsRandom(`GET ${actual}`, await call('GET', actual, memberB), await call('GET', path(randomSpace, randomResult), memberB));
  }
  const writes = [
    { method: 'PATCH', path: workPath, body: { title: '越權修改', objective: '不應寫入', progress: 'todo' }, version: finalWork.version },
    { method: 'POST', path: (space: Space) => `${workPath(space)}/results/uploads`, body: {
      content_type: 'text/plain', byte_size: otherNote.byteLength, sha256: sha(otherNote), display_name: 'unwanted.txt', expected_work_version: finalWork.version,
    }, version: undefined },
    { method: 'POST', path: (space: Space) => `${workspacePath(space)}/manual-work`, body: { guild_key: legacyGuildKey }, version: undefined },
  ];
  for (const route of writes) {
    const hidden = await call(route.method, route.path(spaceA), memberB, JSON.stringify(route.body), jsonHeaders(randomUUID(), route.version));
    const missing = await call(route.method, route.path(randomSpace), memberB, JSON.stringify(route.body), jsonHeaders(randomUUID(), route.version));
    sameAsRandom(`${route.method} ${route.path(spaceA)}`, hidden, missing);
  }
  assert.deepEqual(await evidence(spaceA), before, 'foreign reads and writes must leave Work, Results, intents, pointers and objects unchanged');
  assert.equal(before.objects.length, 3);
  for (const [session, own, other, expectedWork, results] of [
    [memberB, spaceB, spaceA, await readWork(memberB, spaceB, '2', otherResult.result_id), [otherResult]],
    [memberA, spaceA, spaceB, finalWork, [attachmentResult, noteResult]],
  ] as const) {
    const tenants = await call('GET', '/tenants?limit=100', session);
    privateReply(tenants);
    assert.deepEqual(TenantPageSchema.parse(tenants.data).items.map(item => item.tenant_id), [own.tenantId]);
    await loadSpace(session, own);
    const loaded = await context(session, own, true, legacyGuildKey);
    assert.deepEqual(loaded.work_page.items, [expectedWork]);
    const works = await call('GET', `${workspacePath(own)}/works?limit=50`, session);
    privateReply(works);
    assert.deepEqual(WorkPageSchema.parse(works.data).items, [expectedWork]);
    assert.equal(Buffer.from(works.bytes).toString('utf8').includes(other.workId), false);
    await readResults(session, own, [...results]);
  }
  await readContent(memberB, spaceB, otherResult, otherNote, '2');
  await readContent(memberA, spaceA, noteResult, note, '5');
  await readContent(memberA, spaceA, attachmentResult, attachment, '5');
  console.log(JSON.stringify({ check: 'T-022 M1 tenant isolation', tenant_a: spaceA.tenantId, tenant_b: spaceB.tenantId,
    compared_reads: reads.length, compared_writes: writes.length, a_version: finalWork.version, a_results: before.results.length,
    total_objects: before.objects.length, unchanged: true }));
});

test('T-005 M1 journey after the three-category switch: one approved guild per category goes from guild to business space, saves Work notes and attachments, and continues after signing in again (runtime role)', { concurrency: false }, async () => {
  const requestStart = instances.reduce((total, instance) => total + instance.requests, 0);
  const beforeA = await evidence(spaceA); // Before every operator call, including the dry run.
  const beforeB = await evidence(spaceB);
  const identitiesAB = await Promise.all([spaceIdentity(spaceA), spaceIdentity(spaceB)]);
  const dryRun = await adminPost('/guild-preferences/backfill', { dry_run: true, limit: 100 });
  expectStatus(dryRun);
  assert.deepEqual(BackfillReport.parse(dryRun.data), {
    dry_run: true, processed: 1, mapped: 0, blocked: 0, ambiguous: 0,
    remaining: 1, remaining_blocked: 0, blocked_members: [],
  }); // A/B were reconciled by legacy primary writes; the officer has membership only.
  const backfill = await adminPost('/guild-preferences/backfill', { dry_run: false, limit: 100 });
  expectStatus(backfill);
  assert.deepEqual(BackfillReport.parse(backfill.data), {
    dry_run: false, processed: 1, mapped: 0, blocked: 0, ambiguous: 0,
    remaining: 0, remaining_blocked: 0, blocked_members: [],
  });
  const switched = await adminPost('/guild-preferences/switch', { accept_blocked: false });
  expectStatus(switched);
  assert.deepEqual(switched.data, { state: 'switched', aggregate_version: 2, blocked: 0, processed: 0, already_switched: false });
  const rerun = await adminPost('/guild-preferences/backfill', { dry_run: false, limit: 100 });
  expectStatus(rerun);
  assert.deepEqual(BackfillReport.parse(rerun.data), { ...backfill.data, processed: 0 });
  const reswitch = await adminPost('/guild-preferences/switch', { accept_blocked: false });
  expectStatus(reswitch);
  assert.deepEqual(reswitch.data, { ...switched.data, already_switched: true });
  const legacy = await call('GET', '/me/guild-preferences', memberA);
  expectStatus(legacy);
  assert.equal(legacy.data.compatibility, 'legacy_projection');
  assert.equal(legacy.data.primary_guild_key, legacyGuildKey);
  const closed = await post(`/guilds/${legacyGuildKey}/primary`, memberA, {}, String(legacy.data.aggregate_version));
  expectStatus(closed, 409);
  assert.equal(closed.data.code, 'client_upgrade_required');
  const aPreferences = await call('GET', '/me/guild-preferences/v2', memberA);
  privateReply(aPreferences);
  assert.equal(PreferenceView.parse(aPreferences.data).migration_state, 'switched');
  assert.deepEqual(await evidence(spaceA), beforeA);
  assert.deepEqual(await evidence(spaceB), beforeB);
  assert.deepEqual(await Promise.all([spaceIdentity(spaceA), spaceIdentity(spaceB)]), identitiesAB);
  assert.deepEqual(await readWork(memberA, spaceA, '5', attachmentResult.result_id), finalWork);
  await readResults(memberA, spaceA, [attachmentResult, noteResult]);
  await readContent(memberA, spaceA, noteResult, note, '5');
  await readContent(memberA, spaceA, attachmentResult, attachment, '5');
  const aTenants = await call('GET', '/tenants?limit=100', memberA);
  privateReply(aTenants);
  assert.deepEqual(TenantPageSchema.parse(aTenants.data).items.map(item => item.tenant_id), [spaceA.tenantId]);

  const cEmail = 'journey-c@example.test';
  // Registration leaves onboarding pending and the member boundary refuses v2
  // preferences until a prior guild choice. Use the seedLocal user shape to keep
  // all three slots empty; the empty set matches registration's post-switch row.
  const cId = randomUUID();
  await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id=$6`,
    [cId, DEMO_COMMUNITY, cEmail, '合成會員 C', randomUUID(), DEMO_USERS[0].user_id]);
  await owner.query(`INSERT INTO guild_preference_sets(community_id,user_id,aggregate_version,migration_state)
    VALUES($1,$2,1,'switched')`, [DEMO_COMMUNITY, cId]);
  let memberC = await signIn(cEmail);
  assert.equal(memberC.user.user_id, cId);
  const emptyView = await call('GET', '/me/guild-preferences/v2', memberC);
  privateReply(emptyView, '1');
  const emptySlots = CATEGORY_ORDER.map(category => ({ category, guild_key: null }));
  assert.deepEqual(PreferenceView.parse(emptyView.data).primaries, emptySlots);
  assert.equal(emptyView.data.migration_state, 'switched');
  assert.equal(emptyView.data.legacy, null);
  const catalog = await call('GET', '/guild-categories', memberC);
  expectStatus(catalog);
  const selected = CATEGORY_ORDER.map(category => {
    const group = catalog.data.categories.find((item: { category: string }) => item.category === category);
    assert.ok(group);
    const guild = group.items.find((item: { active: boolean; category_review: string }) => item.active && item.category_review === 'approved');
    assert.ok(guild, `${category} needs an active approved guild`);
    assert.equal(guild.category, category);
    assert.match(guild.catalog_revision, /^[1-9][0-9]{0,18}$/);
    return { category, guildKey: guild.guild_key as string, catalogRevision: guild.catalog_revision as string };
  });
  const journeys: Array<{
    category: typeof CATEGORY_ORDER[number]; guildKey: string; space: Space; saved: WorkView; continued?: WorkView;
    results: ResultView[]; noteBytes: Uint8Array; attachmentBytes: Uint8Array;
  }> = [];
  const primaries = [...emptySlots] as Array<{ category: typeof CATEGORY_ORDER[number]; guild_key: string | null }>;
  const privateMarkers: string[] = [];
  for (const { category, guildKey, catalogRevision } of selected) {
    const marker = `C-${category}-`;
    privateMarkers.push(marker);
    const joined = await post(`/guilds/${guildKey}/join`, memberC, {});
    expectStatus(joined);
    assert.equal(joined.data.state, 'active');
    assert.equal(joined.data.member_tier, 'intern');
    // The professional guild may be the already-appointed legacy guild.
    await appointOfficer(guildKey, guildKey === legacyGuildKey ? legacyOfficerVersion : undefined);
    const promoted = await post(`/guilds/${guildKey}/members/${memberC.user.user_id}/tier`, officer,
      { member_tier: 'full' }, String(joined.data.aggregate_version));
    expectStatus(promoted);
    assert.equal(promoted.data.member_tier, 'full');
    assert.equal(promoted.data.changed, true);
    assert.equal(promoted.data.aggregate_version, joined.data.aggregate_version + 1);
    const preferences = await call('GET', '/me/guild-preferences/v2', memberC);
    privateReply(preferences);
    const current = PreferenceView.parse(preferences.data);
    assert.deepEqual(current.primaries, primaries);
    const chosen = await post('/me/guild-preferences/v2/set', memberC,
      { category, guild_key: guildKey, catalog_revision: catalogRevision }, String(current.aggregate_version));
    privateReply(chosen, String(current.aggregate_version + 1));
    primaries.find(slot => slot.category === category)!.guild_key = guildKey;
    assert.deepEqual(PreferenceView.parse(chosen.data).primaries, primaries);
    const confirmed = await call('GET', '/me/guild-preferences/v2', memberC);
    privateReply(confirmed, String(current.aggregate_version + 1));
    assert.deepEqual(confirmed.data, chosen.data);
    const launchpad = await call('GET', `/guilds/${guildKey}/launchpad`, memberC);
    expectStatus(launchpad);
    assert.deepEqual(launchpad.data.membership, { state: 'active', member_tier: 'full' });
    assert.ok(launchpad.data.config.body.blocks.some((block: { kind: string; enabled: boolean }) => block.kind === 'my_work' && block.enabled));
    const space = await createSpace(memberC, `${marker}tenant 業務空間`, guildKey);
    const made = await post(`${workspacePath(space)}/works`, memberC,
      { title: `${marker}work 工作`, objective: `${marker}objective 記錄下一步`, progress: 'in_progress' });
    space.workId = operation(made, 'work.work', space, 201).resource_ref.resource_id;
    const initial = await readWork(memberC, space, '1');
    assert.equal(initial.title, `${marker}work 工作`);
    assert.equal(initial.objective, `${marker}objective 記錄下一步`);
    assert.equal(initial.progress, 'in_progress');
    assert.equal(initial.state, 'draft');
    await readResults(memberC, space, []);
    const noteBytes = new TextEncoder().encode(`# ${marker}note\n私人筆記：重開後繼續。\n`);
    const attachmentBytes = new TextEncoder().encode(`${marker}attachment\n實際附件：確認下一步。\n`);
    const noteSaved = await saveResult(memberC, space, '1', `${marker}note.md`, 'text/markdown', noteBytes, []);
    const attachmentSaved = await saveResult(memberC, space, '2', `${marker}attachment.txt`, 'text/plain', attachmentBytes, [noteSaved]);
    const saved = await readWork(memberC, space, '3', attachmentSaved.result_id);
    assert.deepEqual(saved, { ...initial, version: '3', current_result_id: attachmentSaved.result_id, updated_at: saved.updated_at });
    await readContent(memberC, space, noteSaved, noteBytes, '3');
    journeys.push({ category, guildKey, space, saved, results: [attachmentSaved, noteSaved], noteBytes, attachmentBytes });
  }
  const allPreferences = await call('GET', '/me/guild-preferences/v2', memberC);
  privateReply(allPreferences, '4');
  assert.deepEqual(PreferenceView.parse(allPreferences.data).primaries, primaries);
  const beforeRestart = await Promise.all(journeys.map(journey => evidence(journey.space)));
  const identities = await Promise.all(journeys.map(journey => spaceIdentity(journey.space)));
  const oldSession = memberC;
  expectStatus(await post('/auth/logout', oldSession, {}));
  for (const { space, results } of journeys) {
    for (const path of [workPath(space), ...results.map(result => `${workPath(space)}/results/${result.result_id}/content`)]) {
      const refused = await call('GET', path, oldSession);
      expectStatus(refused, 401);
      const raw = Buffer.from(refused.bytes).toString('utf8');
      for (const marker of privateMarkers) assert.equal(raw.includes(marker), false);
    }
  }
  const beforePid = await quiet('before three-category restart');
  await runtime.end();
  instances.at(-1)!.closed = true;
  startApp();
  const afterPid = await quiet('after three-category restart');
  assert.notEqual(afterPid, beforePid);
  memberC = await signIn(cEmail);
  assert.notEqual(memberC.cookie, oldSession.cookie);
  assert.equal(memberC.user.user_id, oldSession.user.user_id);
  const tenants = await call('GET', '/tenants?limit=100', memberC);
  privateReply(tenants);
  assert.deepEqual(TenantPageSchema.parse(tenants.data).items.map(item => item.tenant_id).sort(), journeys.map(item => item.space.tenantId).sort());
  const resumedPreferences = await call('GET', '/me/guild-preferences/v2', memberC);
  privateReply(resumedPreferences, '4');
  assert.deepEqual(resumedPreferences.data, allPreferences.data);
  for (const [index, journey] of journeys.entries()) {
    const { space, saved, results, noteBytes, attachmentBytes, guildKey } = journey;
    assert.deepEqual(await evidence(space), beforeRestart[index]);
    assert.deepEqual(await spaceIdentity(space), identities[index]);
    await loadSpace(memberC, space);
    const resumed = await context(memberC, space, true, guildKey);
    assert.deepEqual(resumed.work_page.items, [saved]);
    assert.deepEqual(await readWork(memberC, space, '3', results[0].result_id), saved);
    await readResults(memberC, space, results);
    await readContent(memberC, space, results[1], noteBytes, '3');
    await readContent(memberC, space, results[0], attachmentBytes, '3');
    journey.continued = await editWork(memberC, space, saved, `C-${journey.category}-continued 已確認下一步`, 'done');
    assert.equal(journey.continued.version, '4');
    const persistedBeforeStale = await evidence(space);
    const stale = await call('PATCH', workPath(space), memberC,
      JSON.stringify({ title: saved.title, objective: `C-${journey.category}-stale 不應保存`, progress: 'todo' }), jsonHeaders(randomUUID(), saved.version));
    expectStatus(stale, 412);
    assert.equal(stale.data.code, 'version_conflict');
    assert.deepEqual(await evidence(space), persistedBeforeStale);
    assert.deepEqual(await readWork(memberC, space, '4', results[0].result_id), journey.continued);
    await readResults(memberC, space, results);
    await readContent(memberC, space, results[1], noteBytes, '4');
    await readContent(memberC, space, results[0], attachmentBytes, '4');
  }
  for (const [index, { space, results, continued, guildKey }] of journeys.entries()) {
    assert.deepEqual(await spaceIdentity(space), identities[index]);
    assert.deepEqual(identities[index], {
      tenant: { tenant_id: space.tenantId, version: '1', authorization_revision: '1', status: 'active' },
      workspace: { tenant_id: space.tenantId, workspace_id: space.workspaceId, version: '1', status: 'active', is_default: true },
      instance: { tenant_id: space.tenantId, instance_id: space.instanceId, version: '1', module_key: 'work', status: 'active', origin_guild_key: guildKey },
    });
    const persisted = await evidence(space);
    assert.equal(persisted.work.tenant_id, space.tenantId);
    assert.equal(persisted.work.workspace_id, space.workspaceId);
    assert.equal(persisted.work.instance_id, space.instanceId);
    assert.equal(persisted.work.work_item_id, space.workId);
    assert.equal(persisted.work.version, continued!.version);
    assert.equal(persisted.work.title, continued!.title);
    assert.equal(persisted.work.objective, continued!.objective);
    assert.equal(persisted.work.progress, continued!.progress);
    assert.deepEqual(persisted.results.map(row => [row.result_id, row.tenant_id, row.work_item_id, row.revision, row.work_version, row.content_sha256, row.byte_size]),
      results.map(result => [result.result_id, space.tenantId, space.workId, result.revision, result.work_version, result.sha256, result.byte_size]));
    assert.equal(persisted.uploads.length, 2);
    assert.deepEqual(persisted.uploads.map(row => row.state), ['finalized', 'finalized']);
    assert.equal(persisted.target.result_id, results[0].result_id);
    for (const result of persisted.results) {
      const stored = persisted.objects.find(item => item.key === objectKey({ scopeId: result.scope_id, assetId: result.asset_id, representationId: result.representation_id }));
      assert.ok(stored);
      assert.equal(stored.sha256, result.content_sha256);
      assert.equal(stored.byte_size, result.byte_size);
    }
  }
  const allObjects = await objectSnapshot();
  assert.equal(allObjects.length, 9);
  const resultRows = (await owner.query('SELECT scope_id,asset_id,representation_id FROM tenant_work_results')).rows;
  assert.deepEqual([...store.keys].sort(), resultRows.map(row => objectKey({ scopeId: row.scope_id, assetId: row.asset_id, representationId: row.representation_id })).sort());
  const objectRows = (await owner.query('SELECT object_key,content_sha256,byte_size FROM asset_objects ORDER BY object_key')).rows;
  assert.deepEqual(objectRows, allObjects.map(item => ({ object_key: item.key, content_sha256: item.sha256, byte_size: item.byte_size })));
  for (const [space, before] of [[spaceA, beforeA], [spaceB, beforeB]] as const) {
    const after = await evidence(space);
    assert.deepEqual({ ...after, objects: after.objects.filter(item => before.objects.some(old => old.key === item.key)) }, before);
  }
  assert.deepEqual(await Promise.all([spaceIdentity(spaceA), spaceIdentity(spaceB)]), identitiesAB);
  const journal = (await owner.query('SELECT data::text AS data FROM scoped_transition_journal')).rows;
  for (const row of journal) for (const marker of privateMarkers) assert.equal(row.data.includes(marker), false, 'private category Work/Result text leaked into the journal');
  console.log(JSON.stringify({ check: 'T-005 M1 three-category journey', member_id: memberC.user.user_id,
    guilds: Object.fromEntries(selected.map(item => [item.category, item.guildKey])),
    spaces: journeys.map(({ category, guildKey, space, saved, continued, results }, index) => ({ category, guild_key: guildKey,
      tenant_id: space.tenantId, workspace_id: space.workspaceId, instance_id: space.instanceId, work_id: space.workId,
      versions: { tenant: identities[index].tenant.version, workspace: identities[index].workspace.version,
        instance: identities[index].instance.version, before_sign_out: saved.version, continued: continued!.version },
      results: results.map(result => ({ result_id: result.result_id, asset_id: result.asset_id, revision: result.revision,
        work_version: result.work_version, sha256: result.sha256, byte_size: result.byte_size })) })),
    backend_pids: [beforePid, afterPid], backfill: { dry_run: dryRun.data, executed: backfill.data, rerun: rerun.data },
    switch: { accept_blocked: false, outcome: switched.data, rerun: reswitch.data },
    requests: instances.reduce((total, instance) => total + instance.requests, 0) - requestStart, finalized_object_count: allObjects.length, a_and_b_unchanged: true }));
});

test('T-024 M1 journey ran on the runtime role with one pooled connection per app instance', { concurrency: false }, async () => {
  assert.ok(instances.length >= 2, 'the journey must replace its app and pool');
  const who = (await runtime.query(`SELECT current_user,session_user,rolsuper,rolbypassrls,rolinherit,
    pg_backend_pid() AS pid FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.equal(who.current_user, runtimeRole);
  assert.equal(who.session_user, runtimeRole);
  assert.equal(who.rolsuper, false);
  assert.equal(who.rolbypassrls, false);
  assert.equal(who.rolinherit, false);
  const table = (await owner.query(`SELECT pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='work_items'`, [schema])).rows[0];
  assert.equal(table.owner, migrator);
  assert.notEqual(table.owner, runtimeRole);
  assert.equal(table.relrowsecurity, true);
  for (const instance of instances) {
    assert.equal(instance.pool.options.max, 1);
    assert.ok(instance.requests > 0);
    assert.equal(instance.pids.size, 1);
  }
  const pids = instances.map(instance => [...instance.pids][0]);
  assert.equal(new Set(pids).size, instances.length, 'every app instance must use a distinct backend');
  assert.equal(Number(who.pid), pids.at(-1));
  await quiet('final role evidence');
  console.log(JSON.stringify({ check: 'T-024 M1 runtime role', ...who, work_items_owner: table.owner,
    app_instances: instances.map(instance => ({ max_connections: instance.pool.options.max, backend_pids: [...instance.pids], requests: instance.requests })) }));
});
