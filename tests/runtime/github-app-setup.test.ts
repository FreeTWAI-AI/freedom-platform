import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import type { AdminActor } from '../../modules/platform-admin/service.js';
import { completeGitHubAppSetup, githubAppSetupStatus, readSocialConfig, startGitHubAppSetup } from '../../modules/github-social/setup.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_github_setup_${process.pid}_${Date.now()}`, database = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, application_name: schema, max: 8 });
const origin = 'https://workshop.example.invalid', tokenKey = randomBytes(32).toString('base64');
const actor: AdminActor = { admin_id: randomUUID(), community_id: randomUUID(), email: 'setup-admin@example.invalid', display_name: 'Setup Admin', role: 'super_admin', subject: 'verified-fixture-subject' };
const another: AdminActor = { ...actor, admin_id: randomUUID(), email: 'another-admin@example.invalid' };
const code = 'a'.repeat(40), secret = 'synthetic-client-secret-1234567890';
const app = { id: 1234567, slug: 'freedom-workshop-fixture', html_url: 'https://github.com/apps/freedom-workshop-fixture', external_url: origin,
  owner: { login: 'FreeTWAI-AI', type: 'Organization' }, permissions: { starring: 'write', metadata: 'read' }, events: [],
  client_id: 'Iv23.synthetic-client-id', client_secret: secret, pem: 'DO-NOT-STORE-THIS-PRIVATE-KEY', webhook_secret: 'DO-NOT-STORE-WEBHOOK-SECRET', token: 'DO-NOT-STORE-TOKEN' };
const publicResult = { configured: true, app_id: String(app.id), app_slug: app.slug, html_url: app.html_url };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let created = false;

before(async () => { await database.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => {
  await pool.end();
  try { if (created) await database.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { await database.end(); }
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query('INSERT INTO communities VALUES($1,$2)', [actor.community_id, 'Isolated GitHub App setup fixture']);
  for (const admin of [actor, another]) await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',
    [admin.admin_id, admin.community_id, admin.email, admin.display_name]);
});
async function start(admin = actor) {
  const result = await startGitHubAppSetup(pool, admin, origin, tokenKey);
  return { ...result, state: new URL(result.target).searchParams.get('state')! };
}
function provider(reply: () => Promise<Response> = async () => Response.json(app, { status: 201 })) {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), `https://api.github.com/app-manifests/${code}/conversions`);
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/vnd.github+json');
    assert.equal(init?.body, undefined);
    return reply();
  };
  return { fetcher, calls: () => calls };
}
function rejectsWith(code: string) { return (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code; }
async function setupRows() { return (await pool.query('SELECT * FROM github_app_setup_states ORDER BY state_hash')).rows; }
async function complete(state: string, remote = provider(), admin = actor) {
  return completeGitHubAppSetup(pool, admin, { code, state }, tokenKey, { fetcher: remote.fetcher });
}

test('manifest requests starring write and metadata read, fixed callbacks and a disabled webhook; database stores a hashed ten-minute state', async () => {
  assert.deepEqual(await githubAppSetupStatus(pool, actor), { configured: false });
  assert.equal(await readSocialConfig(pool, tokenKey), null);
  const before = Date.now(), result = await start(), manifest = JSON.parse(result.manifest), target = new URL(result.target);
  assert.equal(target.origin + target.pathname, 'https://github.com/organizations/FreeTWAI-AI/settings/apps/new');
  assert.match(result.state, /^[A-Za-z0-9_-]{43}$/); assert.match(manifest.name, /^freedom-workshop-[a-f0-9]{12}$/);
  assert.match(manifest.description, /自由工坊技能書/);
  assert.deepEqual({ ...manifest, name: undefined, description: undefined }, { name: undefined, description: undefined, url: origin,
    redirect_url: `${origin}/admin/github/callback`, callback_urls: [`${origin}/github/callback`], public: true,
    default_permissions: { starring: 'write', metadata: 'read' }, hook_attributes: { url: `${origin}/github/events`, active: false } });
  const [saved] = await setupRows();
  assert.equal(saved.state_hash, hash(result.state)); assert.equal(saved.admin_id, actor.admin_id); assert.equal(saved.community_id, actor.community_id);
  assert.equal(saved.origin, origin); assert.equal(saved.consumed_at, null); assert.equal(saved.code_hash, null);
  assert.equal(saved.expires_at.getTime() - saved.created_at.getTime(), 600000);
  assert.ok(Date.parse(result.expires_at) >= before + 599000);
  assert.ok(!JSON.stringify(saved).includes(result.state));
  const second = await start(); assert.notEqual(second.state, result.state); assert.notEqual(JSON.parse(second.manifest).name, manifest.name);
});

test('successful conversion encrypts only the client secret, returns safe metadata and is immediately readable without restart', async () => {
  const { state } = await start(), remote = provider();
  assert.equal(await readSocialConfig(pool, tokenKey), null);
  assert.deepEqual(await complete(state, remote), publicResult); assert.equal(remote.calls(), 1);
  assert.deepEqual(await githubAppSetupStatus(pool, actor), publicResult);
  assert.deepEqual(await readSocialConfig(pool, tokenKey), { clientId: app.client_id, clientSecret: secret, tokenKey });
  const rows = (await pool.query('SELECT * FROM github_social_apps')).rows;
  assert.equal(rows.length, 1); assert.match(rows[0].client_secret_encrypted, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(rows[0].configured_by, actor.admin_id);
  const [saved] = await setupRows();
  assert.ok(saved.consumed_at instanceof Date); assert.equal(saved.code_hash, hash(code)); assert.equal(saved.completed_app_id, String(app.id));
  const audits = (await pool.query('SELECT * FROM platform_admin_audit')).rows; assert.equal(audits.length, 1);
  assert.equal(audits[0].verified_access_subject, actor.subject); assert.deepEqual(audits[0].after_state, publicResult);
  const stored = JSON.stringify({ rows, states: await setupRows(), audits, result: publicResult });
  for (const forbidden of [secret, tokenKey, code, state, app.pem, app.webhook_secret, app.token]) assert.ok(!stored.includes(forbidden));
  assert.ok(!Object.hasOwn(rows[0], 'private_key')); assert.ok(!Object.hasOwn(rows[0], 'client_secret'));
});

test('a fresh setup replaces the same admin pending state and cleans expired attempts without deleting another active attempt', async () => {
  const first = await start(), other = await start(another), replacement = await start(), remote = provider();
  assert.equal((await setupRows()).length, 2);
  await assert.rejects(complete(first.state, remote), rejectsWith('github_setup_state_invalid'));
  assert.equal(remote.calls(), 0);
  assert.ok((await setupRows()).some(row => row.state_hash === hash(other.state)));
  await pool.query("UPDATE github_app_setup_states SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE state_hash=$1", [hash(other.state)]);
  const fresh = await start();
  assert.equal((await setupRows()).length, 1); assert.equal((await setupRows())[0].state_hash, hash(fresh.state));
  await assert.rejects(complete(replacement.state, remote), rejectsWith('github_setup_state_invalid'));
  assert.deepEqual(await complete(fresh.state, remote), publicResult);
});

test('concurrent identical callbacks exchange once and return the same safe receipt; a different code cannot reuse state', async () => {
  const { state } = await start(), remote = provider();
  const results = await Promise.all([complete(state, remote), complete(state, remote)]);
  assert.deepEqual(results, [publicResult, publicResult]); assert.equal(remote.calls(), 1);
  assert.deepEqual(await complete(state, remote), publicResult); assert.equal(remote.calls(), 1);
  await assert.rejects(completeGitHubAppSetup(pool, actor, { state, code: 'b'.repeat(40) }, tokenKey, { fetcher: remote.fetcher }), rejectsWith('github_setup_state_used'));
  assert.equal(remote.calls(), 1); assert.equal((await pool.query('SELECT count(*) FROM platform_admin_audit')).rows[0].count, '1');
});

test('configuration stays unavailable until conversion is validated and committed', async () => {
  const { state } = await start(); let reached!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const remote = provider(async () => { reached(); await gate; return Response.json(app, { status: 201 }); });
  const pending = complete(state, remote); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([reading, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Provider was not reached.')), 3000); })]);
    assert.equal(await readSocialConfig(pool, tokenKey), null);
    assert.deepEqual(await githubAppSetupStatus(pool, another), { configured: false });
    assert.equal((await setupRows())[0].consumed_at, null);
  } finally { if (timer) clearTimeout(timer); release(); await pending; }
  assert.deepEqual(await pending, publicResult);
  assert.equal((await readSocialConfig(pool, tokenKey))!.clientId, app.client_id);
});

test('other setup states and new setup attempts cannot silently replace a configured GitHub App', async () => {
  const first = await start(), second = await start(another), remote = provider();
  await complete(first.state, remote);
  const prior = (await pool.query('SELECT * FROM github_social_apps')).rows;
  await assert.rejects(complete(second.state, remote, another), rejectsWith('github_app_already_configured'));
  await assert.rejects(start(), rejectsWith('github_app_already_configured'));
  assert.equal(remote.calls(), 1); assert.deepEqual((await pool.query('SELECT * FROM github_social_apps')).rows, prior);
  assert.equal((await setupRows()).find(row => row.state_hash === hash(second.state))!.consumed_at, null);
});

test('state belongs to the initiating active admin and community, including successful receipt replays', async () => {
  const { state } = await start(), remote = provider();
  await assert.rejects(complete(state, remote, another), rejectsWith('github_setup_state_invalid'));
  const otherCommunity = randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)', [otherCommunity, 'Other fixture']);
  await pool.query('UPDATE platform_admins SET community_id=$1 WHERE admin_id=$2', [otherCommunity, another.admin_id]);
  await assert.rejects(complete(state, remote, { ...another, community_id: otherCommunity }), rejectsWith('github_setup_state_invalid'));
  assert.equal(remote.calls(), 0);
  await complete(state, remote);
  await pool.query('UPDATE platform_admins SET active=false WHERE admin_id=$1', [actor.admin_id]);
  await assert.rejects(complete(state, remote), rejectsWith('admin_required'));
  await assert.rejects(githubAppSetupStatus(pool, actor), rejectsWith('admin_required'));
  await assert.rejects(start(), rejectsWith('admin_required')); assert.equal(remote.calls(), 1);
});

test('unknown, expired and malformed state/code fail before provider exchange', async () => {
  const { state } = await start(), remote = provider();
  await assert.rejects(complete(randomBytes(32).toString('base64url'), remote), rejectsWith('github_setup_state_invalid'));
  await pool.query("UPDATE github_app_setup_states SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute'");
  await assert.rejects(complete(state, remote), rejectsWith('github_setup_state_expired'));
  for (const input of [{ state: '../bad-state', code }, { state, code: '../bad-code' }, { state, code: 'x'.repeat(201) }]) {
    await assert.rejects(completeGitHubAppSetup(pool, actor, input, tokenKey, { fetcher: remote.fetcher }));
  }
  assert.equal(remote.calls(), 0); assert.equal(await readSocialConfig(pool, tokenKey), null);
});

test('invalid encryption keys and non-origin callback addresses cannot start setup', async () => {
  for (const key of ['', 'not-base64', randomBytes(31).toString('base64'), tokenKey + '\n']) {
    await assert.rejects(startGitHubAppSetup(pool, actor, origin, key), rejectsWith('github_setup_unavailable'));
  }
  for (const url of ['http://public.example.invalid', 'https://name:pass@example.invalid', `${origin}/path`, `${origin}?query=1`, `${origin}#hash`, 'not-a-url']) {
    await assert.rejects(startGitHubAppSetup(pool, actor, url, tokenKey), rejectsWith('github_setup_unavailable'));
  }
  assert.equal((await setupRows()).length, 0);
  const local = await startGitHubAppSetup(pool, actor, 'http://127.0.0.1:4311', tokenKey);
  assert.equal(JSON.parse(local.manifest).callback_urls[0], 'http://127.0.0.1:4311/github/callback');
});

const providerFailures: { name: string; response: () => Promise<Response> }[] = [
  { name: 'provider failure', response: async () => Response.json({ private_error: secret }, { status: 422 }) },
  { name: 'redirect response', response: async () => new Response(null, { status: 302, headers: { location: 'https://unexpected.example.invalid' } }) },
  { name: 'network exception', response: async () => { throw Error(`Synthetic network error ${secret}`); } },
  { name: 'malformed JSON', response: async () => new Response(`not-json-${secret}`, { status: 201 }) },
  { name: 'declared oversized response', response: async () => Response.json(app, { status: 201, headers: { 'content-length': '1000000' } }) },
  { name: 'streamed oversized response', response: async () => Response.json({ ...app, pem: 'x'.repeat(70000) }, { status: 201 }) },
  ...Object.entries({
    'wrong organization': { owner: { login: 'another-org', type: 'Organization' } },
    'personal owner': { owner: { login: 'FreeTWAI-AI', type: 'User' } },
    'wrong homepage': { external_url: 'https://unexpected.example.invalid' },
    'unsafe app URL': { html_url: 'https://github.com.evil.invalid/apps/freedom-workshop-fixture' },
    'wrong app slug URL': { html_url: 'https://github.com/apps/unrelated-app' },
    'insufficient starring permission': { permissions: { starring: 'read' } },
    'missing metadata permission': { permissions: { starring: 'write' } },
    'additional write permission': { permissions: { starring: 'write', contents: 'write' } },
    'metadata write permission': { permissions: { starring: 'write', metadata: 'write' } },
    'subscribed events': { events: ['push'] },
    'missing client secret': { client_secret: undefined },
    'unsafe app identifier': { id: Number.MAX_SAFE_INTEGER + 1 },
  }).map(([name, override]) => ({ name, response: async () => Response.json({ ...app, ...override }, { status: 201 }) })),
];
for (const scenario of providerFailures) test(`${scenario.name} leaves setup pending without storing credentials or leaking provider details`, async () => {
  const { state } = await start(), prior = await setupRows(), remote = provider(scenario.response);
  await assert.rejects(complete(state, remote), error => {
    assert.ok(rejectsWith('github_setup_provider_failed')(error)); assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secret)); assert.ok(!error.message.includes(app.pem)); return true;
  });
  assert.equal(remote.calls(), 1); assert.deepEqual(await setupRows(), prior);
  assert.equal(await readSocialConfig(pool, tokenKey), null); assert.deepEqual(await githubAppSetupStatus(pool, actor), { configured: false });
  assert.equal((await pool.query('SELECT count(*) FROM platform_admin_audit')).rows[0].count, '0');
});

test('a failed conversion can be retried and only a confirmed response completes setup', async () => {
  const { state } = await start();
  await assert.rejects(complete(state, provider(async () => Response.json({ message: 'temporary error' }, { status: 503 }))), rejectsWith('github_setup_provider_failed'));
  assert.equal((await setupRows())[0].consumed_at, null);
  assert.deepEqual(await complete(state), publicResult);
});

test('encrypted credentials reject a wrong key, tampering and swapped app metadata', async () => {
  const { state } = await start(); await complete(state);
  await assert.rejects(readSocialConfig(pool, randomBytes(32).toString('base64')), rejectsWith('github_setup_unavailable'));
  const initial = (await pool.query('SELECT * FROM github_social_apps')).rows[0];
  await pool.query("UPDATE github_social_apps SET client_id='Iv23.swapped-client'");
  await assert.rejects(readSocialConfig(pool, tokenKey), rejectsWith('github_setup_unavailable'));
  await pool.query('UPDATE github_social_apps SET client_id=$1,client_secret_encrypted=$2', [initial.client_id, initial.client_secret_encrypted.replace(/^v1\./, 'v2.')]);
  await assert.rejects(readSocialConfig(pool, tokenKey), rejectsWith('github_setup_unavailable'));
  await pool.query('UPDATE github_social_apps SET client_secret_encrypted=$1', [initial.client_secret_encrypted]);
  assert.equal((await readSocialConfig(pool, tokenKey))!.clientSecret, secret);
});

test('revocation holding the shared role lock is checked before any provider call', async () => {
  const { state } = await start(), remote = provider(), blocker = await pool.connect();
  let pending: ReturnType<typeof complete> | undefined;
  try {
    await blocker.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`admin-roles/${actor.community_id}`]);
    pending = complete(state, remote);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      blocked = !!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid)) AND wait_event='advisory'", [schema, pid])).rowCount;
      if (blocked) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(blocked); assert.equal(remote.calls(), 0);
    await blocker.query('UPDATE platform_admins SET active=false WHERE admin_id=$1', [actor.admin_id]); await blocker.query('COMMIT');
    await assert.rejects(pending, rejectsWith('admin_required'));
    assert.equal(remote.calls(), 0); assert.equal(await readSocialConfig(pool, tokenKey), null);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending?.catch(() => {}); }
});
