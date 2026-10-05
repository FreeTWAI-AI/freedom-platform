import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDescriptor } from '../../packages/contribution-tools/context.mjs';
import {
  ALWAYS_ON_INTEGRITY_COMMANDS, DOCS_ALLOWLIST_PREFIXES, GENERATED_INVENTORY_PATH, JOB_OUTPUT_KEYS, SELECTABLE_JOBS,
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
  const missingOutput = needsFor(fullDecision, allResults('success'));
  delete missingOutput.select.outputs.runtime_full;
  assert.equal(evaluateVerifyAggregate(missingOutput).reason, 'decision_incomplete');
  const split = needsFor(fullDecision, allResults('success'));
  split.select.outputs.runtime_aggregate = 'false';
  assert.equal(evaluateVerifyAggregate(split).ok, false);
  assert.equal(evaluateVerifyAggregate(null).reason, 'needs_missing');
});

test('checkout descriptors keep an ordinary development doc narrow and a claimed doc full', () => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const loaded = loadModuleDescriptors(root, sha);
  assert.equal(loaded.ok, true);
  assert.ok(loaded.descriptors.every(descriptor => validateDescriptor(descriptor)));
  const ordinary = decideAffectedJobs({
    event: 'pull_request', diffComplete: true,
    changes: [edited('docs/development/runtime-ci-postgres.md')],
    baseline: loaded.descriptors, candidate: loaded.descriptors,
  });
  assert.equal(ordinary.mode, 'docs');
  const withInventory = decideAffectedJobs({
    event: 'pull_request', diffComplete: true,
    changes: [edited('docs/development/runtime-ci-postgres.md'), edited(GENERATED_INVENTORY_PATH)],
    baseline: loaded.descriptors, candidate: loaded.descriptors,
  });
  assert.equal(withInventory.mode, 'docs');
  assert.equal(withInventory.reason, 'docs_allowlist');
  for (const id of SELECTABLE_JOBS) assert.equal(withInventory.jobs[id], false);
  const inventoryOnly = decideAffectedJobs({
    event: 'pull_request', diffComplete: true,
    changes: [edited(GENERATED_INVENTORY_PATH)],
    baseline: loaded.descriptors, candidate: loaded.descriptors,
  });
  assert.equal(inventoryOnly.reason, 'governance_security_or_shared_runtime');
  const claimed = decideAffectedJobs({
    event: 'pull_request', diffComplete: true,
    changes: [edited('docs/development/worker-private-ai-bindings.md')],
    baseline: loaded.descriptors, candidate: loaded.descriptors,
  });
  assert.equal(claimed.reason, 'baseline_candidate_union');
  const candidate = loaded.descriptors.map(descriptor => ({
    ...descriptor,
    owned_paths: descriptor.owned_paths.filter(path => path !== 'docs/development/worker-private-ai-bindings.md'),
  }));
  const shrunk = decideAffectedJobs({
    event: 'pull_request', diffComplete: true,
    changes: [edited('docs/development/worker-private-ai-bindings.md')],
    baseline: loaded.descriptors, candidate,
  });
  assert.equal(shrunk.reason, 'baseline_candidate_union');
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
  assert.match(integrity, /node --test --test-concurrency=1 scripts\/ci\/select-affected-jobs\.test\.mjs/u);
  for (const key of Object.values(JOB_OUTPUT_KEYS)) {
    assert.ok(text.includes(heavyJobCondition(key)), key);
  }
  const runtime = jobBlock(text, 'runtime-full');
  assert.match(runtime, /partition: \[0, 1, 2, 3\]/);
  assert.match(runtime, /fail-fast: false/);
  assert.match(runtime, /node scripts\/runtime-full\.mjs --partition-count 4 --partition-index/);
  assert.match(jobBlock(text, 'runtime-aggregate'), /node scripts\/runtime-aggregate\.mjs/);
  assert.match(jobBlock(text, 'ui-e2e'), /npm run test:e2e/);
  const worker = jobBlock(text, 'static-worker');
  assert.match(worker, /git diff --exit-code -- contracts\/preview\/v1 packages\/sdk/);
  assert.match(worker, /npm run test:worker/);
  assert.match(worker, /npm run check:common-contracts/);
  const governance = jobBlock(text, 'governance-consumers');
  for (const command of ['npm run verify:inventory', 'npm run test:governance', 'npm run test:contracts', 'npm run test:repos']) {
    assert.ok(governance.includes(command), command);
  }
  assert.match(jobBlock(text, 'select'), /--allow-fetch/);
  assert.match(jobBlock(text, 'deploy-preflight'), /node --test deploy\/cloudflare\/test\/\*\.test\.mjs/);
});
