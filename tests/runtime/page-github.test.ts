import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {PageGitHubReader, PageGitHubEventReader, DESIGN_CLAIM_MARKER, issuePageMarker, pageIdsForIssue, publicEvent, type PageGitHubEvent} from '../../modules/development/page-github.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_page_github_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4});
const originalFetch = globalThis.fetch;
const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const PLATFORM = 'freetwai-ai/freedom-platform';
let fetches = 0;

function subject(kind: 'issues' | 'pull', number: number, extra: Record<string, unknown> = {}) {
  return {number, title: `Task ${number}`, html_url: `https://github.com/FreeTWAI-AI/freedom-platform/${kind}/${number}`, ...extra};
}
function event(id: string, type: string, payload: unknown, actor: {login: string} | null = {login: 'member'}) {
  return {id, type, actor, created_at: '2026-09-27T12:00:00Z', payload};
}
function kept(raw: unknown): PageGitHubEvent | null {
  return publicEvent(raw);
}

before(async () => {
  globalThis.fetch = (async () => { fetches += 1; throw new Error('page reads must not fetch'); }) as typeof fetch;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  fetches = 0;
  await pool.query('TRUNCATE github_items, github_sync_repositories, github_repository_events, github_feed_state');
});

async function seedRepo(status: 'ok' | 'pending', syncedAt: Date | null) {
  await pool.query(`INSERT INTO github_sync_repositories(repository_key, repository, access_status, backfilled, last_synced_at)
    VALUES ($1, $1, $2, $3, $4)`, [PLATFORM, status, status === 'ok' && syncedAt != null, syncedAt]);
}
async function seedItem(number: number, kind: 'issue' | 'pr', state: 'open' | 'closed', created: string, pages: string[] = [], author: string | null = 'maker') {
  await pool.query(`INSERT INTO github_items(repository_key, number, kind, title, author_login, state, created_at, updated_at, page_ids)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`, [PLATFORM, number, kind, `${kind} ${number}`, author, state, created, pages]);
}

test('page markers and GitHub labels resolve only known pages', () => {
  assert.equal(issuePageMarker('home'), '<!-- freedom-page:home -->');
  assert.deepEqual(pageIdsForIssue('<!-- freedom-page:home -->', ['page:guilds', 'page:unknown']), ['guilds', 'home']);
  assert.deepEqual(pageIdsForIssue('<!-- freedom-page:unknown -->', []), []);
  assert.throws(() => issuePageMarker('unknown'));
});

test('public events keep only verified platform actions', () => {
  const items = [
    event('1', 'IssuesEvent', {action: 'opened', issue: subject('issues', 1)}),
    event('2', 'PullRequestEvent', {action: 'opened', pull_request: subject('pull', 2)}),
    event('3', 'PullRequestReviewEvent', {action: 'created', pull_request: subject('pull', 2), review: {state: 'approved', html_url: 'https://github.com/FreeTWAI-AI/freedom-platform/pull/2#pullrequestreview-3'}}),
    event('4', 'IssueCommentEvent', {action: 'created', issue: subject('issues', 1), comment: {body: `我願意接手設計\n${DESIGN_CLAIM_MARKER}`, html_url: 'https://github.com/FreeTWAI-AI/freedom-platform/issues/1#issuecomment-4'}}),
    event('5', 'IssueCommentEvent', {action: 'created', issue: subject('issues', 1), comment: {body: '只是看看', html_url: 'https://github.com/FreeTWAI-AI/freedom-platform/issues/1#issuecomment-5'}}),
    event('6', 'IssueCommentEvent', {action: 'created', issue: {...subject('issues', 1), pull_request: {}}, comment: {body: DESIGN_CLAIM_MARKER, html_url: 'https://github.com/FreeTWAI-AI/freedom-platform/issues/1#issuecomment-6'}}),
    event('7', 'PullRequestReviewEvent', {action: 'dismissed', pull_request: subject('pull', 2), review: {state: 'approved', html_url: 'https://github.com/FreeTWAI-AI/freedom-platform/pull/2#pullrequestreview-7'}}),
    event('8', 'PageOpenedEvent', {}),
    event('9', 'PullRequestEvent', {action: 'opened', pull_request: {number: 9, url: 'https://api.github.com/repos/FreeTWAI-AI/freedom-platform/pulls/9'}}),
    event('10', 'PullRequestReviewEvent', {action: 'created', pull_request: {number: 9, url: 'https://api.github.com/repos/FreeTWAI-AI/freedom-platform/pulls/9'}, review: {state: 'approved', html_url: 'https://github.com/FreeTWAI-AI/freedom-platform/pull/9#pullrequestreview-10'}}),
    event('11', 'PullRequestEvent', {action: 'opened', pull_request: {number: 10, url: 'https://api.github.com/repos/other/repo/pulls/10'}}),
    event('12', 'IssuesEvent', {action: 'opened', issue: subject('issues', 1)}, null),
  ].map(kept).filter((item): item is PageGitHubEvent => item != null);
  assert.deepEqual(items.map(item => item.kind), ['issue_opened', 'pr_opened', 'pr_approved', 'design_claimed', 'pr_opened', 'pr_approved']);
  assert.equal(items[3].actor, 'member');
  assert.equal(items[4].title, 'PR #9');
  assert.equal(fetches, 0);
});

test('closed issues, merged and unmerged pull requests, and releases stay distinct', () => {
  const items = [
    event('c1', 'IssuesEvent', {action: 'closed', issue: subject('issues', 4)}),
    event('c2', 'IssuesEvent', {action: 'closed', issue: {...subject('issues', 5), pull_request: {}}}),
    event('c3', 'IssuesEvent', {action: 'reopened', issue: subject('issues', 4)}),
    event('c4', 'PullRequestEvent', {action: 'closed', pull_request: subject('pull', 6, {merged: true})}),
    event('c5', 'PullRequestEvent', {action: 'closed', pull_request: subject('pull', 7, {merged: false})}),
    event('c6', 'PullRequestEvent', {action: 'reopened', pull_request: subject('pull', 7)}),
    event('c7', 'ReleaseEvent', {action: 'published', release: {tag_name: 'v1.2.0', name: '九月更新', html_url: 'https://github.com/FreeTWAI-AI/freedom-platform/releases/tag/v1.2.0'}}),
    event('c8', 'ReleaseEvent', {action: 'published', release: {tag_name: 'v9', name: '別的倉庫', html_url: 'https://github.com/other/repo/releases/tag/v9'}}),
  ].map(kept).filter((item): item is PageGitHubEvent => item != null);
  assert.deepEqual(items.map(item => item.kind), ['issue_closed', 'pr_merged', 'pr_closed', 'release_published']);
  assert.equal(items[3].number, null);
  assert.equal(items[3].title, '九月更新');
  assert.equal(items[3].url, 'https://github.com/FreeTWAI-AI/freedom-platform/releases/tag/v1.2.0');
  assert.equal(fetches, 0);
});

test('page activity is read from stored rows and never calls GitHub', async () => {
  const reader = new PageGitHubReader(pool, () => NOW);
  const missing = await reader.read();
  assert.deepEqual(missing.items, []);
  assert.equal(missing.partial, true);
  assert.equal(missing.stale, true);
  assert.equal(missing.checked_at, new Date(NOW).toISOString());
  await assert.rejects(() => reader.read('unknown'), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'page_not_found');
  await seedRepo('pending', new Date(NOW));
  const pending = await reader.read('home');
  assert.equal(pending.partial, true);
  assert.equal('stale' in pending, false);
  await pool.query('DELETE FROM github_sync_repositories WHERE repository_key=$1', [PLATFORM]);
  await seedRepo('ok', new Date(NOW));
  await seedItem(2, 'issue', 'open', '2026-09-25T10:00:00.000Z', ['positioning']);
  await seedItem(7, 'issue', 'open', '2026-09-25T12:00:00.000Z', ['positioning', 'home'], null);
  await seedItem(8, 'pr', 'open', '2026-09-25T11:00:00.000Z', ['positioning']);
  await seedItem(9, 'issue', 'closed', '2026-09-25T13:00:00.000Z', ['positioning']);
  const page = await reader.read('positioning', true);
  assert.deepEqual(page.items.map(item => item.number), [7, 2]);
  assert.equal(page.items[0].url, 'https://github.com/FreeTWAI-AI/freedom-platform/issues/7');
  assert.equal(page.items[0].author, 'GitHub 使用者');
  assert.equal(page.items[0].kind, 'issue');
  assert.equal('partial' in page, false);
  assert.equal('stale' in page, false);
  assert.equal(page.checked_at, new Date(NOW).toISOString());
  assert.deepEqual((await reader.read()).items.map(item => item.kind), ['issue', 'issue', 'pr', 'issue']);
  const staleAt = new Date(NOW - 31 * 60 * 1000);
  await pool.query('UPDATE github_sync_repositories SET last_synced_at=$2 WHERE repository_key=$1', [PLATFORM, staleAt]);
  const stale = await reader.read('home');
  assert.equal(stale.stale, true);
  assert.equal('partial' in stale, false);
  assert.equal(stale.checked_at, staleAt.toISOString());
  assert.deepEqual(stale.items.map(item => item.number), [7]);
  assert.equal(fetches, 0);
});

test('page activity reports truncation only when more than 100 rows exist', async () => {
  await seedRepo('ok', new Date(NOW));
  for (let number = 1; number <= 101; number += 1) await seedItem(number, 'issue', 'open', '2026-09-01T00:00:00.000Z');
  const page = await new PageGitHubReader(pool, () => NOW).read();
  assert.equal(page.truncated, true);
  assert.equal(page.items.length, 100);
  assert.equal(page.items[0].number, 101);
  assert.equal(page.items[99].number, 2);
  assert.equal(fetches, 0);
});

test('stored public events keep the feed clock, errors and the newest hundred', async () => {
  const reader = new PageGitHubEventReader(pool, () => NOW);
  const missing = await reader.read();
  assert.deepEqual(missing.items, []);
  assert.equal(missing.stale, true);
  assert.equal(missing.checked_at, new Date(NOW).toISOString());
  await pool.query(`INSERT INTO github_feed_state(feed_name, checked_at, next_sync_at, last_error) VALUES ('freedom_platform_events', $1, $1, NULL)`, [new Date(NOW)]);
  await pool.query(`INSERT INTO github_repository_events(event_id, kind, number, title, url, actor, created_at)
    SELECT 'e' || lpad(i::text, 3, '0'), 'issue_opened', 1, '公告', 'https://github.com/FreeTWAI-AI/freedom-platform/issues/1', 'member', $1
    FROM generate_series(0, 100) AS g(i)`, [new Date(NOW)]);
  const fresh = await reader.read();
  assert.equal(fresh.truncated, true);
  assert.equal(fresh.items.length, 100);
  assert.equal(fresh.items[0].id, 'e100');
  assert.equal(fresh.items[0].kind, 'issue_opened');
  assert.equal('stale' in fresh, false);
  await pool.query(`UPDATE github_feed_state SET checked_at=$1 WHERE feed_name='freedom_platform_events'`, [new Date(NOW - 31 * 60 * 1000)]);
  assert.equal((await reader.read()).stale, true);
  await pool.query(`UPDATE github_feed_state SET checked_at=$1, last_error='github_rate_limited' WHERE feed_name='freedom_platform_events'`, [new Date(NOW)]);
  const failed = await reader.read();
  assert.equal(failed.stale, true);
  assert.equal(failed.items[0].url, 'https://github.com/FreeTWAI-AI/freedom-platform/issues/1');
  assert.equal(fetches, 0);
});
