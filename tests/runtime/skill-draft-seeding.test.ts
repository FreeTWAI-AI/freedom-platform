import { test, before, after, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { MAX_ACTIVE_DRAFTS } from '../../modules/skill-submissions/limits.js';
import { listPublishedSkillSubmissions, readPublishedSkillSubmission } from '../../modules/skill-submissions/public.js';
import { repositoryKey } from '../../modules/skill-submissions/repository-match.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_skill_seed_test_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const app = createApp(pool, origin);

interface Session { cookie: string; csrf: string; user: any }
const PROJECT_RESPONSE_KEYS = [
  'aggregate_version', 'commercial_ready', 'community_id', 'created_at', 'current_version', 'current_version_id',
  'demo_url', 'description', 'official', 'owner_name', 'owner_ref', 'project_id', 'relationship', 'relationship_verification',
  'repository_full_name', 'repository_id', 'repository_url', 'status', 'title', 'updated_at', 'use_notes',
];

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
const uploadBody = (repositoryUrl: string) => ({
  repository_url: repositoryUrl, title: '共同筆記技能', description: '把會議紀錄整理成可重用的筆記。',
  use_notes: '先閱讀 README，再在自己的 fork 試用。', demo_url: null, relationship: 'author', share_introductions: intros(),
});
const registration = (repositoryUrl: string, title = '公共程式範例') => ({
  repository_url: repositoryUrl, title, description: '讓人整理共同筆記。', use_notes: '先閱讀 README，再建立自己的 fork。',
  demo_url: 'https://example.com/demo', relationship: 'author', consent_to_share: true,
});

function mockGitHub(t: TestContext, repos: Record<string, { id: number; full_name: string }>) {
  const sha = 'd'.repeat(40);
  const exact = new Map<string, { id: number; full_name: string }>();
  for (const [name, spec] of Object.entries(repos)) {
    exact.set(name, spec);
    exact.set(spec.full_name, spec);
  }
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
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
  return (await pool.query(`SELECT submission_id,status,origin_key_id,grant_hash,grant_key_id,grant_expires_at,grant_consumed_at,grant_revoked_at,
    source_project_id,seed,payload,aggregate_version,updated_at FROM skill_submissions ORDER BY created_at,submission_id`)).rows;
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

test('a new manual registration seeds one grant-less draft and keeps the import response', async t => {
  mockGitHub(t, { 'example/field-notes': { id: 9101, full_name: 'Example/Field-Notes' } });
  const owner = await login();
  const key = randomUUID();
  const created = await api('/opensource/projects', owner, registration('https://github.com/example/field-notes', '田野筆記'), undefined, key);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual(Object.keys(created.data).sort(), PROJECT_RESPONSE_KEYS);
  const stored = (await pool.query('SELECT project_id,title,description,use_notes,demo_url,relationship,repository_full_name FROM oss_projects')).rows[0];
  const [draft] = await drafts();
  assert.equal(draft.status, 'awaiting_upload');
  assert.equal(draft.origin_key_id, null);
  assert.equal(draft.grant_hash, null);
  assert.equal(draft.grant_key_id, null);
  assert.equal(draft.grant_expires_at, null);
  assert.equal(draft.grant_consumed_at, null);
  assert.equal(draft.source_project_id, stored.project_id);
  assert.deepEqual(draft.seed, {
    repository_url: 'https://github.com/' + stored.repository_full_name,
    title: stored.title, description: stored.description, use_notes: stored.use_notes,
    demo_url: stored.demo_url, relationship: stored.relationship,
  });
  const journal = (await pool.query(`SELECT data FROM transition_journal WHERE command='seed_from_manual_registration'`)).rows;
  assert.equal(journal.length, 1);
  assert.deepEqual(journal[0].data, { project_id: stored.project_id, repository_full_name: stored.repository_full_name });
  const replay = await api('/opensource/projects', owner, registration('https://github.com/example/field-notes', '田野筆記'), undefined, key);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.data, created.data);
  assert.equal((await drafts()).length, 1);
  assert.equal((await pool.query(`SELECT count(*) FROM transition_journal WHERE command='seed_from_manual_registration'`)).rows[0].count, '1');
  const listed = await api('/me/skill-submissions', owner);
  assert.equal(listed.status, 200);
  const item = listed.data.items[0];
  assert.deepEqual(item.seed, draft.seed);
  assert.equal(item.source_project_id, stored.project_id);
  assert.equal(item.catalog_book, null);
  const forbidden = ['grant_hash', 'token_hash', 'origin_key_id', 'grant_key_id', 'owner_ref', 'user_id', 'email', 'payload_sha256', 'image_bytes'];
  const text = JSON.stringify(listed.data);
  for (const field of forbidden) assert.equal(text.includes(`"${field}"`), false, field);
  assert.equal(text.includes(owner.user.user_id), false);
  assert.equal(text.includes(owner.user.email), false);
});

test('catalog books, an existing submission, and a full draft shelf do not get another seed', async t => {
  mockGitHub(t, {
    'Hao0321/pos-pro': { id: 9201, full_name: 'Hao0321/pos-pro' },
    'FreeTWAI-AI/pos-pro': { id: 9202, full_name: 'FreeTWAI-AI/pos-pro' },
    'example/open-notes': { id: 9203, full_name: 'example/open-notes' },
    'Example/Seed-Notes': { id: 9204, full_name: 'Example/Seed-Notes' },
    'example/seed-notes': { id: 9205, full_name: 'example/seed-notes' },
    'example/keeper': { id: 9206, full_name: 'example/keeper' },
    'example/published-notes': { id: 9207, full_name: 'example/published-notes' },
    'example/full-shelf': { id: 9208, full_name: 'example/full-shelf' },
  });
  const owner = await login();
  const member = await memberOf(owner);
  for (const url of ['https://github.com/Hao0321/pos-pro', 'https://github.com/FreeTWAI-AI/pos-pro']) {
    const created = await api('/opensource/projects', owner, registration(url));
    assert.equal(created.status, 201, url + ' ' + JSON.stringify(created.data));
  }
  assert.equal((await drafts()).length, 0, 'catalog upstream and fork urls do not seed');

  const key = (await api('/me/skill-upload-keys', owner, { label: '上傳' })).data;
  assert.equal(key.token.startsWith('fpk_'), true);
  const open = await agent('/skill-submissions', key.token, {});
  assert.equal(open.status, 201, JSON.stringify(open.data));
  const uploaded = await agent(`/skill-submissions/${open.data.submission.submission_id}`, open.data.upload_grant.token, uploadBody('https://github.com/Example/Open-Notes'));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const registeredOpen = await api('/opensource/projects', owner, registration('https://github.com/example/open-notes'));
  assert.equal(registeredOpen.status, 201, JSON.stringify(registeredOpen.data));
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions WHERE source_project_id IS NOT NULL')).rows[0].count, '0');

  const seeded = await api('/opensource/projects', owner, registration('https://github.com/Example/Seed-Notes'));
  assert.equal(seeded.status, 201, JSON.stringify(seeded.data));
  const again = await api('/opensource/projects', owner, registration('https://github.com/example/seed-notes'));
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.notEqual(again.data.project_id, seeded.data.project_id);
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions WHERE source_project_id IS NOT NULL')).rows[0].count, '1');

  const publishedKey = (await api('/me/skill-upload-keys', owner, { label: '公開' })).data;
  const publishedDraft = await agent('/skill-submissions', publishedKey.token, {});
  const publishedUpload = await agent(`/skill-submissions/${publishedDraft.data.submission.submission_id}`, publishedDraft.data.upload_grant.token, uploadBody('https://github.com/example/keeper'));
  assert.equal(publishedUpload.status, 200, JSON.stringify(publishedUpload.data));
  const current = (await api(`/me/skill-submissions/${publishedDraft.data.submission.submission_id}`, owner)).data;
  const published = await api(`/me/skill-submissions/${current.submission_id}/publish`, owner, { consent_to_share: true }, current.aggregate_version);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  await pool.query(`UPDATE skill_submissions SET payload=jsonb_set(payload,'{repository_url}','"https://github.com/Example/Published-Notes"') WHERE submission_id=$1`, [current.submission_id]);
  const registeredPublished = await api('/opensource/projects', owner, registration('https://github.com/example/published-notes'));
  assert.equal(registeredPublished.status, 201, JSON.stringify(registeredPublished.data));
  assert.equal((await pool.query(`SELECT count(*) FROM skill_submissions WHERE source_project_id=$1`, [registeredPublished.data.project_id])).rows[0].count, '0');

  const openCount = Number((await pool.query(`SELECT count(*) FROM skill_submissions WHERE owner_ref=$1 AND status IN ('awaiting_upload','ready_for_review')`, [member.user_id])).rows[0].count);
  const needed = MAX_ACTIVE_DRAFTS - openCount;
  assert.ok(needed > 0 && needed <= MAX_ACTIVE_DRAFTS);
  await pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref)
    SELECT unnest($1::uuid[]),$2,$3`, [Array.from({ length: needed }, () => randomUUID()), member.community_id, member.user_id]);
  assert.equal(Number((await pool.query(`SELECT count(*) FROM skill_submissions WHERE owner_ref=$1 AND status IN ('awaiting_upload','ready_for_review')`, [member.user_id])).rows[0].count), MAX_ACTIVE_DRAFTS);
  const before = (await pool.query('SELECT count(*) FROM skill_submissions')).rows[0].count;
  const full = await api('/opensource/projects', owner, registration('https://github.com/example/full-shelf'));
  assert.equal(full.status, 201, JSON.stringify(full.data));
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions')).rows[0].count, before);
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions WHERE source_project_id=$1', [full.data.project_id])).rows[0].count, '0');
});

test('a seeded draft accepts the same repository in another case and rejects a different one without consuming the grant', async t => {
  mockGitHub(t, {
    'example/notes': { id: 9301, full_name: 'example/notes' },
    'example/bound': { id: 9302, full_name: 'example/bound' },
  });
  const owner = await login();
  const notes = await api('/opensource/projects', owner, registration('https://github.com/example/notes'));
  const bound = await api('/opensource/projects', owner, registration('https://github.com/example/bound'));
  assert.equal(notes.status, 201, JSON.stringify(notes.data));
  assert.equal(bound.status, 201, JSON.stringify(bound.data));
  const rows = await drafts();
  const notesDraft = rows.find(row => row.source_project_id === notes.data.project_id);
  const boundDraft = rows.find(row => row.source_project_id === bound.data.project_id);
  const rotate = async (id: string, version: string) => {
    const granted = await api(`/me/skill-submissions/${id}/grant`, owner, {}, version);
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
    return granted.data.upload_grant.token as string;
  };
  const notesToken = await rotate(notesDraft.submission_id, String(notesDraft.aggregate_version));
  const same = await agent(`/skill-submissions/${notesDraft.submission_id}`, notesToken, uploadBody('https://github.com/Example/Notes'));
  assert.equal(same.status, 200, JSON.stringify(same.data));
  assert.equal(same.data.status, 'ready_for_review');
  const notesAfter = (await drafts()).find(row => row.submission_id === notesDraft.submission_id);
  assert.deepEqual(notesAfter.seed, notesDraft.seed);

  const boundToken = await rotate(boundDraft.submission_id, String(boundDraft.aggregate_version));
  const before = (await drafts()).find(row => row.submission_id === boundDraft.submission_id);
  const mismatch = await agent(`/skill-submissions/${boundDraft.submission_id}`, boundToken, uploadBody('https://github.com/example/different'));
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.data.code, 'repository_mismatch');
  assert.equal(mismatch.data.detail, '這份草稿是為 example/bound 建立的；請上傳同一個儲存庫的內容，或撤銷草稿後重新建立。');
  const after = (await drafts()).find(row => row.submission_id === boundDraft.submission_id);
  assert.equal(after.status, before.status);
  assert.equal(after.payload, null);
  assert.equal(after.grant_hash, before.grant_hash);
  assert.equal(after.grant_consumed_at, null);
  assert.equal(String(after.aggregate_version), String(before.aggregate_version));
  assert.equal(new Date(after.updated_at).toISOString(), new Date(before.updated_at).toISOString());
  const fixed = await agent(`/skill-submissions/${boundDraft.submission_id}`, boundToken, uploadBody('https://github.com/example/bound'));
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.equal(fixed.data.status, 'ready_for_review');
});

test('publishing a seeded draft reuses the registered project and lists it', async t => {
  mockGitHub(t, { 'example/shared-notes': { id: 9401, full_name: 'example/shared-notes' } });
  const owner = await login();
  const created = await api('/opensource/projects', owner, registration('https://github.com/example/shared-notes'));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const draft = (await drafts())[0];
  const granted = await api(`/me/skill-submissions/${draft.submission_id}/grant`, owner, {}, String(draft.aggregate_version));
  const uploaded = await agent(`/skill-submissions/${draft.submission_id}`, granted.data.upload_grant.token, uploadBody('https://github.com/example/shared-notes'));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const ready = (await api(`/me/skill-submissions/${draft.submission_id}`, owner)).data;
  const published = await api(`/me/skill-submissions/${draft.submission_id}/publish`, owner, { consent_to_share: true }, ready.aggregate_version);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.project_id, draft.source_project_id);
  assert.equal(published.data.source_project_id, draft.source_project_id);
  const listed = await listPublishedSkillSubmissions(pool);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].submission_id, draft.submission_id);
  const kept = (await drafts())[0];
  assert.deepEqual(kept.seed, draft.seed);
});

test('the shelf hides a published catalog repository but a direct read still returns it', async t => {
  mockGitHub(t, {
    'example/visible-book': { id: 9501, full_name: 'example/visible-book' },
    'Hao0321/pos-pro': { id: 9502, full_name: 'Hao0321/POS-PRO' },
    'FreeTWAI-AI/ai-security-scanner': { id: 9503, full_name: 'FREETWAI-AI/ai-security-scanner' },
  });
  const owner = await login();
  const key = (await api('/me/skill-upload-keys', owner, { label: '書架' })).data;
  async function publishRepo(url: string) {
    const draft = await agent('/skill-submissions', key.token, {});
    assert.equal(draft.status, 201, JSON.stringify(draft.data));
    const uploaded = await agent(`/skill-submissions/${draft.data.submission.submission_id}`, draft.data.upload_grant.token, uploadBody(url));
    assert.equal(uploaded.status, 200, url + ' ' + JSON.stringify(uploaded.data));
    const ready = (await api(`/me/skill-submissions/${draft.data.submission.submission_id}`, owner)).data;
    const published = await api(`/me/skill-submissions/${ready.submission_id}/publish`, owner, { consent_to_share: true }, ready.aggregate_version);
    assert.equal(published.status, 200, url + ' ' + JSON.stringify(published.data));
    return ready.submission_id as string;
  }
  const visible = await publishRepo('https://github.com/example/visible-book');
  const upstream = await publishRepo('https://github.com/Hao0321/pos-pro');
  const fork = await publishRepo('https://github.com/FreeTWAI-AI/ai-security-scanner');
  await pool.query(`UPDATE skill_submissions SET published_at=now()-interval '2 hours' WHERE submission_id=$1`, [visible]);
  await pool.query(`UPDATE skill_submissions SET published_at=now()-interval '1 hour' WHERE submission_id=$1`, [upstream]);
  const own = await api('/me/skill-submissions', owner);
  const upstreamView = own.data.items.find((item: any) => item.submission_id === upstream);
  assert.deepEqual(upstreamView.catalog_book, { book_id: 'pos-pro', title: 'POS Pro 商店工具', public_path: '/development/skills/pos-pro' });
  assert.equal(upstreamView.seed, null);
  assert.equal(upstreamView.source_project_id, null);
  const shelf = await listPublishedSkillSubmissions(pool);
  assert.deepEqual(shelf.map(item => item.submission_id), [visible]);
  const limited = await listPublishedSkillSubmissions(pool, 1);
  assert.deepEqual(limited.map(item => item.submission_id), [visible]);
  for (const id of [upstream, fork]) {
    const read = await readPublishedSkillSubmission(pool, id);
    assert.equal(read?.submission_id, id);
    assert.equal((await app.request(origin + `/development/submissions/${id}`)).status, 200);
  }
  const text = JSON.stringify(own.data);
  assert.equal(text.includes(owner.user.user_id), false);
  assert.equal(text.includes(owner.user.email), false);
  for (const field of ['grant_hash', 'origin_key_id', 'grant_key_id', 'owner_ref']) assert.equal(text.includes(`"${field}"`), false, field);
});

test('seed constraints reject a second open draft and a seed without a project', async t => {
  mockGitHub(t, { 'example/constraint-notes': { id: 9601, full_name: 'example/constraint-notes' } });
  const owner = await login();
  const member = await memberOf(owner);
  const created = await api('/opensource/projects', owner, registration('https://github.com/example/constraint-notes'));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const seed = JSON.stringify({ repository_url: 'https://github.com/example/constraint-notes', title: '另一份', description: '說明', use_notes: '用法', demo_url: null, relationship: 'author' });
  await assert.rejects(
    () => pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,source_project_id,seed) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [randomUUID(), member.community_id, member.user_id, created.data.project_id, seed]),
    (error: any) => { assert.equal(error.code, '23505'); assert.equal(error.constraint, 'skill_submissions_one_open_seed'); return true; },
  );
  await assert.rejects(
    () => pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,seed) VALUES($1,$2,$3,$4::jsonb)`,
      [randomUUID(), member.community_id, member.user_id, seed]),
    (error: any) => { assert.equal(error.code, '23514'); assert.equal(error.constraint, 'skill_submissions_seed_pair'); return true; },
  );
});
