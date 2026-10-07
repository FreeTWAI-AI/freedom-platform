import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
// @ts-expect-error The operator CLI is an ESM JavaScript module without declarations.
import { parseArgs, main, writeReceipt, refusalProblem } from '../../scripts/verify-guild-work.mjs';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';
import { nodeRuntime } from '../../apps/platform-api/src/app.js';
import { createPlatformApp } from '../../apps/platform-api/src/platform-app.js';
import { createR2ObjectStore, type AssetR2Binding } from '../../packages/asset-storage/r2.js';

interface Receipt {
  checks: { name: string; result: string; detail?: { requests?: { actor: string; status: number }[] } }[];
  coverage: { 'T-023': { export_restore: string } };
  digests: { attachment_bytes: number; attachment: string };
  versions: { work: string; note: string; result: string };
  ids: { A: { asset: string } };
  resumed_from?: string;
  run_id: string;
  note_run_id?: string;
}

const SHA = '687dee8739d9a8fc65a78fcb093347833cc004e8';
const scratch = await mkdtemp(join(tmpdir(), 'freedom-verify-guild-work-'));
after(() => rm(scratch, { recursive: true, force: true }));
const args = ['--expect-sha', SHA];

for (const [name, argv] of [
  ['non-loopback origin', [...args, '--origin', 'http://example.test:1234']],
  ['https loopback', [...args, '--origin', 'https://127.0.0.1:1234']],
  ['explicit staging override', [...args, '--origin', 'https://staging.freetwai.com']],
  ['origin credentials', [...args, '--origin', 'http://user:secret@127.0.0.1:1234']],
  ['origin path', [...args, '--origin', 'http://127.0.0.1:1234/private']],
  ['missing SHA', []], ['malformed SHA', ['--expect-sha', 'bad']],
  ['duplicate SHA', [...args, ...args]], ['unknown flag', [...args, '--token', 'secret']],
] as const) {
  test(`offline refusal: ${name}`, async () => {
    assert.throws(() => parseArgs(argv));
    const lines: string[] = [];
    assert.equal(await main(argv, {}, (line: string) => lines.push(line)), 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^FAIL arguments [a-z_]+$/);
    assert.ok(!lines[0].includes('secret'));
  });
}
test('offline refusal: staging token file missing, absent or malformed', async () => {
  const bad = join(scratch, 'malformed-token.json');
  await writeFile(bad, '{malformed');
  for (const env of [{}, { FREEDOM_ACCESS_TOKEN_FILE: join(scratch, 'missing.json') }, { FREEDOM_ACCESS_TOKEN_FILE: bad }]) {
    const lines: string[] = [];
    assert.equal(await main(args, env, (line: string) => lines.push(line)), 2);
    assert.deepEqual(lines, ['FAIL arguments access_token_unavailable']);
  }
});
test('offline refusal: resume origin or SHA differs before opening any request context', async () => {
  for (const [origin, expected_sha, code] of [
    ['http://127.0.0.1:9877', SHA, 'resume_origin_mismatch'],
    ['http://127.0.0.1:9876', 'a'.repeat(40), 'resume_sha_mismatch'],
  ]) {
    const path = join(scratch, randomUUID() + '.json');
    await writeFile(path, JSON.stringify({ origin, expected_sha, served_sha: expected_sha }));
    const lines: string[] = [];
    assert.equal(await main([...args, '--origin', 'http://127.0.0.1:9876', '--resume', path], {}, (line: string) => lines.push(line)), 2);
    assert.deepEqual(lines, [`FAIL arguments ${code}`]);
  }
});
const privateId = 'a1234567-1234-1234-1234-123456789abc';
const privateDigest = 'abc12345'.repeat(8);
const privateTitle = 'Work private fixture';
const markers = new Set([privateId, privateDigest, privateTitle, 'private-note.md', 'private note\n', Buffer.from('saved content prefix')]);
const problemBody = (status: number, code: string) => ({ type: 'about:blank', title: code, status, code, detail: 'Request refused.' });
for (const [status, code] of [[401, 'login_required'], [401, 'session_expired'], [404, 'not_found'],
  [404, 'tenant_not_found'], [405, 'method_not_allowed']] as const) {
  test(`offline refusal body: clean ${status} ${code}`, () => {
    assert.equal(refusalProblem(status, status, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(problemBody(status, code))), markers), null);
  });
}
const clean = problemBody(404, 'not_found');
for (const [name, body, headers, method, expected, failure] of [
  ['extra title key', { ...clean, work_title: 'Unseeded work title' }, {}, 'GET', 404, 'refusal_mismatch'],
  ['private title', { ...clean, title: privateTitle }, {}, 'GET', 404, 'bytes_leaked'],
  ['sha256 field', { ...clean, sha256: privateDigest }, {}, 'GET', 404, 'bytes_leaked'],
  ['ID in message', { ...clean, message: `Missing ${privateId}` }, {}, 'GET', 404, 'bytes_leaked'],
  ['ID in detail', { ...clean, detail: `Missing ${privateId}` }, {}, 'GET', 404, 'bytes_leaked'],
  ['digest ETag', clean, { ETag: `"${privateDigest}"` }, 'GET', 404, 'bytes_leaked'],
  ['HEAD digest ETag', '', { ETag: `"${privateDigest}"` }, 'HEAD', 404, 'bytes_leaked'],
  ['HEAD filename header', '', { 'Content-Disposition': 'attachment; filename="private-note.md"' }, 'HEAD', 404, 'bytes_leaked'],
  ['escaped note in detail', { ...clean, detail: 'private note\n' }, {}, 'GET', 404, 'bytes_leaked'],
  ['content prefix', 'saved content prefix with more bytes', {}, 'GET', 404, 'bytes_leaked'],
  ['wrong code', { ...clean, title: 'unexpected', code: 'unexpected' }, {}, 'GET', 404, 'refusal_mismatch'],
  ['wrong HTTP status', clean, {}, 'GET', 401, 'refusal_mismatch'],
  ['wrong body status', { ...clean, status: 401 }, {}, 'GET', 404, 'refusal_mismatch'],
  ['missing field', { type: clean.type, title: clean.title, status: clean.status, code: clean.code }, {}, 'GET', 404, 'refusal_mismatch'],
  ['non-string detail', { ...clean, detail: {} }, {}, 'GET', 404, 'refusal_mismatch'],
  ['array body', [clean], {}, 'GET', 404, 'refusal_mismatch'],
  ['null body', null, {}, 'GET', 404, 'refusal_mismatch'],
] as const) {
  test(`offline refusal body: ${name}`, () => {
    const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    assert.equal(refusalProblem(404, expected, headers, bytes, markers, method), failure);
  });
}
test('offline refusal body: clean HEAD has no JSON body', () => {
  assert.equal(refusalProblem(404, 404, {}, Buffer.alloc(0), markers, 'HEAD'), null);
});
for (const [name, checks, accepted] of [
  ['creation shape', ['preconditions', 'A creates', 'A logs out and back in', 'B and anonymous are refused'].map(name => ({ name, result: 'pass' })), true],
  ['resume shape', ['preconditions', 'A resumes', 'B and anonymous are refused'].map(name => ({ name, result: 'pass' })), true],
  ['wrong names', ['preconditions', 'A creates', 'B and anonymous are refused'].map(name => ({ name, result: 'pass' })), false],
  ['failed check', ['preconditions', 'A resumes', 'B and anonymous are refused'].map(name => ({ name, result: name === 'A resumes' ? 'fail' : 'pass' })), false],
  ['wrong order', ['A resumes', 'preconditions', 'B and anonymous are refused'].map(name => ({ name, result: 'pass' })), false],
  ['extra check', ['preconditions', 'A creates', 'A logs out and back in', 'B and anonymous are refused', 'extra'].map(name => ({ name, result: 'pass' })), false],
] as const) {
  test(`offline resume validation: ${name}`, async () => {
    const path = join(scratch, randomUUID() + '.json');
    await writeFile(path, JSON.stringify({
      format: 'freedom.staging-guild-work/v1', origin: 'https://staging.freetwai.com', expected_sha: SHA, served_sha: SHA,
      run_id: '20261007T123456000Z-abcdef01', note_run_id: '20261006T123456000Z-abcdef02', checks,
      ids: { A: Object.fromEntries(['tenant', 'workspace', 'work', 'note', 'result', 'note_asset', 'asset', 'original_note', 'original_note_asset', 'upload'].map(key => [key, randomUUID()])) },
      versions: Object.fromEntries(['tenant', 'workspace', 'work', 'note', 'result', 'note_work', 'result_work', 'original_note'].map(key => [key, '1'])),
      digests: { attachment: privateDigest, note: privateDigest, original_note: privateDigest, attachment_bytes: 65536 },
    }));
    const lines: string[] = [];
    // With no token file, an accepted receipt reaches the next argument gate, never a request context.
    assert.equal(await main([...args, '--resume', path], {}, (line: string) => lines.push(line)), 2);
    assert.deepEqual(lines, [`FAIL arguments ${accepted ? 'access_token_unavailable' : 'resume_invalid'}`]);
  });
}
test('receipt details discard cookies, unlabelled tokens and query strings; private modes', async () => {
  const receipt = { run_id: '20261007T123456000Z-abcdef01', checks: [{ name: 'redaction', result: 'fail', ms: 1, detail: {
    cookie: 'private-cookie', token: 'private-token', headers: { 'CF-Access-Client-Secret': 'private-access' },
    code: 'unlabelled-secret', path: '/api/v1/token-private-path', requests: [{ path: 'https://staging.freetwai.com/api/v1/session?token=private-query', status: 401 }],
  } }] };
  const path = await writeReceipt(join(scratch, 'redaction'), receipt);
  const text = await readFile(path, 'utf8');
  for (const secret of ['private-cookie', 'private-token', 'private-access', 'unlabelled-secret', 'private-query', '?token=', 'token-private-path']) assert.ok(!text.includes(secret));
  assert.equal(JSON.parse(text).checks[0].detail.requests[0].path, '/api/v1/session');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(scratch, 'redaction'))).mode & 0o777, 0o700);
});
function execute(argv: string[], evidence: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/verify-guild-work.mjs', ...argv], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, FREEDOM_STAGING_EVIDENCE_DIR: evidence },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

test('local real product routes, PostgreSQL and native local R2: create, resume and fail closed', { timeout: 240000 }, async () => {
  const database = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
  const schema = `fp_j4_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString: database });
  const pool = new Pool({ connectionString: database, options: `-c search_path=${schema}`, max: 12 });
  const role = `${schema}_runtime`;
  let mf: Miniflare | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let runtimePool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await seedLocal(pool);
    const guild = (await pool.query('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key;
    // Operator fixture prerequisites, never a verifier write or a user update.
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
      VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, DEMO_USERS[0].user_id, guild]);
    await pool.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,
      max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,max_model_budget,status)
      VALUES($1,1,NULL,'j4-local-operator-fixture',10,3,2,1000,104857600,4,NULL,'active')`, [randomUUID()]);
    mf = new Miniflare(convertV4MiniflareOptions({
      cachePersist: join(scratch, 'cache'), r2Persist: join(scratch, 'r2'),
      workers: [{ name: 'j4-local-r2', modules: true, script: 'export default { fetch() { return new Response("local R2 only"); } }',
        compatibilityDate: '2026-09-21', r2Buckets: ['MEDIA'] }],
    }));
    await mf.ready;
    const bucket = await mf.getR2Bucket('MEDIA');
    const store = createR2ObjectStore(bucket as unknown as AssetR2Binding);
    let app: ReturnType<typeof createPlatformApp>;
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: req => app.fetch(req) });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    await admin.query(`REVOKE INSERT, UPDATE, DELETE ON ${schema}.tenant_capacity_policies FROM ${role}`);
    await admin.query(`GRANT UPDATE(policy_lock) ON ${schema}.tenant_capacity_policies TO ${role}`);
    runtimePool = new Pool({ connectionString: database, options: `-c search_path=${schema} -c role=${role}`, max: 12 });
    const runtime = nodeRuntime('local', origin, { guildLaunchpadEnabled: true, tenantWorkAssetStore: store });
    // Node has no release identity. Inject exactly the Worker health metadata field.
    runtime.health = { release_sha: SHA };
    app = createPlatformApp(runtimePool, origin, 'local', runtime);
    const evidence = join(scratch, 'evidence');
    const first = await execute([...args, '--origin', origin], evidence);
    assert.equal(first.code, 0, JSON.stringify(first));
    assert.equal(first.stderr, '');
    const [file] = await readdir(evidence), path = join(evidence, file);
    const receipt: Receipt = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(receipt.checks.map(check => [check.name, check.result]), [
      ['preconditions', 'pass'], ['A creates', 'pass'], ['A logs out and back in', 'pass'], ['B and anonymous are refused', 'pass'],
    ]);
    assert.match(receipt.coverage['T-023'].export_restore, /^not_run \(no export route at /);
    assert.equal(receipt.digests.attachment_bytes, 65536);
    assert.equal(receipt.versions.work, '4');
    assert.equal(receipt.versions.note, '3');
    assert.equal(receipt.versions.result, '2');
    const rows = (await pool.query('SELECT result_id,asset_id,content_sha256,byte_size FROM tenant_work_results ORDER BY revision')).rows;
    assert.equal(rows.length, 3);
    const objects = (await bucket.list()).objects;
    assert.equal(objects.length, 3);
    const asset = objects.find(object => object.key.includes(receipt.ids.A.asset));
    assert.ok(asset);
    const object = await bucket.get(asset.key);
    assert.ok(object);
    const bytes = Buffer.from(await object.arrayBuffer());
    assert.equal(bytes.length, 65536);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.digests.attachment);
    const lastCheck = receipt.checks.at(-1);
    assert.ok(lastCheck?.detail?.requests);
    const refusals = lastCheck.detail.requests;
    assert.ok(refusals.length >= 42);
    assert.ok(refusals.some(item => item.actor === 'anonymous' && item.status === 401));
    assert.ok(refusals.some(item => item.actor === 'B' && item.status === 405));
    const users = (await pool.query('SELECT user_id,email,password_hash FROM users ORDER BY user_id')).rows;
    const second = await execute([...args, '--origin', origin, '--resume', path], evidence);
    assert.equal(second.code, 0, JSON.stringify(second));
    const resumeFile = (await readdir(evidence)).find(name => name !== file);
    assert.ok(resumeFile);
    const resumed: Receipt = JSON.parse(await readFile(join(evidence, resumeFile), 'utf8'));
    assert.deepEqual(resumed.checks.map(check => check.name), ['preconditions', 'A resumes', 'B and anonymous are refused']);
    assert.deepEqual(resumed.ids.A, receipt.ids.A);
    assert.deepEqual(resumed.versions, receipt.versions);
    assert.deepEqual(resumed.digests, receipt.digests);
    assert.equal(resumed.resumed_from, file);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_work_results')).rows[0].n, 3);
    const third = await execute([...args, '--origin', origin, '--resume', join(evidence, resumeFile)], evidence);
    assert.equal(third.code, 0, JSON.stringify(third));
    assert.equal(third.stderr, '');
    const thirdFile = (await readdir(evidence)).find(name => name !== file && name !== resumeFile);
    assert.ok(thirdFile);
    const resumedAgain: Receipt = JSON.parse(await readFile(join(evidence, thirdFile), 'utf8'));
    assert.deepEqual(resumedAgain.checks.map(check => [check.name, check.result]), [
      ['preconditions', 'pass'], ['A resumes', 'pass'], ['B and anonymous are refused', 'pass'],
    ]);
    assert.deepEqual(resumedAgain.ids.A, receipt.ids.A);
    assert.deepEqual(resumedAgain.versions, receipt.versions);
    assert.deepEqual(resumedAgain.digests, receipt.digests);
    assert.equal(resumedAgain.resumed_from, resumeFile);
    assert.equal(resumed.note_run_id, receipt.run_id);
    assert.equal(resumedAgain.note_run_id, receipt.run_id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_work_results')).rows[0].n, 3);
    // A corrupt native object makes the real product content reader refuse resume.
    await bucket.put(asset.key, Buffer.from('corrupt object'), { httpMetadata: asset.httpMetadata, customMetadata: asset.customMetadata });
    const corrupt = await execute([...args, '--origin', origin, '--resume', path], join(scratch, 'corrupt'));
    assert.equal(corrupt.code, 1, JSON.stringify(corrupt));
    assert.match(corrupt.stdout, /FAIL A resumes (request_failed|readback_mismatch)/);
    await bucket.put(asset.key, bytes, { httpMetadata: asset.httpMetadata, customMetadata: asset.customMetadata });
    assert.deepEqual((await pool.query('SELECT user_id,email,password_hash FROM users ORDER BY user_id')).rows, users);
    // Rejected preconditions still write a receipt and never reach a member action.
    for (const [health, enabled, expectedCode] of [
      [undefined, true, 'build_identity_unavailable'],
      [{ release_sha: 'a'.repeat(40) }, true, 'build_identity_mismatch'],
      [{ release_sha: SHA }, false, 'launchpad_disabled'],
    ] as const) {
      runtime.health = health; runtime.guildLaunchpadEnabled = enabled;
      app = createPlatformApp(runtimePool, origin, 'local', runtime);
      const dir = join(scratch, expectedCode);
      const rejected = await execute([...args, '--origin', origin], dir);
      assert.equal(rejected.code, 2, JSON.stringify(rejected));
      assert.equal(rejected.stdout, `FAIL preconditions ${expectedCode}\n`);
      const [file] = await readdir(dir), failed = JSON.parse(await readFile(join(dir, file), 'utf8'));
      assert.equal(failed.checks.length, 1);
      assert.equal(failed.checks[0].detail.code, expectedCode);
      assert.deepEqual(failed.ids, { A: {}, B: {} });
    }
    // Real capacity policy refusal after login/creation, with a failing receipt.
    runtime.health = { release_sha: SHA }; runtime.guildLaunchpadEnabled = true;
    app = createPlatformApp(runtimePool, origin, 'local', runtime);
    await pool.query("UPDATE tenant_capacity_policies SET status='retired'");
    const denied = await execute([...args, '--origin', origin], join(scratch, 'policy'));
    assert.equal(denied.code, 1, JSON.stringify(denied));
    assert.match(denied.stdout, /FAIL A creates policy_unconfigured/);
  } finally {
    const errors: unknown[] = [];
    const activeServer = server;
    for (const cleanup of [
      () => activeServer && new Promise<void>((resolve, reject) => activeServer.close(error => error ? reject(error) : resolve())),
      () => mf?.dispose(), () => runtimePool?.end(), () => pool.end(),
      () => admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
      () => admin.query(`DROP ROLE IF EXISTS ${role}`), () => admin.end(),
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Guild Work fixture cleanup failed');
  }
});
