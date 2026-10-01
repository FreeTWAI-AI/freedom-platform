import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createAdminAccessVerifier } from '../../modules/platform-admin/access.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_madmin_${process.pid}_${Date.now()}`;
const database = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'admin-route-tests';
const email = 'admin@example.invalid';
const adminId = randomUUID();
const pair = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey);
const verifier = createAdminAccessVerifier({ issuer, audience, csrfSecret: 'test-fixture-admin-csrf-secret-123456789', keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: 'admin-test', alg: 'RS256' }] }) });
const TOKEN = 'enc-token-do-not-return';
const SHA = 'd'.repeat(40);
let app = createApp(pool, origin, 'local', { adminVerifier: verifier });
let jwt = '';
let csrf = '';

before(async () => {
  await database.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await database.query(`DROP SCHEMA ${schema} CASCADE`);
  await database.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
  await pool.query('INSERT INTO platform_admins (admin_id, community_id, email, display_name) VALUES ($1,$2,$3,$4)', [adminId, DEMO_COMMUNITY, email, 'Verified Admin']);
  app = createApp(pool, origin, 'local', { adminVerifier: verifier });
  jwt = await sign(email);
  csrf = (await verifier(new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }))).csrfToken;
});
async function sign(claimedEmail: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', email: claimedEmail, sub: 'verified-human-fixture', iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 600 }).setProtectedHeader({ alg: 'RS256', kid: 'admin-test' }).sign(pair.privateKey);
}
async function request(path: string, body?: unknown, version?: number, key: string = randomUUID(), headers: Record<string, string> = {}) {
  const defaults: Record<string, string> = { Origin: origin, 'Cf-Access-Jwt-Assertion': jwt, 'X-Admin-CSRF': csrf, ...headers };
  if (body !== undefined) {
    defaults['Content-Type'] ??= 'application/json';
    defaults['Idempotency-Key'] = key;
    if (version !== undefined) defaults['If-Match'] = `"${version}"`;
  }
  const response = await app.request(origin + '/admin/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: defaults, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: response.status, data, response };
}
async function insertRepo() {
  const id = randomUUID();
  await pool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, next_sweep_at)
    VALUES ($1,$2,'9001','77','FreeTWAI-AI/freedom-platform','main','active','observe','2099-01-01T00:00:00Z')`, [id, DEMO_COMMUNITY]);
  return id;
}
async function insertPull(repository: string, number: number, queue: string, observed = '2026-09-30T00:00:00Z', state = 'open') {
  const id = randomUUID();
  await pool.query(`INSERT INTO maintainer_pull_requests (
    pull_id, repository_id, number, github_pull_id, title, html_url, state, is_draft, author_github_id, author_login, author_type,
    author_association, is_fork, head_sha, base_ref, base_sha, labels, additions, deletions, changed_files, github_created_at,
    github_updated_at, head_observed_at, attention_reasons, queue_state, queue_reasons, policy_version, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,false,'42','octocat','User','CONTRIBUTOR',false,$8,'main',$9,'{}',1,0,1,$10,$10,$11,'[]'::jsonb,$12,'[]'::jsonb,'2026-10-01.1',$10)`,
  [id, repository, number, String(800 + number), `PR ${number}`, `https://github.com/FreeTWAI-AI/freedom-platform/pull/${number}`, state, SHA, 'e'.repeat(40), '2026-09-30T00:00:00Z', observed, queue]);
  await pool.query(`INSERT INTO maintainer_pull_files (pull_id, path, status, additions, deletions) VALUES ($1,'README.md','modified',1,0)`, [id]);
  await pool.query(`INSERT INTO maintainer_reviews (pull_id, github_review_id, reviewer_github_id, reviewer_login, reviewer_type, reviewer_association, state, commit_id, submitted_at)
    VALUES ($1,'91','200','reviewer-gh','User','MEMBER','APPROVED',$2,'2026-09-30T01:00:00Z')`, [id, SHA]);
  return id;
}
async function connect(user = DEMO_USERS[0], github = '424242', login = 'maker-gh') {
  await pool.query(`INSERT INTO github_social_connections (user_id, community_id, github_user_id, github_login, encrypted_tokens)
    VALUES ($1,$2,$3,$4,$5)`, [user.user_id, DEMO_COMMUNITY, github, login, TOKEN]);
}
function quiet(value: unknown) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes('maker@local.test'), false);
  assert.equal(text.includes('BEGIN PRIVATE KEY'), false);
}

test('review center reads require the provisioned admin and hide secrets', async () => {
  const repository = await insertRepo();
  const earlier = await insertPull(repository, 1, 'awaiting_review', '2026-09-29T00:00:00Z');
  await insertPull(repository, 2, 'awaiting_review', '2026-09-30T00:00:00Z');
  const done = await insertPull(repository, 3, 'merged', '2026-09-30T01:00:00Z', 'closed');
  await pool.query(`UPDATE maintainer_pull_requests SET queue_state='merged', merged_at=now() WHERE pull_id=$1`, [done]);
  const anonymous = await request('/review-center/summary', undefined, undefined, randomUUID(), { 'Cf-Access-Jwt-Assertion': '' });
  assert.equal(anonymous.status, 401);
  const stranger = await request('/review-center/summary', undefined, undefined, randomUUID(), { 'Cf-Access-Jwt-Assertion': await sign('not-nominated@example.invalid') });
  assert.equal(stranger.status, 403);
  const summary = await request('/review-center/summary');
  assert.equal(summary.status, 200, JSON.stringify(summary.data));
  assert.equal(summary.data.policy_version, '2026-10-01.1');
  assert.equal(summary.data.counts.awaiting_review, 2);
  assert.equal(summary.data.counts.in_review, 0);
  assert.equal(summary.data.counts.merged, undefined);
  assert.equal(summary.data.repositories[0].mode, 'observe');
  assert.equal(summary.data.repositories[0].installation_id, undefined);
  const listed = await request('/review-center/pulls?queue=awaiting_review');
  assert.deepEqual(listed.data.items.map((item: { pull_id: string }) => item.pull_id), [earlier, (await pool.query(`SELECT pull_id FROM maintainer_pull_requests WHERE number=2`)).rows[0].pull_id]);
  assert.equal((await request('/review-center/pulls?queue=done')).data.items.length, 1);
  const detail = await request(`/review-center/pulls/${earlier}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.files[0].notes, []);
  assert.deepEqual(detail.data.attention_reasons, []);
  assert.equal(detail.data.reviews[0].is_current_head, true);
  assert.equal(detail.data.reviews[0].counts_as_valid, false);
  quiet(summary.data); quiet(listed.data); quiet(detail.data);
  assert.equal((await request('/review-center/pulls/' + randomUUID())).status, 404);
});

test('settings writes enforce csrf, idempotency, version and the phase-1a mode limit', async () => {
  const repository = await insertRepo();
  const open = await insertPull(repository, 1, 'awaiting_review');
  const closed = await insertPull(repository, 2, 'closed', '2026-09-30T00:00:00Z', 'closed');
  const path = `/review-center/repositories/${repository}/settings`;
  const body = { mode: 'off', settings: {}, reason: '先關閉觀察。' };
  assert.equal((await request(path, body, 1, randomUUID(), { 'X-Admin-CSRF': 'wrong' })).status, 403);
  assert.equal((await request(path, body, 1, randomUUID(), { Origin: 'https://evil.example' })).data.code, 'origin_rejected');
  assert.equal((await request(path, body, 1, 'short')).status, 400);
  assert.equal((await request(path, body)).status, 428);
  assert.equal((await request(path, body, undefined, randomUUID(), { 'If-Match': '1' })).data.code, 'invalid_version');
  assert.equal((await request(path, body, 9)).status, 412);
  const rejectedMode = await request(path, { mode: 'ai_review', settings: {}, reason: '想開自動審查' }, 1);
  assert.equal(rejectedMode.status, 422);
  assert.equal(rejectedMode.data.code, 'validation_failed');
  const blockedMode = 'merge';
  await assert.rejects(() => pool.query(`UPDATE maintainer_repositories SET mode=$2 WHERE repository_id=$1`, [repository, blockedMode]), (error: { code?: string }) => error.code === '23514');
  await assert.rejects(() => pool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode)
    VALUES ($1,$2,'9002','78','FreeTWAI-AI/mode-check','main','active',$3)`, [randomUUID(), DEMO_COMMUNITY, blockedMode]), (error: { code?: string }) => error.code === '23514');
  assert.equal((await request(path, { mode: 'observe', settings: { extra: true }, reason: '多了欄位' }, 1)).status, 422);
  assert.equal((await request(path, { mode: 'observe', settings: { sla_hours: 24 }, reason: '舊的時效欄位' }, 1)).status, 422);
  assert.equal((await request(path, { mode: 'observe', settings: { claim_hours: null }, reason: '空的時效' }, 1)).status, 422);
  assert.equal((await pool.query('SELECT count(*) FROM platform_admin_audit')).rows[0].count, '0');
  const key = randomUUID();
  const saved = await request(path, body, 1, key);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.mode, 'off');
  assert.equal(saved.data.settings.required_check, 'verify');
  assert.equal(saved.data.settings.claim_hours, null);
  assert.equal(saved.data.settings.sla_hours, undefined);
  assert.equal(saved.data.settings.rules_profile, 'freedom-platform');
  assert.equal(saved.data.aggregate_version, 2);
  assert.deepEqual((await request(path, body, 1, key)).data, saved.data);
  assert.equal((await request(path, { ...body, reason: '換一個理由' }, 1, key)).status, 409);
  assert.equal((await pool.query('SELECT aggregate_version FROM maintainer_repositories')).rows[0].aggregate_version, '2');
  const audit = (await pool.query(`SELECT action, before_state, after_state FROM platform_admin_audit`)).rows[0];
  assert.equal(audit.action, 'maintainer_repository_settings');
  assert.equal(audit.before_state.mode, 'observe');
  assert.equal(audit.after_state.mode, 'off');
  assert.equal(audit.after_state.settings.required_check, 'verify');
  assert.ok((await pool.query('SELECT recheck_at FROM maintainer_pull_requests WHERE pull_id=$1', [open])).rows[0].recheck_at);
  assert.equal((await pool.query('SELECT recheck_at FROM maintainer_pull_requests WHERE pull_id=$1', [closed])).rows[0].recheck_at, null);
  const resync = await request(`/review-center/pulls/${open}/resync`, {});
  assert.equal(resync.status, 200, JSON.stringify(resync.data));
  assert.equal(resync.data.enqueued, true);
  assert.equal((await request(`/review-center/pulls/${open}/resync`, {})).data.enqueued, false);
  const actions = (await pool.query(`SELECT action FROM platform_admin_audit ORDER BY created_at`)).rows.map(row => row.action);
  assert.deepEqual(actions, ['maintainer_repository_settings', 'maintainer_pull_resync', 'maintainer_pull_resync']);
  quiet(saved.data);
});

test('summary viewer status does not need a mirrored repository', async () => {
  const absent = (await request('/review-center/summary')).data.viewer;
  assert.equal(absent.can_self_claim, false);
  assert.equal(absent.status, 'no_member');
  assert.equal(absent.user_id, null);
  assert.equal(absent.github_login, null);
  assert.equal(absent.reason, '你的管理員 email 沒有對應的會員帳號，所以不能認領給自己；仍可以指派其他人。');
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_repositories')).rows[0].count, '0');

  const user = DEMO_USERS[0];
  await pool.query('UPDATE users SET email=$2, email_verified_at=NULL WHERE user_id=$1', [user.user_id, email]);
  const unverified = (await request('/review-center/summary')).data.viewer;
  assert.equal(unverified.can_self_claim, false);
  assert.equal(unverified.status, 'email_unverified');
  assert.equal(unverified.user_id, user.user_id);
  assert.equal(unverified.reason, '你的會員 email 還沒驗證（用會員登入頁的「忘記密碼」重設一次密碼即可完成驗證），所以不能認領給自己；仍可以指派其他人。');

  await pool.query('UPDATE users SET email_verified_at=now() WHERE user_id=$1', [user.user_id]);
  const unlinked = (await request('/review-center/summary')).data.viewer;
  assert.equal(unlinked.can_self_claim, false);
  assert.equal(unlinked.status, 'no_github');
  assert.equal(unlinked.github_login, null);
  assert.equal(unlinked.reason, '你的會員帳號還沒有連結 GitHub，所以不能認領給自己；仍可以指派其他人。');

  await connect(user, '424242', 'maker-gh');
  const ready = (await request('/review-center/summary')).data.viewer;
  assert.equal(ready.can_self_claim, true);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.reason, null);
  assert.equal(ready.user_id, user.user_id);
  assert.equal(ready.github_login, 'maker-gh');
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_repositories')).rows[0].count, '0');
});

test('a deadlock on repository ownership is a retryable 409', async () => {
  const repository = await insertRepo();
  const path = `/review-center/repositories/${repository}/ownership`;
  const body = { guild_key: null, scope_kind: 'module', open_to_guilds: false, skill_book_id: null, reason: '死結時不該留下歸屬。' };
  const key = randomUUID();
  await pool.query(`CREATE FUNCTION maintainer_ownership_deadlock_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$`);
  await pool.query('CREATE TRIGGER maintainer_ownership_deadlock_test BEFORE UPDATE ON maintainer_repositories FOR EACH ROW EXECUTE FUNCTION maintainer_ownership_deadlock_test()');
  try {
    const denied = await request(path, body, 1, key);
    assert.equal(denied.status, 409, JSON.stringify(denied.data));
    assert.equal(denied.data.code, 'maintainer_write_conflict');
    assert.match(denied.data.detail, /請重新整理後再試一次/);
    assert.equal((await pool.query('SELECT scope_kind FROM maintainer_repositories WHERE repository_id=$1', [repository])).rows[0].scope_kind, null);
    assert.equal((await pool.query('SELECT count(*) FROM platform_admin_receipts WHERE idempotency_key=$1', [key])).rows[0].count, '0');
    assert.equal((await pool.query('SELECT count(*) FROM maintainer_ownership_changes WHERE repository_id=$1', [repository])).rows[0].count, '0');
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS maintainer_ownership_deadlock_test ON maintainer_repositories');
    await pool.query('DROP FUNCTION IF EXISTS maintainer_ownership_deadlock_test()');
  }
  const saved = await request(path, body, 1, key);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.scope_kind, 'module');
});

test('the reviewer directory and repository ownership replace the roster', async () => {
  const repository = await insertRepo();
  const open = await insertPull(repository, 1, 'awaiting_review', '2026-09-29T00:00:00Z');
  const closed = await insertPull(repository, 2, 'closed', '2026-09-30T00:00:00Z', 'closed');
  await connect();
  await pool.query(`INSERT INTO positioning_profession_memberships (membership_id, community_id, user_id, guild_key, state)
    VALUES ($1,$2,$3,'guild_ai_vibe','active')`, [randomUUID(), DEMO_COMMUNITY, DEMO_USERS[0].user_id]);
  await pool.query(`INSERT INTO positioning_guild_officers (community_id, guild_key, user_id) VALUES ($1,'guild_ai_vibe',$2)`, [DEMO_COMMUNITY, DEMO_USERS[0].user_id]);
  const directory = await request('/review-center/reviewers');
  assert.equal(directory.status, 200, JSON.stringify(directory.data));
  quiet(directory.data);
  const adminRow = directory.data.admins.find((row: { admin_id: string }) => row.admin_id === adminId);
  assert.equal(adminRow.status, 'no_member');
  assert.equal(adminRow.github_login, null);
  const guild = directory.data.guilds.find((row: { guild_key: string }) => row.guild_key === 'guild_ai_vibe');
  assert.equal(guild.leader.display_name, '示範創作者');
  assert.equal(guild.leader.github_login, 'maker-gh');
  assert.equal(directory.data.open_repositories[0].repository_id, repository);
  assert.equal(directory.data.admin_only_repositories.length, 0);
  assert.ok(directory.data.guild_choices.some((row: { guild_key: string }) => row.guild_key === 'guild_platform_engineering'));
  assert.equal((await request('/review-center/reviewer-candidates?q=maker-gh')).status, 404);

  const path = `/review-center/repositories/${repository}/ownership`;
  const body = { guild_key: 'guild_ai_vibe', scope_kind: 'module', open_to_guilds: false, skill_book_id: null, reason: '這個儲存庫歸平台工程以外的開發公會。' };
  assert.equal((await request(path, body)).status, 428);
  assert.equal((await request(path, body, 9)).status, 412);
  assert.equal((await request(path, { ...body, guild_key: 'missing_guild', reason: '沒有這個公會' }, 1)).data.code, 'maintainer_guild_not_found');
  assert.equal((await request(path, { ...body, open_to_guilds: true, reason: '不能同時開放' }, 1)).data.code, 'maintainer_ownership_invalid');
  const saved = await request(path, body, 1);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.guild_key, 'guild_ai_vibe');
  assert.equal(saved.data.scope_kind, 'module');
  assert.equal(saved.data.open_to_guilds, false);
  assert.equal(saved.data.aggregate_version, 2);
  assert.equal((await request(path, body, 2)).data.code, 'maintainer_ownership_unchanged');
  const history = (await pool.query(`SELECT source, guild_key, scope_kind, open_to_guilds, changed_by_admin, reason FROM maintainer_ownership_changes WHERE repository_id=$1`, [repository])).rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].source, 'admin');
  assert.equal(history[0].changed_by_admin, adminId);
  assert.equal(history[0].guild_key, 'guild_ai_vibe');
  const audit = (await pool.query(`SELECT action, before_state, after_state FROM platform_admin_audit`)).rows[0];
  assert.equal(audit.action, 'maintainer_repository_ownership');
  assert.equal(audit.before_state.guild_key, null);
  assert.equal(audit.after_state.guild_key, 'guild_ai_vibe');
  assert.ok((await pool.query('SELECT recheck_at FROM maintainer_pull_requests WHERE pull_id=$1', [open])).rows[0].recheck_at);
  assert.equal((await pool.query('SELECT recheck_at FROM maintainer_pull_requests WHERE pull_id=$1', [closed])).rows[0].recheck_at, null);
  const listed = await request('/review-center/pulls?queue=open&guild_key=guild_ai_vibe');
  assert.equal(listed.data.items.some((item: { pull_id: string }) => item.pull_id === open), true);
  assert.equal((await request('/review-center/pulls?queue=open&guild_key=none')).data.items.length, 0);
  const detail = await request(`/review-center/pulls/${open}`);
  assert.equal(detail.data.ownership.guild_key, 'guild_ai_vibe');
  assert.equal(detail.data.ownership.history[0].source, 'admin');
  assert.equal(detail.data.ownership.history[0].reason, body.reason);
  quiet(saved.data);
  quiet(detail.data);
});

test('ownership records a catalog skill book and rejects an unknown or taken id', async () => {
  const repository = await insertRepo();
  const other = randomUUID();
  await pool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, next_sweep_at)
    VALUES ($1,$2,'9002','77','FreeTWAI-AI/other-book','main','active','observe','2099-01-01T00:00:00Z')`, [other, DEMO_COMMUNITY]);
  const path = `/review-center/repositories/${repository}/ownership`;
  const unknown = { guild_key: null, scope_kind: 'skill_book', open_to_guilds: true, skill_book_id: 'not-a-book', reason: '這本不在目錄裡。' };
  assert.equal((await request(path, unknown, 1)).data.code, 'maintainer_skill_book_invalid');
  const wrongScope = { guild_key: null, scope_kind: 'module', open_to_guilds: true, skill_book_id: 'career-guide', reason: '類型不是技能書。' };
  assert.equal((await request(path, wrongScope, 1)).data.code, 'maintainer_skill_book_invalid');
  const body = { guild_key: null, scope_kind: 'skill_book', open_to_guilds: true, skill_book_id: 'career-guide', reason: '這是方向探索技能書的工坊。' };
  const saved = await request(path, body, 1);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.skill_book_id, 'career-guide');
  assert.equal(saved.data.scope_kind, 'skill_book');
  const history = (await pool.query(`SELECT skill_book_id, scope_kind, source FROM maintainer_ownership_changes WHERE repository_id=$1`, [repository])).rows[0];
  assert.equal(history.skill_book_id, 'career-guide');
  assert.equal(history.scope_kind, 'skill_book');
  assert.equal(history.source, 'admin');
  const taken = await request(`/review-center/repositories/${other}/ownership`, { ...body, reason: '這本書已經對到另一個儲存庫。' }, 1);
  assert.equal(taken.status, 409, JSON.stringify(taken.data));
  assert.equal(taken.data.code, 'maintainer_skill_book_taken');
});
