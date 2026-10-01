import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem } from '../../packages/shared/problem.js';
import { inspectGitHubRepository } from '../../modules/opensource-marketing/github.js';

const TOKEN = 'github_pat_synthetic_fixture';
const SHA = 'a'.repeat(40);
const PUBLIC = { id: 501, full_name: 'example/project', private: false, visibility: 'public', default_branch: 'main', fork: false, archived: false };

function repoResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('a platform token is sent, and a public repository is imported without logging it', async () => {
  const calls: Array<{ authorization: string | null; signal: AbortSignal | null | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ authorization: headers.get('Authorization'), signal: init?.signal });
    assert.equal(new URL(String(input)).hostname, 'api.github.com');
    assert.equal(init?.redirect, 'manual');
    const url = String(input);
    if (url.endsWith('/repos/example/project')) return repoResponse(200, PUBLIC);
    if (url.endsWith('/commits/main')) return repoResponse(200, { sha: SHA });
    if (url.includes('/license?ref=')) return repoResponse(200, { path: 'LICENSE', license: { spdx_id: 'MIT' } });
    throw new Error('unexpected ' + url);
  };
  const source = await inspectGitHubRepository('https://github.com/example/project', fetcher, TOKEN);
  assert.equal(source.repository_id, '501');
  assert.equal(source.commit_sha, SHA);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.authorization === `Bearer ${TOKEN}`));
  assert.ok(calls.every(call => call.signal === calls[0].signal));
  assert.equal(JSON.stringify(source).includes(TOKEN), false);
});

test('token 401, SSO 403 and a token rate limit each retry once anonymously on the same signal', async () => {
  const cases: Array<{ name: string; status: number; headers: Record<string, string>; body: { message: string } }> = [
    { name: '401', status: 401, headers: { 'retry-after': '15' }, body: { message: 'Bad credentials' } },
    { name: 'sso', status: 403, headers: { 'x-ratelimit-remaining': '100' }, body: { message: 'Resource protected by organization SAML enforcement' } },
    { name: 'limited', status: 429, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '20' }, body: { message: 'API rate limit exceeded' } },
  ];
  for (const item of cases) {
    const calls: Array<{ authorization: string | null; signal: AbortSignal | null | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ authorization: headers.get('Authorization'), signal: init?.signal });
      const url = String(input);
      if (headers.has('Authorization')) return repoResponse(item.status, item.body, item.headers);
      if (url.endsWith('/repos/example/project')) return repoResponse(200, PUBLIC);
      if (url.endsWith('/commits/main')) return repoResponse(200, { sha: SHA });
      if (url.includes('/license?ref=')) return repoResponse(200, { path: 'LICENSE', license: { spdx_id: 'MIT' } });
      throw new Error('unexpected ' + url);
    };
    const source = await inspectGitHubRepository('https://github.com/example/project', fetcher, TOKEN);
    assert.equal(source.license_spdx, 'MIT', item.name);
    assert.equal(calls.length, 6, item.name);
    assert.equal(calls.filter(call => call.authorization === `Bearer ${TOKEN}`).length, 3, item.name);
    assert.equal(calls.filter(call => call.authorization === null).length, 3, item.name);
    assert.ok(calls.every(call => call.signal === calls[0].signal), item.name);
    assert.equal(JSON.stringify(source).includes(TOKEN), false, item.name);
  }
});

test('when the token and the anonymous read are both rate limited the result is github_rate_limited', async () => {
  const calls: string[] = [];
  let signal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(new Headers(init?.headers).get('Authorization') ?? '');
    signal ??= init?.signal;
    assert.equal(init?.signal, signal);
    assert.equal(String(input).includes(TOKEN), false);
    return repoResponse(429, { message: 'rate limit' }, { 'retry-after': '40' });
  };
  await assert.rejects(() => inspectGitHubRepository('https://github.com/example/project', fetcher, TOKEN), (error: unknown) => {
    assert.ok(error instanceof Problem);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'github_rate_limited');
    assert.equal(error.retryAfterSeconds, 40);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
  assert.deepEqual(calls, [`Bearer ${TOKEN}`, '']);
});

test('a private repository visible to the token is indistinguishable from a missing repository', async () => {
  let notFound: Problem | undefined;
  const missing: typeof fetch = async () => new Response('missing', { status: 404 });
  await assert.rejects(() => inspectGitHubRepository('https://github.com/example/project', missing), (error: unknown) => {
    notFound = error as Problem;
    return true;
  });
  for (const body of [
    { ...PUBLIC, private: true, visibility: 'private' },
    { ...PUBLIC, private: true, visibility: 'public' },
    { ...PUBLIC, private: false, visibility: 'internal' },
  ]) {
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1;
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${TOKEN}`);
      return repoResponse(200, body);
    };
    await assert.rejects(() => inspectGitHubRepository('https://github.com/example/project', fetcher, TOKEN), (error: unknown) => {
      assert.ok(error instanceof Problem);
      assert.ok(notFound);
      assert.equal(error.status, notFound.status);
      assert.equal(error.code, notFound.code);
      assert.equal(error.message, notFound.message);
      assert.equal(error.message.includes(TOKEN), false);
      assert.equal(error.message.includes('private'), false);
      return true;
    });
    assert.equal(calls, 1, JSON.stringify(body.visibility));
  }
});

test('an anonymous 403 without a token stays a single rate-limited read', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls += 1; return new Response('{}', { status: 403 }); };
  await assert.rejects(() => inspectGitHubRepository('https://github.com/example/project', fetcher), (error: unknown) => {
    assert.ok(error instanceof Problem);
    assert.equal(error.code, 'github_rate_limited');
    return true;
  });
  assert.equal(calls, 1);
});
