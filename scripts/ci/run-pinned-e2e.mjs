import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm, rename, stat, lstat, opendir, realpath } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { E2E_BASELINE, E2E_PLAN, E2E_DEFAULT_SHARDS, GUILD_E2E_PLAN, GUILD_PREVIEW_PLAN, E2E_PASS_TIMEOUT_MS, evaluateE2ePasses, evaluateE2ePassProgress, planE2eSelection } from '../../packages/contribution-tools/pinned-e2e.mjs';
import { GUILD_PRESENTATION_PROFILE } from '../../packages/contribution-tools/guild-presentation-profile.mjs';
import { collectRepositoryE2eDecision } from './select-affected-jobs.mjs';
import { readBounded } from '../../packages/contribution-tools/io.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const defaultConfigFile = fileURLToPath(new URL('./pinned-playwright.config.mjs', import.meta.url));

// Diagnostics are untrusted synthetic test output, never admission evidence.
// Retain only the fixed Playwright outputs, with bounded traversal/bytes and
// readBounded's regular-file/no-symlink checks. Always remove the disk scratch.
export async function cleanupE2ePass(temp, output, passId, failed) {
  try {
    if (!failed) return;
    const parent = dirname(output), target = output + '.failure-artifacts';
    await mkdir(parent, { recursive: true });
    if (await realpath(parent) !== resolve(parent)) throw Error('unsafe_diagnostic_parent');
    await mkdir(target, { recursive: true });
    if (!(await lstat(target)).isDirectory() || (await lstat(target)).isSymbolicLink()) throw Error('unsafe_diagnostic_directory');
    const destination = await mkdtemp(join(target, passId + '-'));
    let remaining = 128 * 1024 * 1024, entries = 0, copied = 0, omitted = 0;
    async function copy(path, depth = 0) {
      if (++entries > 512 || depth > 8) { omitted++; return; }
      try {
        const info = await lstat(join(temp, path));
        if (info.isSymbolicLink()) { omitted++; return; }
        if (info.isDirectory()) {
          for await (const item of await opendir(join(temp, path))) {
            if (entries >= 512) { omitted++; break; }
            await copy(path + '/' + item.name, depth + 1);
          }
        } else if (info.isFile()) {
          const bytes = await readBounded(temp, path, Math.min(64 * 1024 * 1024, remaining));
          await mkdir(dirname(join(destination, path)), { recursive: true });
          await writeFile(join(destination, path), bytes, { flag: 'wx', mode: 0o600 });
          remaining -= bytes.length; copied++;
        } else omitted++;
      } catch { omitted++; }
    }
    // Preserve the inventory and both reports before optional traces consume
    // the shared byte/entry bound.
    for (const path of ['report.json', 'listing.json', ...E2E_DEFAULT_SHARDS.map(shard => `shard-${shard.current}/report.json`),
      'last-run.json', 'artifacts', ...E2E_DEFAULT_SHARDS.flatMap(shard => [`shard-${shard.current}/last-run.json`, `shard-${shard.current}/artifacts`])]) await copy(path);
    await writeFile(join(destination, 'diagnostics.json'), JSON.stringify({ pass: passId, copied, omitted,
      bytes: 128 * 1024 * 1024 - remaining, admission_evidence: false }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch { console.error('pinned_e2e_diagnostics_unavailable'); }
  finally { await rm(temp, { recursive: true, force: true }); }
}

// SIGINT enters Playwright's test-runner teardown, which sends the configured
// SIGTERM to its separate webServer group and drops the private schema.
// Escalation is bounded independently of the host-owned whole-pass budget.
function execute(root, cli, pass, env, signal, configFile, { listing = false, shard, timeoutMs } = {}) {
  if (signal.aborted) return Promise.resolve({ exit_code: null, reason: 'test_cancelled' });
  const maximum = listing ? 60_000 : E2E_PASS_TIMEOUT_MS[pass.id];
  const budget = timeoutMs === undefined ? maximum : Math.min(maximum, timeoutMs);
  if (budget <= 0) return Promise.resolve({ exit_code: null, reason: 'test_timeout' });
  return new Promise(done => {
    const group = process.platform !== 'win32';
    const files = pass.files.map(file => '(?:^|/)' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    // Print each failure before a whole-pass timeout can prevent the final summary.
    const child = spawn(process.execPath, [cli, 'test', '--config', configFile, '--forbid-only', listing ? '--reporter=json' : '--reporter=line,json', ...(listing ? ['--list'] : []), ...(shard ? ['--shard', `${shard.current}/${shard.total}`] : []), '--output', join(dirname(env.PLAYWRIGHT_JSON_OUTPUT_FILE), 'artifacts'), ...files],
      { cwd: root, env, stdio: 'inherit', detached: group });
    let reason, escalation;
    const kill = name => {
      try { if (group && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* already exited */ }
    };
    const stop = code => {
      if (reason) return;
      reason = code;
      kill('SIGINT');
      escalation = setTimeout(() => kill('SIGKILL'), 20000);
    };
    const abort = () => stop('test_cancelled');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop('test_timeout'), budget);
    child.once('error', () => { reason ??= 'test_process_failed'; });
    child.once('close', (exit_code, termination_signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener('abort', abort);
      done({ exit_code, reason: reason ?? (termination_signal ? 'test_process_failed' : undefined) });
    });
  });
}

async function readPassReport(path) {
  try {
    const bytes = await readFile(path);
    return { report: JSON.parse(bytes.toString('utf8')), evidence_sha256: sha256(bytes) };
  } catch { return {}; }
}

async function main() {
  const args = process.argv.slice(2), input = {};
  const flags = { '--root': 'root', '--output': 'output', '--event': 'event', '--base': 'base',
    '--head': 'head', '--candidate': 'candidate', '--pull-request': 'pullRequest' };
  let valid = true;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (['--guild-presentation', '--guild-preview'].includes(flag) && input.guildProfile === undefined) { input.guildProfile=flag.slice(2); continue; }
    if (flag === '--allow-fetch' && input.allowFetch === undefined) { input.allowFetch = true; continue; }
    const key = flags[flag], value = args[++index];
    if (!key || Object.hasOwn(input, key) || typeof value !== 'string' || !value || value.startsWith('--')) { valid = false; break; }
    input[key] = value;
  }
  if (!valid || !input.root) {
    console.error('invalid_pinned_e2e_arguments');
    process.exitCode = 2;
    return;
  }
  const root = resolve(input.root);
  const configFile = input.guildProfile === 'guild-preview' ? fileURLToPath(new URL('./pinned-guild-preview.config.mjs', import.meta.url)) : defaultConfigFile;
  const output = input.output ? resolve(input.output) : resolve(root, '.freedom/reports/pinned-e2e.json');
  // Recompute from host SHAs before candidate test/config execution. No profile
  // env var, candidate JSON report or arbitrary file argument is accepted.
  const selection = input.guildProfile ? {profile: input.guildProfile, reason: 'reviewed_guild_job_obligations'} : collectRepositoryE2eDecision({ ...input, repository: root });
  let plan = E2E_PLAN, profile = 'full';
  let expectedFiles = [], passReports = [];
  const fail = (status, reason) => ({ check_id: 'ci.e2e', status, reason, test_count: 0,
    selected_files: expectedFiles, test_files: expectedFiles.map(path => ({ path, counts: { tests: 0, passed: 0 } })), passes: [] });
  const publish = async (result, exitCode = result.status === 'passed' ? 0 : 1) => {
    await mkdir(dirname(output), { recursive: true });
    result.selection = { profile, reason: selection.reason };
    result.binding = Object.fromEntries(['base', 'head', 'candidate'].filter(key => /^[a-f0-9]{40}$/.test(input[key] ?? '')).map(key => [key, input[key]]));
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ check_id: result.check_id, status: result.status, reason: result.reason,
      test_count: result.test_count, file_count: result.selected_files.length, selection: result.selection, binding: result.binding,
      passes: result.passes.map(({ id, exit_code }) => ({ id, exit_code })) }));
    if (result.status !== 'passed') for (const file of result.test_files) {
      if (!file.counts.tests || file.counts.passed !== file.counts.tests) console.log(JSON.stringify(file));
    }
    process.exitCode = exitCode;
  };
  try {
    if (!(await stat(root)).isDirectory()) throw Error();
  } catch {
    await publish(fail('not_run', 'invalid_pinned_e2e_arguments'), 2);
    return;
  }
  try {
    if (input.guildProfile) {
      profile=input.guildProfile;plan=profile==='guild-preview'?GUILD_PREVIEW_PLAN:GUILD_E2E_PLAN;
      expectedFiles=[...(profile==='guild-preview'?GUILD_PRESENTATION_PROFILE.previewFiles:GUILD_PRESENTATION_PROFILE.integrationFiles)].sort();
      for (const file of expectedFiles) await readBounded(root,file);
    } else {
    const found = (await readdir(resolve(root, 'tests/e2e')))
      .filter(name => /^[a-z0-9][a-z0-9-]*\.spec\.ts$/.test(name)).map(name => 'tests/e2e/' + name);
    expectedFiles = [...new Set([...E2E_BASELINE, ...found])].sort();
    for (const file of expectedFiles) await readBounded(root, file);
    const selected = planE2eSelection(selection.profile, expectedFiles);
    expectedFiles = selected.expectedFiles; plan = selected.plan; profile = selected.profile;
    }
  } catch {
    await publish(fail('not_run', 'e2e_files_unavailable'));
    return;
  }
  if (!expectedFiles.length) {
    await publish(fail('failed', 'empty_test_set'));
    return;
  }
  let cli;
  try { cli = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli'); }
  catch {
    await publish(fail('not_run', 'e2e_runner_unavailable'));
    return;
  }
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    if (key === 'NODE_OPTIONS' || key === 'ACTIONS_ID_TOKEN_REQUEST_URL' || key.endsWith('_TOKEN') || key.endsWith('_SECRET')) delete baseEnv[key];
  }
  if (profile === 'guild-preview') { delete baseEnv.TEST_DATABASE_URL; delete baseEnv.DATABASE_URL; }
  // The pinned plan owns all fixture flags; inherited flags cannot alter pass 1.
  delete baseEnv.FREEDOM_E2E_PRIVATE_AI_FIXTURE;
  delete baseEnv.FREEDOM_E2E_AVATAR_ASSET_FIXTURE;
  delete baseEnv.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE;
  delete baseEnv.FREEDOM_E2E_STORE_PHOTO_FIXTURE;
  delete baseEnv.FREEDOM_E2E_NOTIFICATION_PREFERENCES;
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let executionReason;
  const evidenceOptions = { rootDir: resolve(root, profile === 'guild-preview' ? 'modules' : 'tests/e2e').split(sep).join('/'), configFile, profile };
  let progress;
  try {
    for (const pass of plan) {
      if (controller.signal.aborted) { executionReason = 'test_cancelled'; break; }
      let temp, passCompleted = false;
      try {
        temp = await mkdtemp(join(tmpdir(), 'fp-pinned-'));
        const reportPath = join(temp, 'report.json');
        const env = { ...baseEnv, ...pass.env, FREEDOM_PINNED_E2E_ROOT: root,
          PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath, PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: join(temp, 'last-run.json') };
        const partitioned = profile === 'full' && pass.id === 'default';
        const deadline = partitioned ? Date.now() + E2E_PASS_TIMEOUT_MS.default : undefined;
        let listing, listing_exit_code, listing_evidence_sha256;
        if (profile !== 'full' || partitioned) {
          const listed = await execute(root, cli, pass, env, controller.signal, configFile,
            { listing: true, timeoutMs: partitioned ? deadline - Date.now() : undefined });
          listing_exit_code = listed.exit_code;
          const data = await readPassReport(reportPath);
          listing = data.report; listing_evidence_sha256 = data.evidence_sha256;
          executionReason = listed.reason ?? (listed.exit_code !== 0 ? 'test_process_failed' : !listing ? 'invalid_case_listing' : undefined);
          if (executionReason) {
            passReports.push({ id: pass.id, exit_code: listed.exit_code, listing, listing_exit_code, listing_evidence_sha256 });
            break;
          }
          await rename(reportPath, join(temp, 'listing.json'));
        }
        if (partitioned) {
          const peers = new AbortController();
          const signal = AbortSignal.any([controller.signal, peers.signal]);
          let failed;
          const partitions = await Promise.all(E2E_DEFAULT_SHARDS.map(async shard => {
            try {
              const directory = join(temp, `shard-${shard.current}`);
              await mkdir(directory);
              const shardEnv = { ...env, FREEDOM_E2E_PORT: String(shard.port),
                FREEDOM_E2E_SCHEMA: `fp_e2e_${randomUUID().replaceAll('-', '')}`,
                PLAYWRIGHT_JSON_OUTPUT_FILE: join(directory, 'report.json'),
                PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: join(directory, 'last-run.json') };
              const ran = await execute(root, cli, pass, shardEnv, signal, configFile,
                { shard, timeoutMs: deadline - Date.now() });
              const data = await readPassReport(shardEnv.PLAYWRIGHT_JSON_OUTPUT_FILE);
              const reason = ran.reason ?? (ran.exit_code !== 0 ? 'test_process_failed' : !data.report ? 'invalid_test_results' : undefined);
              if (reason && !failed) { failed = reason; peers.abort(); }
              return { current: shard.current, total: shard.total, exit_code: ran.exit_code, ...data };
            } catch {
              if (!failed) { failed = 'incomplete_test_results'; peers.abort(); }
              return { current: shard.current, total: shard.total, exit_code: null };
            }
          }));
          executionReason = failed;
          const exit_code = partitions.every(part => part.exit_code === 0) ? 0
            : partitions.find(part => Number.isInteger(part.exit_code) && part.exit_code !== 0)?.exit_code ?? null;
          passReports.push({ id: pass.id, exit_code, partitions, listing, listing_exit_code, listing_evidence_sha256 });
        } else {
          const ran = await execute(root, cli, pass, env, controller.signal, configFile);
          const data = await readPassReport(reportPath);
          passReports.push({ id: pass.id, exit_code: ran.exit_code, ...data,
            ...(profile !== 'full' ? { listing, listing_exit_code, listing_evidence_sha256 } : {}) });
          executionReason = ran.reason ?? (ran.exit_code !== 0 ? 'test_process_failed' : !data.report ? 'invalid_test_results' : undefined);
        }
        // An early stop leaves fewer passes; report its cause rather than invalid_pass_plan.
        if (executionReason) break;
        progress = evaluateE2ePassProgress(expectedFiles, passReports, evidenceOptions);
        if (progress.status !== 'passed') { executionReason = progress.reason; break; }
        passCompleted = true;
      } finally {
        if (temp) await cleanupE2ePass(temp, output, pass.id, !passCompleted);
      }
    }
  } catch { executionReason ??= 'incomplete_test_results'; }
  finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  if (controller.signal.aborted) executionReason = 'test_cancelled';
  const result = progress?.status === 'failed' ? progress : evaluateE2ePasses(expectedFiles, passReports, evidenceOptions);
  if (executionReason) { result.status = 'failed'; result.reason = executionReason; }
  await publish(result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('pinned_e2e_output_unavailable');
  process.exitCode = 1;
});
