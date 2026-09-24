import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat, writeFile, readFile, symlink, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const bin = join(packageDir, 'bin', 'freedom-skill-upload.mjs');
const fakeKey = () => 'fpk_' + randomBytes(32).toString('base64url');
const fakeGrant = () => 'fpg_' + randomBytes(32).toString('base64url');

function run(args, { home, stdin = '', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, all: stdout + stderr }));
    child.stdin.end(stdin);
  });
}
async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'freedom-skill-upload-test-'));
  try { return await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}
const configPath = home => join(home, '.config', 'freedom-skill-upload', 'config.json');

test('help explains site-side review and revocation', async () => withHome(async home => {
  const r = await run(['help'], { home });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /#skills/);
  assert.match(r.stdout, /撤銷/);
  assert.match(r.stdout, /--key-stdin/);
}));

test('init stores key privately from stdin; config and reset never print it', async () => withHome(async home => {
  const key = fakeKey();
  const init = await run(['init', '--origin', 'https://freetwai.com', '--key-stdin'], { home, stdin: key + '\n' });
  assert.equal(init.code, 0, init.all);
  assert.equal(init.all.includes(key), false);
  const file = await stat(configPath(home)), dir = await stat(join(home, '.config', 'freedom-skill-upload'));
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(dir.mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(configPath(home), 'utf8')), { origin: 'https://freetwai.com', key });
  const config = await run(['config'], { home });
  assert.equal(config.code, 0);
  assert.deepEqual(JSON.parse(config.stdout), { origin: 'https://freetwai.com', keyConfigured: true });
  assert.equal(config.all.includes(key), false);
  // Environment variable path overwrites atomically.
  const second = fakeKey();
  assert.equal((await run(['init', '--origin', 'https://freetwai.com'], { home, env: { FREEDOM_SKILL_UPLOAD_KEY: second } })).code, 0);
  assert.equal(JSON.parse(await readFile(configPath(home), 'utf8')).key, second);
  const reset = await run(['reset'], { home });
  assert.equal(reset.code, 0);
  await assert.rejects(stat(configPath(home)));
  assert.deepEqual(JSON.parse((await run(['config'], { home })).stdout), { origin: null, keyConfigured: false });
}));

test('credentials in argv are refused without being echoed', async () => withHome(async home => {
  const key = fakeKey();
  for (const args of [['init', '--origin', 'https://freetwai.com', '--key', key], ['init', `--key=${key}`], ['submit', key]]) {
    const r = await run(args, { home });
    assert.notEqual(r.code, 0);
    assert.equal(r.all.includes(key), false);
    assert.match(r.stderr, /撤銷/);
  }
  await assert.rejects(stat(configPath(home)));
  const unknown = await run(['init', '--origin', 'https://freetwai.com', '--token', 'plain-secret-value'], { home });
  assert.notEqual(unknown.code, 0);
  assert.equal(unknown.all.includes('plain-secret-value'), false);
}));

test('origin must be an exact HTTPS origin or loopback HTTP', async () => withHome(async home => {
  const key = fakeKey();
  for (const origin of ['http://freetwai.com', 'https://freetwai.com/path', 'https://user@freetwai.com', 'https://freetwai.com/?q=1', 'https://freetwai.com/#x', 'ftp://freetwai.com', 'http://10.0.0.1']) {
    const r = await run(['init', '--origin', origin, '--key-stdin'], { home, stdin: key });
    assert.equal(r.code, 2, origin);
  }
  for (const origin of ['http://127.0.0.1:4310', 'http://localhost:4310', 'http://[::1]:4310', 'https://staging.freetwai.com/']) {
    assert.equal((await run(['init', '--origin', origin, '--key-stdin'], { home, stdin: key })).code, 0, origin);
  }
}));

test('symlinked or permissive config files are rejected', async () => withHome(async home => {
  const dir = join(home, '.config', 'freedom-skill-upload');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(home, 'elsewhere.json');
  await writeFile(target, JSON.stringify({ origin: 'https://freetwai.com', key: fakeKey() }), { mode: 0o600 });
  await symlink(target, join(dir, 'config.json'));
  assert.notEqual((await run(['config'], { home })).code, 0);
  assert.notEqual((await run(['init', '--origin', 'https://freetwai.com', '--key-stdin'], { home, stdin: fakeKey() })).code, 0);
  await rm(join(dir, 'config.json'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ origin: 'https://freetwai.com', key: fakeKey() }));
  await chmod(join(dir, 'config.json'), 0o644);
  assert.notEqual((await run(['config'], { home })).code, 0);
}));

function fakeServer(handler) {
  return new Promise(resolve => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => { requests.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, body, requests); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}
const payload = { repository_url: 'https://github.com/example/project', title: 't', description: 'd', use_notes: 'u', relationship: 'author', share_introductions: [] };

test('submit creates a draft with the key, uploads with the one-time grant, and prints no secrets', async () => withHome(async home => {
  const key = fakeKey(), grant = fakeGrant(), id = randomUUID();
  const { server, requests, origin } = await fakeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agent-api/v1/skill-submissions') {
      res.statusCode = 201;
      return res.end(JSON.stringify({ submission: { submission_id: id, status: 'awaiting_upload' }, upload_grant: { token: grant, expires_at: 'x', submit_url: `${origin}/agent-api/v1/skill-submissions/${id}` } }));
    }
    res.end(JSON.stringify({ submission_id: id, status: 'ready_for_review', grant_consumed_at: 'x', review_url: 'https://evil.example/' }));
  });
  try {
    assert.equal((await run(['init', '--origin', origin, '--key-stdin'], { home, stdin: key })).code, 0);
    const file = join(home, 'skill.json');
    await writeFile(file, JSON.stringify(payload));
    const r = await run(['submit', '--file', file], { home });
    assert.equal(r.code, 0, r.all);
    assert.match(r.stdout, new RegExp(`submission_id: ${id}`));
    assert.match(r.stdout, /status: ready_for_review/);
    assert.match(r.stdout, new RegExp(`review_url: ${origin.replace(/[.]/g, '\\.')}/#skills`));
    for (const secret of [key, grant]) assert.equal(r.all.includes(secret), false);
    assert.equal(requests.length, 2);
    const [create, upload] = requests;
    assert.equal(create.headers.authorization, `Bearer ${key}`);
    assert.match(create.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
    assert.equal(create.body, '{}');
    assert.equal(upload.url, `/agent-api/v1/skill-submissions/${id}`);
    assert.equal(upload.headers.authorization, `Bearer ${grant}`);
    assert.equal(upload.headers.cookie, undefined);
    assert.deepEqual(JSON.parse(upload.body), payload);
    // The grant is never persisted.
    assert.equal((await readFile(configPath(home), 'utf8')).includes(grant), false);
  } finally { server.close(); }
}));

test('one-off grant mode, redirects blocked and server errors summarised without raw body', async () => withHome(async home => {
  const grant = fakeGrant(), id = randomUUID();
  let mode = 'redirect';
  const { server, requests, origin } = await fakeServer((req, res) => {
    if (mode === 'redirect') { res.statusCode = 307; res.setHeader('Location', 'https://evil.example/steal'); return res.end(); }
    res.statusCode = 422; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 'validation_failed', detail: `echo ${grant}`, echo: grant }));
  });
  try {
    const file = join(home, 'skill.json');
    await writeFile(file, JSON.stringify(payload));
    const redirected = await run(['submit', '--origin', origin, '--submission', id, '--grant-stdin', '--file', file], { home, stdin: grant });
    assert.equal(redirected.code, 1);
    assert.match(redirected.stderr, /轉址/);
    assert.equal(requests.length, 1);
    mode = 'error';
    const failed = await run(['submit', '--origin', origin, '--submission', id, '--file', file], { home, env: { FREEDOM_SKILL_UPLOAD_GRANT: grant } });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /HTTP 422 validation_failed/);
    assert.match(failed.stderr, /100 則/);
    assert.equal(failed.all.includes(grant), false);
    assert.equal(requests[1].headers.authorization, `Bearer ${grant}`);
    await assert.rejects(stat(configPath(home)), 'grant mode never writes config');
    assert.equal((await run(['submit', '--origin', origin, '--submission', id, '--grant-stdin'], { home, stdin: grant })).code, 2, '--grant-stdin needs --file');
  } finally { server.close(); }
}));

test('malicious acknowledgement fields never echo credentials', async () => withHome(async home => {
  const grant = fakeGrant(), id = randomUUID();
  let response = { submission_id: grant, status: 'ready_for_review' };
  const { server, origin } = await fakeServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
  });
  try {
    const file = join(home, 'skill.json'); await writeFile(file, JSON.stringify(payload));
    for (const body of [{ submission_id: grant, status: 'ready_for_review' }, { submission_id: id, status: grant }]) {
      response = body;
      const result = await run(['submit', '--origin', origin, '--submission', id, '--file', file], { home, env: { FREEDOM_SKILL_UPLOAD_GRANT: grant } });
      assert.equal(result.code, 1); assert.equal(result.all.includes(grant), false); assert.equal(result.stdout, '');
    }
  } finally { server.close(); }
}));

test('symlinked config parent is rejected by init, config and reset', async () => withHome(async home => {
  const target = join(home, 'elsewhere'); await mkdir(target);
  await symlink(target, join(home, '.config'));
  for (const args of [['init','--origin','https://freetwai.com','--key-stdin'], ['config'], ['reset']]) {
    const result = await run(args, {home,stdin:fakeKey()}); assert.notEqual(result.code,0);
  }
}));

test('npm pack ships only the executable and public docs', () => {
  const [result] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: packageDir, encoding: 'utf8' }));
  assert.equal(result.name, '@freetwai/skill-upload');
  assert.equal(result.version, '0.1.0');
  assert.deepEqual(result.files.map(f => f.path).sort(), ['README.md', 'SKILL.md', 'bin/freedom-skill-upload.mjs', 'package.json', 'protocol.md']);
  const binFile = result.files.find(f => f.path === 'bin/freedom-skill-upload.mjs');
  assert.ok(binFile.mode & 0o111, 'bin is executable');
});
