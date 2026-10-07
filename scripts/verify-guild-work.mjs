// Operator-only staging evidence. Importing this file performs no I/O.
import { request } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STAGING = 'https://staging.freetwai.com';
const FORMAT = 'freedom.staging-guild-work/v1';
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[1-9][0-9]{0,18}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const evidenceSegments = new Set(['api', 'v1', 'session', 'health', 'site', 'auth', 'login', 'logout', 'guilds', 'directory',
  'tenants', 'workspaces', 'works', 'results', 'uploads', 'content', 'manual-work', 'module-instances', 'launchpad-context', 'assets', 'variants']);
const evidencePath = path => path.startsWith('/api/v1/') && path.split('/').slice(1).every(part => evidenceSegments.has(part) || UUID.test(part));
const RUN = /^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}$/;
const safeCodes = new Set(['bad_arguments', 'origin_refused', 'expect_sha_required', 'access_token_unavailable',
  'resume_invalid', 'resume_origin_mismatch', 'resume_sha_mismatch', 'launchpad_disabled', 'build_identity_unavailable',
  'build_identity_mismatch', 'health_failed', 'access_challenge_failed', 'request_failed', 'response_invalid',
  'policy_unconfigured', 'guild_full_member_required', 'readback_mismatch', 'refusal_mismatch', 'bytes_leaked',
  'logout_failed', 'unexpected_error', 'not_found', 'tenant_not_found', 'method_not_allowed', 'session_required',
  'session_expired', 'login_required', 'A', 'B', 'anonymous', 'GET', 'HEAD', 'pass', 'fail']);
class Failure extends Error {
  constructor(code, detail = {}, exitCode = 1) { super(code); this.code = code; this.detail = detail; this.exitCode = exitCode; }
}
function requireThat(ok, code, detail = {}, exitCode = 1) { if (!ok) throw new Failure(code, detail, exitCode); }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const increment = value => String(BigInt(value) + 1n);

export function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    requireThat(['--expect-sha', '--origin', '--resume'].includes(flag) && !values.has(flag)
      && typeof value === 'string' && !value.startsWith('--'), 'bad_arguments', {}, 2);
    values.set(flag, value);
  }
  const expectedSha = values.get('--expect-sha')?.toLowerCase();
  requireThat(SHA.test(expectedSha ?? ''), 'expect_sha_required', {}, 2);
  let origin = STAGING;
  if (values.has('--origin')) {
    const raw = values.get('--origin');
    let url; try { url = new URL(raw); } catch { throw new Failure('origin_refused', {}, 2); }
    requireThat(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
      && raw === url.origin, 'origin_refused', {}, 2);
    origin = url.origin;
  }
  return { origin, expectedSha, resume: values.get('--resume') };
}

// Details use a closed value vocabulary, so even unlabelled upstream secrets disappear.
// URLs are retained as paths only; response bodies/headers and errors never enter evidence.
export function redactDetail(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.startsWith('/') || /^https?:\/\//.test(value)) {
      try {
        const path = new URL(value, STAGING).pathname;
        return evidencePath(path) ? path : '[redacted]';
      } catch { return '[redacted]'; }
    }
    return safeCodes.has(value) ? value : '[redacted]';
  }
  if (Array.isArray(value)) return value.map(redactDetail);
  if (value && typeof value === 'object') {
    const keys = new Set(['code', 'status', 'expected_status', 'path', 'method', 'actor', 'requests', 'count', 'loopback', 'bytes', 'range']);
    return Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key)).map(([key, item]) => [key, redactDetail(item)]));
  }
  return '[redacted]';
}
export async function writeReceipt(directory, receipt) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const clean = { ...receipt, checks: receipt.checks.map(check => ({
    name: check.name, result: check.result, ms: check.ms, detail: redactDetail(check.detail),
  })) };
  const path = join(directory, `guild-work-${receipt.run_id}.json`);
  await writeFile(path, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return path;
}
async function previousReceipt(path, cli) {
  let previous;
  try {
    const stat = await lstat(path);
    requireThat(stat.isFile() && stat.size <= 1024 * 1024, 'resume_invalid', {}, 2);
    previous = JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new Failure('resume_invalid', {}, 2); }
  requireThat(previous.origin === cli.origin, 'resume_origin_mismatch', {}, 2);
  requireThat(previous.expected_sha === cli.expectedSha && previous.served_sha === cli.expectedSha, 'resume_sha_mismatch', {}, 2);
  requireThat(previous.format === FORMAT && RUN.test(previous.run_id) && RUN.test(previous.note_run_id ?? previous.run_id)
    && previous.checks?.length >= 4 && previous.checks.every(check => check.result === 'pass'), 'resume_invalid', {}, 2);
  const a = previous.ids?.A, versions = previous.versions, digests = previous.digests;
  requireThat(a && ['tenant', 'workspace', 'work', 'note', 'result', 'note_asset', 'asset', 'original_note', 'original_note_asset', 'upload'].every(key => UUID.test(a[key]))
    && versions && ['tenant', 'workspace', 'work', 'note', 'result', 'note_work', 'result_work', 'original_note'].every(key => VERSION.test(versions[key]))
    && digests && ['attachment', 'note', 'original_note'].every(key => DIGEST.test(digests[key]))
    && digests.attachment_bytes === 65536, 'resume_invalid', {}, 2);
  return previous;
}
async function accessHeaders(env, staging) {
  if (!staging) return {};
  try {
    requireThat(Boolean(env.FREEDOM_ACCESS_TOKEN_FILE), 'access_token_unavailable', {}, 2);
    const token = JSON.parse(await readFile(env.FREEDOM_ACCESS_TOKEN_FILE, 'utf8'));
    requireThat(typeof token.client_id === 'string' && token.client_id.length > 0
      && typeof token.client_secret === 'string' && token.client_secret.length > 0, 'access_token_unavailable', {}, 2);
    return { 'CF-Access-Client-Id': token.client_id, 'CF-Access-Client-Secret': token.client_secret };
  } catch { throw new Failure('access_token_unavailable', {}, 2); }
}

export async function main(argv, env = process.env, log = line => console.log(line)) {
  let cli, previous, headers;
  try {
    cli = parseArgs(argv);
    previous = cli.resume ? await previousReceipt(cli.resume, cli) : null;
    headers = await accessHeaders(env, cli.origin === STAGING);
  } catch (error) {
    log(`FAIL arguments ${error instanceof Failure ? error.code : 'unexpected_error'}`);
    return 2;
  }
  const runId = new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomBytes(4).toString('hex');
  const receipt = {
    format: FORMAT, origin: cli.origin, expected_sha: cli.expectedSha, served_sha: null, run_id: runId,
    started_at: new Date().toISOString(), finished_at: null, environment: cli.origin === STAGING ? 'staging' : 'local', checks: [], ids: { A: {}, B: {} }, digests: {}, versions: {},
    coverage: { 'T-005': 'not_run', 'T-023': { permission: 'not_run', export_restore: `not_run (no export route at ${cli.expectedSha})` } },
    ...(previous ? { resumed_from: `guild-work-${previous.run_id}.json`, note_run_id: previous.note_run_id ?? previous.run_id } : {}),
  };
  const contexts = [];
  const open = async (access = true) => {
    const context = await request.newContext({ timeout: 30000 }); contexts.push(context);
    return { context, csrf: null, access };
  };
  const send = async (actor, method, path, options = {}) => {
    const url = new URL(path, cli.origin);
    requireThat(url.origin === cli.origin && path.startsWith('/') && !path.startsWith('//'), 'response_invalid');
    const sent = { ...(actor.access && cli.origin === STAGING ? headers : {}), ...options.headers };
    if (!['GET', 'HEAD'].includes(method)) {
      sent.Origin = cli.origin;
      if (actor.csrf) sent['X-CSRF-Token'] = actor.csrf;
      sent['Idempotency-Key'] = randomUUID();
      if (options.version) sent['If-Match'] = `"${options.version}"`;
    }
    return actor.context.fetch(url.href, { method, headers: sent, data: options.data, maxRedirects: 0 });
  };
  const json = async (actor, method, path, data, version, status = 200) => {
    const response = await send(actor, method, path, { data, version });
    let body; try { body = await response.json(); } catch { throw new Failure('response_invalid', { path, status: response.status() }); }
    requireThat(response.status() === status, ['policy_unconfigured', 'guild_full_member_required'].includes(body.code)
      ? body.code : 'request_failed', { path, status: response.status(), expected_status: status });
    return body;
  };
  const login = async email => {
    const actor = await open();
    const body = await json(actor, 'POST', '/api/v1/auth/login', { email, password: 'freedom-local-demo' });
    requireThat(typeof body.csrf_token === 'string' && body.csrf_token.length > 0 && body.user?.email === email, 'response_invalid');
    actor.csrf = body.csrf_token; return actor;
  };
  let exitCode = 0, a;
  const check = async (name, run) => {
    const start = performance.now();
    try {
      const detail = redactDetail(await run());
      receipt.checks.push({ name, result: 'pass', ms: Math.round(performance.now() - start), detail });
      log(`PASS ${name}`);
    } catch (error) {
      const failure = error instanceof Failure ? error : new Failure('unexpected_error');
      const detail = redactDetail({ ...failure.detail, code: failure.code });
      receipt.checks.push({ name, result: 'fail', ms: Math.round(performance.now() - start), detail });
      log(`FAIL ${name} ${failure.code}`); throw failure;
    }
  };
  const id = value => { requireThat(UUID.test(value), 'response_invalid'); return value; };
  const version = value => { requireThat(VERSION.test(value), 'response_invalid'); return value; };
  const tenantPath = () => `/api/v1/tenants/${receipt.ids.A.tenant}`;
  const workPath = () => `${tenantPath()}/works/${receipt.ids.A.work}`;
  const resultPath = result => `${workPath()}/results/${result}`;
  const noteText = edited => `Guild work note ${receipt.note_run_id ?? runId}${edited ? ' continued after login' : ''}\n`;
  const receivedContent = new Set();
  const privatePrefixes = new Map();
  const discover = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /(?:url|href)$/i.test(key)) {
        const url = new URL(item, cli.origin);
        requireThat(url.origin === cli.origin && !url.search && !url.hash && url.pathname.startsWith('/api/v1/'), 'response_invalid');
        receivedContent.add(url.pathname);
      } else discover(item);
    }
  };
  const readJson = async path => { const value = await json(a, 'GET', path); if (receipt.ids.A.work && path.startsWith(workPath())) discover(value); return value; };
  const content = async (result, digest, size) => {
    const path = `${resultPath(result)}/content`; receivedContent.add(path);
    const response = await send(a, 'GET', path), bytes = await response.body();
    requireThat(response.status() === 200 && bytes.length === size && hash(bytes) === digest, 'readback_mismatch', { path });
    privatePrefixes.set(path, bytes.subarray(0, Math.min(16, bytes.length)));
    return bytes;
  };
  const saveResult = async (bytes, name, contentType) => {
    const work = await readJson(workPath());
    const prepared = await json(a, 'POST', `${workPath()}/results/uploads`, {
      content_type: contentType, byte_size: bytes.length, sha256: hash(bytes), display_name: name, expected_work_version: work.version,
    }, undefined, 201);
    const uploadId = id(prepared.resource_ref?.resource_id), uploadPath = `${workPath()}/results/uploads/${uploadId}`;
    const upload = await readJson(uploadPath);
    requireThat(upload.upload_id === uploadId && upload.work_id === receipt.ids.A.work && upload.sha256 === hash(bytes)
      && upload.byte_size === bytes.length && upload.display_name === name, 'readback_mismatch');
    const written = await json(a, 'PUT', uploadPath + '/content', bytes, version(upload.version));
    requireThat(written.upload_id === uploadId && written.verified === true && written.version === increment(upload.version), 'readback_mismatch');
    const stored = await readJson(uploadPath);
    requireThat(stored.phase === 'stored' && stored.version === written.version && stored.asset_id === upload.asset_id, 'readback_mismatch');
    const finalized = await json(a, 'POST', uploadPath + '/finalize', { expected_work_version: work.version }, written.version);
    const resultId = id(finalized.resource_ref?.resource_id), result = await readJson(resultPath(resultId));
    const after = await readJson(workPath()), finished = await readJson(uploadPath);
    requireThat(result.result_id === resultId && result.work_id === work.work_id && result.asset_id === upload.asset_id
      && result.sha256 === hash(bytes) && result.byte_size === bytes.length && result.provenance === 'human'
      && result.work_version === increment(work.version) && after.version === result.work_version
      && after.current_result_id === resultId && finished.phase === 'finalized', 'readback_mismatch');
    await content(resultId, hash(bytes), bytes.length);
    return { resultId, assetId: id(result.asset_id), uploadId, revision: version(result.revision), workVersion: version(after.version) };
  };
  const readBack = async () => {
    const ids = receipt.ids.A, v = receipt.versions, d = receipt.digests;
    const tenant = await readJson(tenantPath());
    const spaces = await readJson(tenantPath() + '/workspaces');
    const space = spaces.items.find(item => item.workspace_id === ids.workspace);
    const work = await readJson(workPath());
    requireThat(tenant.tenant_id === ids.tenant && tenant.version === v.tenant && space?.tenant_id === ids.tenant
      && space.version === v.workspace && work.work_id === ids.work && work.workspace_id === ids.workspace
      && work.tenant_id === ids.tenant && work.version === v.work, 'readback_mismatch');
    const list = await readJson(workPath() + '/results');
    const original = await readJson(resultPath(ids.original_note));
    requireThat(original.result_id === ids.original_note && original.work_id === ids.work
      && original.revision === v.original_note && original.asset_id === ids.original_note_asset && original.sha256 === d.original_note, 'readback_mismatch');
    await content(ids.original_note, d.original_note, Buffer.byteLength(noteText(false)));
    for (const [resultId, assetId, revision, workVersion, digest, size] of [
      [ids.note, ids.note_asset, v.note, v.note_work, d.note, Buffer.byteLength(noteText(true))],
      [ids.result, ids.asset, v.result, v.result_work, d.attachment, d.attachment_bytes],
    ]) {
      const result = await readJson(resultPath(resultId));
      requireThat(list.items.some(item => item.result_id === resultId) && result.result_id === resultId
        && result.work_id === ids.work && result.asset_id === assetId && result.revision === revision
        && result.work_version === workVersion && result.sha256 === digest && result.byte_size === size, 'readback_mismatch');
      await content(resultId, digest, size);
    }
  };
  try {
    await check('preconditions', async () => {
      if (cli.origin === STAGING) {
        const visitor = await open(false), denied = await send(visitor, 'GET', '/');
        let location; try { location = new URL(denied.headers().location); } catch { /* fixed failure below */ }
        requireThat(denied.status() === 302 && location?.hostname.endsWith('.cloudflareaccess.com'), 'access_challenge_failed', {}, 2);
      }
      const http = await open(), health = await json(http, 'GET', '/api/v1/health');
      requireThat(health.status === 'ok' && health.mode === (cli.origin === STAGING ? 'staging' : 'local')
        && health.money_movement_enabled === false, 'health_failed', {}, 2);
      const site = await json(http, 'GET', '/api/v1/site');
      requireThat(site.guild_launchpad_enabled === true, 'launchpad_disabled', {}, 2);
      requireThat(SHA.test(health.release_sha ?? ''), 'build_identity_unavailable', {}, 2);
      receipt.served_sha = health.release_sha;
      requireThat(health.release_sha === cli.expectedSha, 'build_identity_mismatch', {}, 2);
      return { loopback: cli.origin !== STAGING };
    });
    if (previous) {
      await check('A resumes', async () => {
        receipt.ids.A = Object.fromEntries(['tenant', 'workspace', 'work', 'note', 'result', 'note_asset', 'asset', 'original_note', 'original_note_asset', 'upload'].map(key => [key, previous.ids.A[key]]));
        receipt.versions = Object.fromEntries(['tenant', 'workspace', 'work', 'note', 'result', 'note_work', 'result_work', 'original_note'].map(key => [key, previous.versions[key]]));
        receipt.digests = Object.fromEntries(['attachment', 'note', 'original_note', 'attachment_bytes'].map(key => [key, previous.digests[key]]));
        a = await login('maker@local.test'); await readBack();
        receipt.coverage['T-005'] = 'pass (resume: persisted IDs, versions and byte digests; original receipt covers creation/edit)';
        return {};
      });
    } else {
      await check('A creates', async () => {
        a = await login('maker@local.test');
        const guilds = await readJson('/api/v1/guilds/directory');
        const guild = guilds.items.find(item => item.membership?.state === 'active' && item.membership.member_tier === 'full');
        requireThat(guild, 'guild_full_member_required');
        const made = await json(a, 'POST', '/api/v1/tenants', { display_name: `A ${runId}`, workspace_name: `Default ${runId}` }, undefined, 201);
        const ids = receipt.ids.A, v = receipt.versions;
        ids.tenant = id(made.tenant.tenant_id); v.tenant = version(made.tenant.version);
        const workspace = await json(a, 'POST', tenantPath() + '/workspaces', { name: `Workspace ${runId}` }, undefined, 201);
        ids.workspace = id(workspace.workspace_id); v.workspace = version(workspace.version);
        await json(a, 'POST', `${tenantPath()}/workspaces/${ids.workspace}/manual-work`, { guild_key: guild.guild_key });
        const created = await json(a, 'POST', `${tenantPath()}/workspaces/${ids.workspace}/works`, {
          title: `Work ${runId}`, objective: `Manual work ${runId}`, progress: 'todo',
        }, undefined, 201);
        ids.work = id(created.resource_ref?.resource_id);
        const note = await saveResult(Buffer.from(noteText(false)), `note-${runId}.md`, 'text/markdown');
        ids.note = note.resultId; ids.original_note = note.resultId; ids.original_note_asset = note.assetId; ids.note_asset = note.assetId;
        v.original_note = note.revision; receipt.digests.original_note = hash(Buffer.from(noteText(false)));
        // Uniformly random printable bytes: the product accepts UTF-8 text, not arbitrary binary.
        const bytes = randomBytes(65536).map(byte => 0x20 + (byte & 0x3f));
        const file = await saveResult(bytes, `attachment-${runId}.txt`, 'text/plain');
        ids.result = file.resultId; ids.asset = file.assetId; ids.upload = file.uploadId;
        v.work = file.workVersion; v.result = file.revision; v.result_work = file.workVersion;
        receipt.digests.attachment = hash(bytes); receipt.digests.attachment_bytes = bytes.length;
        const original = await readJson(resultPath(ids.note));
        requireThat(original.revision === note.revision && original.asset_id === ids.note_asset, 'readback_mismatch');
        await content(ids.note, receipt.digests.original_note, Buffer.byteLength(noteText(false)));
        return { bytes: bytes.length };
      });
      await check('A logs out and back in', async () => {
        // Preserve the server-issued jar without depending on a cookie name.
        const stale = { context: await request.newContext({ storageState: await a.context.storageState(), timeout: 30000 }), access: true };
        contexts.push(stale.context);
        await json(a, 'POST', '/api/v1/auth/logout', {});
        requireThat((await send(stale, 'GET', '/api/v1/session')).status() === 401
          && (await send(a, 'GET', '/api/v1/session')).status() === 401, 'logout_failed');
        a = await login('maker@local.test');
        const work = await readJson(workPath());
        requireThat(work.version === receipt.versions.work && work.work_id === receipt.ids.A.work, 'readback_mismatch');
        await content(receipt.ids.A.original_note, receipt.digests.original_note, Buffer.byteLength(noteText(false)));
        await content(receipt.ids.A.result, receipt.digests.attachment, 65536);
        const edited = await saveResult(Buffer.from(noteText(true)), `note-${runId}.md`, 'text/markdown');
        requireThat(edited.workVersion === increment(work.version) && BigInt(edited.revision) > BigInt(receipt.versions.original_note), 'readback_mismatch');
        receipt.ids.A.note = edited.resultId; receipt.ids.A.note_asset = edited.assetId;
        receipt.versions.work = edited.workVersion; receipt.versions.note = edited.revision; receipt.versions.note_work = edited.workVersion;
        receipt.digests.note = hash(Buffer.from(noteText(true)));
        await readBack();
        receipt.coverage['T-005'] = 'pass (manual Work, note Result, attachment Result, logout/login and next note revision; HTTP/DB/object bytes)';
        return {};
      });
    }
    await check('B and anonymous are refused', async () => {
      const b = await login('reviewer@local.test'), anon = await open();
      const made = await json(b, 'POST', '/api/v1/tenants', { display_name: `B ${runId}`, workspace_name: `B workspace ${runId}` }, undefined, 201);
      receipt.ids.B = { tenant: id(made.tenant.tenant_id), workspace: id(made.workspace.workspace_id), work: null, note: null, result: null, asset: null };
      // Read every page; a later page cannot conceal A's ID from the verifier.
      const list = async path => {
        let cursor, seen = new Set();
        do {
          const page = await json(b, 'GET', path + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
          requireThat(Array.isArray(page.items) && !page.items.some(item => JSON.stringify(item).includes(receipt.ids.A.tenant)
            || JSON.stringify(item).includes(receipt.ids.A.work)), 'readback_mismatch');
          cursor = page.next_cursor;
          requireThat(!cursor || (typeof cursor === 'string' && !seen.has(cursor) && seen.size < 100), 'response_invalid');
          if (cursor) seen.add(cursor);
        } while (cursor);
      };
      await list('/api/v1/tenants');
      await list(`/api/v1/tenants/${receipt.ids.B.tenant}/workspaces/${receipt.ids.B.workspace}/works`);
      const metadataPaths = [tenantPath(), `${tenantPath()}/workspaces`, workPath(),
        `${tenantPath()}/workspaces/${receipt.ids.A.workspace}/works`, resultPath(receipt.ids.A.original_note),
        resultPath(receipt.ids.A.note), resultPath(receipt.ids.A.result), `${workPath()}/results/uploads/${receipt.ids.A.upload}`];
      const contentPaths = [...receivedContent];
      const statuses = [];
      for (const [actorName, actor, paths] of [['B', b, [...metadataPaths, ...contentPaths]], ['anonymous', anon, contentPaths]]) {
        for (const path of [...new Set(paths)]) {
          for (const [method, range] of [['GET', false], ['HEAD', false], ['GET', true]]) {
            const response = await send(actor, method, path, { headers: range ? { Range: 'bytes=0-15' } : {} });
            const bytes = await response.body();
            const isContent = contentPaths.includes(path);
            const expected = actorName === 'anonymous' ? 401 : isContent && (method === 'HEAD' || range) ? 405 : 404;
            statuses.push({ actor: actorName, path, method, status: response.status(), expected_status: expected, range });
            const prefixes = [...privatePrefixes.values()];
            requireThat(!prefixes.some(prefix => bytes.includes(prefix)) && hash(bytes) !== receipt.digests.attachment, 'bytes_leaked', { requests: statuses });
            requireThat(response.status() === expected, 'refusal_mismatch', { requests: statuses });
            if (method !== 'HEAD') {
              let body; try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new Failure('refusal_mismatch', { requests: statuses }); }
              const codes = expected === 405 ? ['method_not_allowed'] : expected === 404 ? ['tenant_not_found', 'not_found'] : ['login_required', 'session_expired'];
              requireThat(codes.includes(body.code), 'refusal_mismatch', { requests: statuses });
            }
          }
        }
      }
      receipt.coverage['T-023'].permission = 'pass (all issued content paths; GET/HEAD/Range; B and Access-only anonymous; no separate object/variant URL issued)';
      return { requests: statuses, count: statuses.length };
    });
  } catch (error) {
    exitCode = error instanceof Failure ? error.exitCode : 1;
    // Any precondition failure happens before member actions, so it is a refusal.
    if (receipt.checks.at(-1)?.name === 'preconditions') exitCode = 2;
  } finally {
    receipt.finished_at = new Date().toISOString();
    await writeReceipt(env.FREEDOM_STAGING_EVIDENCE_DIR ?? join(homedir(), '.local/state/freedom-staging/verification'), receipt);
    await Promise.allSettled(contexts.map(context => context.dispose()));
  }
  return exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    console.error('FAIL receipt unexpected_error'); process.exitCode = 1;
  });
}
