// Conservative job selection for .github/workflows/verify.yml.
// A pull request narrows only inside the explicit docs allowlist or the fixed
// frontend leaf profiles below. Leaf edits retain all runtime/browser/static
// jobs and require unchanged, compatible baseline/candidate descriptor graphs.
// The exact generated inventory manifest may accompany qualifying edits; owning that one metadata file does not widen the decision, and the file
// is not itself an allowlisted document. source-integrity still verifies the
// manifest unconditionally. Rename, delete, copy, mode change, unknown paths,
// merge_group, push, and governance, security, or shared-runtime paths keep
// every selectable job. The aggregate accepts a skip only for a job this
// decision left unselected; failure and cancellation do not pass.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectImpact, validateDescriptor, isModuleDescriptorPath, ROOT_INSTRUCTIONS, owns } from '../../packages/contribution-tools/context.mjs';
import { artifactPath, parseJson } from '../../packages/contribution-tools/io.mjs';
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
import { runtimeTextSources } from '../generate-runtime-text.mjs';

export const SELECTABLE_JOBS = Object.freeze([
  'runtime-full', 'runtime-aggregate', 'ui-e2e', 'static-worker', 'governance-consumers', 'deploy-preflight',
]);
// Every selectable job must report a result, including an intentional docs skip.
// Keep one list so a selected check cannot disappear from aggregate validation.
export const REQUIRED_SELECTED_JOBS = SELECTABLE_JOBS;
export const JOB_OUTPUT_KEYS = Object.freeze({
  'runtime-full': 'runtime_full',
  'runtime-aggregate': 'runtime_aggregate',
  'ui-e2e': 'ui_e2e',
  'static-worker': 'static_worker',
  'governance-consumers': 'governance_consumers',
  'deploy-preflight': 'deploy_preflight',
});
export const ALWAYS_ON_INTEGRITY_COMMANDS = Object.freeze([
  'npm run contracts:build',
  'git diff --exit-code -- contracts/preview/v1 packages/sdk',
  'npm run check:runtime-text',
  'npm run verify:inventory',
  'npm run test:governance',
]);
export const DOCS_ALLOWLIST_PREFIXES = Object.freeze([
  'docs/development/', 'docs/design/', 'docs/plans/', 'docs/releases/',
]);
// scripts/update-inventory.py rewrites this manifest for every hashed source
// change. It remains under docs/platform-plan/ for every other classification.
export const GENERATED_INVENTORY_PATH = 'docs/platform-plan/verification/2026-09-20-file-inventory.json';

// Host-owned paths and expected module obligations, never a candidate glob or
// executable command. New files, public sharing/auth helpers, guide contracts,
// gates, content/release pins and unlisted frontend paths retain full selection.
export const FRONTEND_LEAF_PROFILES = Object.freeze([
  Object.freeze({ module: 'member-card', dependencies: Object.freeze(['command-core']), tests: Object.freeze(['runtime.member-card']),
    paths: Object.freeze(['MemberECard.tsx', 'MemberECard.css', 'MemberEditorialCard.css', 'MemberCardDownload.tsx', 'MemberCardQr.tsx']
      .map(path => 'apps/portal-web/src/modules/' + path)) }),
  Object.freeze({ module: 'newcomer-guides', dependencies: Object.freeze(['public-guide-assets']), tests: Object.freeze(['runtime.full']),
    paths: Object.freeze(['GuideHost.tsx', 'engine/GuideEngine.tsx', 'engine/GuideGallery.tsx', 'engine/page-spirit.css']
      .map(path => 'apps/portal-web/src/modules/newcomer-guides/' + path)) }),
]);
export const FRONTEND_LEAF_JOBS = Object.freeze(['runtime-full', 'runtime-aggregate', 'ui-e2e', 'static-worker']);
const leafProfile = path => FRONTEND_LEAF_PROFILES.find(profile => profile.paths.includes(path));
const sameSet = (a, b) => { const right = [...b].sort(); return a.length === b.length && [...a].sort().every((value, index) => value === right[index]); };

const TREE_PATH_LIMIT = 16384;
const DESCRIPTOR_LIMIT = 256;
const CHANGE_LIMIT = 4096;
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const SHA = /^[0-9a-f]{40}$/;
const EVENT = /^[a-z_]{1,40}$/;
const PR_NUMBER = /^[1-9][0-9]{0,8}$/;
const RUNTIME_TEXT = new Set(Object.values(runtimeTextSources));
const BANNED_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'fixture', 'fixtures', '__fixtures__']);
const CODE_OR_CONFIG = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|py|sh|bash|ps1|sql|ya?ml|jsonc?|toml|ini|lock|wasm|env|rb|php|pl|exe)$/i;
const TEST_OR_SPEC_NAME = /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i;
const FULL_SCOPE = Object.freeze([
  '.github/', 'governance/', 'packages/contribution-tools/', 'scripts/ci/', 'scripts/runtime-full.mjs',
  'scripts/runtime-aggregate.mjs', 'docs/platform-plan/', 'contracts/', 'deploy/', 'migrations/', 'packages/db/',
  'packages/shared/', 'packages/testing/', 'tests/runtime/', 'packages/contribution-tools/suite-runner.mjs',
  'apps/credential-broker/', 'modules/identity-membership/', 'modules/platform-admin/',
  'apps/platform-api/src/worker-private-ai.ts',
]);
const REASON_PRIORITY = Object.freeze([
  'deleted_path', 'renamed_or_copied_path', 'untrusted_change_status', 'unknown_path', 'root_instruction',
  'governance_security_or_shared_runtime', 'excluded_test_spec_or_config', 'not_docs_allowlist',
]);

export function heavyJobCondition(outputKey) {
  return `!cancelled() && (needs.select.result != 'success' || needs.select.outputs.${outputKey} == 'true')`;
}

function decision(mode, reason, selected) {
  if (!['full', 'docs', 'affected'].includes(mode) || !/^[a-z0-9_]+$/.test(reason)) throw new Error('invalid_selection_decision');
  return Object.freeze({
    mode, reason,
    jobs: Object.freeze(Object.fromEntries(SELECTABLE_JOBS.map(id => [id, mode === 'affected' ? FRONTEND_LEAF_JOBS.includes(id) : selected]))),
  });
}
const full = reason => decision('full', reason, true);
const docs = () => decision('docs', 'docs_allowlist', false);
const affected = () => decision('affected', 'frontend_leaf_profiles', false);

function inScope(path, entry) {
  return entry.endsWith('/') ? path.startsWith(entry) : path === entry;
}
function safeRepoPath(path) {
  if (typeof path !== 'string') return false;
  try { artifactPath(path); return true; } catch { return false; }
}
function hiddenSegment(path) {
  return path.split('/').some(part => part.startsWith('.'));
}
function bannedDocsEntry(path) {
  if (!path.startsWith('docs/')) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return CODE_OR_CONFIG.test(path) || TEST_OR_SPEC_NAME.test(base)
    || path.split('/').some(part => BANNED_SEGMENTS.has(part.toLowerCase()));
}
export function isDocsAllowlisted(path) {
  if (!safeRepoPath(path) || hiddenSegment(path) || !path.endsWith('.md') || RUNTIME_TEXT.has(path) || bannedDocsEntry(path)) return false;
  if (DOCS_ALLOWLIST_PREFIXES.some(prefix => path.startsWith(prefix))) return true;
  return /^docs\/[^/]+\.md$/.test(path);
}
function rejectionReason(path) {
  if (!safeRepoPath(path)) return 'unknown_path';
  if (ROOT_INSTRUCTIONS.includes(path)) return 'root_instruction';
  if (FULL_SCOPE.some(entry => inScope(path, entry)) || RUNTIME_TEXT.has(path) || isModuleDescriptorPath(path)) return 'governance_security_or_shared_runtime';
  if (hiddenSegment(path)) return 'unknown_path';
  if (bannedDocsEntry(path)) return 'excluded_test_spec_or_config';
  if (!isDocsAllowlisted(path) && !leafProfile(path)) return 'not_docs_allowlist';
  return null;
}
function statusReason(change) {
  if (!change || typeof change !== 'object') return 'untrusted_change_status';
  const status = typeof change.status === 'string' ? change.status : '';
  const letter = /^[AMDTRCUXB]$/.test(status) ? status : /^[RC][0-9]{1,3}$/.test(status) ? status[0] : '';
  if (!letter) return 'untrusted_change_status';
  if (letter === 'D') return 'deleted_path';
  if (letter === 'R' || letter === 'C') return 'renamed_or_copied_path';
  if (letter !== 'A' && letter !== 'M') return 'untrusted_change_status';
  if (change.previousPath) return 'untrusted_change_status';
  return null;
}
function strongest(reasons) {
  return REASON_PRIORITY.find(reason => reasons.includes(reason)) ?? null;
}

export function decideAffectedJobs(input) {
  const event = input?.event;
  if (event === 'merge_group') return full('merge_group');
  if (event === 'push') return full('push');
  if (typeof event !== 'string' || !EVENT.test(event) || event !== 'pull_request') return full('non_pull_request');
  if (input.diffComplete !== true || !Array.isArray(input.changes) || input.changes.length > CHANGE_LIMIT) return full('diff_unproven');
  if (input.changes.length === 0) return full('empty_diff');
  const reasons = [];
  const paths = [];
  let inventoryCompanion = false;
  for (const change of input.changes) {
    const status = statusReason(change);
    if (status) { reasons.push(status); continue; }
    // A content edit of the generated manifest is metadata. It is omitted from
    // selectImpact so ownership of that metadata cannot veto qualifying edits.
    if (change.path === GENERATED_INVENTORY_PATH) { inventoryCompanion = true; continue; }
    if (leafProfile(change.path) && change.status !== 'M') { reasons.push('untrusted_change_status'); continue; }
    const reason = rejectionReason(change.path);
    if (reason) reasons.push(reason);
    else paths.push(change.path);
  }
  const rejected = strongest(reasons);
  if (rejected) return full(rejected);
  // The manifest alone is still governance scope. A dropped change fails closed.
  if (paths.length === 0) return full(inventoryCompanion ? 'governance_security_or_shared_runtime' : 'diff_unproven');
  const baseline = Array.isArray(input.baseline) ? input.baseline : null;
  const candidate = Array.isArray(input.candidate) ? input.candidate : null;
  if (input.descriptorsProven === false || !baseline?.length || !candidate?.length) return full('descriptors_unproven');
  let impact;
  try {
    impact = selectImpact({ baseline, candidate, changedPaths: paths });
  } catch (error) {
    return full(error?.code === 'invalid_artifact_path' ? 'unknown_path' : 'descriptors_unproven');
  }
  if (impact.unknown_paths.length) return full('unknown_path');
  if (paths.some(path => leafProfile(path))) {
    return compatibleLeafImpact(paths, baseline, candidate, impact) ? affected() : full('leaf_profile_unproven');
  }
  if (impact.module_ids.length || impact.tests.length) return full('baseline_candidate_union');
  return docs();
}

function compatibleLeafImpact(paths, baseline, candidate, impact) {
  // Drift cannot subtract baseline obligations. Validate the whole bounded graph
  // because an unrelated module can add a reverse dependency on a changed leaf.
  const graphs = [];
  try {
    for (const descriptors of [baseline, candidate]) {
      if (descriptors.length > DESCRIPTOR_LIMIT) return false;
      const byId = new Map();
      for (const descriptor of descriptors) {
        validateDescriptor(descriptor);
        if (byId.has(descriptor.module_id)) return false;
        byId.set(descriptor.module_id, descriptor);
      }
      const active = new Set(), done = new Set();
      const visit = id => {
        if (active.has(id) || !byId.has(id)) throw new Error('invalid_module_graph');
        if (done.has(id)) return;
        active.add(id);
        for (const dependency of byId.get(id).dependencies) visit(dependency);
        active.delete(id); done.add(id);
      };
      for (const id of byId.keys()) visit(id);
      graphs.push(byId);
    }
    if (!sameSet([...graphs[0].keys()], [...graphs[1].keys()])) return false;
    for (const [id, value] of graphs[0]) if (JSON.stringify(value) !== JSON.stringify(graphs[1].get(id))) return false;
    const profiles = [...new Set(paths.map(leafProfile).filter(Boolean))];
    if (!sameSet(impact.module_ids, profiles.map(profile => profile.module))
      || !sameSet(impact.tests, [...new Set(profiles.flatMap(profile => profile.tests))])) return false;
    for (const path of paths.filter(path => leafProfile(path))) {
      const expected = leafProfile(path);
      for (const descriptors of [baseline, candidate]) {
        const owners = descriptors.filter(descriptor => owns(descriptor, path));
        if (owners.length !== 1 || owners[0].module_id !== expected.module || owners[0].owner_role !== 'foundation'
          || !sameSet(owners[0].dependencies, expected.dependencies) || !sameSet(owners[0].tests, expected.tests)) return false;
      }
    }
    return true;
  } catch { return false; }
}

function regularBlob(entry) {
  return entry?.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
}
export function parseLsTreeZ(text) {
  const files = new Map();
  if (typeof text !== 'string') return { ok: false, files };
  if (text.length === 0) return { ok: true, files };
  const records = text.split('\0').filter(Boolean);
  if (records.length > TREE_PATH_LIMIT) return { ok: false, files };
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) return { ok: false, files };
    const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})$/.exec(record.slice(0, tab));
    const path = record.slice(tab + 1);
    if (!match || files.has(path) || !path) return { ok: false, files };
    files.set(path, { mode: match[1], type: match[2], oid: match[3] });
  }
  return { ok: true, files };
}
export function parseNameStatusZ(text) {
  if (typeof text !== 'string') return { ok: false, changes: [] };
  const records = text.split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length;) {
    const header = records[index++];
    const letter = header[0];
    if ((letter === 'R' || letter === 'C') && /^[RC][0-9]{1,3}$/.test(header)) {
      const previousPath = records[index++];
      const path = records[index++];
      if (!previousPath || !path) return { ok: false, changes: [] };
      changes.push({ status: letter, path, previousPath });
    } else if (/^[AMDTUXB]$/.test(header)) {
      const path = records[index++];
      if (!path) return { ok: false, changes: [] };
      changes.push({ status: header, path });
    } else return { ok: false, changes: [] };
  }
  return { ok: changes.length <= CHANGE_LIMIT, changes };
}
function oidCounts(files) {
  const counts = new Map();
  for (const entry of files.values()) {
    if (!regularBlob(entry)) continue;
    counts.set(entry.oid, (counts.get(entry.oid) ?? 0) + 1);
  }
  return counts;
}
export function changesFromTrees(baseFiles, headFiles) {
  if (!(baseFiles instanceof Map) || !(headFiles instanceof Map)) return { ok: false, changes: [] };
  if (baseFiles.size > TREE_PATH_LIMIT || headFiles.size > TREE_PATH_LIMIT) return { ok: false, changes: [] };
  const changes = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && after && before.oid === after.oid && before.mode === after.mode && before.type === after.type) continue;
    if ((before && !regularBlob(before)) || (after && !regularBlob(after))) {
      changes.push({ path, status: 'T' });
      continue;
    }
    if (before && !after) changes.push({ path, status: 'D' });
    else if (!before && after) changes.push({ path, status: 'A' });
    else if (before.mode !== after.mode) changes.push({ path, status: 'T' });
    else changes.push({ path, status: 'M' });
  }
  const baseCount = oidCounts(baseFiles);
  const headCount = oidCounts(headFiles);
  const added = new Map(changes.filter(change => change.status === 'A').map(change => [change.path, change]));
  const consumed = new Set();
  const renames = [];
  for (const change of changes) {
    if (change.status !== 'D') continue;
    const before = baseFiles.get(change.path);
    if (!before || before.oid === EMPTY_BLOB) continue;
    if (baseCount.get(before.oid) !== 1 || headCount.get(before.oid) !== 1) continue;
    const match = [...added.keys()].find(path => !consumed.has(path) && headFiles.get(path)?.oid === before.oid);
    if (!match) continue;
    consumed.add(match);
    consumed.add(change.path);
    renames.push({ status: 'R', path: match, previousPath: change.path });
  }
  const folded = [...changes.filter(change => !consumed.has(change.path)), ...renames];
  folded.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { ok: folded.length <= CHANGE_LIMIT, changes: folded };
}

function gitEnv(source = process.env) {
  const env = verificationEnvironment(source);
  if (typeof source.HOME === 'string') env.HOME = source.HOME;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}
function runGit(repository, args, timeout = 20_000) {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'diff.external=', '-C', repository, ...args], {
    env: gitEnv(), timeout, maxBuffer: 16_000_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function hasCommit(repository, sha) {
  try { runGit(repository, ['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; }
}
function ensureCommit(repository, sha, pullRequest, allowFetch) {
  if (hasCommit(repository, sha)) return true;
  if (!allowFetch) return false;
  try { runGit(repository, ['fetch', '--no-tags', '--depth=1', 'origin', sha], 60_000); } catch { /* The PR head may live only on the pull ref. */ }
  if (hasCommit(repository, sha)) return true;
  if (!PR_NUMBER.test(pullRequest ?? '')) return false;
  try { runGit(repository, ['fetch', '--no-tags', 'origin', `pull/${pullRequest}/head`], 60_000); } catch { return false; }
  try { return runGit(repository, ['rev-parse', '--verify', 'FETCH_HEAD']).toString().trim() === sha; } catch { return false; }
}
export function loadModuleDescriptors(repository, sha) {
  let text;
  try { text = runGit(repository, ['ls-tree', '-r', '-z', '--end-of-options', sha]).toString('utf8'); }
  catch { return { ok: false, descriptors: [] }; }
  const parsed = parseLsTreeZ(text);
  if (!parsed.ok) return { ok: false, descriptors: [] };
  const paths = [...parsed.files.keys()].filter(isModuleDescriptorPath);
  if (paths.length > DESCRIPTOR_LIMIT) return { ok: false, descriptors: [] };
  const descriptors = [];
  for (const path of paths) {
    const entry = parsed.files.get(path);
    if (!regularBlob(entry)) return { ok: false, descriptors: [] };
    let bytes;
    try { bytes = runGit(repository, ['show', '--end-of-options', `${sha}:${path}`]); }
    catch { return { ok: false, descriptors: [] }; }
    if (bytes.length > 128_000) return { ok: false, descriptors: [] };
    try {
      const value = validateDescriptor(parseJson(bytes));
      descriptors.push({ ...value, owned_paths: [...value.owned_paths, path] });
    } catch { return { ok: false, descriptors: [] }; }
  }
  return { ok: descriptors.length > 0, descriptors };
}
function loadTrees(repository, base, head) {
  try {
    const baseTree = parseLsTreeZ(runGit(repository, ['ls-tree', '-r', '-z', '--end-of-options', base]).toString('utf8'));
    const headTree = parseLsTreeZ(runGit(repository, ['ls-tree', '-r', '-z', '--end-of-options', head]).toString('utf8'));
    if (!baseTree.ok || !headTree.ok) return null;
    return changesFromTrees(baseTree.files, headTree.files);
  } catch { return null; }
}
export function collectRepositoryDecision({ repository, event, base = '', head = '', pullRequest = '', allowFetch = false } = {}) {
  if (event !== 'pull_request') return decideAffectedJobs({ event, diffComplete: false, changes: [], baseline: [], candidate: [] });
  const root = typeof repository === 'string' && isAbsolute(repository) ? resolve(repository) : '';
  if (!root || root.startsWith('-') || !SHA.test(base) || !SHA.test(head)) return full('diff_unproven');
  if (!ensureCommit(root, base, '', allowFetch) || !ensureCommit(root, head, pullRequest, allowFetch)) return full('diff_unproven');
  const diff = loadTrees(root, base, head);
  if (!diff?.ok) return full('diff_unproven');
  const baseline = loadModuleDescriptors(root, base);
  const candidate = loadModuleDescriptors(root, head);
  return decideAffectedJobs({
    event, diffComplete: true, changes: diff.changes,
    baseline: baseline.descriptors, candidate: candidate.descriptors,
    descriptorsProven: baseline.ok && candidate.ok,
  });
}

function resultOf(job) {
  return job && typeof job === 'object' && typeof job.result === 'string' ? job.result : null;
}
export function decisionFromNeeds(needs) {
  const outputs = needs?.select?.outputs;
  if (!outputs || typeof outputs !== 'object') return { ok: false, reason: 'decision_incomplete' };
  if (!['full', 'docs', 'affected'].includes(outputs.mode) || typeof outputs.reason !== 'string'
    || !/^[a-z0-9_]+$/.test(outputs.reason)) return { ok: false, reason: 'decision_incomplete' };
  const jobs = {};
  for (const [id, key] of Object.entries(JOB_OUTPUT_KEYS)) {
    if (outputs[key] !== 'true' && outputs[key] !== 'false') return { ok: false, reason: 'decision_incomplete' };
    jobs[id] = outputs[key] === 'true';
  }
  const selectedAll = SELECTABLE_JOBS.every(id => jobs[id]);
  const selectedNone = SELECTABLE_JOBS.every(id => !jobs[id]);
  if (outputs.mode === 'full' && !selectedAll) return { ok: false, reason: 'decision_inconsistent' };
  if (outputs.mode === 'docs' && !selectedNone) return { ok: false, reason: 'decision_inconsistent' };
  if (outputs.mode === 'affected' && (outputs.reason !== 'frontend_leaf_profiles'
    || SELECTABLE_JOBS.some(id => jobs[id] !== FRONTEND_LEAF_JOBS.includes(id)))) return { ok: false, reason: 'decision_inconsistent' };
  if (jobs['runtime-full'] !== jobs['runtime-aggregate']) return { ok: false, reason: 'runtime_selection_split' };
  return { ok: true, decision: { mode: outputs.mode, reason: outputs.reason ?? '', jobs } };
}
export function evaluateVerifyAggregate(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) return { ok: false, reason: 'needs_missing' };
  if (resultOf(needs.select) !== 'success') return { ok: false, reason: 'select_not_success' };
  if (resultOf(needs['source-integrity']) !== 'success') return { ok: false, reason: 'source_integrity_not_success' };
  const parsed = decisionFromNeeds(needs);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const known = new Set(['select', 'source-integrity', ...REQUIRED_SELECTED_JOBS]);
  for (const [id, job] of Object.entries(needs)) {
    if (known.has(id)) continue;
    if (resultOf(job) !== 'success') return { ok: false, reason: 'unexpected_job_not_success', job: id, result: resultOf(job) ?? 'missing' };
  }
  for (const id of REQUIRED_SELECTED_JOBS) {
    const result = resultOf(needs[id]);
    if (parsed.decision.jobs[id]) {
      if (result !== 'success') return { ok: false, reason: 'selected_job_not_success', job: id, result: result ?? 'missing' };
    } else if (result !== 'skipped' && result !== 'success') {
      return { ok: false, reason: 'unselected_job_not_clean', job: id, result: result ?? 'missing' };
    }
  }
  return { ok: true, reason: parsed.decision.mode === 'docs' ? 'docs_selected_subset' : parsed.decision.mode === 'affected' ? 'affected_selected_subset' : 'full_selection' };
}
export function githubOutput(selection) {
  const lines = [`mode=${selection.mode}`, `reason=${selection.reason}`];
  for (const [id, key] of Object.entries(JOB_OUTPUT_KEYS)) lines.push(`${key}=${selection.jobs[id] ? 'true' : 'false'}`);
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const args = { allowFetch: false, checkAggregate: false, pullRequest: '' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--check-aggregate') args.checkAggregate = true;
    else if (arg === '--allow-fetch') args.allowFetch = true;
    else if (arg === '--event') args.event = argv[++index];
    else if (arg === '--repository') args.repository = argv[++index];
    else if (arg === '--base') args.base = argv[++index];
    else if (arg === '--head') args.head = argv[++index];
    else if (arg === '--pull-request') args.pullRequest = argv[++index];
    else if (arg === '--github-output') args.githubOutput = argv[++index];
    else return null;
    if (argv[index] === undefined) return null;
  }
  return args;
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) { console.error('invalid_selection_arguments'); process.exitCode = 2; return; }
  if (args.checkAggregate) {
    let needs;
    try { needs = JSON.parse(process.env.NEEDS_JSON ?? ''); } catch { needs = null; }
    const verdict = evaluateVerifyAggregate(needs);
    console.log(JSON.stringify({ ok: verdict.ok, reason: verdict.reason, job: verdict.job ?? null, result: verdict.result ?? null }));
    if (!verdict.ok) process.exitCode = 1;
    return;
  }
  if (typeof args.event !== 'string' || typeof args.githubOutput !== 'string' || !isAbsolute(args.githubOutput)) {
    console.error('invalid_selection_arguments'); process.exitCode = 2; return;
  }
  const selection = collectRepositoryDecision({
    repository: args.repository, event: args.event, base: args.base ?? '', head: args.head ?? '',
    pullRequest: args.pullRequest, allowFetch: args.allowFetch,
  });
  appendFileSync(args.githubOutput, githubOutput(selection));
  console.log(JSON.stringify({ mode: selection.mode, reason: selection.reason, jobs: selection.jobs }));
}
const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(resolve(entryArg)).href) main();
