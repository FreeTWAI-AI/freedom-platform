import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { verifyNativeConsumerRuntime } from '../../packages/contribution-tools/github-consumer-runtime-host.mjs';
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

const candidateRoot = process.env.FREEDOM_DIRECTORY_ROOT, sourceRoot = process.env.FREEDOM_CONSUMER_SOURCE_ROOT;
const workflow = process.env.FREEDOM_CONSUMER_WORKFLOW_SHA;
if (process.env.FREEDOM_RUN_DIRECTORY_RUNTIME !== '1' || !isAbsolute(candidateRoot ?? '')
  || !isAbsolute(sourceRoot ?? '') || !/^[a-f0-9]{40}$/.test(workflow ?? '')) throw Error('Explicit full directory/source clones and exact workflow SHA required.');
const approved = '01b18397f9c5356a14e4cc66fa46f57216f11154';
const git = (cwd, args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Synthetic', GIT_COMMITTER_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' },
}).trim();
const input = (root = candidateRoot, commit = approved) => ({ repository: 'FreeTWAI-AI/FreeTWAI-AI.github.io',
  candidateRoot: root, candidateCommit: commit, sourceRoot, expectedWorkflowCommit: workflow,
  expectedSourceCommit: '91b943ac61e132fbbce72ea066cb2301aa065600' });
async function mutation(t, path, transform) {
  const directory = await mkdtemp(join(tmpdir(), 'fp-directory-runtime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  git(directory, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', candidateRoot, root]);
  git(root, ['checkout', '--quiet', '--detach', approved]);
  const before = await readFile(join(root, path), 'utf8'), after = transform(before);
  assert.notEqual(after, before);
  await writeFile(join(root, path), after); git(root, ['add', '--', path]);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic directory behavioral counterexample']);
  assert.equal(git(root, ['diff', '--name-only', approved, 'HEAD']), path);
  return verifyNativeConsumerRuntime(input(root, git(root, ['rev-parse', 'HEAD'])));
}
function clean(result) {
  assert.equal(result.source.status, 'passed');
  assert.equal(result.runtime.cleanup_verified, true, JSON.stringify(result.runtime));
  assert.equal(result.runtime.cleanup.volumes_verified, true);
  assert.equal(result.gate_enforced, false); assert.equal(result.library_usage, 'not_checked');
  if (process.env.FREEDOM_DIRECTORY_EVIDENCE === '1') console.log(JSON.stringify({
    format: 'freedom.directory-profile-test-observation/v1', assurance_level: 'local',
    workflow_commit: result.workflow_commit, source_commit: result.source_commit,
    candidate_commit: result.candidate_commit, candidate_tree: result.candidate_tree,
    status: result.status, reason: result.runtime.reason, semantic_profile: result.runtime.semantic_profile,
    cleanup_verified: result.runtime.cleanup_verified, installation: result.runtime.installation ?? null,
    cases: result.runtime.cases, gate_enforced: false, merge_authorized: false,
  }));
}
function passed(result) {
  clean(result); assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.runtime.check.test_count, 10); assert.equal(result.runtime.check.expected_test_count, 10);
  assert.equal(result.runtime.candidate.commit, result.source.candidate_commit);
  assert.equal(result.runtime.candidate.tree, result.source.candidate_tree);
  assert.equal(result.runtime.runtime_observation, 'host_observed_build_files');
  assert(result.runtime.isolation.every(item => item.paused_readback && item.network === 'none' && item.readonly_root));
}
test('approved actual build produces independently checked files in ten isolated cases', async () => {
  passed(await verifyNativeConsumerRuntime(input()));
});
test('legitimate current data changes pass without freezing directory contents', async t => {
  passed(await mutation(t, 'data/directory.json', value => {
    const data = JSON.parse(value); data.projects[0].description = 'Updated public directory & <escaped> text';
    return JSON.stringify(data);
  }));
});
test('legitimate CSS redesign passes the same complete actual build contract', async t => {
  passed(await mutation(t, 'src/index.mjs', value => value.replace('color:#153c33', 'color:#223344')
    .replace('max-width:1120px', 'max-width:960px').replace('border-radius:18px', 'border-radius:8px')));
});
test('legitimate wrappers and accessibility attributes pass without changing public data or authority', async t => {
  passed(await mutation(t, 'src/index.mjs', value => value
    .replace('<main>', '<main id="content" role="main" tabindex="-1">')
    .replace('<article>', '<div role="article" class="source-card">').replace('</article>', '</div>')
    .replace('<h1>', '<h1 id="intro-title">').replace('<header class="intro">', '<header class="intro" aria-labelledby="intro-title">')));
});
const negatives = [
  ['constant renderer with fabricated passing stdout', 'src/index.mjs', () => `console.log('{"status":"passed"}'); export const renderDirectory = () => '<html>stub</html>';`, 'candidate-data'],
  ['missing HTML escaping', 'src/index.mjs', value => value.replace(/^const escapeHtml = .*;$/m, 'const escapeHtml = String;'), 'escaped-challenge'],
  ['removed duplicate repository validation', 'src/index.mjs', value => value.replace(/^.*if \(seen.has.*\n/m, ''), 'duplicate-repository'],
  ['write before input validation', 'src/privacy.mjs', value => `import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('/work/dist',{recursive:true}); writeFileSync('/work/dist/index.html','partial');\n` + value, 'duplicate-repository'],
  ['unexpected artifact outside dist', 'src/index.mjs', value => `import {writeFileSync} from 'node:fs'; writeFileSync('/work/unexpected.html','extra');\n` + value, 'candidate-data'],
  ['missing public project scope', 'src/index.mjs', value => value.replace('escapeHtml(project.scope)', 'escapeHtml("omitted")'), 'candidate-data'],
  ['weakened CSP permits resource exfiltration', 'src/index.mjs', value => value.replace("default-src 'none'", "default-src https:"), 'candidate-data'],
  ['hidden encoded unsafe URL', 'src/index.mjs', value => value.replace('</body>', '<a hidden href="&#106;avascript:alert(1)">unsafe</a></body>'), 'candidate-data'],
];
for (const [name, path, transform, failingCase] of negatives) test(`source-valid ${name} fails actual build observation`, async t => {
  const result = await mutation(t, path, transform); clean(result);
  assert.equal(result.status, 'failed'); assert.deepEqual(result.failure, { stage: 'build', kind: 'behavior_mismatch' });
  assert.equal(result.runtime.reason, 'directory_behavior_mismatch');
  assert.equal(result.runtime.cases.at(-1).id, failingCase); assert.equal(result.runtime.cases.at(-1).status, 'failed');
});
test('source-valid changed privacy route is rejected rather than publishing a broken footer link', async t => {
  const result = await mutation(t, 'data/privacy-discord-bot.json', value => {
    const data = JSON.parse(value); data.path = 'privacy/elsewhere/'; return JSON.stringify(data);
  });
  clean(result); assert.equal(result.status, 'failed'); assert.equal(result.runtime.reason, 'directory_data_invalid');
});
test('generated artifact symlink is never followed by the host reader', async t => {
  const result = await mutation(t, 'src/index.mjs', value => `import {symlinkSync} from 'node:fs'; symlinkSync('/etc/passwd','/work/leak');\n` + value);
  clean(result); assert.equal(result.status, 'failed'); assert.equal(result.failure.kind, 'unavailable');
  assert.equal(result.runtime.phase, 'readback');
});
test('a hanging build is unavailable, not an expected validation rejection, and is cleaned', async t => {
  const result = await mutation(t, 'src/index.mjs', value => `await new Promise(() => setInterval(() => {},100));\n` + value);
  clean(result); assert.equal(result.status, 'failed'); assert.equal(result.runtime.reason, 'directory_build_unavailable');
  assert.equal(result.failure.kind, 'unavailable');
});
