import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext } from './context.mjs';
import { inspectWorkspace, resolveCommit } from './workspace.mjs';
import { readBounded, parseJson, sha256 } from './io.mjs';
import { validateFormat } from './formats.mjs';
import { verifyContractPin } from './contracts.mjs';
import { safeFailure, requireCondition as check } from './errors.mjs';
import { verificationEnvironment } from './process-env.mjs';

export async function runLocalSuite(root, id) {
  // Candidate descriptors may choose IDs, never executable commands or hooks.
  if (id !== 'governance.unit') return { check_id: id, status: 'not_run', reason: 'suite_adapter_unavailable' };
  let files;
  try {
    files = (await readdir(resolve(root, 'packages/contribution-tools/test')))
      .filter(name => /^[a-z][a-z0-9-]*\.test\.mjs$/.test(name)).sort()
      .map(name => 'packages/contribution-tools/test/' + name);
    for (const path of files) await readBounded(root, path);
  } catch { return { check_id: id, status: 'not_run', reason: 'suite_files_unavailable' }; }
  if (!files.length) return { check_id: id, status: 'failed', reason: 'empty_test_set', test_count: 0 };
  let output;
  try {
    output = execFileSync(process.execPath, ['--test', '--test-reporter=' + fileURLToPath(new URL('./test-reporter.mjs', import.meta.url)), ...files], {
      cwd: root, timeout: 60_000, maxBuffer: 4_000_000, env: verificationEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { return { check_id: id, status: 'failed', reason: 'test_process_failed' }; }
  let result;
  try { result = parseJson(output); }
  catch { return { check_id: id, status: 'failed', reason: 'invalid_test_results' }; }
  const validCounts = item => item?.success === true && Number.isSafeInteger(item.counts?.tests)
    && item.counts.tests > 0 && item.counts.passed === item.counts.tests
    && ['failed', 'cancelled', 'skipped', 'todo'].every(name => item.counts[name] === 0);
  const tests = result.counts?.tests;
  const expected = new Set(files.map(file => resolve(root, file)));
  const complete = validCounts(result) && Array.isArray(result.files) && result.files.length === files.length
    && result.files.every(item => expected.delete(item.file) && validCounts(item)) && expected.size === 0;
  return { check_id: id, status: complete ? 'passed' : 'failed', reason: complete ? 'tests_executed' : 'incomplete_test_results',
    ...(Number.isSafeInteger(tests) ? { test_count: tests } : {}), evidence_sha256: sha256(output) };
}

async function contractCheck(workspace) {
  try {
    if (workspace.candidate_paths.includes('contracts.lock.json')) {
      await verifyContractPin({ repositoryRoot: workspace.root });
      return { check_id: 'contracts', status: 'passed', reason: 'local_pin_integrity' };
    }
    if (workspace.candidate_paths.includes('contracts/preview/v1/bundle.json')) {
      const bundle = parseJson(await readBounded(workspace.root, 'contracts/preview/v1/bundle.json'));
      check(bundle.format === 'freedom.contract-bundle/v1' && bundle.files && typeof bundle.files === 'object', 'invalid_preview_bundle');
      for (const [path, declared] of Object.entries(bundle.files)) {
        const bytes = await readBounded(workspace.root, 'contracts/preview/v1/' + path);
        check(bytes.length === declared.bytes && sha256(bytes) === declared.sha256, 'artifact_integrity_mismatch');
      }
      check(Object.keys(bundle.files).length > 0, 'empty_preview_bundle');
      return { check_id: 'contracts', status: 'passed', reason: 'producer_preview_bytes_only' };
    }
    return { check_id: 'contracts', status: 'not_run', reason: 'contract_source_missing' };
  } catch (error) {
    const failure = safeFailure(error);
    return { check_id: 'contracts', status: failure.status === 'unavailable' ? 'not_run' : 'failed', reason: failure.code };
  }
}

export async function verifyWorkspace(options, { suiteRunner = runLocalSuite } = {}) {
  const built = await buildContext(options), { workspace, context, impact } = built;
  const checks = [{ check_id: 'descriptors', status: 'passed', reason: 'schema_and_references_checked' }, await contractCheck(workspace)];
  for (const blocker of context.blockers) checks.push({ check_id: blocker, status: 'not_run', reason: blocker });
  const suites = new Set(impact.tests);
  if (impact.unknown_paths.length) {
    suites.add('governance.unit'); suites.add('runtime.full');
  }
  const codeChanged = workspace.changed_paths.some(path => /\.(?:[cm]?[jt]sx?|rs|sql|jsonc?)$/.test(path));
  if (codeChanged && !suites.size) checks.push({ check_id: 'coverage', status: 'not_run', reason: 'surface_unmapped' });
  for (const id of [...suites].sort()) checks.push(await suiteRunner(workspace.root, id));
  const runtimeChanged = impact.module_ids.some(id => id !== 'governance') || impact.unknown_paths.length > 0;
  if (runtimeChanged) checks.push({ check_id: 'runtime.surface-coverage', status: 'not_run', reason: 'registration_behavior_audit_required' });
  const current = await inspectWorkspace(workspace.root, workspace.base_commit);
  if (current.workspace_sha256 !== workspace.workspace_sha256) checks.push({ check_id: 'workspace', status: 'failed', reason: 'workspace_changed_during_verification' });
  if (resolveCommit(workspace.root, options.baseRef ?? 'origin/main') !== workspace.base_commit) {
    checks.push({ check_id: 'base', status: 'failed', reason: 'base_changed_during_verification' });
  }
  const status = checks.some(item => item.status === 'failed') ? 'failed'
    : checks.some(item => item.status === 'not_run') ? 'unavailable' : 'passed';
  const report = { format: 'freedom.verifier-report/v1', assurance_level: 'local', repository: context.repository,
    base_commit: workspace.base_commit, head_commit: workspace.head_commit, workspace_sha256: workspace.workspace_sha256,
    status, scope: impact.module_ids, checks, blockers: [...new Set(checks.filter(item => item.status !== 'passed').map(item => item.reason))].sort() };
  validateFormat('verifierReport', report);
  return report;
}
