// Host installation only. Never load this file from a candidate checkout.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, realpath, readlink, rm, chmod, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, relative, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { runMemberRouteBehavior, behaviorFixtureIdentity, installedBehaviorHarnessDigest } from './behavior-harness.mjs';
import { installedVerifierDigest, validateHostEvidenceBinding, validateHostWorkflow } from './trusted-ci.mjs';
import { MEMBER_BEHAVIOR as manifest } from './behavior-manifest.mjs';
import { artifactPath, parseJson } from './io.mjs';
import { verificationEnvironment } from './process-env.mjs';
import { createConsumerHttpFixture, CONSUMER_BEHAVIOR_PROFILES, CONSUMER_CLI_PROFILES } from './consumer-behavior-fixture.mjs';
import { inspectConsumerRuntime } from './consumer-runtime-recipe.mjs';
import { DIRECTORY_REPOSITORY, directoryBuildCases, checkDirectoryBuildArchive } from './directory-build-fixture.mjs';
import { directoryHtmlDependencyIdentity } from './directory-html-dependencies.mjs';

// Member mode retains its cached local image identities; consumer mode uses the
// separately provisioned public recipe. Neither is operator trust approval.
const BASE_IMAGE = 'sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171';
const PG_IMAGE = 'sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Current genuine import graph measured275 descriptors in an isolated container.
// Finite per-process ceilings; every Docker observation attests these exact values.
export const SUPERVISOR_NOFILE = Object.freeze({ candidate: 512, database: 256 });
export function validateSupervisorUlimits(ulimits, kind) {
  if (!Object.hasOwn(SUPERVISOR_NOFILE, kind) || !Array.isArray(ulimits) || ulimits.length !== 2) fail('supervisor_container_changed');
  const found = new Map();
  for (const item of ulimits) {
    if (!item || Object.keys(item).sort().join(',') !== 'Hard,Name,Soft' || found.has(item.Name)
      || !['nofile', 'core'].includes(item.Name)) fail('supervisor_container_changed');
    const expected = item.Name === 'nofile' ? SUPERVISOR_NOFILE[kind] : 0;
    if (item.Soft !== expected || item.Hard !== expected) fail('supervisor_container_changed');
    found.set(item.Name, Object.freeze({ Name: item.Name, Soft: item.Soft, Hard: item.Hard }));
  }
  if (!found.has('nofile') || !found.has('core')) fail('supervisor_container_changed');
  return Object.freeze([...found.values()].sort((a,b)=>a.Name.localeCompare(b.Name)));
}
const LIMITS = Object.freeze({ files: 8192, sourceBytes: 64 * 1024 * 1024, dependencyBytes: 512 * 1024 * 1024,
  frameBytes: 384 * 1024, outputBytes: 4 * 1024 * 1024, stderrBytes: 16384, wallMs: 120000 });
const fail = code => { throw new Error(code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const env = () => ({ ...verificationEnvironment(), PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' });
function command(executable, args, options = {}) {
  try { return execFileSync(executable, args, { env: env(), timeout: 15000, maxBuffer: LIMITS.sourceBytes + 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...options }); } catch { return fail('supervisor_host_command_failed'); }
}
const docker = (args, extraEnvironment = {}) => command('/usr/bin/docker', args, { env: { ...env(), ...extraEnvironment } });
/** Docker may finish a create after its CLI times out. A later empty listing is
 * not an acknowledgement or cancellation of that request. Keep uncertainty for
 * this invocation even if best-effort cleanup finds and removes a labeled ID. */
export function createSupervisorContainerLifecycle() {
  const dispatches = [];
  return Object.freeze({
    dispatch(kind, operation, invoke) {
      if (!['candidate', 'database'].includes(kind) || !['create', 'run'].includes(operation)
        || typeof invoke !== 'function') fail('supervisor_create_dispatch_invalid');
      const entry = { kind, operation, state: 'create_pending' };
      dispatches.push(entry); // Before calling Docker, including timeout/unknown ACK paths.
      const id = invoke().toString().trim();
      if (!/^[a-f0-9]{64}$/.test(id)) fail('supervisor_host_command_failed');
      entry.state = 'acknowledged';
      return id;
    },
    cleanupState(labelScanEmpty) {
      const pending = dispatches.filter(entry => entry.state === 'create_pending').map(entry => ({ ...entry }));
      return { status: pending.length ? 'create_pending' : labelScanEmpty === true ? 'verified' : 'unverified',
        cleanup_verified: pending.length === 0 && labelScanEmpty === true, pending_creates: pending };
    },
  });
}
function recordCleanupOutcome(outcome, lifecycle, label, labelScanEmpty, consumer) {
  const cleanup = lifecycle.cleanupState(labelScanEmpty);
  outcome.cleanup_verified = cleanup.cleanup_verified;
  outcome.cleanup = { ...cleanup, owner_label: label };
  if (!cleanup.cleanup_verified) {
    outcome.operation_failure_reason = outcome.reason;
    outcome.reason = cleanup.status === 'create_pending' ? 'supervisor_create_outcome_unknown' : 'supervisor_cleanup_failed';
    if (consumer) { outcome.runtime_observation = 'not_checked'; outcome.check = { status: 'failed' }; }
    else { outcome.observation = null; delete outcome.check; }
  }
}

function git(repository, args, options = {}) {
  return command('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.allow=never', ...args], { cwd: repository, ...options });
}
function regularCandidatePath(path) {
  artifactPath(path);
  if (path.split('/').some(part => ['.git', 'node_modules', '.env', '.npmrc', '.netrc'].includes(part))) fail('supervisor_candidate_path_rejected');
  return path;
}
/** Read immutable Git blobs, never archive hooks, working-tree files or candidate commands. */
export async function materializeBehaviorCandidate(repository, commit, destination) {
  if (!isAbsolute(repository) || !/^[a-f0-9]{40}$/.test(commit)) fail('supervisor_candidate_identity_invalid');
  const tree = git(repository, ['rev-parse', '--verify', commit + '^{tree}']).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(tree)) fail('supervisor_candidate_identity_invalid');
  const entries = git(repository, ['ls-tree', '-rz', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) fail('supervisor_nonregular_candidate');
    return { oid: match[2], path: regularCandidatePath(match[3]) };
  });
  if (!entries.length || entries.length > LIMITS.files) fail('supervisor_source_limit');
  const folded = new Map(), filePaths = new Set(entries.map(entry => entry.path));
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/'), key = prefix.toLowerCase();
      if (folded.has(key) && folded.get(key) !== prefix || length < parts.length && filePaths.has(prefix)) fail('supervisor_case_collision');
      folded.set(key, prefix);
    }
  }
  const batch = git(repository, ['cat-file', '--batch'], { input: entries.map(e => e.oid).join('\n') + '\n' });
  let offset = 0, total = 0; const records = [];
  for (const entry of entries) {
    const end = batch.indexOf(10, offset), header = batch.subarray(offset, end).toString('ascii');
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(header);
    if (!match || match[1] !== entry.oid || end < offset) fail('supervisor_git_blob_invalid');
    const size = Number(match[2]); if (!Number.isSafeInteger(size) || (total += size) > LIMITS.sourceBytes) fail('supervisor_source_limit');
    const bytes = batch.subarray(end + 1, end + 1 + size);
    if (bytes.length !== size || batch[end + 1 + size] !== 10) fail('supervisor_git_blob_invalid');
    if (createHash('sha1').update(`blob ${size}\0`).update(bytes).digest('hex') !== entry.oid) fail('supervisor_git_blob_invalid');
    offset = end + 2 + size;
    const target = join(destination, entry.path); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o444, flag: 'wx' }); records.push([entry.path, sha256(bytes)]);
  }
  if (offset !== batch.length) fail('supervisor_git_blob_invalid');
  return { commit, tree, files: entries.length, source_sha256: sha256(JSON.stringify(records)), records };
}
async function checkSnapshot(directory, records) {
  for (const [path, digest] of records) {
    const target = join(directory, path), stat = await lstat(target);
    if (!stat.isFile() || sha256(await readFile(target)) !== digest) fail('supervisor_source_changed');
  }
}
export async function validateBehaviorDependencyCache(source) {
  if (!isAbsolute(source)) fail('supervisor_dependencies_invalid');
  const root = await realpath(source); let bytes = 0, count = 0; const records = [];
  // Host fixture pg/sharp imports and candidate imports must share this identity.
  if (root !== await realpath(join(ROOT, 'node_modules'))) fail('supervisor_dependencies_invalid');
  if (basename(root) !== 'node_modules' || !(await lstat(root)).isDirectory()) fail('supervisor_dependencies_invalid');
  async function inspect(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = join(path, entry.name); if (++count > 50000) fail('supervisor_dependency_limit');
      if (['.git', '.env', '.npmrc', '.netrc', '.ssh', '.aws'].includes(entry.name)) fail('supervisor_dependencies_invalid');
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(full), rel = relative(root, resolved);
        if (rel.startsWith('..') || isAbsolute(rel) || isAbsolute(await readlink(full))) fail('supervisor_dependency_escape');
        records.push([relative(root, full), 'link', await readlink(full)]);
      } else if (entry.isDirectory()) await inspect(full);
      else if (!entry.isFile() || (bytes += (await lstat(full)).size) > LIMITS.dependencyBytes) fail('supervisor_dependency_limit');
      else records.push([relative(root, full), 'file', sha256(await readFile(full))]);
    }
  }
  await inspect(root); return { root, sha256: sha256(JSON.stringify(records)), files: count };
}
export async function installedSupervisorIdentity({ nodeExecutable = '/usr/bin/node', directoryHtml = false } = {}) {
  const paths = ['packages/contribution-tools/behavior-supervisor.mjs', 'packages/contribution-tools/behavior-supervisor-fixture.mjs',
    'packages/contribution-tools/behavior-supervisor-target.mjs', 'packages/contribution-tools/consumer-behavior-target.mjs',
    'packages/contribution-tools/consumer-behavior-fixture.mjs', 'packages/contribution-tools/consumer-runtime-recipe.mjs',
    'packages/contribution-tools/directory-build-fixture.mjs', 'packages/contribution-tools/directory-build-archive.py',
    'packages/contribution-tools/directory-html-dependencies.mjs',
    'packages/contribution-tools/directory-reference/index.mjs', 'packages/contribution-tools/directory-reference/privacy.mjs',
    'contracts/preview/v1/protocol.mjs',
    'packages/contribution-tools/github-behavior-host.mjs',
    'packages/contribution-tools/github-trusted-adapter.mjs', 'package-lock.json'];
  const directoryParser = directoryHtml ? await directoryHtmlDependencyIdentity() : null;
  if (directoryHtml) paths.push('packages/contribution-tools/directory-html-profile.mjs', 'packages/contribution-tools/directory-html-host/package.json',
    'packages/contribution-tools/directory-html-host/package-lock.json');
  for (const name of await readdir(join(ROOT, 'migrations'))) if (/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) paths.push('migrations/' + name);
  const files = [];
  for (const path of paths.sort()) files.push([path, sha256(await readFile(join(ROOT, path)))]);
  const runtimeFiles = [];
  for (const path of [nodeExecutable, '/usr/lib/x86_64-linux-gnu/libdl.so.2', '/usr/lib/x86_64-linux-gnu/libstdc++.so.6',
    '/usr/lib/x86_64-linux-gnu/libm.so.6', '/usr/lib/x86_64-linux-gnu/libgcc_s.so.1', '/usr/lib/x86_64-linux-gnu/libpthread.so.0',
    '/usr/lib/x86_64-linux-gnu/libc.so.6', '/usr/lib64/ld-linux-x86-64.so.2']) runtimeFiles.push([path, sha256(await readFile(path))]);
  return { supervisor_sha256: sha256(JSON.stringify(files)), harness_sha256: await installedBehaviorHarnessDigest(),
    node_runtime_sha256: sha256(JSON.stringify(runtimeFiles)), node_version: process.version,
    runtime_coverage: 'node-and-listed-linked-libraries-only', host_os_approval: 'unverified',
    ...(directoryHtml ? { directory_html_parser: directoryParser } : {}) };
}
export function decodeBehaviorResponseFrame(bytes, expectedId) {
  const value = parseJson(bytes, { maxBytes: LIMITS.frameBytes, maxDepth: 4, maxNodes: 512 });
  if (!value || Object.keys(value).sort().join(',') !== 'body,headers,id,status' || value.id !== expectedId
    || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || !Array.isArray(value.headers)
    || value.headers.length > 128 || typeof value.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.body)) fail('supervisor_response_invalid');
  let headerBytes = 0;
  for (const header of value.headers) {
    if (!Array.isArray(header) || header.length !== 2 || header.some(item => typeof item !== 'string')
      || (headerBytes += Buffer.byteLength(header[0]) + Buffer.byteLength(header[1])) > 16384) fail('supervisor_response_invalid');
  }
  const body = Buffer.from(value.body, 'base64');
  if (body.length > manifest.limits.response_bytes || body.toString('base64') !== value.body) fail('supervisor_response_invalid');
  return { status: value.status, headers: value.headers, body };
}
function responsePort(child, terminate) {
  let pending, failed = false, buffer = Buffer.alloc(0), total = 0, stderr = 0, sequence = 0;
  const clearPending = () => {
    const current = pending; pending = undefined;
    current?.signal.removeEventListener('abort', abort);
    return current;
  };
  const abort = () => { failed = true; clearPending()?.reject(new Error('supervisor_transport_failed')); terminate(); };
  child.on('error', abort); child.on('exit', abort);
  child.stderr.on('data', bytes => { if ((stderr += bytes.length) > LIMITS.stderrBytes) abort(); });
  child.stdout.on('data', bytes => {
    if ((total += bytes.length) > LIMITS.outputBytes || buffer.length + bytes.length > LIMITS.frameBytes) return abort();
    buffer = Buffer.concat([buffer, bytes]); const end = buffer.indexOf(10); if (end < 0) return;
    if (!pending || end !== buffer.length - 1) return abort();
    try { const value = decodeBehaviorResponseFrame(buffer.subarray(0, end), pending.id); buffer = Buffer.alloc(0);
      const current = clearPending(); current.resolve(value); } catch { abort(); }
  });
  return async (request, signal) => {
    if (failed || pending || signal.aborted) fail('supervisor_transport_failed');
    const id = ++sequence, body = request.body ? Buffer.from(await request.arrayBuffer()).toString('base64') : null;
    const frame = JSON.stringify({ id, url: request.url, method: request.method, headers: [...request.headers], body }) + '\n';
    const value = await new Promise((resolve, reject) => { pending = { id, resolve, reject, signal };
      signal.addEventListener('abort', abort, { once: true }); child.stdin.write(frame, error => { if (error) abort(); });
    });
    const responseBody = request.method === 'HEAD' || [204, 205, 304].includes(value.status) ? null : value.body;
    // A HEAD frame containing bytes is not silently discarded by the transport.
    if (request.method === 'HEAD' && value.body.length) fail('supervisor_response_invalid');
    return new Response(responseBody, { status: value.status, headers: value.headers });
  };
}
function observeSupervisorContainer(item, label) {
  const value = JSON.parse(docker(['inspect', '--format', '{{json .}}', item.id]));
  const ulimits = validateSupervisorUlimits(value.HostConfig.Ulimits, item.kind);
  if (value.Id !== item.id || value.Config.Labels?.['freedom.behavior-owner'] !== label || !value.State.Running
    || value.HostConfig.NetworkMode !== 'none' || !value.HostConfig.ReadonlyRootfs || value.HostConfig.Privileged
    || value.HostConfig.PidsLimit !== 128 || value.HostConfig.Memory !== 536870912
    || value.HostConfig.NanoCpus !== 1000000000 || value.Image !== (item.image ?? (item.kind === 'candidate' ? BASE_IMAGE : PG_IMAGE))
    || (item.imageReference && value.Config.Image !== item.imageReference)
    || value.Config.User !== (item.kind === 'candidate' ? `${process.getuid()}:${process.getgid()}` : 'postgres')
    || !value.HostConfig.CapDrop?.includes('ALL') || !value.HostConfig.SecurityOpt?.includes('no-new-privileges')) fail('supervisor_container_changed');
  if (value.Mounts.some(mount => !['bind', 'tmpfs', ...(item.volume ? ['volume'] : [])].includes(mount.Type))) fail('supervisor_container_changed');
  if (item.volume) {
    const volumes = value.Mounts.filter(mount => mount.Type === 'volume');
    if (volumes.length !== 1 || volumes[0].Name !== item.volume || volumes[0].Destination !== '/work'
      || volumes[0].RW !== true || volumes[0].Driver !== 'local') fail('supervisor_container_changed');
    const volume = JSON.parse(docker(['volume', 'inspect', '--format', '{{json .}}', item.volume]));
    if (volume.Name !== item.volume || volume.Driver !== 'local' || volume.Scope !== 'local'
      || volume.Labels?.['freedom.behavior-owner'] !== label || volume.Options?.type !== 'tmpfs'
      || volume.Options?.device !== 'tmpfs'
      || volume.Options?.o !== `size=32m,uid=${process.getuid()},gid=${process.getgid()},mode=0700`
      || Object.keys(volume.Options).length !== 3) fail('supervisor_container_changed');
  }
  const mounts = value.Mounts.filter(mount => mount.Type === 'bind').map(mount => [mount.Source, mount.Destination, mount.RW]).sort();
  if (item.mounts && JSON.stringify(mounts) !== JSON.stringify(item.mounts.slice().sort())) fail('supervisor_container_changed');
  if (item.kind === 'candidate' && value.Config.Env.some(entry => !['PATH', 'TMPDIR', 'NODE_ENV', 'FP_BEHAVIOR_DB_PASSWORD'].includes(entry.split('=', 1)[0]))) fail('supervisor_container_changed');
  return { id: value.Id, image: value.Image, network: 'none', readonly_root: true, memory_bytes: value.HostConfig.Memory, pids: value.HostConfig.PidsLimit, ulimits };
}
const containerLimits = label => ['--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '128', '--cpus', '1', '--label', 'freedom.behavior-owner=' + label,
  '--log-driver', 'none', '--ulimit', 'core=0:0'];
const safeCodes = new Set(['supervisor_host_command_failed','supervisor_candidate_identity_invalid','supervisor_candidate_path_rejected',
  'supervisor_nonregular_candidate','supervisor_case_collision','supervisor_source_limit','supervisor_git_blob_invalid',
  'supervisor_source_changed','supervisor_dependencies_invalid','supervisor_dependency_limit','supervisor_dependency_escape',
  'supervisor_database_unavailable','supervisor_container_changed','supervisor_fixture_changed','supervisor_installation_changed','supervisor_deadline']);

/** Explicit local host entrypoint. No candidate callbacks, reports or test lists.
 * A pass remains local/unavailable: GitHub workflow/source approval is absent. */
export async function runIsolatedMemberBehavior({ candidateRepository, candidateCommit, dependencyRoot, hostEvidence = null }) {
  const label = randomUUID(), owned = [], lifecycle = createSupervisorContainerLifecycle(), started = Date.now(); let directory, pool, child, timer, timedOut = false, phase = 'preflight', outcome;
  const killCandidate = () => { if (child?.pid) { try { child.kill('SIGKILL'); } catch {} }
    const id = owned.find(value => value.kind === 'candidate')?.id; if (id) { try { docker(['kill', id]); } catch {} } };
  const report = (reason, extra = {}) => (outcome = { assurance_level: 'local', status: 'unavailable', merge_authorized: false,
    execution_authorized: false, publisher_trust: 'unverified', reason, ...extra });
  const observeContainer = item => observeSupervisorContainer(item, label);
  try {
    if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24 || process.getuid() === 0) fail('supervisor_host_command_failed');
    const { openSupervisorDatabase, initializeSupervisorFixture, supervisorFixtureFacts, FIXTURE_DATABASE } = await import('./behavior-supervisor-fixture.mjs');
    directory = await mkdtemp(join(tmpdir(), 'fp-behavior-supervisor-'));
    const candidate = join(directory, 'candidate'), socket = join(directory, 'database'), launcher = join(directory, 'target.mjs');
    await mkdir(candidate); await mkdir(socket); await chmod(socket, 0o777);
    timer = setTimeout(() => { timedOut = true; killCandidate(); }, LIMITS.wallMs);
    phase = 'snapshot'; const snapshot = await materializeBehaviorCandidate(candidateRepository, candidateCommit, candidate);
    const dependency = await validateBehaviorDependencyCache(dependencyRoot), dependencies = dependency.root;
    const installation = await installedSupervisorIdentity();
    // Only the installed host adapter supplies this object. Structural validation
    // here is not authentication; pin/approval checks happen before this call.
    const evidence = hostEvidence === null ? null : {
      binding: validateHostEvidenceBinding(hostEvidence.binding), workflow: validateHostWorkflow(hostEvidence.workflow),
      harness: hostEvidence.harness_sha256,
    };
    if (evidence && (evidence.binding.candidate_commit !== snapshot.commit || evidence.binding.candidate_tree !== snapshot.tree
      || evidence.harness !== installation.harness_sha256 || evidence.binding.verifier_sha256 !== await installedVerifierDigest())) fail('supervisor_installation_changed');
    await mkdir(join(candidate, 'node_modules'));
    await writeFile(launcher, await readFile(new URL('./behavior-supervisor-target.mjs', import.meta.url)), { mode: 0o444, flag: 'wx' });
    const common = containerLimits(label);
    const adminPassword = randomBytes(32).toString('base64url'), appPassword = randomBytes(32).toString('base64url');
    phase = 'database'; const pgId = lifecycle.dispatch('database', 'run', () => docker(['run', '-d', ...common, '--ulimit', `nofile=${SUPERVISOR_NOFILE.database}:${SUPERVISOR_NOFILE.database}`, '--user', 'postgres', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
      '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=1m',
      '--mount', `type=bind,src=${socket},dst=/run/postgresql`, '-e', 'PGDATA=/tmp/data', '-e', 'POSTGRES_DB=' + FIXTURE_DATABASE,
      '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=reject',
      PG_IMAGE, 'postgres', '-c', 'listen_addresses=', '-c', 'unix_socket_directories=/run/postgresql'], { POSTGRES_PASSWORD: adminPassword }));
    if (!/^[a-f0-9]{64}$/.test(pgId)) fail('supervisor_host_command_failed'); owned.push({ id: pgId, kind: 'database', mounts: [[socket, '/run/postgresql', true]] });
    observeContainer(owned[0]); pool = await openSupervisorDatabase(socket, adminPassword);
    phase = 'fixture'; const fixture = await initializeSupervisorFixture(pool, appPassword), before = await supervisorFixtureFacts(pool, fixture);
    phase = 'candidate'; const appId = lifecycle.dispatch('candidate', 'create', () => docker(['create', '-i', ...common, '--ulimit', `nofile=${SUPERVISOR_NOFILE.candidate}:${SUPERVISOR_NOFILE.candidate}`, '--user', `${process.getuid()}:${process.getgid()}`,
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,mode=1777', '--mount', 'type=bind,src=/usr,dst=/usr,readonly',
      '--mount', `type=bind,src=${candidate},dst=/candidate,readonly`, '--mount', `type=bind,src=${dependencies},dst=/candidate/node_modules,readonly`,
      '--mount', `type=bind,src=${socket},dst=/database,readonly`, '--mount', `type=bind,src=${launcher},dst=/target.mjs,readonly`,
      '--workdir', '/candidate', '-e', 'TMPDIR=/tmp', '-e', 'NODE_ENV=test', '-e', 'FP_BEHAVIOR_DB_PASSWORD', '--entrypoint', '/usr/bin/node',
      BASE_IMAGE, '--max-old-space-size=256', '--import', '/candidate/node_modules/tsx/dist/loader.mjs', '/target.mjs'],
    { FP_BEHAVIOR_DB_PASSWORD: appPassword }));
    if (!/^[a-f0-9]{64}$/.test(appId)) fail('supervisor_host_command_failed'); owned.push({ id: appId, kind: 'candidate', mounts:
      [['/usr', '/usr', false], [candidate, '/candidate', false], [dependencies, '/candidate/node_modules', false], [socket, '/database', false], [launcher, '/target.mjs', false]] });
    if (timedOut) fail('supervisor_deadline');
    clearTimeout(timer); timer = setTimeout(() => { timedOut = true; killCandidate(); }, 60000);
    child = spawn('/usr/bin/docker', ['start', '-a', '-i', appId], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    const request = responsePort(child, killCandidate);
    // Wait for Docker state, not an untrusted candidate ready/identity message.
    let appObservation;
    for (let tries = 0; tries < 30; tries++) {
      try { appObservation = observeContainer(owned[1]); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!appObservation || timedOut) fail(timedOut ? 'supervisor_deadline' : 'supervisor_container_changed');
    const harness = await installedBehaviorHarnessDigest(), verifier = await installedVerifierDigest();
    const hostCommit = evidence ? null : git(ROOT, ['rev-parse', 'HEAD']).toString().trim();
    // Local callers retain synthetic identities; the installed adapter supplies
    // authenticated bindings without requiring Git metadata in its installation.
    const binding = evidence?.binding ?? { repository: 'local/isolated-candidate', pull_request: 1, run_id: 'local-' + label, run_attempt: 1,
      base_commit: snapshot.commit, head_commit: snapshot.commit, candidate_commit: snapshot.commit, candidate_tree: snapshot.tree,
      source_commit: hostCommit, release_set_sha256: snapshot.source_sha256, policy_revision: 'local-supervisor-prototype',
      policy_sha256: sha256('local-supervisor-prototype'), verifier_commit: hostCommit, verifier_sha256: verifier };
    const workflow = evidence?.workflow ?? { identity: 'local/isolated-behavior', commit: hostCommit, publisher: 'unverified-local-host' };
    phase = 'behavior'; const observed = await runMemberRouteBehavior({ binding, workflow, fixture, expectedHarnessSha256: harness }, {
      request, observeTarget: async () => { for (const item of owned) observeContainer(item); await checkSnapshot(candidate, snapshot.records);
        if (timedOut) fail('supervisor_deadline');
        return { binding, workflow, harness_sha256: harness, fixture: behaviorFixtureIdentity(fixture) }; },
    });
    const isolation = owned.map(observeContainer);
    killCandidate();
    await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND usename='behavior_app'", [FIXTURE_DATABASE]);
    if (JSON.stringify(before) !== JSON.stringify(await supervisorFixtureFacts(pool, fixture))) fail('supervisor_fixture_changed');
    if (dependency.sha256 !== (await validateBehaviorDependencyCache(dependencyRoot)).sha256
      || JSON.stringify(installation) !== JSON.stringify(await installedSupervisorIdentity())) fail('supervisor_installation_changed');
    return report('isolated_behavior_observed_only', { check: observed.check, observation: observed.observation,
      isolation, candidate: { commit: snapshot.commit, tree: snapshot.tree, source_sha256: snapshot.source_sha256 },
      installation: { ...installation, dependency_sha256: dependency.sha256, dependency_files: dependency.files, dependency_approval: 'unverified-local-cache' },
      duration_ms: Date.now() - started });
  } catch (error) { return report(timedOut ? 'supervisor_deadline' : safeCodes.has(error.message) ? error.message : 'supervisor_failed', { phase }); }
  finally {
    clearTimeout(timer); killCandidate(); if (pool) await pool.end();
    // Best-effort removal only: a missing ID cannot settle a timed-out create.
    try { for (const id of docker(['ps', '-aq', '--no-trunc', '--filter', 'label=freedom.behavior-owner=' + label]).toString().trim().split('\n')) {
      if (/^[a-f0-9]{64}$/.test(id) && !owned.some(item => item.id === id)) owned.push({ id });
    } } catch {}
    for (const item of owned.reverse()) {
      // Remove only IDs this invocation created and whose random owner label matches.
      try { const owner = docker(['inspect', '--format', '{{index .Config.Labels "freedom.behavior-owner"}}', item.id]).toString().trim();
        if (owner === label) docker(['rm', '-f', '-v', item.id]); } catch {}
    }
    if (directory && dirname(directory) === tmpdir() && (await lstat(directory)).isDirectory() && !((await lstat(directory)).isSymbolicLink())) {
      await rm(directory, { recursive: true, force: false });
    }
    if (outcome) {
      let labelScanEmpty = false;
      try { labelScanEmpty = docker(['ps', '-aq', '--filter', 'label=freedom.behavior-owner=' + label]).toString().trim() === ''; } catch {}
      recordCleanupOutcome(outcome, lifecycle, label, labelScanEmpty, false);
    }
  }
}

/** Fixed three-consumer profile. Same immutable export, container restrictions and
 * bounded response port as the member supervisor; host independently records HTTP.
 * Local observations do not install a publisher or prove internal library calls. */
export async function runIsolatedConsumerBehavior(input) { return runConsumerProfile(input, 'workspace'); }

/** Fixed actual user-facing CLI, executed only in the candidate container. */
export async function runIsolatedAgentKitCliBehavior(input) { return runConsumerProfile(input, 'kit-cli'); }
export async function runIsolatedConsumerCliBehavior(input) {
  return runConsumerProfile(input, input?.repository === 'FreeTWAI-AI/freedom-agent-kit' ? 'kit-cli' : 'scoped-cli');
}

async function runConsumerProfile(input, profile) {
  const keys = ['repository', 'candidateRepository', 'candidateCommit'];
  if (!input || Object.keys(input).sort().join() !== keys.sort().join()
    || !Object.hasOwn(CONSUMER_BEHAVIOR_PROFILES, input.repository)
    || (profile === 'kit-cli' && input.repository !== 'FreeTWAI-AI/freedom-agent-kit')) fail('consumer_profile_required');
  const { repository, candidateRepository, candidateCommit } = input;
  const selected = profile === 'workspace' ? CONSUMER_BEHAVIOR_PROFILES[repository] : CONSUMER_CLI_PROFILES[repository];
  const label = randomUUID(), owned = [], lifecycle = createSupervisorContainerLifecycle(), cases = [];
  let directory, child, fixture, timer, timedOut = false, outcome, phase = 'preflight';
  const kill = () => {
    if (child?.pid) { try { child.kill('SIGKILL'); } catch {} }
    for (const item of owned) { try { docker(['kill', item.id]); } catch {} }
  };
  const report = (reason, extra = {}) => (outcome = { format: 'freedom.isolated-consumer-http/v1',
    repository, assurance_level: 'local', status: 'unavailable', reason,
    source_integrity: 'not_checked', runtime_observation: 'not_checked', library_invocation: 'not_checked', library_usage: 'not_checked',
    server_authorization: 'not_checked', gate_enforced: false, merge_authorized: false, execution_authorized: false,
    publisher_trust: 'unverified', ...extra });
  try {
    if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24 || process.getuid() === 0) fail('supervisor_host_command_failed');
    directory = await mkdtemp(join(tmpdir(), 'fp-consumer-supervisor-'));
    const candidate = join(directory, 'candidate'), socket = join(directory, 'fixture'), launcher = join(directory, 'target.mjs');
    await mkdir(candidate); await mkdir(socket);
    timer = setTimeout(() => { timedOut = true; kill(); }, LIMITS.wallMs);
    phase = 'snapshot'; const snapshot = await materializeBehaviorCandidate(candidateRepository, candidateCommit, candidate);
    const runtime = await inspectConsumerRuntime(), nodeExecutable = runtime.node.executable;
    const installation = await installedSupervisorIdentity({ nodeExecutable });
    await writeFile(launcher, await readFile(new URL('./consumer-behavior-target.mjs', import.meta.url)), { mode: 0o444, flag: 'wx' });
    phase = 'fixture'; fixture = await createConsumerHttpFixture({ repository, socketPath: join(socket, 'http.sock'), onViolation: kill, profile });
    phase = 'candidate';
    const id = lifecycle.dispatch('candidate', 'create', () => docker(['create', '-i', ...containerLimits(label),
      '--ulimit', `nofile=${SUPERVISOR_NOFILE.candidate}:${SUPERVISOR_NOFILE.candidate}`, '--user', `${process.getuid()}:${process.getgid()}`,
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,mode=1777',
      '--mount', `type=bind,src=${nodeExecutable},dst=/trusted-node,readonly`,
      '--mount', `type=bind,src=${candidate},dst=/candidate,readonly`, '--mount', `type=bind,src=${socket},dst=/fixture,readonly`,
      '--mount', `type=bind,src=${launcher},dst=/target.mjs,readonly`, '--workdir', '/candidate',
      '-e', 'TMPDIR=/tmp', '-e', 'NODE_ENV=test', '--entrypoint', '/trusted-node',
      runtime.image.reference, '--max-old-space-size=256', '/target.mjs', profile]));
    if (!/^[a-f0-9]{64}$/.test(id)) fail('supervisor_host_command_failed');
    owned.push({ id, kind: 'candidate', image: runtime.image.local_id, imageReference: runtime.image.reference, mounts: [[nodeExecutable, '/trusted-node', false], [candidate, '/candidate', false],
      [socket, '/fixture', false], [launcher, '/target.mjs', false]] });
    if (timedOut) fail('supervisor_deadline');
    clearTimeout(timer); timer = setTimeout(() => { timedOut = true; kill(); }, 15000);
    child = spawn('/usr/bin/docker', ['start', '-a', '-i', id], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    const request = responsePort(child, kill);
    let isolation;
    for (let tries = 0; tries < 30; tries++) {
      try { isolation = observeSupervisorContainer(owned[0], label); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!isolation) fail('supervisor_container_changed');
    phase = 'behavior';
    for (const scenario of selected.scenarios) {
      const challenge = fixture.begin(scenario);
      const response = await request(new Request('http://127.0.0.1:4310/consumer-driver', {
        method: 'POST', body: JSON.stringify(challenge), headers: { 'content-type': 'application/json' },
      }), AbortSignal.timeout(5000));
      const observed = await fixture.verify(response); cases.push(observed);
      observeSupervisorContainer(owned[0], label); await checkSnapshot(candidate, snapshot.records);
      if (observed.status !== 'passed') break;
    }
    kill(); await fixture.close(); fixture.assertHealthy(); fixture = null;
    if (timedOut) fail('supervisor_deadline');
    if (JSON.stringify(runtime) !== JSON.stringify(await inspectConsumerRuntime())) fail('supervisor_installation_changed');
    if (JSON.stringify(installation) !== JSON.stringify(await installedSupervisorIdentity({ nodeExecutable }))) fail('supervisor_installation_changed');
    const passed = cases.length === selected.scenarios.length && cases.every(value => value.status === 'passed');
    return report(passed ? 'isolated_consumer_http_observed_only' : 'consumer_behavior_mismatch', {
      check: { status: passed ? 'passed' : 'failed', test_count: cases.length, expected_test_count: selected.scenarios.length },
      runtime_observation: passed ? 'host_observed_http' : 'not_checked', cases, isolation: [{ ...isolation, bind_destinations: owned[0].mounts.map(item => item[1]).sort() }],
      installation: { ...installation, node_executable: nodeExecutable, runtime_recipe: runtime },
      candidate: { commit: snapshot.commit, tree: snapshot.tree, source_sha256: snapshot.source_sha256 },
      entry: profile === 'workspace' ? 'src/index.mjs#' + selected.entry : selected.entry,
    });
  } catch (error) {
    return report(timedOut ? 'supervisor_deadline' : safeCodes.has(error.message) || ['consumer_fixture_invalid', 'consumer_image_unavailable', 'consumer_image_identity_mismatch', 'consumer_node_identity_mismatch', 'consumer_runtime_platform_mismatch'].includes(error.message)
      ? error.message : 'consumer_supervisor_failed', { phase, check: { status: 'failed' }, cases });
  } finally {
    clearTimeout(timer); kill(); if (fixture) await fixture.close();
    try {
      for (const id of docker(['ps', '-aq', '--no-trunc', '--filter', 'label=freedom.behavior-owner=' + label]).toString().trim().split('\n')) {
        if (/^[a-f0-9]{64}$/.test(id) && !owned.some(item => item.id === id)) owned.push({ id });
      }
    } catch {}
    for (const item of owned) {
      try { if (docker(['inspect', '--format', '{{index .Config.Labels "freedom.behavior-owner"}}', item.id]).toString().trim() === label) docker(['rm', '-f', '-v', item.id]); } catch {}
    }
    if (directory) await rm(directory, { recursive: true, force: false });
    if (outcome) {
      let labelScanEmpty = false;
      try { labelScanEmpty = docker(['ps', '-aq', '--filter', 'label=freedom.behavior-owner=' + label]).toString().trim() === ''; } catch {}
      recordCleanupOutcome(outcome, lifecycle, label, labelScanEmpty, true);
    }
  }
}

// A docker CLI exit 1 can also mean transport failure. Obtain the candidate exit
// from its exact daemon exec object, never infer validation rejection from a CLI.
function directoryDaemonRequest(method, path, body, status) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = httpRequest({ socketPath: '/var/run/docker.sock', method, path,
      headers: payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
      let bytes = 0; const chunks = [];
      response.on('data', chunk => {
        if ((bytes += chunk.length) > 65536) request.destroy(Error('directory_build_unavailable'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(Error('directory_build_unavailable')));
      response.on('end', () => {
        if (response.statusCode !== status) return reject(Error('directory_build_unavailable'));
        try { resolve(bytes ? JSON.parse(Buffer.concat(chunks)) : null); }
        catch { reject(Error('directory_build_unavailable')); }
      });
    });
    const timer = setTimeout(() => request.destroy(Error('directory_build_unavailable')), 2000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', () => reject(Error('directory_build_unavailable')));
    request.end(payload);
  });
}
async function executeDirectoryBuild(id) {
  const args = ['--max-old-space-size=256', 'scripts/build.mjs'];
  const exec = await directoryDaemonRequest('POST', '/containers/' + id + '/exec', {
    AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false,
    WorkingDir: '/work', User: `${process.getuid()}:${process.getgid()}`, Cmd: ['/trusted-node', ...args],
  }, 201);
  if (!/^[a-f0-9]{64}$/.test(exec?.Id ?? '')) fail('directory_build_unavailable');
  await directoryDaemonRequest('POST', '/exec/' + exec.Id + '/start', { Detach: true, Tty: false }, 200);
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const state = await directoryDaemonRequest('GET', '/exec/' + exec.Id + '/json', undefined, 200);
    if (state?.ID !== exec.Id || state.ContainerID !== id || state.ProcessConfig?.entrypoint !== '/trusted-node'
      || JSON.stringify(state.ProcessConfig?.arguments) !== JSON.stringify(args)) fail('directory_build_unavailable');
    if (state.Running === false && Number.isInteger(state.ExitCode)) return { id: exec.Id, exitCode: state.ExitCode };
    if (state.Running !== true) fail('directory_build_unavailable');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fail('directory_build_unavailable');
}

/** Bounded actual static build. The daemon pauses every container before copying
 * its tmpfs tree; a host-only reader hashes regular files and captures bounded
 * static HTML bytes without extracting them.
 * No writable host mount, candidate test, collector or self-reported verdict. */
export async function runIsolatedDirectoryBuild({ repository, candidateRepository, candidateCommit }) {
  if (repository !== DIRECTORY_REPOSITORY) fail('consumer_profile_required');
  const label = randomUUID(), owned = [], lifecycle = createSupervisorContainerLifecycle(), cases = [];
  let directory, outcome, phase = 'preflight', pendingVolumeCreate = false;
  const volumes = [];
  const started = Date.now();
  const deadline = () => { if (Date.now() - started > LIMITS.wallMs) fail('supervisor_deadline'); };
  const report = (reason, extra = {}) => (outcome = { format: 'freedom.isolated-directory-build/v1',
    repository, assurance_level: 'local', status: 'unavailable', reason, semantic_profile: 'freedom.directory-html/v2',
    source_integrity: 'not_checked', runtime_observation: 'not_checked', library_usage: 'not_checked',
    gate_enforced: false, merge_authorized: false, execution_authorized: false, publisher_trust: 'unverified',
    entry: 'scripts/build.mjs', check: { status: 'failed' }, cases, ...extra });
  try {
    const runtime = await inspectConsumerRuntime(), nodeExecutable = runtime.node.executable;
    const installation = await installedSupervisorIdentity({ nodeExecutable, directoryHtml: true });
    directory = await mkdtemp(join(tmpdir(), 'fp-directory-build-'));
    const candidate = join(directory, 'candidate'); await mkdir(candidate);
    phase = 'snapshot';
    const snapshot = await materializeBehaviorCandidate(candidateRepository, candidateCommit, candidate);
    // The bounded archive reader and fixed clean build tree have narrower limits
    // than the general source snapshot; unavailable never becomes a passing check.
    if (snapshot.files > 512 || snapshot.records.some(([path]) => path === 'dist' || path.startsWith('dist/')))
      fail('directory_snapshot_limit');
    let sourceBytes = 0;
    for (const [path] of snapshot.records) sourceBytes += (await lstat(join(candidate, path))).size;
    if (sourceBytes > 2 * 1024 * 1024) fail('directory_snapshot_limit');
    phase = 'fixture';
    let scenarios;
    try { scenarios = directoryBuildCases(await readFile(join(candidate, 'data/directory.json'), 'utf8'),
      await readFile(join(candidate, 'data/privacy-discord-bot.json'), 'utf8')); }
    catch { return report('directory_data_invalid', { phase }); }
    const isolation = [];
    for (const scenario of scenarios) {
      deadline(); phase = 'candidate';
      const input = join(directory, scenario.id); await cp(candidate, input, { recursive: true, errorOnExist: true });
      for (const [path, bytes] of Object.entries(scenario.overrides)) {
        await chmod(join(input, path), 0o600); await writeFile(join(input, path), bytes); await chmod(join(input, path), 0o444);
      }
      const volume = 'fp-directory-' + label + '-' + scenario.id;
      volumes.push(volume); pendingVolumeCreate = true;
      const volumeAck = docker(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
        '--opt', `o=size=32m,uid=${process.getuid()},gid=${process.getgid()},mode=0700`,
        '--label', 'freedom.behavior-owner=' + label, volume]).toString().trim();
      if (volumeAck !== volume) fail('supervisor_host_command_failed');
      pendingVolumeCreate = false;
      const id = lifecycle.dispatch('candidate', 'create', () => docker(['create', ...containerLimits(label),
        '--ulimit', `nofile=${SUPERVISOR_NOFILE.candidate}:${SUPERVISOR_NOFILE.candidate}`,
        '--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,mode=1777',
        '--mount', `type=bind,src=${nodeExecutable},dst=/trusted-node,readonly`,
        '--mount', `type=bind,src=${input},dst=/candidate,readonly`, '--workdir', '/tmp',
        '--mount', `type=volume,src=${volume},dst=/work`,
        '-e', 'TMPDIR=/tmp', '-e', 'NODE_ENV=test', '--entrypoint', '/bin/sleep', runtime.image.reference, 'infinity']));
      const item = { id, kind: 'candidate', image: runtime.image.local_id, imageReference: runtime.image.reference, volume,
        mounts: [[nodeExecutable, '/trusted-node', false], [input, '/candidate', false]] };
      owned.push(item); docker(['start', id]);
      const observed = observeSupervisorContainer(item, label);
      docker(['exec', id, '/bin/cp', '-r', '/candidate/.', '/work/']);
      phase = 'build';
      const execution = await executeDirectoryBuild(id), { exitCode } = execution;
      deadline(); observeSupervisorContainer(item, label);
      docker(['pause', id]);
      const frozen = JSON.parse(docker(['inspect', '--format', '{{json .State}}', id]));
      if (!frozen.Running || !frozen.Paused) fail('supervisor_container_changed');
      phase = 'readback';
      const tar = command('/usr/bin/docker', ['cp', id + ':/work', '-'], { maxBuffer: 8 * 1024 * 1024 });
      const archive = JSON.parse(command('/usr/bin/python3', ['-I', fileURLToPath(new URL('./directory-build-archive.py', import.meta.url)), '--html'],
        { input: tar, maxBuffer: 6 * 1024 * 1024 }));
      docker(['rm', '-f', '-v', id]); owned.splice(owned.indexOf(item), 1);
      docker(['volume', 'rm', volume]); volumes.splice(volumes.indexOf(volume), 1);
      await checkSnapshot(candidate, snapshot.records);
      const passed = checkDirectoryBuildArchive(archive, snapshot.records, scenario, exitCode);
      cases.push({ id: scenario.id, status: passed ? 'passed' : 'failed', exec_id: execution.id, exit_code: exitCode,
        archive_sha256: sha256(tar), files: archive.files.length,
        output_sha256: archive.files.filter(([path]) => path.startsWith('work/dist/')),
        input_sha256: snapshot.records.filter(([path]) => path.startsWith('data/')).map(([path, digest]) =>
          [path, Object.hasOwn(scenario.overrides, path) ? sha256(scenario.overrides[path]) : digest]) });
      isolation.push({ ...observed, bind_destinations: ['/candidate', '/trusted-node'], paused_readback: true });
      if (!passed) break;
    }
    deadline();
    if (JSON.stringify(runtime) !== JSON.stringify(await inspectConsumerRuntime())
      || JSON.stringify(installation) !== JSON.stringify(await installedSupervisorIdentity({ nodeExecutable, directoryHtml: true })))
      fail('supervisor_installation_changed');
    const passed = cases.length === scenarios.length && cases.every(value => value.status === 'passed');
    return report(passed ? 'isolated_directory_build_observed_only' : 'directory_behavior_mismatch', {
      check: { status: passed ? 'passed' : 'failed', test_count: cases.length, expected_test_count: scenarios.length },
      runtime_observation: passed ? 'host_observed_build_files' : 'not_checked', isolation,
      installation: { ...installation, runtime_recipe: runtime },
      candidate: { commit: snapshot.commit, tree: snapshot.tree, source_sha256: snapshot.source_sha256 },
    });
  } catch (error) {
    return report(safeCodes.has(error.message) || ['directory_snapshot_limit', 'directory_build_unavailable', 'directory_html_unavailable', 'directory_parser_dependency_invalid',
      'consumer_image_unavailable', 'consumer_image_identity_mismatch', 'consumer_node_identity_mismatch',
      'consumer_runtime_platform_mismatch'].includes(error.message) ? error.message : 'directory_supervisor_failed', { phase });
  } finally {
    try {
      for (const id of docker(['ps', '-aq', '--no-trunc', '--filter', 'label=freedom.behavior-owner=' + label]).toString().trim().split('\n')) {
        if (/^[a-f0-9]{64}$/.test(id) && !owned.some(item => item.id === id)) owned.push({ id });
      }
    } catch {}
    for (const item of owned) {
      try { if (docker(['inspect', '--format', '{{index .Config.Labels "freedom.behavior-owner"}}', item.id]).toString().trim() === label)
        docker(['rm', '-f', '-v', item.id]); } catch {}
    }
    for (const volume of volumes) {
      try { if (docker(['volume', 'inspect', '--format', '{{index .Labels "freedom.behavior-owner"}}', volume]).toString().trim() === label)
        docker(['volume', 'rm', volume]); } catch {}
    }
    if (directory) await rm(directory, { recursive: true, force: false });
    if (outcome) {
      let labelScanEmpty = false;
      try { labelScanEmpty = docker(['ps', '-aq', '--filter', 'label=freedom.behavior-owner=' + label]).toString().trim() === ''; } catch {}
      recordCleanupOutcome(outcome, lifecycle, label, labelScanEmpty, true);
      let volumesGone = false;
      try { volumesGone = docker(['volume', 'ls', '-q', '--filter', 'label=freedom.behavior-owner=' + label]).toString().trim() === ''; } catch {}
      outcome.cleanup.volumes_verified = volumesGone && !pendingVolumeCreate;
      outcome.cleanup.pending_volume_create = pendingVolumeCreate;
      if (!outcome.cleanup.volumes_verified) {
        outcome.cleanup_verified = false; outcome.cleanup.cleanup_verified = false;
        outcome.cleanup.status = pendingVolumeCreate ? 'create_pending' : 'unverified';
        outcome.operation_failure_reason = outcome.reason;
        outcome.reason = pendingVolumeCreate ? 'supervisor_create_outcome_unknown' : 'supervisor_cleanup_failed';
        outcome.runtime_observation = 'not_checked'; outcome.check = { status: 'failed' };
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, repository, candidateRepository, candidateCommit, ...extra] = process.argv.slice(2);
    if (!['consumer', 'consumer-cli'].includes(mode) || extra.length) fail('consumer_supervisor_cli_usage');
    const run = mode === 'consumer-cli' ? runIsolatedConsumerCliBehavior : runIsolatedConsumerBehavior;
    const result = await run({ repository, candidateRepository, candidateCommit });
    console.log(JSON.stringify(result));
    if (result.check?.status !== 'passed' || result.cleanup_verified !== true) process.exitCode = 1;
  } catch { console.log(JSON.stringify({ status: 'unavailable', reason: 'consumer_supervisor_cli_invalid', merge_authorized: false })); process.exitCode = 1; }
}
