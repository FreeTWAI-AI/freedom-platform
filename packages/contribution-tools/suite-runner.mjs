import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readBounded, parseJson, sha256 } from './io.mjs';
import { verificationEnvironment } from './process-env.mjs';
import { RUNTIME_SUITES, FULL_RUNTIME_BASELINE } from './runtime-suites.mjs';

const MAX_OUTPUT = 16_000_000, MAX_FILES = 512;
const COUNT_KEYS = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];
const reporter = fileURLToPath(new URL('./test-reporter.mjs', import.meta.url));
const result = (id, status, reason) => ({ check_id: id, status, reason });

// Admission checks are not proof that a database is disposable. Its operator
// must provision an isolated test-only server; this library never discovers one.
export function isDisposableDatabaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\0]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || url.password
      || !/^[a-z_][a-z0-9_]{0,62}$/.test(url.username)
      || !/^\/fp_[a-z0-9_]{1,59}$/.test(url.pathname)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) return false;
    const entries = [...url.searchParams];
    if (entries.length === 0) return true;
    if (entries.length !== 1 || entries[0][0] !== 'host') return false;
    const socket = entries[0][1];
    return /^\/[a-zA-Z0-9_./-]+$/.test(socket) && resolve(socket) === socket && socket !== '/';
  } catch { return false; }
}

async function suiteFiles(root, id) {
  let files;
  if (id === 'governance.unit') {
    files = (await readdir(resolve(root, 'packages/contribution-tools/test')))
      .filter(name => /^[a-z][a-z0-9-]*\.test\.mjs$/.test(name)).sort()
      .map(name => 'packages/contribution-tools/test/' + name);
  } else if (id === 'runtime.full') {
    const found = (await readdir(resolve(root, 'tests/runtime')))
      .filter(name => /^[a-z][a-z0-9_-]*\.test\.ts$/.test(name)).map(name => 'tests/runtime/' + name);
    files = [...new Set([...FULL_RUNTIME_BASELINE, ...found])].sort();
  } else files = RUNTIME_SUITES[id];
  if (files.length > MAX_FILES) throw new Error('file_limit');
  for (const path of files) await readBounded(root, path);
  return files;
}

// No shell, package hooks, inherited NODE_OPTIONS, test context, credentials,
// or default database URL. Kill the isolated process group on POSIX timeout.
function execute(root, files, runtime, databaseUrl, timeoutMs) {
  return new Promise(done => {
    let loader;
    try { if (runtime) loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href; }
    catch { done({ reason: 'runtime_loader_unavailable' }); return; }
    const args = [...(runtime ? ['--import', loader] : []), '--test', '--test-concurrency=1',
      '--test-reporter=' + reporter, ...files];
    const env = verificationEnvironment();
    if (runtime) env.TEST_DATABASE_URL = databaseUrl;
    const group = process.platform !== 'win32';
    const child = spawn(process.execPath, args, { cwd: root, env, detached: group, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0, output = [], reason;
    const stop = code => {
      reason ??= code;
      try { if (group && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => stop('test_timeout'), timeoutMs);
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > MAX_OUTPUT) stop('test_output_limit');
      else output.push(bytes);
    });
    child.stderr.on('data', bytes => { size += bytes.length; if (size > MAX_OUTPUT) stop('test_output_limit'); });
    child.on('error', () => { reason ??= 'test_process_failed'; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ output: Buffer.concat(output), reason, failed: code !== 0 || signal !== null });
    });
  });
}

function countsValid(counts) {
  return counts && COUNT_KEYS.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    && counts.tests === COUNT_KEYS.slice(1).reduce((sum, key) => sum + counts[key], 0);
}

function evidenceFor(raw, files) {
  const expected = new Set(files), seen = new Set(), ids = new Set();
  if (typeof raw.success !== 'boolean' || !countsValid(raw.counts) || !Array.isArray(raw.files)
    || raw.files.length !== files.length || !Array.isArray(raw.cases)) return;
  const evidence = [];
  for (const item of raw.files) {
    if (!expected.has(item.file) || seen.has(item.file) || typeof item.success !== 'boolean' || !countsValid(item.counts)) return;
    seen.add(item.file);
    const cases = raw.cases.filter(entry => entry.file === item.file);
    if (cases.length !== item.counts.tests || cases.length > 20_000) return;
    for (const entry of cases) {
      if (!/^[a-f0-9]{64}$/.test(entry.case_sha256) || !COUNT_KEYS.slice(1).includes(entry.status) || ids.has(entry.case_sha256)) return;
      ids.add(entry.case_sha256);
    }
    if (COUNT_KEYS.slice(1).some(key => item.counts[key] !== cases.filter(entry => entry.status === key).length)) return;
    evidence.push({ path: item.file, counts: Object.fromEntries(COUNT_KEYS.map(key => [key, item.counts[key]])),
      cases: cases.map(({ case_sha256, status }) => ({ case_sha256, status })) });
  }
  if (raw.cases.some(item => !expected.has(item.file)) || COUNT_KEYS.some(key => raw.counts[key] !== evidence.reduce((n, file) => n + file.counts[key], 0))) return;
  return evidence.sort((a, b) => a.path.localeCompare(b.path));
}

async function runGroup(root, selections, runtime, options) {
  const files = [...new Set(selections.flatMap(item => item.files))].sort();
  const cap = runtime ? 900_000 : 60_000;
  const timeout = options.timeoutMs ?? cap;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > cap) {
    return selections.map(({ id }) => result(id, 'not_run', 'invalid_suite_timeout'));
  }
  const ran = await execute(root, files, runtime, options.testDatabaseUrl, timeout);
  const failure = reason => selections.map(({ id, files: selected_files }) => ({
    ...result(id, reason === 'runtime_loader_unavailable' ? 'not_run' : 'failed', reason), selected_files,
  }));
  if (ran.reason) return failure(ran.reason);
  let raw, evidence;
  try { raw = parseJson(ran.output, { maxBytes: MAX_OUTPUT, maxNodes: 500_000 }); evidence = evidenceFor(raw, files); }
  catch { return failure('invalid_test_results'); }
  if (!evidence) return failure('incomplete_test_results');
  const evidence_sha256 = sha256(ran.output);
  return selections.map(({ id, files: selected }) => {
    const test_files = evidence.filter(item => selected.includes(item.path));
    const test_count = test_files.reduce((count, item) => count + item.counts.tests, 0);
    // Any process-level failure fails the batch, even if one subset passed.
    const passed = !ran.failed && raw.success && raw.files.every(file => file.success)
      && test_files.every(file => file.counts.tests > 0 && file.counts.tests === file.counts.passed);
    return { ...result(id, passed ? 'passed' : 'failed', passed ? 'tests_executed' : ran.failed ? 'test_process_failed' : 'incomplete_test_results'),
      test_count, evidence_sha256, selected_files: selected, test_files };
  });
}

export async function runLocalSuites(root, ids, options = {}) {
  const results = new Map(), governance = [], runtime = [];
  for (const id of [...new Set(ids)].sort()) {
    const isRuntime = id === 'runtime.full' || Object.hasOwn(RUNTIME_SUITES, id);
    if (id !== 'governance.unit' && !isRuntime) { results.set(id, result(id, 'not_run', 'suite_adapter_unavailable')); continue; }
    if (isRuntime && !isDisposableDatabaseUrl(options.testDatabaseUrl)) {
      results.set(id, result(id, 'not_run', options.testDatabaseUrl === undefined ? 'test_database_required' : 'test_database_rejected')); continue;
    }
    let files;
    try { files = await suiteFiles(root, id); }
    catch { results.set(id, result(id, 'not_run', 'suite_files_unavailable')); continue; }
    if (!files.length) { results.set(id, { ...result(id, 'failed', 'empty_test_set'), test_count: 0 }); continue; }
    (isRuntime ? runtime : governance).push({ id, files });
  }
  for (const [selected, isRuntime] of [[governance, false], [runtime, true]]) {
    if (selected.length) for (const item of await runGroup(root, selected, isRuntime, options)) results.set(item.check_id, item);
  }
  return [...results.values()].sort((a, b) => a.check_id.localeCompare(b.check_id));
}

export async function runLocalSuite(root, id, options = {}) {
  return (await runLocalSuites(root, [id], options))[0];
}
