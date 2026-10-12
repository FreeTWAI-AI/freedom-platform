import {test, before, after, beforeEach, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {communityCatalog} from '../../modules/community/catalog.js';
import {historyRepositories} from '../../modules/community/github-history.js';

// This suite requires an explicitly provisioned disposable database; no default database discovery.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL must name a disposable test database.');
const origin = 'http://127.0.0.1:4310';
const schema = `fp_oss_book_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12});
const app = createApp(pool, origin);
interface Session {cookie: string; csrf: string; user: {user_id: string; email: string}}
before(async () => {await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);});
after(async () => {await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();});
beforeEach(async () => {await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool);});

async function api(path: string, session?: Session, body?: unknown, version?: string | number, key = randomUUID()) {
  const headers: Record<string, string> = {Origin: origin, ...(session ? {Cookie: session.cookie, 'X-CSRF-Token': session.csrf} : {})};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = `"${version}"`;
  }
  const response = await app.request(origin + '/api/v1' + path, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json() as any, response};
}
async function login(email = DEMO_USERS[0].email): Promise<Session> {
  const result = await api('/auth/login', undefined, {email, password: DEMO_PASSWORD});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return {cookie: result.response.headers.get('set-cookie')!.split(';')[0], csrf: result.data.csrf_token, user: result.data.user};
}
function github(t: TestContext, repository = 'example/legacy-tool', license = 'MIT') {
  const sha = 'd'.repeat(40), seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); seen.push(url);
    assert.equal(new URL(url).hostname, 'api.github.com'); assert.equal(init?.redirect, 'manual');
    const base = `https://api.github.com/repos/${repository}`;
    if (url === base) return Response.json({id: 777, full_name: repository, private: false, visibility: 'public', default_branch: 'main', fork: false, archived: false});
    if (url === `${base}/commits/main`) return Response.json({sha});
    if (url === `${base}/license?ref=${sha}`) return license === 'NOASSERTION'
      ? Response.json({message: 'Not Found'}, {status: 404}) : Response.json({path: 'LICENSE', license: {spdx_id: license}});
    throw new Error(`Unexpected GitHub fixture request: ${url}`);
  });
  return {sha, seen};
}
const metadata = (repository = 'example/legacy-tool') => ({repository_url: `https://github.com/${repository}`, title: '既有共同筆記工具', description: '將會議筆記整理成可重用的工作紀錄。', use_notes: '先閱讀原作者 README，再以合成資料練習。', demo_url: null, relationship: 'curator'});
async function registered(owner: Session, repository?: string) {
  const result = await api('/opensource/projects', owner, {...metadata(repository), consent_to_share: true});
  assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
}
async function prepare(owner: Session, project: any, key = randomUUID()) {
  return api(`/opensource/projects/${project.project_id}/skill-submission`, owner, {}, project.aggregate_version, key);
}
function expectPrepared(result: Awaited<ReturnType<typeof api>>) {
  assert.ok(result.status === 200 || result.status === 201, JSON.stringify(result.data));
  assert.ok(result.data.submission); return result.data.submission;
}
async function listed(session: Session, id: string) {
  const result = await api('/opensource/projects', session); assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.items.find((item: any) => item.project_id === id);
}
function minimalProjection(value: any) {
  assert.deepEqual(Object.keys(value).sort(), ['can_edit', 'catalog_book', 'public_path', 'status', 'submission_id']);
  for (const field of ['payload', 'grant_hash', 'upload_grant', 'owner_ref', 'seed', 'grant_expires_at']) assert.equal(field in value, false);
}
async function publish(owner: Session, draft: any) {
  const result = await api(`/me/skill-submissions/${draft.submission_id}/publish`, owner, {consent_to_share: true}, draft.aggregate_version);
  assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
}

test('legacy OSS project becomes a private one-introduction draft, then explicit owner consent publishes its existing source', async t => {
  const source = github(t, undefined, 'NOASSERTION'), owner = await login(), project = await registered(owner);
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions')).rows[0].count, '0');
  assert.equal((await listed(owner, project.project_id)).skill_book, null);
  const result = await prepare(owner, project), draft = expectPrepared(result);
  assert.equal(result.data.created, true); assert.equal(result.data.catalog_book, null);
  assert.equal(draft.status, 'ready_for_review'); assert.equal(draft.public_path, null); assert.equal(draft.can_edit, true);
  assert.equal(draft.payload.share_introductions.length, 1); assert.equal(draft.grant_expires_at, null);
  for (const [key, value] of Object.entries(metadata())) assert.deepEqual(draft.payload[key], value);
  assert.equal(source.seen.length, 3, 'draft preparation must not fetch GitHub or implicitly publish');
  const stored = (await pool.query('SELECT consent_to_share,grant_hash,project_id FROM skill_submissions WHERE submission_id=$1', [draft.submission_id])).rows[0];
  assert.equal(stored.consent_to_share, false); assert.equal(stored.grant_hash, null);
  assert.deepEqual((await api('/skill-submissions/published')).data.items, []);
  assert.equal((await api(`/me/skill-submissions/${draft.submission_id}/publish`, owner, {consent_to_share: false}, draft.aggregate_version)).status, 422);
  const ownBook = (await listed(owner, project.project_id)).skill_book;
  minimalProjection(ownBook); assert.equal(ownBook.submission_id, draft.submission_id); assert.equal(ownBook.public_path, null);
  const published = await publish(owner, draft);
  assert.equal(published.project_id, project.project_id); assert.equal(source.seen.length, 6);
  assert.equal((await pool.query('SELECT count(*) FROM oss_projects')).rows[0].count, '1');
  const publicItem = (await api(`/skill-submissions/${draft.submission_id}`)).data;
  assert.equal(publicItem.source.commit_sha, source.sha); assert.equal(publicItem.source.license_spdx, 'NOASSERTION');
  assert.equal(publicItem.official, false); assert.equal(publicItem.relationship, 'curator'); assert.equal(publicItem.relationship_verification, 'self_declared');
  const publicBook = (await listed(owner, project.project_id)).skill_book;
  minimalProjection(publicBook); assert.equal(publicBook.status, 'published'); assert.equal(publicBook.public_path, published.public_path);
});

test('new keys, retries and simultaneous preparations reuse one draft and never overwrite the owner edits', async t => {
  github(t); const owner = await login(), project = await registered(owner), key = randomUUID();
  const results = await Promise.all([prepare(owner, project, key), prepare(owner, project), prepare(owner, project)]);
  const drafts = results.map(expectPrepared); assert.equal(new Set(drafts.map(draft => draft.submission_id)).size, 1);
  assert.equal(results.filter(result => result.data.created).length, 1);
  const draft = drafts[0];
  const revision = await api(`/me/skill-submissions/${draft.submission_id}/manual`, owner, {...metadata(), title: '本人修改尚未公開的標題'}, draft.aggregate_version);
  assert.equal(revision.status, 200, JSON.stringify(revision.data));
  const reused = await prepare(owner, project); assert.equal(reused.data.created, false);
  assert.equal(expectPrepared(reused).payload.title, '本人修改尚未公開的標題');
  assert.equal(expectPrepared(reused).aggregate_version, revision.data.aggregate_version);
  const replay = await prepare(owner, project, key); assert.equal(expectPrepared(replay).submission_id, draft.submission_id);
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions')).rows[0].count, '1');
});

test('published submission is reused ahead of a later draft for the same canonical repository', async t => {
  github(t); const owner = await login(), project = await registered(owner);
  const manual = await api('/me/skill-submissions/manual', owner, {...metadata(), repository_url: 'https://github.com/example/legacy-tool.git/'});
  assert.equal(manual.status, 201, JSON.stringify(manual.data)); const published = await publish(owner, manual.data);
  const later = await api('/me/skill-submissions/manual', owner, {...metadata(), title: '另一份未公開草稿'});
  assert.equal(later.status, 201);
  const result = await prepare(owner, await listed(owner,project.project_id)); assert.equal(result.data.created, false);
  assert.equal(expectPrepared(result).submission_id, published.submission_id); assert.equal(expectPrepared(result).status, 'published');
  assert.equal((await listed(owner, project.project_id)).skill_book.submission_id, published.submission_id);
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions')).rows[0].count, '2');
});

test('revoked draft is not resurrected and a new preparation starts a private draft', async t => {
  github(t); const owner = await login(), project = await registered(owner), first = expectPrepared(await prepare(owner, project));
  const revoked = await api(`/me/skill-submissions/${first.submission_id}/revoke`, owner, {}, first.aggregate_version);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const result = await prepare(owner, project), next = expectPrepared(result);
  assert.equal(result.data.created, true); assert.notEqual(next.submission_id, first.submission_id); assert.equal(next.status, 'ready_for_review');
  assert.equal((await api(`/me/skill-submissions/${first.submission_id}`, owner)).data.status, 'revoked');
  assert.deepEqual((await api('/skill-submissions/published')).data.items, []);
});

test('static catalog match returns its genuine book link and never creates a duplicate submission', async t => {
  const book = communityCatalog.skill_books.find(book => /^https:\/\/github.com\/[^/]+\/[^/]+$/.test(book.repository_url))!;
  const repository = new URL(book.repository_url).pathname.slice(1); github(t, repository);
  const owner = await login(), project = await registered(owner, repository), result = await prepare(owner, project);
  assert.ok(result.status === 200 || result.status === 201, JSON.stringify(result.data));
  assert.equal(result.data.created, false); assert.equal(result.data.submission, null);
  assert.equal(result.data.catalog_book.book_id, book.id); assert.equal(result.data.catalog_book.public_path, `/development/skills/${book.id}`);
  const projection = (await listed(owner, project.project_id)).skill_book; minimalProjection(projection);
  assert.equal(projection.catalog_book.book_id, book.id); assert.equal((await pool.query('SELECT count(*) FROM skill_submissions')).rows[0].count, '0');
});

test('foreign viewers cannot see private draft metadata or prepare a book; published links are safe projections', async t => {
  github(t); const owner = await login(), other = await login(DEMO_USERS[1].email), project = await registered(owner);
  const draft = expectPrepared(await prepare(owner, project));
  assert.equal((await listed(other, project.project_id)).skill_book, null);
  assert.equal((await prepare(other, project)).status, 404);
  assert.equal((await api(`/me/skill-submissions/${draft.submission_id}`, other)).status, 404);
  const published = await publish(owner, draft), projection = (await listed(other, project.project_id)).skill_book;
  minimalProjection(projection); assert.equal(projection.status, 'published'); assert.equal(projection.public_path, published.public_path);
  assert.equal(projection.can_edit, false); assert.equal((await prepare(other, project)).status, 404);
});

test('cross-community project IDs and private submissions remain isolated', async t => {
  github(t); const owner = await login(), project = await registered(owner); expectPrepared(await prepare(owner, project));
  const community = randomUUID(), user = randomUUID(), email = 'other-community@example.invalid';
  await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Other community']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,$2,$3,'Other community member',password_hash,$4,false FROM users LIMIT 1`, [user, community, email, randomUUID()]);
  const other = await login(email);
  assert.equal((await listed(other, project.project_id)), undefined); assert.equal((await prepare(other, project)).status, 404);
  assert.equal((await api('/me/skill-submissions', other)).data.items.length, 0);
});

test('preparation enforces project CAS, strict empty input, session and CSRF before creating anything', async t => {
  github(t); const owner = await login(), project = await registered(owner), path = `/opensource/projects/${project.project_id}/skill-submission`;
  assert.equal((await api(path, owner, {}, Number(project.aggregate_version) + 1)).status, 412);
  assert.equal((await api(path, owner, {})).status, 428);
  assert.equal((await api(path, undefined, {}, project.aggregate_version)).status, 401);
  assert.equal((await api(path, {...owner, csrf: 'wrong'}, {}, project.aggregate_version)).status, 403);
  for (const body of [{consent_to_share: true}, {official: true}, {owner_ref: DEMO_USERS[1].user_id}, {title: 'overwrite'}])
    assert.equal((await api(path, owner, body, project.aggregate_version)).status, 422);
  assert.equal((await pool.query('SELECT count(*) FROM skill_submissions')).rows[0].count, '0');
  expectPrepared(await prepare(owner, project));
});

test('deactivation and incomplete onboarding remove published skill links and prevent preparation', async t => {
  github(t); const owner = await login(), other = await login(DEMO_USERS[1].email), project = await registered(owner);
  const published = await publish(owner, expectPrepared(await prepare(owner, project)));
  await pool.query('UPDATE users SET active=false WHERE user_id=$1', [owner.user.user_id]);
  assert.equal((await listed(other, project.project_id))?.skill_book ?? null, null);
  assert.equal((await api(`/skill-submissions/${published.submission_id}`)).status, 404);
  assert.equal((await prepare(owner, project)).status, 401);
  await pool.query('UPDATE users SET active=true,onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [owner.user.user_id]);
  assert.equal((await listed(other, project.project_id))?.skill_book ?? null, null);
  assert.equal((await api(`/skill-submissions/${published.submission_id}`)).status, 404);
  assert.equal((await prepare(owner, project)).status, 403);
});

test('an existing manual draft found by canonical repository is reused without altering content', async t => {
  github(t); const owner = await login(), project = await registered(owner);
  const manual = await api('/me/skill-submissions/manual', owner, {...metadata(), repository_url: 'https://github.com/EXAMPLE/legacy-tool.git/', title: '之前獨立儲存的私人草稿'});
  assert.equal(manual.status, 201, JSON.stringify(manual.data));
  const result = await prepare(owner, project), draft = expectPrepared(result);
  assert.equal(result.data.created, false); assert.equal(draft.submission_id, manual.data.submission_id);
  assert.equal(draft.payload.title, manual.data.payload.title); assert.equal(draft.aggregate_version, manual.data.aggregate_version);
});

test('an awaiting-upload upgrade keeps its seeded identity and does not turn into a new manual draft', async t => {
  github(t); const owner = await login(), project = await registered(owner);
  const first = await publish(owner, expectPrepared(await prepare(owner, await listed(owner,project.project_id))));
  const upgrade = await api(`/me/skill-submissions/${first.submission_id}/upgrade`, owner, {});
  assert.equal(upgrade.status, 201, JSON.stringify(upgrade.data));
  // Simulate operator withdrawal of the original public book; the retained private upgrade is still the owner's work.
  await pool.query("UPDATE skill_submissions SET status='revoked',consent_to_share=false,revoked_at=now() WHERE submission_id=$1", [first.submission_id]);
  const result = await prepare(owner, await listed(owner,project.project_id)), draft = expectPrepared(result);
  assert.equal(result.data.created, false); assert.equal(draft.submission_id, upgrade.data.submission_id);
  assert.equal(draft.status, 'awaiting_upload'); assert.deepEqual(draft.seed, upgrade.data.seed);
  assert.equal(draft.payload, null); assert.equal(draft.can_edit, false);
  const projection = (await listed(owner, project.project_id)).skill_book;
  minimalProjection(projection); assert.equal(projection.status, 'awaiting_upload'); assert.equal(projection.can_edit, false);
});

test('verification accounts and withdrawn publication never leak a skill-book link through project cards', async t => {
  github(t); const owner = await login(), other = await login(DEMO_USERS[1].email), project = await registered(owner);
  const published = await publish(owner, expectPrepared(await prepare(owner, project)));
  await pool.query('UPDATE users SET email=$2 WHERE user_id=$1', [owner.user.user_id, 'book-fixture@example.invalid']);
  assert.equal((await listed(other, project.project_id)), undefined);
  assert.equal((await api(`/skill-submissions/${published.submission_id}`)).status, 404);
  await pool.query('UPDATE users SET email=$2 WHERE user_id=$1', [owner.user.user_id, owner.user.email]);
  await pool.query("UPDATE skill_submissions SET status='revoked',consent_to_share=false,revoked_at=now() WHERE submission_id=$1", [published.submission_id]);
  assert.equal((await listed(other, project.project_id)).skill_book, null);
  assert.equal((await api(`/skill-submissions/${published.submission_id}`)).status, 404);
});

test('independent registrations of the same repository never borrow another owner book or private draft', async t => {
  github(t); const owner = await login(), other = await login(DEMO_USERS[1].email);
  const ownProject = await registered(owner), otherProject = await registered(other);
  const published = await publish(owner, expectPrepared(await prepare(owner, ownProject)));
  assert.equal((await listed(other, otherProject.project_id)).skill_book, null);
  const otherDraft = expectPrepared(await prepare(other, otherProject));
  assert.notEqual(otherDraft.submission_id, published.submission_id); assert.equal(otherDraft.status, 'ready_for_review');
  assert.equal((await listed(owner, otherProject.project_id)).skill_book, null);
  assert.equal((await listed(other, ownProject.project_id)).skill_book.submission_id, published.submission_id);
});

test('a publication whose stored version no longer belongs to its project is omitted from project-book links', async t => {
  github(t); const owner = await login(), other = await login(DEMO_USERS[1].email);
  const project = await registered(owner), otherProject = await registered(other);
  const published = await publish(owner, expectPrepared(await prepare(owner, project)));
  // A synthetically mismatched retained pin must not resolve via the mutable current_version instead.
  await pool.query('UPDATE skill_submissions SET project_version_id=$2 WHERE submission_id=$1', [published.submission_id, otherProject.current_version.version_id]);
  assert.equal((await listed(other, project.project_id)).skill_book, null);
  assert.equal((await api(`/skill-submissions/${published.submission_id}`)).status, 404);
});

test('owner withdraws the whole work, retains private editing, and explicitly republishes on a new link', async t => {
  github(t); const owner=await login(), other=await login(DEMO_USERS[1].email);
  const original=await registered(owner), book=await publish(owner,expectPrepared(await prepare(owner,original)));
  let project=await listed(owner,original.project_id);
  const path=`/opensource/projects/${project.project_id}/withdraw`;
  assert.equal((await api(path,other,{},project.aggregate_version)).status,404);
  assert.equal((await api(path,undefined,{},project.aggregate_version)).status,401);
  assert.equal((await api(path,{...owner,csrf:'wrong'},{},project.aggregate_version)).status,403);
  assert.equal((await api(path,owner,{},original.aggregate_version)).status,412);
  const key=randomUUID(), withdrawn=await api(path,owner,{},project.aggregate_version,key);
  assert.equal(withdrawn.status,200,JSON.stringify(withdrawn.data));
  assert.deepEqual(Object.keys(withdrawn.data).sort(),['aggregate_version','project_id','sharing_withdrawn']);
  assert.deepEqual((await api(path,owner,{},project.aggregate_version,key)).data,withdrawn.data);
  assert.equal(await listed(other,project.project_id),undefined);
  project=await listed(owner,project.project_id);
  assert.ok(project.sharing_withdrawn_at);assert.equal(project.skill_book,null);
  const managed=await api(`/opensource/projects/${project.project_id}`,owner);
  assert.equal(managed.status,200);assert.equal(managed.data.project_id,project.project_id);
  assert.equal(managed.response.headers.get('cache-control'),'no-store');
  assert.equal((await api(`/opensource/projects/${project.project_id}`,other)).status,404);
  assert.equal((await api(`/opensource/projects/${project.project_id}`)).status,401);
  for(const route of [`/skill-submissions/${book.submission_id}`,`/skill-submissions/${book.submission_id}/share-content`]) {
    const missing=await api(route);assert.equal(missing.status,404);assert.equal(missing.response.headers.get('cache-control'),'no-store');
  }
  for(const route of [book.public_path,`${book.public_path}/SKILL.md`,`/api/v1/skill-submissions/${book.submission_id}/illustration`]) {
    const missing=await app.request(origin+route);assert.equal(missing.status,404);assert.equal(missing.headers.get('cache-control'),'no-store');
  }
  assert.deepEqual((await api('/skill-submissions/published')).data.items,[]);
  assert.equal((await api(`/me/skill-submissions/${book.submission_id}`,owner)).data.status,'revoked');
  const hidden=await api(`/opensource/projects/${project.project_id}:revise`,owner,{title:'只給自己的修改',description:'尚未重新同意公開',use_notes:'先本機試用',demo_url:null},project.aggregate_version);
  assert.equal(hidden.status,200,JSON.stringify(hidden.data));assert.ok(hidden.data.sharing_withdrawn_at);
  assert.equal(await listed(other,project.project_id),undefined);
  const nextDraft=expectPrepared(await prepare(owner,hidden.data));
  assert.equal(nextDraft.payload.title,'只給自己的修改');
  assert.equal(await listed(other,project.project_id),undefined,'preparing a draft cannot restore visibility');
  const next=await publish(owner,nextDraft);
  assert.notEqual(next.submission_id,book.submission_id);
  assert.equal(next.project_id,project.project_id);
  assert.equal((await api(`/skill-submissions/${next.submission_id}`)).data.title,'只給自己的修改');
  assert.equal((await app.request(origin+book.public_path)).status,404,'withdrawn old links stay closed after republishing');
  assert.equal((await listed(other,project.project_id)).sharing_withdrawn_at,null);
  assert.equal((await api(path,owner,{},hidden.data.aggregate_version)).status,412,'new publication invalidates the old project version');
});

test('republishing cannot overwrite a newer private edit and recovers through a newly prepared draft', async t => {
  github(t); const owner=await login(),other=await login(DEMO_USERS[1].email);
  const original=await registered(owner),book=await publish(owner,expectPrepared(await prepare(owner,original)));
  let project=await listed(owner,original.project_id);
  const withdrawn=await api(`/opensource/projects/${project.project_id}/withdraw`,owner,{},project.aggregate_version);
  assert.equal(withdrawn.status,200,JSON.stringify(withdrawn.data));
  project=await listed(owner,project.project_id);
  const staleDraft=expectPrepared(await prepare(owner,project));
  const revised=await api(`/opensource/projects/${project.project_id}:revise`,owner,
    {title:'另一分頁保存的新標題',description:'這些私人修改不能被舊預覽覆蓋',use_notes:'先確認新版內容',demo_url:null},project.aggregate_version);
  assert.equal(revised.status,200,JSON.stringify(revised.data));
  const conflict=await api(`/me/skill-submissions/${staleDraft.submission_id}/publish`,owner,{consent_to_share:true},staleDraft.aggregate_version);
  assert.equal(conflict.status,412,JSON.stringify(conflict.data));assert.equal(conflict.data.code,'project_publication_changed');
  assert.match(conflict.data.detail,/撤回這份草稿/);
  const retained=await listed(owner,project.project_id);
  assert.equal(retained.title,revised.data.title);assert.equal(retained.aggregate_version,revised.data.aggregate_version);
  assert.ok(retained.sharing_withdrawn_at);assert.equal(await listed(other,project.project_id),undefined);
  assert.equal((await api(`/me/skill-submissions/${staleDraft.submission_id}`,owner)).data.status,'ready_for_review');
  assert.equal((await api(`/me/skill-submissions/${staleDraft.submission_id}/revoke`,owner,{},staleDraft.aggregate_version)).status,200);
  const fresh=expectPrepared(await prepare(owner,retained));assert.equal(fresh.payload.title,revised.data.title);
  const published=await publish(owner,fresh);
  assert.equal((await api(`/skill-submissions/${published.submission_id}`)).data.title,revised.data.title);
  assert.equal((await app.request(origin+book.public_path)).status,404);
});

test('withdrawing closes pending upgrade grants and co-creation discovery without changing another owners source', async t => {
  github(t);const owner=await login(),other=await login(DEMO_USERS[1].email);
  const project=await registered(owner), independent=await registered(other);
  const book=await publish(owner,expectPrepared(await prepare(owner,project)));
  const upgraded=await api(`/me/skill-submissions/${book.submission_id}/upgrade`,owner,{});
  assert.equal(upgraded.status,201,JSON.stringify(upgraded.data));
  const upgrade=upgraded.data;
  const grant=await api(`/me/skill-submissions/${upgrade.submission_id}/grant`,owner,{},upgrade.aggregate_version);
  assert.equal(grant.status,200,JSON.stringify(grant.data));
  const co=await api('/co-creation/projects',owner,{source_project_id:project.project_id,title:'一起改進工具',goal:'用合成資料試用',guild_keys:[],help_wanted:['testing'],contribution_notes:'依原 Repo 規範參與'});
  assert.equal(co.status,201,JSON.stringify(co.data));
  const current=await listed(owner,project.project_id);
  assert.equal((await api(`/opensource/projects/${project.project_id}/withdraw`,owner,{},current.aggregate_version)).status,200);
  const retained=(await api(`/me/skill-submissions/${upgrade.submission_id}`,owner)).data;
  assert.equal(retained.status,'revoked');assert.ok(retained.grant_revoked_at);
  assert.equal((await api(`/me/skill-submissions/${upgrade.submission_id}/grant`,owner,{},retained.aggregate_version)).status,409);
  assert.equal((await api(`/co-creation/projects/${co.data.project_id}/brief`,other)).status,404);
  assert.equal((await api(`/co-creation/projects/${co.data.project_id}/brief`,owner)).status,200);
  assert.ok(await listed(other,independent.project_id));
  const history=await historyRepositories(pool,{community_id:project.community_id,user_id:owner.user.user_id} as any);
  assert.equal(history.find(item=>item.name.toLowerCase()==='example/legacy-tool')?.title,independent.title,'an independent valid source remains discoverable');
});

test('withdrawal during GitHub inspection prevents the late publication from restoring sharing', async t => {
  github(t);const owner=await login(),project=await registered(owner);
  await publish(owner,expectPrepared(await prepare(owner,project)));
  const current=await listed(owner,project.project_id);
  const draft=await api('/me/skill-submissions/manual',owner,{...metadata(),title:'同來源的新分享'});
  let entered!:()=>void,release!:()=>void;
  const inspecting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const originalFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async (...args:Parameters<typeof fetch>)=>{entered();await gate;return originalFetch(...args);});
  const publishing=api(`/me/skill-submissions/${draft.data.submission_id}/publish`,owner,{consent_to_share:true},draft.data.aggregate_version);
  await inspecting;
  const withdrawing=api(`/opensource/projects/${project.project_id}/withdraw`,owner,{},current.aggregate_version);
  const withdrawn=await withdrawing;release();
  const published=await publishing;
  assert.equal(withdrawn.status,200,JSON.stringify(withdrawn.data));assert.equal(published.status,412,JSON.stringify(published.data));
  assert.ok((await listed(owner,project.project_id)).sharing_withdrawn_at);
  assert.deepEqual((await api('/skill-submissions/published')).data.items,[]);
});
