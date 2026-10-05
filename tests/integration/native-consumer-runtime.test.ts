import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
// @ts-expect-error Fixed host JavaScript, never imported from candidate.
import { verifyNativeConsumerRuntime } from '../../packages/contribution-tools/github-consumer-runtime-host.mjs';
// @ts-expect-error Fixed isolated CLI profile; candidate executes only in Docker.
import { runIsolatedAgentKitCliBehavior } from '../../packages/contribution-tools/behavior-supervisor.mjs';
// @ts-expect-error Existing clean subprocess environment.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

const roots = process.env.FREEDOM_CONSUMER_RUNTIME_ROOT, sourceRoot = process.env.FREEDOM_CONSUMER_SOURCE_ROOT;
const expectedWorkflowCommit = process.env.FREEDOM_CONSUMER_WORKFLOW_SHA;
if (process.env.FREEDOM_RUN_ISOLATED_CONSUMERS !== '1' || !roots || !isAbsolute(roots)
  || !sourceRoot || !isAbsolute(sourceRoot) || !/^[a-f0-9]{40}$/.test(expectedWorkflowCommit ?? '')) throw Error('Explicit isolated runtime roots and trusted source/workflow SHA required.');
const candidates = [
  ['freedom-agent-kit', 'b2227bc36a571084f6c3d5c5ab340ed4485c6738'],
  ['freedom-storefront', '87eda4878fb761deb4f9a1c1d7e421c2701f3dcb'],
  ['freedom-supplier-client', '7e98c3733e48aa96517d53de6944e3e365108979'],
];
const input = (name: string, candidateRoot: string, candidateCommit: string) => ({ repository: 'FreeTWAI-AI/' + name,
  candidateRoot, candidateCommit, sourceRoot, expectedWorkflowCommit, expectedSourceCommit: '91b943ac61e132fbbce72ea066cb2301aa065600' });
for (const [name, commit] of candidates) test(`combined fixed host binds source and HTTP observations for ${name}`, async () => {
  const result = await verifyNativeConsumerRuntime(input(name, join(roots, name), commit));
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.source.candidate_commit, result.runtime.candidate.commit);
  assert.equal(result.source.candidate_tree, result.runtime.candidate.tree);
  assert.equal(result.runtime.cleanup_verified, true); assert.equal(result.library_usage, 'not_checked');
  assert.equal(result.gate_enforced, false); assert.equal(result.merge_authorized, false);
});
test('combined native host rejects a source-valid stub rather than accepting source PASS as runtime proof', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fp-native-consumer-negative-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'candidate'); await mkdir(repository);
  // Preserve the full approved ancestry needed by the independent source guard.
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repository, env: { ...verificationEnvironment(), GIT_AUTHOR_NAME: 'Synthetic', GIT_COMMITTER_NAME: 'Synthetic',
      GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000,
  }).trim();
  git(['clone', '--quiet', '--no-hardlinks', join(roots, 'freedom-agent-kit'), '.']);
  git(['checkout', '--quiet', candidates[0][1]]);
  await writeFile(join(repository, 'src/index.mjs'), 'export async function loadMemberWorkspace(){return {status:"passed"};}\n');
  git(['add', 'src/index.mjs']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic source-valid stub']);
  const result = await verifyNativeConsumerRuntime(input('freedom-agent-kit', repository, git(['rev-parse', 'HEAD'])));
  assert.equal(result.source.status, 'passed'); assert.equal(result.runtime.check.status, 'failed');
  assert.equal(result.status, 'failed'); assert.equal(result.runtime.cleanup_verified, true);
});


async function sourceValidKitMutation(t: any, path: string, contents: string, verify = verifyNativeConsumerRuntime) {
  const directory = await mkdtemp(join(tmpdir(), 'fp-native-consumer-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'candidate'); await mkdir(repository);
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repository, env: { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Synthetic', GIT_COMMITTER_NAME: 'Synthetic',
      GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000,
  }).trim();
  git(['clone', '--quiet', '--no-hardlinks', join(roots!, 'freedom-agent-kit'), '.']);
  git(['checkout', '--quiet', candidates[0][1]]);
  await writeFile(join(repository, path), contents);
  git(['add', '--', path]); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic assurance-boundary mutation']);
  assert.equal(git(['diff', '--name-only', candidates[0][1], 'HEAD']), path);
  assert.equal(git(['diff', '--name-only', candidates[0][1], 'HEAD', '--', 'vendor', 'contracts.lock.json', 'consumer-libraries.lock.json']), '');
  return verify(input('freedom-agent-kit', repository, git(['rev-parse', 'HEAD'])));
}

test('source and observed HTTP PASS do not prove the approved workspace library was invoked', async t => {
  // No import of the approved vendor workspace: reproduce its externally visible
  // operation sequence and assembly directly. Fresh server markers still match.
  const result = await sourceValidKitMutation(t, 'src/index.mjs', `
    export async function loadMemberWorkspace(client) {
      const [session,dashboard,work,positioning,guilds] = await Promise.all(
        ['getSession','getDashboard','listWorks','getPositioning','listGuilds'].map(id=>client.call(id)));
      return {member:session.user,dashboard,work:work.items,positioning,guilds:guilds.items,
        mode:'internal_preview',agent_execution_grant:false};
    }
  `);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.source.status, 'passed'); assert.equal(result.runtime.check.status, 'passed');
  assert.equal(result.runtime.cases[0].observed_requests, 6);
  assert.equal(result.runtime.cases[0].response_matches_challenge, true);
  assert.equal(result.library_invocation, 'not_checked'); assert.equal(result.library_usage, 'not_checked');
  assert.equal(result.runtime.library_invocation, 'not_checked'); assert.equal(result.runtime.cleanup_verified, true);
});

test('the workspace-export profile does not certify a replaced actual CLI entrypoint', async t => {
  const result = await sourceValidKitMutation(t, 'src/cli.mjs', `
    // The real user-facing entrypoint no longer invokes any workspace operation.
    process.stdout.write(JSON.stringify({status:'passed'})+'\\n');
  `);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.source.status, 'passed'); assert.equal(result.runtime.check.status, 'passed');
  assert.equal(result.runtime.entry, 'src/index.mjs#loadMemberWorkspace');
  assert.equal(result.runtime.runtime_observation, 'host_observed_http');
  assert.equal(result.runtime.library_invocation, 'not_checked'); assert.equal(result.runtime.cleanup_verified, true);
});


test('separate actual CLI profile rejects the same stub that still passes source and workspace checks', async t => {
  const evidence = await sourceValidKitMutation(t, 'src/cli.mjs', `console.log(JSON.stringify({status:'passed'}));`,
    async (candidate: any) => ({ workspace: await verifyNativeConsumerRuntime(candidate),
      cli: await runIsolatedAgentKitCliBehavior({ repository: candidate.repository,
        candidateRepository: candidate.candidateRoot, candidateCommit: candidate.candidateCommit }) }));
  assert.equal(evidence.workspace.source.status, 'passed'); assert.equal(evidence.workspace.runtime.check.status, 'passed');
  assert.equal(evidence.cli.check.status, 'failed', JSON.stringify(evidence));
  assert.equal(evidence.cli.reason, 'consumer_behavior_mismatch'); assert.equal(evidence.cli.cases[0].observed_requests, 0);
  assert.equal(evidence.cli.cleanup_verified, true); assert.equal(evidence.cli.library_invocation, 'not_checked');
});
