import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDescriptor } from '../../packages/contribution-tools/context.mjs';
import {
  ALWAYS_ON_INTEGRITY_COMMANDS, DOCS_ALLOWLIST_PREFIXES, GENERATED_INVENTORY_PATH, JOB_OUTPUT_KEYS, SELECTABLE_JOBS, FRONTEND_LEAF_PROFILES, FRONTEND_LEAF_JOBS,
  changesFromTrees, collectRepositoryDecision, decideAffectedJobs, evaluateVerifyAggregate, githubOutput,
  heavyJobCondition, isDocsAllowlisted, loadModuleDescriptors, parseLsTreeZ, parseNameStatusZ,
} from './select-affected-jobs.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const selector = fileURLToPath(new URL('./select-affected-jobs.mjs', import.meta.url));
const workflowPath = join(root, '.github/workflows/verify.yml');
const oid = (suffix = 'a') => suffix.repeat(40).slice(0, 40);
const narrow = () => [moduleDescriptor('example', ['modules/example/**'])];

function moduleDescriptor(id, paths, extra = {}) {
  return {
    format: 'freedom.module/v1', module_id: id, owner_role: 'foundation', owned_paths: paths,
    public_exports: [], dependencies: extra.dependencies ?? [], contract_families: ['preview'],
    client_profiles: ['member'], instructions: ['governance/README.md'], invariants: ['local-only'],
    tests: extra.tests ?? ['governance.unit'], surfaces: [],
  };
}
function pull(changes, extra = {}) {
  return decideAffectedJobs({
    event: 'pull_request', diffComplete: true, changes,
    baseline: extra.baseline ?? narrow(), candidate: extra.candidate ?? extra.baseline ?? narrow(),
    ...extra,
  });
}
function edited(path, status = 'M') { return { path, status }; }
function needsFor(selection, results, { select = 'success', integrity = 'success', extra = {} } = {}) {
  const outputs = Object.fromEntries(githubOutput(selection).trim().split('\n').map(line => line.split('=')));
  const needs = {
    select: { result: select, outputs },
    'source-integrity': { result: integrity, outputs: {} },
    ...extra,
  };
  for (const id of SELECTABLE_JOBS) needs[id] = { result: results[id], outputs: {} };
  return needs;
}
function allResults(result) {
  return Object.fromEntries(SELECTABLE_JOBS.map(id => [id, result]));
}
function jobBlock(text, name) {
  const marker = `\n  ${name}:\n`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, name);
  const rest = text.slice(start + marker.length);
  const next = rest.search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('explicit docs prefixes are prose trees outside platform-plan and runtime text', () => {
  assert.deepEqual([...DOCS_ALLOWLIST_PREFIXES], ['docs/development/', 'docs/design/', 'docs/plans/', 'docs/releases/']);
  assert.equal(isDocsAllowlisted('docs/development/runtime-ci-postgres.md'), true);
  assert.equal(isDocsAllowlisted('docs/skill-book-upstream-sync-2026-09-27.md'), true);
  assert.equal(isDocsAllowlisted('docs/plans/unified-foundation.md'), true);
  assert.equal(isDocsAllowlisted('docs/platform-plan/execution/unified-foundation/handoff-2026-10-04.md'), false);
  assert.equal(isDocsAllowlisted(GENERATED_INVENTORY_PATH), false);
  assert.equal(GENERATED_INVENTORY_PATH, 'docs/platform-plan/verification/2026-09-20-file-inventory.json');
  assert.equal(isDocsAllowlisted('packages/shop-agent/common.md'), false);
  assert.equal(isDocsAllowlisted('packages/skill-upload-client/SKILL.md'), false);
  assert.equal(isDocsAllowlisted('README.md'), false);
});

test('docs-only pull request skips heavy jobs and keeps runtime partitions tied', () => {
  const selection = pull([edited('docs/development/runtime-ci-postgres.md'), edited('docs/releases/note.md', 'A')]);
  assert.equal(selection.mode, 'docs');
  assert.equal(selection.reason, 'docs_allowlist');
  assert.equal(Object.hasOwn(selection.jobs, 'source-integrity'), false);
  for (const id of SELECTABLE_JOBS) assert.equal(selection.jobs[id], false);
  assert.equal(selection.jobs['runtime-full'], selection.jobs['runtime-aggregate']);
});

test('merge_group, push, and any other event stay on the full set', () => {
  const docs = [edited('docs/development/runtime-ci-postgres.md')];
  assert.equal(decideAffectedJobs({ event: 'merge_group', diffComplete: true, changes: docs, baseline: narrow(), candidate: narrow() }).reason, 'merge_group');
  assert.equal(decideAffectedJobs({ event: 'push', diffComplete: true, changes: docs, baseline: narrow(), candidate: narrow() }).reason, 'push');
  assert.equal(decideAffectedJobs({ event: 'pull_request_target', diffComplete: true, changes: docs, baseline: narrow(), candidate: narrow() }).reason, 'non_pull_request');
  for (const event of ['merge_group', 'push', 'workflow_dispatch']) {
    const selection = decideAffectedJobs({ event, diffComplete: true, changes: docs, baseline: narrow(), candidate: narrow() });
    assert.equal(selection.mode, 'full');
    for (const id of SELECTABLE_JOBS) assert.equal(selection.jobs[id], true);
  }
});

test('incomplete, empty, and oversized diffs stay on the full set', () => {
  assert.equal(pull([], { diffComplete: false }).reason, 'diff_unproven');
  assert.equal(decideAffectedJobs({ event: 'pull_request', diffComplete: true, changes: [], baseline: narrow(), candidate: narrow() }).reason, 'empty_diff');
  const many = Array.from({ length: 4097 }, (_, index) => edited(`docs/development/note-${index}.md`));
  assert.equal(decideAffectedJobs({ event: 'pull_request', diffComplete: true, changes: many, baseline: narrow(), candidate: narrow() }).reason, 'diff_unproven');
});

test('deleted, renamed, copied, and mode changes stay on the full set', () => {
  assert.equal(pull([edited('docs/development/old.md', 'D')]).reason, 'deleted_path');
  assert.equal(pull([{ path: 'docs/development/new.md', previousPath: 'modules/example/old.ts', status: 'R100' }]).reason, 'renamed_or_copied_path');
  assert.equal(pull([{ path: 'docs/development/copy.md', previousPath: 'docs/development/old.md', status: 'C090' }]).reason, 'renamed_or_copied_path');
  assert.equal(pull([edited('docs/development/guide.md', 'T')]).reason, 'untrusted_change_status');
  assert.equal(pull([{ path: 'docs/development/guide.md', previousPath: 'docs/development/guide.md', status: 'M' }]).reason, 'untrusted_change_status');
  assert.equal(pull([{ path: 'docs/development/guide.md', status: 'U' }]).reason, 'untrusted_change_status');
});

test('unknown, root, governance, security, shared runtime, test, spec, and config paths stay on the full set', () => {
  assert.equal(pull([edited('docs/development/../secret.md')]).reason, 'unknown_path');
  assert.equal(pull([edited('not a path.md')]).reason, 'unknown_path');
  assert.equal(pull([edited('docs/development/.hidden.md')]).reason, 'unknown_path');
  assert.equal(pull([edited('AGENTS.md')]).reason, 'root_instruction');
  assert.equal(pull([edited('README.md')]).reason, 'root_instruction');
  assert.equal(pull([edited('.github/workflows/verify.yml')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('scripts/ci/select-affected-jobs.mjs')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('governance/README.md')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('docs/platform-plan/verification/verify_revision.py')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('packages/shared/index.ts')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('tests/runtime/command-core.test.ts')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('packages/db/index.ts')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('migrations/113_chat_stickers_replies.sql')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('apps/credential-broker/src/worker.ts')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('packages/shop-agent/common.md')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('docs/development/foo.test.md')]).reason, 'excluded_test_spec_or_config');
  assert.equal(pull([edited('docs/development/spec/guide.md')]).reason, 'excluded_test_spec_or_config');
  assert.equal(pull([edited('docs/development/snippet.ts')]).reason, 'excluded_test_spec_or_config');
  assert.equal(pull([edited('docs/development/config.json')]).reason, 'excluded_test_spec_or_config');
  assert.equal(pull([edited('apps/portal-web/src/App.tsx')]).reason, 'not_docs_allowlist');
  assert.equal(pull([edited('package.json')]).reason, 'not_docs_allowlist');
  assert.equal(pull([edited('docs/design/mark.png')]).reason, 'not_docs_allowlist');
});

test('the generated inventory is metadata only beside an allowlisted document', () => {
  const inventoryOwner = [moduleDescriptor('governance', ['modules/example/**', 'docs/platform-plan/verification/**'])];
  const accompanied = pull([
    edited('docs/development/notes.md'), edited(GENERATED_INVENTORY_PATH, 'A'),
  ], { baseline: inventoryOwner, candidate: inventoryOwner });
  assert.equal(accompanied.mode, 'docs');
  assert.equal(accompanied.reason, 'docs_allowlist');
  for (const id of SELECTABLE_JOBS) assert.equal(accompanied.jobs[id], false);
  assert.equal(accompanied.jobs['runtime-full'], accompanied.jobs['runtime-aggregate']);
  assert.equal(pull([edited(GENERATED_INVENTORY_PATH)], { baseline: inventoryOwner, candidate: inventoryOwner }).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited(GENERATED_INVENTORY_PATH, 'D')]).reason, 'deleted_path');
  assert.equal(pull([{ path: GENERATED_INVENTORY_PATH, previousPath: 'docs/development/old.md', status: 'R' }]).reason, 'renamed_or_copied_path');
  assert.equal(pull([edited('docs/development/notes.md'), edited(GENERATED_INVENTORY_PATH), edited('docs/platform-plan/verification/verify_revision.py')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('docs/development/notes.md'), edited('docs/platform-plan/execution/note.md'), edited(GENERATED_INVENTORY_PATH)]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('docs/development/notes.md'), edited('docs/platform-plan/verification/2026-09-20-file-inventory.json.bak')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('docs/development/notes.md'), edited(GENERATED_INVENTORY_PATH), edited('apps/portal-web/src/App.tsx')]).reason, 'not_docs_allowlist');
  assert.equal(pull([edited('docs/development/notes.md'), edited(GENERATED_INVENTORY_PATH), edited('package.json')]).reason, 'not_docs_allowlist');
  assert.equal(pull([edited('docs/development/notes.md'), edited(GENERATED_INVENTORY_PATH), edited('apps/portal-web/public/downloads/freedom-skill-client.tgz')]).reason, 'not_docs_allowlist');
  assert.equal(pull([edited('docs/development/notes.md'), edited(GENERATED_INVENTORY_PATH), edited('.github/workflows/verify.yml')]).reason, 'governance_security_or_shared_runtime');
  assert.equal(pull([edited('docs/development/notes.md'), edited(GENERATED_INVENTORY_PATH), edited('docs/development/foo.test.md')]).reason, 'excluded_test_spec_or_config');
  assert.equal(pull([edited('docs/development/notes.md'), edited(GENERATED_INVENTORY_PATH), edited('docs/development/config.json')]).reason, 'excluded_test_spec_or_config');
  const ownedDoc = [moduleDescriptor('notes', ['docs/development/**', 'docs/platform-plan/verification/**'])];
  assert.equal(pull([
    edited('docs/development/notes.md'), edited(GENERATED_INVENTORY_PATH),
  ], { baseline: ownedDoc, candidate: ownedDoc }).reason, 'baseline_candidate_union');
});

test('one non-doc path keeps the whole pull request on the full set', () => {
  const selection = pull([edited('docs/development/guide.md'), edited('apps/portal-web/src/App.tsx')]);
  assert.equal(selection.mode, 'full');
  assert.equal(selection.reason, 'not_docs_allowlist');
});

test('baseline ownership survives a candidate descriptor that drops the path', () => {
  const baseline = [moduleDescriptor('execution-runs', ['modules/agent-execution/**', 'docs/development/worker-private-ai-bindings.md'])];
  const candidate = [moduleDescriptor('execution-runs', ['modules/agent-execution/**'])];
  const selection = pull([edited('docs/development/worker-private-ai-bindings.md')], { baseline, candidate });
  assert.equal(selection.mode, 'full');
  assert.equal(selection.reason, 'baseline_candidate_union');
});

test('a shrunk directory glob cannot remove baseline docs from the full set', () => {
  const baseline = [moduleDescriptor('notes', ['docs/development/**'])];
  const candidate = [moduleDescriptor('notes', ['docs/design/**'])];
  const selection = pull([edited('docs/development/guide.md')], { baseline, candidate });
  assert.equal(selection.reason, 'baseline_candidate_union');
});

test('candidate ownership and reverse dependencies widen a docs path to the full set', () => {
  const baseline = narrow();
  const owner = moduleDescriptor('notes', ['docs/plans/**']);
  const dependent = moduleDescriptor('page', ['apps/portal-web/src/modules/**'], { dependencies: ['notes'], tests: ['runtime.card'] });
  const selection = pull([edited('docs/plans/unified-foundation.md')], { baseline: [...baseline, owner], candidate: [...baseline, owner, dependent] });
  assert.equal(selection.reason, 'baseline_candidate_union');
});

test('missing descriptors cannot prove a docs-only decision', () => {
  assert.equal(pull([edited('docs/development/guide.md')], { baseline: [], candidate: [] }).reason, 'descriptors_unproven');
  assert.equal(pull([edited('docs/development/guide.md')], { descriptorsProven: false }).reason, 'descriptors_unproven');
  assert.equal(pull([edited('apps/portal-web/src/App.tsx')], { baseline: [], candidate: [] }).reason, 'not_docs_allowlist');
});

test('tree comparison reports content edits, deletions, mode changes, and unique renames', () => {
  const base = new Map([
    ['docs/development/guide.md', { mode: '100644', type: 'blob', oid: oid('a') }],
    ['modules/old.ts', { mode: '100644', type: 'blob', oid: oid('b') }],
    ['docs/development/link.md', { mode: '120000', type: 'blob', oid: oid('c') }],
    ['keep.ts', { mode: '100644', type: 'blob', oid: oid('d') }],
  ]);
  const head = new Map([
    ['docs/development/guide.md', { mode: '100644', type: 'blob', oid: oid('e') }],
    ['docs/development/moved.md', { mode: '100644', type: 'blob', oid: oid('b') }],
    ['docs/development/link.md', { mode: '100644', type: 'blob', oid: oid('c') }],
    ['keep.ts', { mode: '100755', type: 'blob', oid: oid('d') }],
  ]);
  const diff = changesFromTrees(base, head);
  assert.equal(diff.ok, true);
  assert.deepEqual(diff.changes, [
    { path: 'docs/development/guide.md', status: 'M' },
    { path: 'docs/development/link.md', status: 'T' },
    { path: 'docs/development/moved.md', status: 'R', previousPath: 'modules/old.ts' },
    { path: 'keep.ts', status: 'T' },
  ]);
  assert.equal(pull(diff.changes).mode, 'full');
  assert.equal(pull(diff.changes).reason, 'renamed_or_copied_path');
});

test('name-status letters for rename and delete stay on the full set', () => {
  const parsed = parseNameStatusZ('M\0docs/development/guide.md\0R100\0modules/old.ts\0docs/development/moved.md\0D\0docs/development/gone.md\0');
  assert.equal(parsed.ok, true);
  assert.equal(pull(parsed.changes).reason, 'deleted_path');
  assert.equal(parseNameStatusZ('R100\0only-old\0').ok, false);
  const broken = parseLsTreeZ('100644 blob ' + oid('a') + '\tdocs/development/guide.md\0broken\0');
  assert.equal(broken.ok, false);
});

test('aggregate passes a proven docs skip and a complete full run', () => {
  const docsDecision = pull([edited('docs/development/guide.md')]);
  const fullDecision = pull([edited('package.json')]);
  assert.equal(evaluateVerifyAggregate(needsFor(docsDecision, allResults('skipped'))).reason, 'docs_selected_subset');
  assert.equal(evaluateVerifyAggregate(needsFor(fullDecision, allResults('success'))).reason, 'full_selection');
  const extraSuccess = needsFor(docsDecision, allResults('skipped'));
  extraSuccess['runtime-full'] = { result: 'success', outputs: {} };
  assert.equal(evaluateVerifyAggregate(extraSuccess).ok, true);
});

test('deployment preflight must be observed and succeed when selected, while docs may skip it', () => {
  for (const [selection, otherResult] of [
    [pull([edited('deploy/cloudflare/lib/migrations.mjs')]), 'success'],
    [pull([edited('docs/development/guide.md')]), 'skipped'],
  ]) {
    for (const result of [undefined, 'failure', 'cancelled', 'skipped', 'success']) {
      const needs = needsFor(selection, allResults(otherResult));
      if (result === undefined) delete needs['deploy-preflight'];
      else needs['deploy-preflight'].result = result;
      const verdict = evaluateVerifyAggregate(needs);
      const shouldPass = result === 'success' || (selection.mode === 'docs' && result === 'skipped');
      assert.equal(verdict.ok, shouldPass, `${selection.mode}: deploy-preflight ${result ?? 'missing'}`);
      if (!shouldPass) assert.deepEqual(verdict, {
        ok: false,
        reason: selection.mode === 'full' ? 'selected_job_not_success' : 'unselected_job_not_clean',
        job: 'deploy-preflight', result: result ?? 'missing',
      });
    }
  }
});

test('failed, cancelled, missing, and inconsistent dependencies never pass', () => {
  const docsDecision = pull([edited('docs/development/guide.md')]);
  const fullDecision = pull([edited('package.json')]);
  const cases = [
    needsFor(fullDecision, { ...allResults('success'), 'runtime-full': 'failure' }),
    needsFor(fullDecision, { ...allResults('success'), 'runtime-aggregate': 'cancelled' }),
    needsFor(fullDecision, { ...allResults('success'), 'ui-e2e': 'skipped' }),
    needsFor(docsDecision, { ...allResults('skipped'), 'static-worker': 'failure' }),
    needsFor(docsDecision, { ...allResults('skipped'), 'governance-consumers': 'cancelled' }),
    needsFor(docsDecision, allResults('skipped'), { integrity: 'failure' }),
    needsFor(docsDecision, allResults('skipped'), { integrity: 'skipped' }),
    needsFor(docsDecision, allResults('skipped'), { integrity: 'cancelled' }),
    needsFor(fullDecision, allResults('success'), { select: 'failure' }),
    needsFor(fullDecision, allResults('success'), { select: 'cancelled' }),
    needsFor(docsDecision, allResults('skipped'), { extra: { 'unexpected-job': { result: 'failure', outputs: {} } } }),
  ];
  for (const needs of cases) assert.equal(evaluateVerifyAggregate(needs).ok, false);
  for (const integrity of ['failure', 'cancelled', 'skipped']) {
    const verdict = evaluateVerifyAggregate(needsFor(docsDecision, allResults('skipped'), { integrity }));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'source_integrity_not_success');
  }
  const unavailable = needsFor(docsDecision, allResults('skipped'));
  delete unavailable['source-integrity'];
  assert.equal(evaluateVerifyAggregate(unavailable).reason, 'source_integrity_not_success');
  for (const selection of [docsDecision, fullDecision]) for (const missingReason of [undefined, '']) {
    const needs = needsFor(selection, allResults('success')); needs.select.outputs.reason = missingReason;
    assert.equal(evaluateVerifyAggregate(needs).reason, 'decision_incomplete');
  }
  const missingOutput = needsFor(fullDecision, allResults('success'));
  delete missingOutput.select.outputs.runtime_full;
  assert.equal(evaluateVerifyAggregate(missingOutput).reason, 'decision_incomplete');
  const split = needsFor(fullDecision, allResults('success'));
  split.select.outputs.runtime_aggregate = 'false';
  assert.equal(evaluateVerifyAggregate(split).ok, false);
  assert.equal(evaluateVerifyAggregate(null).reason, 'needs_missing');
});

test('real checkout descriptors parse without freezing live document ownership', () => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const loaded = loadModuleDescriptors(root, sha);
  assert.equal(loaded.ok, true);
  assert.ok(loaded.descriptors.length > 0);
  assert.ok(loaded.descriptors.every(descriptor => validateDescriptor(descriptor)));
  // Ownership/union/shrink assertions use controlled fixtures above. A valid
  // future module claiming an existing doc may legitimately select full CI.
});

test('repository tree diff narrows a docs edit and refuses a rename or merge_group input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fp-select-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Selector Test', GIT_AUTHOR_EMAIL: 'selector@example.invalid',
      GIT_COMMITTER_NAME: 'Selector Test', GIT_COMMITTER_EMAIL: 'selector@example.invalid' },
  });
  git(['init', '-q', '-b', 'main']);
  const put = async (path, body) => { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), body); };
  await put('packages/example/freedom.module.json', JSON.stringify(moduleDescriptor('example', ['modules/example/**'])));
  await put('governance/README.md', '# Fixture\n');
  await put('docs/development/guide.md', 'original\n');
  await put('modules/old.ts', 'export const uniqueRename = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  await put('docs/development/guide.md', 'candidate prose\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'docs']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const docsDecision = collectRepositoryDecision({ repository: directory, event: 'pull_request', base, head });
  assert.equal(docsDecision.reason, 'docs_allowlist');
  const queued = collectRepositoryDecision({ repository: directory, event: 'merge_group', base, head });
  assert.equal(queued.reason, 'merge_group');
  await put('docs/development/moved.md', 'export const uniqueRename = 1;\n');
  git(['add', 'docs/development/moved.md']);
  git(['rm', '-q', 'modules/old.ts']);
  git(['commit', '-q', '-m', 'rename']);
  const renamed = git(['rev-parse', 'HEAD']).trim();
  const renameDecision = collectRepositoryDecision({ repository: directory, event: 'pull_request', base: head, head: renamed });
  assert.equal(renameDecision.mode, 'full');
  assert.equal(renameDecision.reason, 'renamed_or_copied_path');
  assert.equal(collectRepositoryDecision({ repository: directory, event: 'pull_request', base: 'g'.repeat(40), head }).reason, 'diff_unproven');
});

test('cli writes a full decision without treating a bad base as a skip', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fp-select-cli-'));
  const output = join(directory, 'output.txt');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await mkdtemp(join(tmpdir(), 'fp-select-repo-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Selector Test', GIT_AUTHOR_EMAIL: 'selector@example.invalid',
      GIT_COMMITTER_NAME: 'Selector Test', GIT_COMMITTER_EMAIL: 'selector@example.invalid' },
  });
  git(['init', '-q', '-b', 'main']);
  await mkdir(join(repo, 'docs/development'), { recursive: true });
  await mkdir(join(repo, 'packages/example'), { recursive: true });
  await mkdir(join(repo, 'governance'), { recursive: true });
  await writeFile(join(repo, 'governance/README.md'), '# Fixture\n');
  await writeFile(join(repo, 'packages/example/freedom.module.json'), JSON.stringify(moduleDescriptor('example', ['modules/example/**'])));
  await writeFile(join(repo, 'docs/development/guide.md'), 'one\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  const run = spawnSync(process.execPath, [selector, '--event', 'pull_request', '--repository', repo, '--base', base,
    '--head', 'a'.repeat(40), '--github-output', output], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  const text = await readFile(output, 'utf8');
  assert.match(text, /^mode=full\nreason=diff_unproven\n/u);
  assert.match(text, /runtime_full=true\nruntime_aggregate=true\n/);
  const usage = spawnSync(process.execPath, [selector, '--unknown'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  const aggregate = spawnSync(process.execPath, [selector, '--check-aggregate'], {
    encoding: 'utf8', env: { ...process.env, NEEDS_JSON: '{' },
  });
  assert.equal(aggregate.status, 1);
});

test('a real git docs edit plus regenerated inventory narrows, and a tampered manifest does not', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fp-select-inventory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Selector Test', GIT_AUTHOR_EMAIL: 'selector@example.invalid',
      GIT_COMMITTER_NAME: 'Selector Test', GIT_COMMITTER_EMAIL: 'selector@example.invalid' },
  });
  const put = async (path, body) => { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), body); };
  const runPython = script => spawnSync('python3', [script], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const regenerate = () => {
    const result = runPython('scripts/update-inventory.py');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Wrote [1-9][0-9]* file hashes to docs\/platform-plan\/verification\/2026-09-20-file-inventory\.json/u);
    return result.stdout;
  };
  const verifyInventory = () => runPython('docs/platform-plan/verification/verify_revision.py');
  const at = sha => { git(['checkout', '-q', '-f', sha]); git(['clean', '-fdq']); };
  const assertDocs = selection => {
    assert.equal(selection.mode, 'docs');
    assert.equal(selection.reason, 'docs_allowlist');
    for (const id of SELECTABLE_JOBS) assert.equal(selection.jobs[id], false);
    assert.equal(selection.jobs['runtime-full'], selection.jobs['runtime-aggregate']);
  };
  const assertFull = (selection, reason) => {
    assert.equal(selection.mode, 'full');
    assert.equal(selection.reason, reason);
    for (const id of SELECTABLE_JOBS) assert.equal(selection.jobs[id], true);
  };
  git(['init', '-q', '-b', 'main']);
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await mkdir(join(directory, 'docs/platform-plan/verification'), { recursive: true });
  await copyFile(join(root, 'scripts/update-inventory.py'), join(directory, 'scripts/update-inventory.py'));
  await copyFile(join(root, 'docs/platform-plan/verification/verify_revision.py'), join(directory, 'docs/platform-plan/verification/verify_revision.py'));
  await put('package.json', '{"version":"0.0.0"}\n');
  await put('governance/README.md', '# Fixture\n');
  await put('docs/development/notes.md', '# Notes\n\nOrdinary development note.\n');
  await put('packages/example/freedom.module.json', JSON.stringify(moduleDescriptor('governance', [
    'modules/example/**', 'docs/platform-plan/verification/**',
  ])));
  regenerate();
  const initial = verifyInventory();
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  assert.match(initial.stdout, /[1-9][0-9]* file hashes; [0-9]+ local file\/directory links; 0 failures/u);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  await put('docs/development/notes.md', '# Notes\n\nOrdinary development note.\n\nReviewed wording.\n');
  regenerate();
  const regenerated = verifyInventory();
  assert.equal(regenerated.status, 0, regenerated.stdout + regenerated.stderr);
  assert.match(regenerated.stdout, /0 failures/u);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'docs and inventory']);
  const docsHead = git(['rev-parse', 'HEAD']).trim();
  assert.notEqual(git(['show', `${base}:${GENERATED_INVENTORY_PATH}`]), git(['show', `${docsHead}:${GENERATED_INVENTORY_PATH}`]));
  assertDocs(collectRepositoryDecision({ repository: directory, event: 'pull_request', base, head: docsHead }));
  at(base);
  const manifestPath = join(directory, GENERATED_INVENTORY_PATH);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files[0].sha256 = manifest.files[0].sha256.startsWith('0') ? '1'.repeat(64) : '0'.repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const tampered = verifyInventory();
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stdout, /FAIL:/u);
  git(['add', GENERATED_INVENTORY_PATH]);
  git(['commit', '-q', '-m', 'tamper inventory']);
  const tamperedHead = git(['rev-parse', 'HEAD']).trim();
  assertFull(collectRepositoryDecision({ repository: directory, event: 'pull_request', base, head: tamperedHead }), 'governance_security_or_shared_runtime');
  at(base);
  await put('docs/development/notes.md', '# Notes\n\nOrdinary development note.\n\nReviewed wording.\n');
  await put('docs/platform-plan/verification/extra.md', '# Not exempt\n');
  regenerate();
  const extraPlan = verifyInventory();
  assert.equal(extraPlan.status, 0, extraPlan.stdout + extraPlan.stderr);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'docs inventory and platform-plan']);
  const extraHead = git(['rev-parse', 'HEAD']).trim();
  assertFull(collectRepositoryDecision({ repository: directory, event: 'pull_request', base, head: extraHead }), 'governance_security_or_shared_runtime');
  at(base);
  await put('modules/example/added.mjs', 'export const added = 1;\n');
  regenerate();
  const codeTree = verifyInventory();
  assert.equal(codeTree.status, 0, codeTree.stdout + codeTree.stderr);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'code and inventory']);
  const codeHead = git(['rev-parse', 'HEAD']).trim();
  assertFull(collectRepositoryDecision({ repository: directory, event: 'pull_request', base, head: codeHead }), 'not_docs_allowlist');
});

test('verify workflow keeps the required gate, unconditional integrity, and historical checks', async () => {
  const text = await readFile(workflowPath, 'utf8');
  const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\nconcurrency:\n'));
  assert.match(on, /pull_request:\n/);
  assert.match(on, /merge_group:\n/);
  assert.match(on, /push:\n/);
  assert.doesNotMatch(on, /\n\s+paths:/u);
  assert.equal(text.includes('github.event.merge_group'), false);
  assert.match(text, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
  for (const id of ['select', 'verify']) {
    const trusted = jobBlock(text, id);
    assert.match(trusted, /repository: \$\{\{ job\.workflow_repository \}\}/u);
    assert.match(trusted, /ref: \$\{\{ job\.workflow_sha \}\}/u);
  }
  assert.match(text, /ref: \$\{\{ github\.sha \}\}/u);
  const verify = jobBlock(text, 'verify');
  assert.match(verify, /if: \$\{\{ always\(\) \}\}/u);
  const needsLine = /^ {4}needs: \[([^\]]+)\]$/mu.exec(verify);
  assert.ok(needsLine, 'verify declares the actual job dependencies');
  assert.deepEqual(needsLine[1].split(',').map(id => id.trim()).sort(),
    ['select', 'source-integrity', ...SELECTABLE_JOBS].sort());
  assert.match(verify, /--check-aggregate/);
  assert.doesNotMatch(verify, /required\.some/);
  const integrity = jobBlock(text, 'source-integrity');
  assert.doesNotMatch(integrity, /\n {4}needs:/u);
  assert.doesNotMatch(integrity, /\n {4}if:/u);
  for (const command of ALWAYS_ON_INTEGRITY_COMMANDS) assert.ok(integrity.includes(command), command);
  for (const key of Object.values(JOB_OUTPUT_KEYS)) {
    assert.ok(text.includes(heavyJobCondition(key)), key);
  }

  for (const id of ['source-integrity', 'runtime-full', 'runtime-aggregate', 'static-worker', 'governance-consumers', 'deploy-preflight']) {
    const trusted = jobBlock(text, id);
    assert.match(trusted, /repository: \$\{\{ job\.workflow_repository \}\}/u);
    assert.match(trusted, /ref: \$\{\{ job\.workflow_sha \}\}/u);
    assert.match(trusted, /path: \.freedom\/trusted/u);
    assert.match(trusted, /persist-credentials: false/u);
    assert.match(trusted, /test "\$\(git -C \.freedom\/trusted rev-parse HEAD\)" = "\$PINNED_SHA"/u);

    const checkout = trusted.indexOf('path: .freedom/trusted');
    assert.ok(checkout > 0, `Missing checkout in ${id}`);
    const first = trusted.indexOf('node .freedom/trusted/');
    const last = trusted.lastIndexOf('node .freedom/trusted/');
    assert.ok(first > checkout, `Trusted execution must come after checkout in ${id}`);
    assert.ok(trusted.lastIndexOf('npm ci') < checkout, `Last npm ci must come before checkout in ${id}`);
    assert.doesNotMatch(trusted.slice(checkout, last), /(?:^|\s)(?:npm|npx|node scripts\/|bash scripts\/)/mu, `No candidate command may run between checkout and last trusted command in ${id}`);
  }

  assert.match(jobBlock(text, 'ui-e2e'), /npm run test:e2e/);

  const banned = [
    'npm run test:governance',
    'npm run test:worker',
    'npm run test:skill-client',
    'npm run test:repos',
    'node --test deploy/cloudflare/test/',
    'node scripts/runtime-full.mjs',
    'node scripts/runtime-aggregate.mjs',
    'node --test --test-concurrency=1 tests/contribution-tools/',
    'node --test --test-concurrency=1 scripts/ci/select-affected-jobs.test.mjs'
  ];
  for (const str of banned) assert.doesNotMatch(text, new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));

  const runtimeFull = jobBlock(text, 'runtime-full');
  assert.match(runtimeFull, /partition: \[0, 1, 2, 3, 4, 5\]/);
  assert.match(runtimeFull, /fail-fast: false/);
  assert.match(runtimeFull, /node \.freedom\/trusted\/scripts\/runtime-full\.mjs --partition-count 6 --partition-index/);

  const runtimeAggregate = jobBlock(text, 'runtime-aggregate');
  assert.match(runtimeAggregate, /node \.freedom\/trusted\/scripts\/runtime-aggregate\.mjs --partition-count 6 --input-dir/);

  const staticWorker = jobBlock(text, 'static-worker');
  assert.match(staticWorker, /git diff --exit-code -- contracts\/preview\/v1 packages\/sdk/);
  assert.match(staticWorker, /npm run check:common-contracts/);

  const select = jobBlock(text, 'select');
  assert.match(select, /--allow-fetch/);

  const consumers = jobBlock(text, 'governance-consumers');
  assert.match(consumers, /npm run test:contracts/);
  assert.match(consumers, /npm run verify:inventory/);

  assert.match(integrity, /--suite ci\.selector-unit/);
  assert.match(integrity, /--suite ci\.governance-unit/);
  assert.match(jobBlock(text, 'runtime-full'), /--suite ci\.runtime-sharding-integration/);
  assert.match(jobBlock(text, 'static-worker'), /--suite ci\.worker-unit/);
  assert.match(consumers, /--suite ci\.skill-client-unit/);
  assert.match(consumers, /--suite ci\.runtime-union-integration/);
  assert.match(consumers, /--suite ci\.governance-unit/);
  assert.match(consumers, /--suite ci\.consumer-repositories/);
  assert.match(jobBlock(text, 'deploy-preflight'), /--suite ci\.deploy-preflight/);
  assert.match(jobBlock(text, 'deploy-preflight'), /--suite ci\.migration-postgres/);
});

function leafDescriptors() {
  return [
    ...FRONTEND_LEAF_PROFILES.map(profile => moduleDescriptor(profile.module, [...profile.paths], { dependencies: [...profile.dependencies], tests: [...profile.tests] })),
    moduleDescriptor('command-core', ['packages/command-core/**']),
    moduleDescriptor('public-guide-assets', ['packages/public-guide-assets/**']),
  ];
}
function leafDecision(paths = [FRONTEND_LEAF_PROFILES[0].paths[0]], extra = {}) {
  return pull(paths.map(path => edited(path)), { baseline: leafDescriptors(), ...extra });
}
function assertLeaf(selection) {
  assert.equal(selection.mode, 'affected');
  assert.equal(selection.reason, 'frontend_leaf_profiles');
  assert.deepEqual(selection.jobs, Object.fromEntries(SELECTABLE_JOBS.map(id => [id, FRONTEND_LEAF_JOBS.includes(id)])));
}

test('fixed frontend profiles retain complete runtime/browser/static jobs without adding a runner', () => {
  const descriptors = leafDescriptors();
  for (const profile of FRONTEND_LEAF_PROFILES) for (const path of profile.paths) {
    assertLeaf(leafDecision([path], {baseline: descriptors, candidate: descriptors}));
  }
  assertLeaf(leafDecision(FRONTEND_LEAF_PROFILES.flatMap(profile => profile.paths)));
  assertLeaf(leafDecision([FRONTEND_LEAF_PROFILES[0].paths[0], 'docs/development/ordinary.md', GENERATED_INVENTORY_PATH]));
  assert.deepEqual(FRONTEND_LEAF_JOBS, ['runtime-full', 'runtime-aggregate', 'ui-e2e', 'static-worker']);
  assert.equal(SELECTABLE_JOBS.length, 6);
});

test('leaf selection refuses new/unmapped/auth/contract/descriptor/runtime-text and destructive paths', () => {
  const leaf = FRONTEND_LEAF_PROFILES[0].paths[0];
  for (const path of ['apps/portal-web/src/modules/MemberShare.tsx', 'apps/portal-web/src/modules/PublicMemberPage.tsx',
    'apps/portal-web/src/modules/MemberCardShareActions.tsx', 'apps/portal-web/src/modules/newcomer-guides/gate.ts',
    'apps/portal-web/src/modules/newcomer-guides/release-pin.ts', 'apps/portal-web/src/modules/newcomer-guides/contracts.ts',
    'apps/portal-web/src/modules/newcomer-guides/new-page.tsx', 'apps/portal-web/src/App.tsx',
    'packages/command-core/README.md', 'contracts/common/v1/ArtifactRef.json', 'packages/shop-agent/common.md',
    'apps/portal-web/src/modules/freedom.module.json', 'modules/identity-membership/member-sharing.ts',
    'migrations/117_example.sql', 'deploy/cloudflare/migration-operator.mjs', 'scripts/database.ts']) {
    assert.equal(leafDecision([leaf, path]).mode, 'full', path);
  }
  for (const status of ['A', 'D', 'T', 'R100']) {
    assert.equal(pull([edited(leaf, status)], {baseline: leafDescriptors()}).mode, 'full', status);
  }
  for (const event of ['push', 'merge_group']) assert.equal(leafDecision([leaf], {event}).mode, 'full');
});

test('both descriptor graphs and their complete reverse dependencies must prove the fixed leaf profile', () => {
  const path = FRONTEND_LEAF_PROFILES[0].paths[0], baseline = leafDescriptors();
  const changed = transform => { const candidate = structuredClone(baseline); transform(candidate); return candidate; };
  const candidates = [
    changed(d => { d[0].owned_paths = ['modules/elsewhere/**']; }),
    changed(d => { d[0].owner_role = 'changed-owner'; }),
    changed(d => { d[0].tests = []; }),
    changed(d => { d[0].tests.push('runtime.full'); }),
    changed(d => { d[0].dependencies.push('public-guide-assets'); }),
    changed(d => { d[1].dependencies.push('member-card'); }),
    changed(d => { d.push(moduleDescriptor('new-consumer', ['modules/new-consumer/**'], { dependencies: ['member-card'] })); }),
    changed(d => { d.shift(); }),
  ];
  for (const candidate of candidates) {
    assert.equal(leafDecision([path], {baseline, candidate}).mode, 'full');
    assert.equal(leafDecision([path], {baseline: candidate, candidate: baseline}).mode, 'full');
  }
  // Drift already present in both inputs must not expand host-approved ownership,
  // tests/dependencies or admit an invalid graph, even without a reported edit.
  for (const descriptors of [
    changed(d => { d[0].tests = ['governance.unit']; }),
    changed(d => { d[0].dependencies = []; }),
    changed(d => { d[0].owner_role = 'changed-owner'; }),
    changed(d => { d.push(moduleDescriptor('second-owner', [path])); }),
    changed(d => { d.push(moduleDescriptor('new-consumer', ['modules/new-consumer/**'], {dependencies: ['member-card']})); }),
    changed(d => { d[0].dependencies = ['absent-module']; }),
    changed(d => { d[2].dependencies = ['member-card']; }),
    changed(d => { d.push(structuredClone(d[0])); }),
  ]) assert.equal(leafDecision([path], {baseline: descriptors, candidate: descriptors}).mode, 'full');
  assert.equal(leafDecision([path], {baseline: [], candidate: []}).mode, 'full');
  assert.equal(leafDecision([path], {descriptorsProven: false}).mode, 'full');
});

test('affected aggregate admits exactly the fixed job shape and rejects every omitted or bad result/output', () => {
  const selection = leafDecision(), results = Object.fromEntries(SELECTABLE_JOBS.map(id => [id, selection.jobs[id] ? 'success' : 'skipped']));
  assert.equal(evaluateVerifyAggregate(needsFor(selection, results)).reason, 'affected_selected_subset');
  assert.equal(evaluateVerifyAggregate(needsFor(selection, allResults('success'))).ok, true);
  for (const id of SELECTABLE_JOBS) for (const bad of [undefined, '', 'failure', 'cancelled', 'skipped']) {
    const needs = needsFor(selection, results);
    if (bad === undefined) delete needs[id]; else needs[id].result = bad;
    assert.equal(evaluateVerifyAggregate(needs).ok, !selection.jobs[id] && bad === 'skipped', `${id}: ${bad}`);
  }
  for (const key of Object.values(JOB_OUTPUT_KEYS)) for (const bad of [undefined, '', 'TRUE', false]) {
    const needs = needsFor(selection, results);
    if (bad === undefined) delete needs.select.outputs[key]; else needs.select.outputs[key] = bad;
    assert.equal(evaluateVerifyAggregate(needs).ok, false, key);
  }
  for (const key of ['mode', 'reason']) for (const bad of [undefined, '', 'invented_profile']) {
    const needs = needsFor(selection, results);
    if (bad === undefined) delete needs.select.outputs[key]; else needs.select.outputs[key] = bad;
    assert.equal(evaluateVerifyAggregate(needs).ok, false, key);
  }
  for (let mask = 0; mask < 64; mask++) {
    const needs = needsFor(selection, allResults('success'));
    SELECTABLE_JOBS.forEach((id, index) => { needs.select.outputs[JOB_OUTPUT_KEYS[id]] = String(Boolean(mask & (1 << index))); });
    assert.equal(evaluateVerifyAggregate(needs).ok, mask === 15, `affected shape ${mask}`);
  }
});

test('actual Git leaf candidate and CLI narrow; co-edited safety, owner drift and new reverse consumers stay full', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fp-select-leaf-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const git = args => execFileSync('/usr/bin/git', ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Selector Fixture', GIT_AUTHOR_EMAIL: 'selector@example.invalid', GIT_COMMITTER_NAME: 'Selector Fixture', GIT_COMMITTER_EMAIL: 'selector@example.invalid'},
  }).trim();
  const put = async (path, body) => { await mkdir(dirname(join(directory, path)), {recursive: true}); await writeFile(join(directory, path), body); };
  const commit = message => { git(['add', '.']); git(['commit', '-qm', message]); return git(['rev-parse', 'HEAD']); };
  const descriptorPath = id => `modules/${id}/freedom.module.json`;
  git(['init', '-q', '-b', 'main']);
  for (const descriptor of leafDescriptors()) await put(descriptorPath(descriptor.module_id), JSON.stringify(descriptor));
  await put('governance/README.md', '# Synthetic module rules\n');
  const leaf = FRONTEND_LEAF_PROFILES[0].paths[0]; await put(leaf, 'export const view = "before";\n');
  const base = commit('base');
  await put(leaf, 'export const view = "ordinary accessible redesign";\n');
  const head = commit('frontend edit');
  const observed = collectRepositoryDecision({repository: directory, event: 'pull_request', base, head}); assertLeaf(observed);
  const output = join(directory, 'job-output');
  const cli = spawnSync(process.execPath, [selector, '--event', 'pull_request', '--repository', directory, '--base', base, '--head', head, '--github-output', output], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr); assertLeaf(JSON.parse(cli.stdout));
  assert.equal(await readFile(output, 'utf8'), githubOutput(observed)); await rm(output);
  const compare = current => collectRepositoryDecision({repository: directory, event: 'pull_request', base, head: current});
  await put('packages/command-core/command.ts', 'export const unsafe = true;\n');
  assert.equal(compare(commit('mixed safety edit')).mode, 'full');
  git(['checkout', '-q', head]);
  const owner = leafDescriptors()[0]; owner.owned_paths = ['modules/elsewhere/**'];
  await put(descriptorPath(owner.module_id), JSON.stringify(owner));
  assert.equal(compare(commit('shrink owner')).mode, 'full');
  git(['checkout', '-q', head]);
  await put(descriptorPath('new-consumer'), JSON.stringify(moduleDescriptor('new-consumer', ['modules/new-consumer/**'], {dependencies: ['member-card']})));
  const dependentBase = commit('new reverse dependency');
  assert.equal(compare(dependentBase).mode, 'full');
  await put(leaf, 'export const view = "next leaf edit";\n');
  const dependentHead = commit('edit leaf beneath unchanged reverse consumer');
  const reverse = collectRepositoryDecision({repository: directory, event: 'pull_request', base: dependentBase, head: dependentHead});
  assert.equal(reverse.mode, 'full'); assert.equal(reverse.reason, 'leaf_profile_unproven');
  git(['checkout', '-q', head]); git(['mv', leaf, leaf + '.renamed']);
  assert.equal(compare(commit('rename leaf')).mode, 'full');
});
