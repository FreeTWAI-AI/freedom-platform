import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { E2E_BASELINE, E2E_PLAN, E2E_PASS_TIMEOUT_MS, evaluateE2ePasses } from '../../packages/contribution-tools/pinned-e2e.mjs';
import { readBounded } from '../../packages/contribution-tools/io.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const configFile = fileURLToPath(new URL('./pinned-playwright.config.mjs', import.meta.url));

// SIGTERM allows Playwright's 15s webServer shutdown to drop the private schema.
// Escalation is bounded independently of the host-owned whole-pass budget.
function execute(root, cli, pass, env, signal) {
  return new Promise(done => {
    const group = process.platform !== 'win32';
    const child = spawn(process.execPath, [cli, 'test', '--config', configFile, '--forbid-only', '--reporter=list,json', '--output', join(dirname(env.PLAYWRIGHT_JSON_OUTPUT_FILE), 'artifacts'), ...pass.files],
      { cwd: root, env, stdio: 'inherit', detached: group });
    let reason, escalation;
    const kill = name => {
      try { if (group && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* already exited */ }
    };
    const stop = code => {
      if (reason) return;
      reason = code;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 20000);
    };
    const abort = () => stop('test_cancelled');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop('test_timeout'), E2E_PASS_TIMEOUT_MS[pass.id]);
    child.once('error', () => { reason ??= 'test_process_failed'; });
    child.once('close', (exit_code, termination_signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener('abort', abort);
      done({ exit_code, reason: reason ?? (termination_signal ? 'test_process_failed' : undefined) });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!((args.length === 2 || args.length === 4) && args[0] === '--root' && args[1]
    && !args[1].startsWith('--') && (args.length === 2 || (args[2] === '--output' && args[3] && !args[3].startsWith('--'))))) {
    console.error('invalid_pinned_e2e_arguments');
    process.exitCode = 2;
    return;
  }
  const root = resolve(args[1]);
  const output = args.length === 4 ? resolve(args[3]) : resolve(root, '.freedom/reports/pinned-e2e.json');
  let expectedFiles = [], passReports = [];
  const fail = (status, reason) => ({ check_id: 'ci.e2e', status, reason, test_count: 0,
    selected_files: expectedFiles, test_files: expectedFiles.map(path => ({ path, counts: { tests: 0, passed: 0 } })), passes: [] });
  const publish = async (result, exitCode = result.status === 'passed' ? 0 : 1) => {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ check_id: result.check_id, status: result.status, reason: result.reason,
      test_count: result.test_count, file_count: result.selected_files.length,
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
    const found = (await readdir(resolve(root, 'tests/e2e')))
      .filter(name => /^[a-z0-9][a-z0-9-]*\.spec\.ts$/.test(name)).map(name => 'tests/e2e/' + name);
    expectedFiles = [...new Set([...E2E_BASELINE, ...found])].sort();
    for (const file of expectedFiles) await readBounded(root, file);
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
  // The pinned plan owns all fixture flags; inherited flags cannot alter pass 1.
  delete baseEnv.FREEDOM_E2E_PRIVATE_AI_FIXTURE;
  delete baseEnv.FREEDOM_E2E_AVATAR_ASSET_FIXTURE;
  delete baseEnv.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE;
  delete baseEnv.FREEDOM_E2E_STORE_PHOTO_FIXTURE;
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let executionReason;
  try {
    for (const pass of E2E_PLAN) {
      if (controller.signal.aborted) { executionReason = 'test_cancelled'; break; }
      let temp;
      try {
        temp = await mkdtemp(join(tmpdir(), 'fp-pinned-'));
        const reportPath = join(temp, 'report.json');
        const ran = await execute(root, cli, pass,
          { ...baseEnv, ...pass.env, FREEDOM_PINNED_E2E_ROOT: root, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath, PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: join(temp, 'last-run.json') }, controller.signal);
        executionReason = ran.reason;
        let report, evidence_sha256;
        try {
          const bytes = await readFile(reportPath);
          report = JSON.parse(bytes.toString('utf8'));
          evidence_sha256 = sha256(bytes);
        } catch { /* unreadable evidence fails closed */ }
        passReports.push({ id: pass.id, exit_code: ran.exit_code, report, evidence_sha256 });
        // An early stop leaves fewer passes; report its cause rather than invalid_pass_plan.
        if (!executionReason && ran.exit_code !== 0) executionReason = 'test_process_failed';
        if (!executionReason && !report) executionReason = 'invalid_test_results';
        if (executionReason) break;
      } finally {
        if (temp) await rm(temp, { recursive: true, force: true });
      }
    }
  } catch { executionReason ??= 'incomplete_test_results'; }
  finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  if (controller.signal.aborted) executionReason = 'test_cancelled';
  const result = evaluateE2ePasses(expectedFiles, passReports, { rootDir: resolve(root, 'tests/e2e').split(sep).join('/'), configFile });
  if (executionReason) { result.status = 'failed'; result.reason = executionReason; }
  await publish(result);
}

main().catch(() => {
  console.error('pinned_e2e_output_unavailable');
  process.exitCode = 1;
});
