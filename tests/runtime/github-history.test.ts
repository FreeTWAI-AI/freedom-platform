import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {GITHUB_HISTORY_PAGE_CAP, githubHistoryLeaderboards, githubHistoryPage, historyRepositories} from '../../modules/community/github-history.js';
import type {Actor} from '../../modules/identity-membership/service.js';
import {contributionPoints, isGitHubBot, issueResolved, leaderboardFromItems, pullClosedUnmerged, pullUpdated, rankedLeaderboards} from '../../packages/shared/github-leaderboard.js';

const when = '2026-09-28T12:00:00.000Z';
const origin = 'http://127.0.0.1:4392';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_github_history_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6});
const originalFetch = globalThis.fetch;
const actor = {community_id: DEMO_COMMUNITY, user_id: DEMO_USERS[0].user_id} as Actor;
const calls: string[] = [];
let app = createApp(pool, origin);

type Session = {cookie: string; csrf: string};
before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error('real network');
  }) as typeof fetch;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await seedLocal(pool);
  const otherCommunity = '30000000-0000-4000-8000-000000000099';
  const otherUser = '30000000-0000-4000-8000-000000000098';
  await pool.query('INSERT INTO communities VALUES($1,$2)', [otherCommunity, '其他社群']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,'other-history@local.test','其他','hash',$3)`, [otherUser, otherCommunity, randomUUID()]);
  await pool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship)
    VALUES($1,$2,$3,'可見','說明','用法','1382968101','Example-Org/visible-tool','https://github.com/Example-Org/visible-tool','author')`, [randomUUID(), DEMO_COMMUNITY, DEMO_USERS[0].user_id]);
  await pool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship)
    VALUES($1,$2,$3,'隱藏','說明','用法','1382968102','Example-Org/hidden-repo','https://github.com/Example-Org/hidden-repo','author')`, [randomUUID(), otherCommunity, otherUser]);
  app = createApp(pool, origin);
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE github_items, github_sync_repositories, github_sync_backoff');
});

async function request(path: string, session?: Session) {
  const headers: Record<string, string> = {Origin: origin, ...(session ? {Cookie: session.cookie} : {})};
  const response = await app.request(origin + '/api/v1' + path, {method: 'GET', headers});
  const data = await response.json() as Record<string, unknown>;
  return {status: response.status, data, response};
}
async function signIn(): Promise<Session> {
  const body = JSON.stringify({email: DEMO_USERS[0].email, password: DEMO_PASSWORD});
  const response = await app.request(origin + '/api/v1/auth/login', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body});
  const data = await response.json() as {csrf_token: string};
  assert.equal(response.status, 200);
  return {cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token};
}
async function putRepo(name: string, fields: {status?: string; backfilled?: boolean; synced?: string | null} = {}) {
  await pool.query(`INSERT INTO github_sync_repositories(repository_key, repository, access_status, backfilled, last_synced_at, next_sync_at)
    VALUES ($1,$2,$3,$4,$5,now())
    ON CONFLICT (repository_key) DO UPDATE SET access_status=EXCLUDED.access_status, backfilled=EXCLUDED.backfilled, last_synced_at=EXCLUDED.last_synced_at`,
  [name.toLowerCase(), name, fields.status ?? 'ok', fields.backfilled ?? true, fields.synced === undefined ? when : fields.synced]);
}
async function putItem(name: string, row: {number: number; kind: 'issue' | 'pr'; author: string | null; state?: 'open' | 'closed'; stateReason?: string | null; mergedAt?: string | null; created: string}) {
  await pool.query(`INSERT INTO github_items(repository_key,number,kind,title,author_login,state,state_reason,merged_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [name.toLowerCase(), row.number, row.kind, `標題 ${row.number}`, row.author, row.state ?? 'open', row.stateReason ?? null, row.mergedAt ?? null, row.created]);
}

test('leaderboard scores stay display-only and skip automation accounts', () => {
  assert.equal(isGitHubBot('dependabot[bot]'), true);
  assert.equal(isGitHubBot('Dependabot'), true);
  assert.equal(isGitHubBot('github-actions'), true);
  assert.equal(isGitHubBot('GitHub-Actions[bot]'), true);
  assert.equal(isGitHubBot('member-demo'), false);
  assert.equal(isGitHubBot(' '), true);
  assert.equal(contributionPoints(2, 1), 30);
  assert.equal(contributionPoints(0, 2), 40);
  assert.equal(issueResolved('closed'), true);
  assert.equal(issueResolved('open'), false);
  assert.equal(pullUpdated(when), true);
  assert.equal(pullUpdated(null), false);
  assert.equal(pullClosedUnmerged('closed', null), true);
  assert.equal(pullClosedUnmerged('open', null), false);
  assert.equal(pullClosedUnmerged('closed', when), false);
  const grouped = leaderboardFromItems([
    {author: 'Member-Demo', kind: 'issue'},
    {author: 'member-demo', kind: 'pr'},
    {author: 'dependabot', kind: 'issue'},
    {author: null, kind: 'issue'},
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].login, 'Member-Demo');
  assert.equal(grouped[0].ideas, 1);
  assert.equal(grouped[0].edits, 1);
});

test('stored history pages keep order, stale and unavailable flags, and never call GitHub', async () => {
  const beforeCalls = calls.length;
  await putRepo('FreeTWAI-AI/freedom-platform', {backfilled: true, synced: when});
  const newest = '2026-09-30T00:00:00.000Z';
  for (let number = 1; number <= 101; number += 1) {
    const created = number === 80 || number === 90 ? newest : new Date(Date.parse('2026-09-01T00:00:00.000Z') + number * 1000).toISOString();
    await putItem('FreeTWAI-AI/freedom-platform', {number, kind: 'issue', author: 'maker', created, state: number === 2 ? 'closed' : 'open', stateReason: number === 2 ? 'not_planned' : null});
  }
  await putItem('FreeTWAI-AI/freedom-platform', {number: 500, kind: 'pr', author: 'editor', created: '2026-09-02T00:00:00.000Z', state: 'closed', mergedAt: when});
  const issues = await githubHistoryPage(pool, 'FreeTWAI-AI/freedom-platform', 'issue', 1, Date.parse(when) + 60 * 1000);
  assert.equal(issues.items.length, 100);
  assert.equal(issues.has_more, true);
  assert.equal(issues.items[0].number, 90);
  assert.equal(issues.items[1].number, 80);
  assert.equal(issues.items[0].url, 'https://github.com/FreeTWAI-AI/freedom-platform/issues/90');
  assert.equal(issues.checked_at, when);
  assert.equal(issues.stale, false);
  assert.equal(issues.unavailable, undefined);
  const closed = issues.items.find(item => item.number === 2);
  assert.equal(closed?.state, 'closed');
  assert.equal(closed?.state_reason, 'not_planned');
  const page2 = await githubHistoryPage(pool, 'FreeTWAI-AI/freedom-platform', 'issue', 2, Date.parse(when) + 60 * 1000);
  assert.equal(page2.items.length, 1);
  assert.equal(page2.has_more, false);
  assert.equal(page2.items[0].number, 1);
  const pulls = await githubHistoryPage(pool, 'FreeTWAI-AI/freedom-platform', 'pr', 1);
  assert.equal(pulls.items.length, 1);
  assert.equal(pulls.items[0].merged_at, when);
  const stale = await githubHistoryPage(pool, 'FreeTWAI-AI/freedom-platform', 'issue', 1, Date.parse(when) + 2 * 60 * 60 * 1000 + 1);
  assert.equal(stale.stale, true);
  assert.equal(stale.items.length, 100);
  await pool.query(`UPDATE github_sync_repositories SET backfilled=false, last_synced_at=$2 WHERE repository_key=$1`, ['freetwai-ai/freedom-platform', when]);
  const syncing = await githubHistoryPage(pool, 'FreeTWAI-AI/freedom-platform', 'issue', 1, Date.parse(when) + 1000);
  assert.equal(syncing.stale, true);
  assert.equal(syncing.unavailable, undefined);
  assert.equal(syncing.items.length, 100);
  await pool.query(`UPDATE github_sync_repositories SET access_status='unreadable', backfilled=true, last_synced_at=$2 WHERE repository_key=$1`, ['freetwai-ai/freedom-platform', when]);
  const blocked = await githubHistoryPage(pool, 'FreeTWAI-AI/freedom-platform', 'issue', 1, Date.parse(when) + 1000);
  assert.equal(blocked.unavailable, 'github_unreadable');
  assert.equal(blocked.stale, false);
  assert.equal(blocked.items.length, 100);
  await pool.query('DELETE FROM github_items WHERE repository_key=$1', ['freetwai-ai/freedom-platform']);
  await pool.query('DELETE FROM github_sync_repositories WHERE repository_key=$1', ['freetwai-ai/freedom-platform']);
  const pending = await githubHistoryPage(pool, 'FreeTWAI-AI/freedom-platform', 'issue', 1);
  assert.equal(pending.unavailable, 'github_sync_pending');
  assert.equal(pending.stale, true);
  assert.equal(pending.items.length, 0);
  assert.equal(pending.checked_at, null);
  await assert.rejects(githubHistoryPage(pool, 'FreeTWAI-AI/freedom-platform', 'issue', 101), {status: 422, code: 'invalid_page'});
  await assert.rejects(githubHistoryPage(pool, 'https://example.com/secret', 'issue', 1), {status: 422, code: 'invalid_repository'});
  assert.equal(calls.length, beforeCalls);
});

test('leaderboard counts match the shared helpers and follow repository visibility', async () => {
  const beforeCalls = calls.length;
  const repos = await historyRepositories(pool, actor);
  assert.equal(repos.some(repo => repo.name === 'Example-Org/visible-tool'), true);
  assert.equal(repos.some(repo => repo.name.toLowerCase() === 'example-org/hidden-repo'), false);
  for (const repo of repos) await putRepo(repo.name, {backfilled: true, status: 'ok', synced: when});
  await putRepo('Example-Org/hidden-repo', {backfilled: true, status: 'ok', synced: when});
  const visible = [
    {number: 1, kind: 'issue' as const, author: 'member-demo', state: 'open' as const, created: '2026-09-27T00:00:00.000Z'},
    {number: 2, kind: 'issue' as const, author: 'member-demo', state: 'closed' as const, stateReason: 'not_planned', created: '2026-09-26T00:00:00.000Z'},
    {number: 3, kind: 'pr' as const, author: 'member-demo', state: 'open' as const, created: '2026-09-28T00:00:00.000Z'},
    {number: 4, kind: 'pr' as const, author: 'contributor-demo', state: 'closed' as const, mergedAt: when, created: '2026-09-25T00:00:00.000Z'},
    {number: 5, kind: 'pr' as const, author: 'contributor-demo', state: 'closed' as const, created: '2026-09-22T00:00:00.000Z'},
    {number: 6, kind: 'issue' as const, author: 'dependabot', created: '2026-09-21T00:00:00.000Z'},
    {number: 7, kind: 'issue' as const, author: 'dependabot[bot]', created: '2026-09-21T00:00:01.000Z'},
    {number: 8, kind: 'issue' as const, author: 'github-actions', created: '2026-09-21T00:00:02.000Z'},
    {number: 9, kind: 'issue' as const, author: 'GitHub-Actions[bot]', created: '2026-09-21T00:00:03.000Z'},
    {number: 10, kind: 'issue' as const, author: null, created: '2026-09-21T00:00:04.000Z'},
  ];
  for (const row of visible) await putItem('FreeTWAI-AI/freedom-platform', row);
  await putItem('Example-Org/visible-tool', {number: 1, kind: 'issue', author: 'visible-maker', created: '2026-09-20T00:00:00.000Z'});
  await putItem('Example-Org/hidden-repo', {number: 1, kind: 'issue', author: 'hidden-author', created: '2026-09-20T00:00:00.000Z'});
  await putItem('Example-Org/hidden-repo', {number: 2, kind: 'pr', author: 'member-demo', created: '2026-09-20T00:00:00.000Z', state: 'closed', mergedAt: when});
  const helperItems = [
    ...visible.map(row => ({author: row.author, kind: row.kind})),
    {author: 'visible-maker', kind: 'issue' as const},
  ];
  const expected = rankedLeaderboards(leaderboardFromItems(helperItems));
  const boards = await githubHistoryLeaderboards(pool, actor);
  assert.deepEqual(boards.ideas, expected.ideas);
  assert.deepEqual(boards.edits, expected.edits);
  assert.deepEqual(boards.contributions, expected.contributions);
  assert.equal(boards.complete, true);
  assert.equal(boards.syncing.length, 0);
  assert.equal(boards.unreadable.length, 0);
  assert.equal(boards.oldest_synced_at, when);
  assert.equal(JSON.stringify(boards).includes('hidden-author'), false);
  assert.equal(boards.ideas.some(row => row.login === 'visible-maker' && row.count === 1), true);
  assert.equal(boards.ideas.find(row => row.login === 'member-demo')?.count, 2);
  assert.equal(boards.edits.find(row => row.login === 'contributor-demo')?.count, 2);
  assert.equal(boards.contributions.find(row => row.login === 'contributor-demo')?.count, contributionPoints(0, 2));
  await pool.query(`UPDATE github_sync_repositories SET access_status='unreadable' WHERE repository_key='freetwai-ai/freedom-agent-kit'`);
  await pool.query(`UPDATE github_sync_repositories SET backfilled=false WHERE repository_key='freetwai-ai/freedom-storefront'`);
  const partial = await githubHistoryLeaderboards(pool, actor);
  assert.equal(partial.complete, false);
  assert.equal(partial.unreadable.includes('FreeTWAI-AI/freedom-agent-kit'), true);
  assert.equal(partial.syncing.includes('FreeTWAI-AI/freedom-storefront'), true);
  assert.deepEqual(partial.ideas, expected.ideas);
  const session = await signIn();
  const started = calls.length;
  const routeBoards = await request('/community/github-history/leaderboards', session);
  const routeRepos = await request('/community/github-history/repositories', session);
  const routeItems = await request('/community/github-history/items?repository=FreeTWAI-AI%2Ffreedom-platform&kind=issue&page=1', session);
  const missing = await request('/community/github-history/items?repository=Example-Org%2Fhidden-repo&kind=issue&page=1', session);
  const tooFar = await request('/community/github-history/items?repository=FreeTWAI-AI%2Ffreedom-platform&kind=issue&page=101', session);
  const anon = await request('/community/github-history/leaderboards');
  assert.equal(routeBoards.status, 200);
  assert.deepEqual((routeBoards.data as {ideas: unknown}).ideas, expected.ideas);
  assert.equal((routeBoards.data as {complete: boolean}).complete, false);
  assert.equal(routeItems.status, 200);
  const page = routeItems.data as {items: {number: number}[]; has_more: boolean; checked_at: string; unavailable?: string};
  assert.equal(page.items.length, 7);
  assert.equal(page.has_more, false);
  assert.equal(page.checked_at, when);
  assert.equal(page.unavailable, undefined);
  const listed = routeRepos.data as {items: {name: string; sync: {status: string}}[]};
  assert.equal(listed.items.find(item => item.name === 'FreeTWAI-AI/freedom-agent-kit')?.sync.status, 'unreadable');
  assert.equal(listed.items.find(item => item.name === 'FreeTWAI-AI/freedom-storefront')?.sync.status, 'syncing');
  assert.equal(listed.items.find(item => item.name === 'FreeTWAI-AI/freedom-platform')?.sync.status, 'ok');
  assert.equal(listed.items.some(item => item.name.toLowerCase() === 'example-org/hidden-repo'), false);
  assert.equal(missing.status, 422);
  assert.equal(missing.data.code, 'invalid_repository');
  assert.equal(tooFar.status, 422);
  assert.equal(anon.status, 401);
  assert.equal(calls.slice(started).some(url => url.includes('github.com')), false);
  assert.equal(calls.slice(beforeCalls).some(url => url.includes('github.com')), false);
});

function declaredNumber(source: string, name: string) {
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
  assert.ok(match, name);
  return Number(match[1]);
}

test('the portal page cap stays equal to the exported history page cap', () => {
  const server = readFileSync('modules/community/github-history.ts', 'utf8');
  const portal = readFileSync('apps/portal-web/src/modules/CommunityHistory.tsx', 'utf8');
  const route = readFileSync('apps/platform-api/src/routes/co-creation.ts', 'utf8');
  assert.equal(GITHUB_HISTORY_PAGE_CAP, 100);
  assert.match(portal, /GITHUB_HISTORY_PAGE_CAP in modules\/community\/github-history\.ts/);
  assert.equal(declaredNumber(server, 'GITHUB_HISTORY_PAGE_CAP'), GITHUB_HISTORY_PAGE_CAP);
  assert.equal(declaredNumber(portal, 'PAGE_CAP'), GITHUB_HISTORY_PAGE_CAP);
  assert.match(server, /page <= GITHUB_HISTORY_PAGE_CAP/);
  assert.match(route, /\.max\(GITHUB_HISTORY_PAGE_CAP\)/);
});

test('repository categories prioritize platform architecture and guild assigned skill books', async () => {
  const fake = {query: async (sql: string) => ({rows: sql.includes('guild_skill_book_bindings') ? [{book_id: 'video-autopilot'}] : [
    {repository_full_name: 'FreeTWAI-AI/freedom-platform', title: '重複平台'},
    {repository_full_name: 'example/personal-tool', title: '個人工具'},
  ]})} as unknown as Pool;
  const repos = await historyRepositories(fake, {community_id: 'test-community'} as Actor);
  assert.equal(repos.find(repo => repo.name === 'FreeTWAI-AI/freedom-platform')?.category, 'platform');
  assert.equal(repos.find(repo => repo.name === 'example/personal-tool')?.category, 'personal');
  assert.ok(repos.some(repo => repo.category === 'official'));
  assert.equal(new Set(repos.map(repo => repo.name.toLowerCase())).size, repos.length);
});
