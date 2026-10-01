import { test, before, after, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { MAX_ACTIVE_DRAFTS } from '../../modules/skill-submissions/limits.js';
import { listPublishedSkillSubmissions, readPublishedSkillSubmission, readPublishedSkillTitles } from '../../modules/skill-submissions/public.js';
import { repositoryKey } from '../../modules/skill-submissions/repository-match.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_skill_upgrade_test_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const app = createApp(pool, origin);

interface Session { cookie: string; csrf: string; user: { user_id: string; email: string } }

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); });

async function api(path: string, session?: Session, body?: unknown, version?: string | number, key: string = randomUUID()) {
  const headers: Record<string, string> = { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = `"${version}"`;
  }
  const response = await app.request(origin + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = response.headers.get('Content-Type') ?? '';
  return { status: response.status, data: type.includes('json') ? await response.json() as any : null, response };
}
async function agent(path: string, token: string, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  if (path === '/skill-submissions') headers['Idempotency-Key'] = randomUUID();
  const response = await app.request(origin + '/agent-api/v1' + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
async function login(email = DEMO_USERS[0].email): Promise<Session> {
  const r = await api('/auth/login', undefined, { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf_token, user: r.data.user };
}
const intros = () => Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 則介紹：這個技能幫助團隊整理共同筆記`);
const uploadBody = (repositoryUrl: string, title = '共同筆記技能') => ({
  repository_url: repositoryUrl, title, description: '把會議紀錄整理成可重用的筆記。',
  use_notes: '先閱讀 README，再在自己的 fork 試用。', demo_url: null, relationship: 'author', share_introductions: intros(),
});
const manualBody = (repositoryUrl: string, title: string) => ({
  repository_url: repositoryUrl, title, description: '把會議紀錄整理成可重用的筆記。',
  use_notes: '先閱讀 README，再在自己的 fork 試用。', demo_url: 'https://example.com/demo', relationship: 'curator',
});

function mockGitHub(t: TestContext, repos: Record<string, { id: number; full_name?: string }>) {
  const sha = 'd'.repeat(40);
  const exact = new Map<string, { id: number; full_name: string }>();
  for (const [name, spec] of Object.entries(repos)) {
    const full = spec.full_name ?? name;
    exact.set(name, { id: spec.id, full_name: full });
    exact.set(full, { id: spec.id, full_name: full });
  }
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert.equal(new URL(url).hostname, 'api.github.com');
    assert.equal(init?.redirect, 'manual');
    const repo = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/);
    if (!repo) throw new Error('unexpected url ' + url);
    const spec = exact.get(repo[1]);
    if (!spec) throw new Error('unexpected repo ' + repo[1]);
    if (!repo[2]) return Response.json({ id: spec.id, full_name: spec.full_name, private: false, visibility: 'public', default_branch: 'main', fork: false, archived: false });
    if (repo[2] === 'commits/main') return Response.json({ sha });
    if (repo[2] === `license?ref=${sha}`) return Response.json({ path: 'LICENSE', license: { spdx_id: 'MIT' } });
    throw new Error('unexpected url ' + url);
  });
  return { sha };
}

async function memberOf(session: Session) {
  return (await pool.query('SELECT community_id,user_id FROM users WHERE user_id=$1', [session.user.user_id])).rows[0] as { community_id: string; user_id: string };
}
async function drafts() {
  return (await pool.query(`SELECT submission_id,status,grant_hash,grant_consumed_at,upgrades_submission_id,seed,payload,aggregate_version,updated_at
    FROM skill_submissions ORDER BY created_at,submission_id`)).rows as any[];
}
async function publishManual(owner: Session, repositoryUrl: string, title: string) {
  const saved = await api('/me/skill-submissions/manual', owner, manualBody(repositoryUrl, title));
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const published = await api(`/me/skill-submissions/${saved.data.submission_id}/publish`, owner, { consent_to_share: true }, saved.data.aggregate_version);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  return published.data;
}
function assertNoSecrets(text: string, owner: Session) {
  for (const field of ['grant_hash', 'token_hash', 'origin_key_id', 'grant_key_id', 'owner_ref', 'user_id', 'email', 'payload_sha256', 'image_bytes']) {
    assert.equal(text.includes(`"${field}"`), false, field);
  }
  assert.equal(text.includes(owner.user.user_id), false);
  assert.equal(text.includes(owner.user.email), false);
}

test('repositoryKey keeps owner/repo and rejects anything else', () => {
  assert.equal(repositoryKey('https://github.com/Owner/Repo'), 'owner/repo');
  assert.equal(repositoryKey('https://github.com/Owner/Repo/'), 'owner/repo');
  assert.equal(repositoryKey('https://github.com/Owner/Repo.git'), 'owner/repo');
  assert.equal(repositoryKey('https://github.com/Owner/Repo.git/'), 'owner/repo');
  for (const url of [null, '', 'https://gitlab.com/Owner/Repo', 'https://github.com/Owner/Repo/tree/main', 'https://github.com/Owner/Repo?ref=1', 'http://github.com/Owner/Repo', 'https://user:pass@github.com/Owner/Repo']) {
    assert.equal(repositoryKey(url), null, String(url));
  }
});

test('only the owner can upgrade a published simple submission, and an open draft is reused', async t => {
  mockGitHub(t, {
    'example/field-notes': { id: 9101, full_name: 'example/field-notes' },
    'example/agent-book': { id: 9102, full_name: 'example/agent-book' },
  });
  const owner = await login();
  const other = await login(DEMO_USERS[1].email);
  const simple = await publishManual(owner, 'https://github.com/example/field-notes', '田野筆記');
  assert.equal(simple.can_upgrade, true);
  assert.equal(simple.manual, undefined);
  assert.equal(simple.seed, null);
  assert.equal(simple.upgrades_submission_id, null);
  assert.equal(simple.upgrade, null);
  assert.equal(simple.catalog_book, null);
  const unpublished = await api('/me/skill-submissions/manual', owner, manualBody('https://github.com/example/field-notes', '還沒公開'));
  assert.equal(unpublished.status, 201, JSON.stringify(unpublished.data));
  assert.equal((await api(`/me/skill-submissions/${unpublished.data.submission_id}/upgrade`, owner, {})).data.code, 'not_upgradable');
  assert.equal((await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, other, {})).status, 404);
  assert.equal((await api(`/me/skill-submissions/${randomUUID()}/upgrade`, owner, {})).status, 404);

  const key = (await api('/me/skill-upload-keys', owner, { label: '上傳' })).data;
  const agentDraft = await agent('/skill-submissions', key.token, {});
  const agentUpload = await agent(`/skill-submissions/${agentDraft.data.submission.submission_id}`, agentDraft.data.upload_grant.token, uploadBody('https://github.com/example/agent-book'));
  assert.equal(agentUpload.status, 200, JSON.stringify(agentUpload.data));
  const agentReady = (await api(`/me/skill-submissions/${agentDraft.data.submission.submission_id}`, owner)).data;
  const agentPublished = await api(`/me/skill-submissions/${agentReady.submission_id}/publish`, owner, { consent_to_share: true }, agentReady.aggregate_version);
  assert.equal(agentPublished.status, 200, JSON.stringify(agentPublished.data));
  const notManual = await api(`/me/skill-submissions/${agentPublished.data.submission_id}/upgrade`, owner, {});
  assert.equal(notManual.status, 409);
  assert.equal(notManual.data.code, 'not_upgradable');
  assert.equal(notManual.data.detail, '只有已公開的簡易投稿可以升級。');

  const idem = randomUUID();
  const created = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {}, undefined, idem);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.status, 'awaiting_upload');
  assert.equal(created.data.upgrades_submission_id, simple.submission_id);
  assert.equal(created.data.can_upgrade, false);
  assert.equal(created.data.can_edit, false);
  assert.equal(created.data.upgrade, null);
  assert.deepEqual(created.data.seed, {
    repository_url: 'https://github.com/example/field-notes', title: '田野筆記',
    description: '把會議紀錄整理成可重用的筆記。', use_notes: '先閱讀 README，再在自己的 fork 試用。',
    demo_url: 'https://example.com/demo', relationship: 'curator',
  });
  const replay = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {}, undefined, idem);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.data, created.data);
  const again = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {});
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.submission_id, created.data.submission_id);
  assert.equal((await pool.query(`SELECT count(*) FROM skill_submissions WHERE upgrades_submission_id=$1`, [simple.submission_id])).rows[0].count, '1');
  const journal = (await pool.query(`SELECT data FROM transition_journal WHERE command='seed_upgrade_from_simple_submission'`)).rows;
  assert.equal(journal.length, 1);
  assert.deepEqual(journal[0].data, { upgrades_submission_id: simple.submission_id, repository_url: 'https://github.com/example/field-notes' });
  const source = (await api(`/me/skill-submissions/${simple.submission_id}`, owner)).data;
  assert.deepEqual(source.upgrade, { submission_id: created.data.submission_id, status: 'awaiting_upload' });
  assert.equal(source.can_upgrade, false);
  const listed = await api('/me/skill-submissions', owner);
  assertNoSecrets(JSON.stringify(listed.data), owner);
  const revise = await api(`/me/skill-submissions/${created.data.submission_id}/manual`, owner, manualBody('https://github.com/example/field-notes', '不能改'), created.data.aggregate_version);
  assert.equal(revise.status, 409);
  assert.equal(revise.data.code, 'draft_not_editable');
});

test('a catalog book and a draft shelf at the limit do not create another upgrade', async t => {
  mockGitHub(t, {
    'Hao0321/pos-pro': { id: 9201, full_name: 'Hao0321/pos-pro' },
    'example/full-shelf': { id: 9202, full_name: 'example/full-shelf' },
  });
  const owner = await login();
  const member = await memberOf(owner);
  const catalog = await publishManual(owner, 'https://github.com/Hao0321/pos-pro', '收銀工具');
  assert.deepEqual(catalog.catalog_book, { book_id: 'pos-pro', title: 'POS Pro 商店工具', public_path: '/development/skills/pos-pro' });
  assert.equal(catalog.can_upgrade, false);
  const blocked = await api(`/me/skill-submissions/${catalog.submission_id}/upgrade`, owner, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'catalog_book_exists');
  assert.equal(blocked.data.detail, '這個儲存庫已收錄為技能書「POS Pro 商店工具」，不需要再升級。');
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions WHERE upgrades_submission_id IS NOT NULL')).rows[0].count, '0');

  const simple = await publishManual(owner, 'https://github.com/example/full-shelf', '滿架作品');
  await pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref)
    SELECT unnest($1::uuid[]),$2,$3`, [Array.from({ length: MAX_ACTIVE_DRAFTS }, () => randomUUID()), member.community_id, member.user_id]);
  const full = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {});
  assert.equal(full.status, 409);
  assert.equal(full.data.code, 'draft_limit');
  assert.equal(full.data.detail, `最多保留 ${MAX_ACTIVE_DRAFTS} 份未公開的技能草稿；請先公開或撤回不再需要的草稿。`);
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions WHERE upgrades_submission_id=$1', [simple.submission_id])).rows[0].count, '0');

  await pool.query(`DELETE FROM skill_submissions WHERE submission_id = (
    SELECT submission_id FROM skill_submissions WHERE owner_ref=$1 AND upgrades_submission_id IS NULL AND status='awaiting_upload' LIMIT 1)`, [member.user_id]);
  const opened = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {});
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  assert.equal(Number((await pool.query(`SELECT count(*) FROM skill_submissions WHERE owner_ref=$1 AND status IN ('awaiting_upload','ready_for_review')`, [member.user_id])).rows[0].count), MAX_ACTIVE_DRAFTS);
  const reused = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {});
  assert.equal(reused.status, 200, JSON.stringify(reused.data));
  assert.equal(reused.data.submission_id, opened.data.submission_id);
});

test('two upgrade requests at once create one draft', async t => {
  mockGitHub(t, { 'example/race-notes': { id: 9210, full_name: 'example/race-notes' } });
  const owner = await login();
  const simple = await publishManual(owner, 'https://github.com/example/race-notes', '同時升級');
  const [first, second] = await Promise.all([
    api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {}),
    api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {}),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 201], JSON.stringify([first.data, second.data]));
  assert.equal(first.data.submission_id, second.data.submission_id);
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions WHERE upgrades_submission_id=$1', [simple.submission_id])).rows[0].count, '1');
});

test('an upgrade draft rejects a different repository before the grant is consumed', async t => {
  mockGitHub(t, { 'example/bound': { id: 9301, full_name: 'example/bound' } });
  const owner = await login();
  const simple = await publishManual(owner, 'https://github.com/example/bound', '綁定作品');
  const created = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const granted = await api(`/me/skill-submissions/${created.data.submission_id}/grant`, owner, {}, created.data.aggregate_version);
  assert.equal(granted.status, 200, JSON.stringify(granted.data));
  const before = (await drafts()).find(row => row.submission_id === created.data.submission_id);
  const mismatch = await agent(`/skill-submissions/${created.data.submission_id}`, granted.data.upload_grant.token, uploadBody('https://github.com/example/different'));
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.data.code, 'repository_mismatch');
  assert.equal(mismatch.data.detail, '這份草稿是為 example/bound 建立的；請上傳同一個儲存庫的內容，或撤銷草稿後重新建立。');
  const after = (await drafts()).find(row => row.submission_id === created.data.submission_id);
  assert.equal(after.status, 'awaiting_upload');
  assert.equal(after.payload, null);
  assert.equal(after.grant_hash, before.grant_hash);
  assert.equal(after.grant_consumed_at, null);
  assert.equal(String(after.aggregate_version), String(before.aggregate_version));
  assert.equal(new Date(after.updated_at).toISOString(), new Date(before.updated_at).toISOString());
  const fixed = await agent(`/skill-submissions/${created.data.submission_id}`, granted.data.upload_grant.token, uploadBody('https://github.com/Example/Bound', '完整版筆記'));
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.equal(fixed.data.status, 'ready_for_review');
  const kept = (await drafts()).find(row => row.submission_id === created.data.submission_id);
  assert.deepEqual(kept.seed, created.data.seed);
});

test('publishing the upgrade replaces the simple submission until that full version is revoked', async t => {
  mockGitHub(t, { 'example/shared-notes': { id: 9401, full_name: 'example/shared-notes' } });
  const owner = await login();
  const member = await memberOf(owner);
  const simple = await publishManual(owner, 'https://github.com/example/shared-notes', '簡易筆記');
  const upgrade = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {});
  assert.equal(upgrade.status, 201, JSON.stringify(upgrade.data));
  const granted = await api(`/me/skill-submissions/${upgrade.data.submission_id}/grant`, owner, {}, upgrade.data.aggregate_version);
  const uploaded = await agent(`/skill-submissions/${upgrade.data.submission_id}`, granted.data.upload_grant.token, uploadBody('https://github.com/example/shared-notes', '完整筆記'));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const ready = (await api(`/me/skill-submissions/${upgrade.data.submission_id}`, owner)).data;
  const link = await api('/promotion/links', owner, { kind: 'skill_book', target: `submission:${simple.submission_id}` });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  assert.equal(link.data.title, '簡易筆記');
  const published = await api(`/me/skill-submissions/${upgrade.data.submission_id}/publish`, owner, { consent_to_share: true }, ready.aggregate_version);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.upgrades_submission_id, simple.submission_id);
  assert.equal(published.data.payload.title, '完整筆記');
  const source = (await api(`/me/skill-submissions/${simple.submission_id}`, owner)).data;
  assert.deepEqual(source.upgrade, { submission_id: published.data.submission_id, status: 'published' });
  assert.equal(source.can_upgrade, false);
  await pool.query(`UPDATE skill_submissions SET published_at=now() WHERE submission_id=$1`, [simple.submission_id]);
  await pool.query(`UPDATE skill_submissions SET published_at=now()-interval '1 hour' WHERE submission_id=$1`, [published.data.submission_id]);
  const shelf = await listPublishedSkillSubmissions(pool);
  assert.deepEqual(shelf.map(item => item.submission_id), [published.data.submission_id]);
  const limited = await listPublishedSkillSubmissions(pool, 1);
  assert.deepEqual(limited.map(item => item.submission_id), [published.data.submission_id]);
  assert.equal((await readPublishedSkillSubmission(pool, simple.submission_id))?.title, '簡易筆記');
  const titles = await readPublishedSkillTitles(pool, member.community_id, [simple.submission_id, published.data.submission_id]);
  assert.equal(titles.get(simple.submission_id), '簡易筆記');
  assert.equal(titles.get(published.data.submission_id), '完整筆記');
  for (const suffix of ['?intro=3', '/SKILL.md?intro=2'] as const) {
    const redirected = await app.request(origin + `/development/submissions/${simple.submission_id}${suffix}`);
    assert.equal(redirected.status, 302, suffix);
    assert.equal(redirected.headers.get('location'), `/development/submissions/${published.data.submission_id}${suffix}`);
  }
  const go = await app.request(`${origin}/go/${link.data.code}?intro=1`);
  assert.equal(go.status, 200);
  const html = await go.text();
  assert.match(html, new RegExp(`data-target="/development/submissions/${published.data.submission_id}\\?intro=1"`));
  assert.match(html, /完整筆記/);
  assert.match(html, /第 1 則介紹：這個技能幫助團隊整理共同筆記/);
  assert.equal(html.includes(`/development/submissions/${simple.submission_id}`), false);
  const again = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {});
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'already_upgraded');
  assert.equal(again.data.detail, '這件作品已升級成完整技能書。');

  await pool.query(`UPDATE skill_submissions SET status='revoked', revoked_at=now(), consent_to_share=false WHERE submission_id=$1`, [published.data.submission_id]);
  const restored = await app.request(origin + `/development/submissions/${simple.submission_id}?intro=3`);
  assert.equal(restored.status, 200);
  assert.match(await restored.text(), /簡易筆記/);
  const skill = await app.request(origin + `/development/submissions/${simple.submission_id}/SKILL.md?intro=2`);
  assert.equal(skill.status, 200);
  const after = await listPublishedSkillSubmissions(pool);
  assert.deepEqual(after.map(item => item.submission_id), [simple.submission_id]);
  const revived = (await api(`/me/skill-submissions/${simple.submission_id}`, owner)).data;
  assert.equal(revived.can_upgrade, true);
  assert.equal(revived.upgrade.status, 'revoked');
});

test('publishing a second upgrade of the same simple submission is already_upgraded', async t => {
  mockGitHub(t, { 'example/second-book': { id: 9410, full_name: 'example/second-book' } });
  const owner = await login();
  const member = await memberOf(owner);
  const simple = await publishManual(owner, 'https://github.com/example/second-book', '第二份');
  const upgrade = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {});
  const granted = await api(`/me/skill-submissions/${upgrade.data.submission_id}/grant`, owner, {}, upgrade.data.aggregate_version);
  const uploaded = await agent(`/skill-submissions/${upgrade.data.submission_id}`, granted.data.upload_grant.token, uploadBody('https://github.com/example/second-book', '完整第二份'));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const ready = (await api(`/me/skill-submissions/${upgrade.data.submission_id}`, owner)).data;
  const existing = (await pool.query(`SELECT project_id,project_version_id,payload,payload_sha256 FROM skill_submissions WHERE submission_id=$1`, [simple.submission_id])).rows[0];
  const publishedId = randomUUID();
  await pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,status,payload,payload_sha256,consent_to_share,project_id,project_version_id,published_at,grant_consumed_at,upgrades_submission_id,seed)
    VALUES($1,$2,$3,'published',$4,$5,true,$6,$7,now(),now(),$8,$9)`,
    [publishedId, member.community_id, member.user_id, JSON.stringify(existing.payload), existing.payload_sha256, existing.project_id, existing.project_version_id, simple.submission_id, JSON.stringify(upgrade.data.seed)]);
  const rejected = await api(`/me/skill-submissions/${ready.submission_id}/publish`, owner, { consent_to_share: true }, ready.aggregate_version);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
  assert.equal(rejected.data.code, 'already_upgraded');
  assert.equal(rejected.data.detail, '這件作品已升級成完整技能書。');
  const still = (await api(`/me/skill-submissions/${ready.submission_id}`, owner)).data;
  assert.equal(still.status, 'ready_for_review');
});

test('the shelf hides a published catalog repository but a direct read still returns it', async t => {
  mockGitHub(t, {
    'example/visible-book': { id: 9501, full_name: 'example/visible-book' },
    'Hao0321/pos-pro': { id: 9502, full_name: 'Hao0321/POS-PRO' },
    'FreeTWAI-AI/ai-security-scanner': { id: 9503, full_name: 'FREETWAI-AI/ai-security-scanner' },
  });
  const owner = await login();
  const visible = await publishManual(owner, 'https://github.com/example/visible-book', '看得到的作品');
  const upstream = await publishManual(owner, 'https://github.com/Hao0321/pos-pro', '收銀');
  const fork = await publishManual(owner, 'https://github.com/FreeTWAI-AI/ai-security-scanner', '掃描');
  await pool.query(`UPDATE skill_submissions SET published_at=now()-interval '2 hours' WHERE submission_id=$1`, [visible.submission_id]);
  await pool.query(`UPDATE skill_submissions SET published_at=now()-interval '1 hour' WHERE submission_id=$1`, [upstream.submission_id]);
  const shelf = await listPublishedSkillSubmissions(pool);
  assert.deepEqual(shelf.map(item => item.submission_id), [visible.submission_id]);
  const limited = await listPublishedSkillSubmissions(pool, 1);
  assert.deepEqual(limited.map(item => item.submission_id), [visible.submission_id]);
  for (const id of [upstream.submission_id, fork.submission_id]) {
    assert.equal((await readPublishedSkillSubmission(pool, id))?.submission_id, id);
    assert.equal((await app.request(origin + `/development/submissions/${id}`)).status, 200);
  }
  const own = await api('/me/skill-submissions', owner);
  const upstreamView = own.data.items.find((item: { submission_id: string }) => item.submission_id === upstream.submission_id);
  assert.deepEqual(upstreamView.catalog_book, { book_id: 'pos-pro', title: 'POS Pro 商店工具', public_path: '/development/skills/pos-pro' });
  assertNoSecrets(JSON.stringify(own.data), owner);
});

test('seed constraints reject a second open upgrade and a seed without a source', async t => {
  mockGitHub(t, { 'example/constraint-notes': { id: 9601, full_name: 'example/constraint-notes' } });
  const owner = await login();
  const member = await memberOf(owner);
  const simple = await publishManual(owner, 'https://github.com/example/constraint-notes', '限制作品');
  const created = await api(`/me/skill-submissions/${simple.submission_id}/upgrade`, owner, {});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const seed = JSON.stringify(created.data.seed);
  await assert.rejects(
    () => pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,upgrades_submission_id,seed) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [randomUUID(), member.community_id, member.user_id, simple.submission_id, seed]),
    (error: any) => { assert.equal(error.code, '23505'); assert.equal(error.constraint, 'skill_submissions_one_open_upgrade'); return true; },
  );
  await assert.rejects(
    () => pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,seed) VALUES($1,$2,$3,$4::jsonb)`,
      [randomUUID(), member.community_id, member.user_id, seed]),
    (error: any) => { assert.equal(error.code, '23514'); assert.equal(error.constraint, 'skill_submissions_seed_pair'); return true; },
  );
});
