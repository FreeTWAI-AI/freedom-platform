// Explicit local integration: reviewed consumer clones + pinned Docker recipe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { verifyNativeConsumerRuntime } from '../../packages/contribution-tools/github-consumer-runtime-host.mjs';
import { runIsolatedConsumerCliBehavior } from '../../packages/contribution-tools/behavior-supervisor.mjs';
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

const roots = process.env.FREEDOM_CONSUMER_RUNTIME_ROOT;
const sourceRoot = process.env.FREEDOM_CONSUMER_SOURCE_ROOT;
const expectedWorkflowCommit = process.env.FREEDOM_CONSUMER_WORKFLOW_SHA;
if (process.env.FREEDOM_RUN_ISOLATED_CONSUMERS !== '1' || !roots || !isAbsolute(roots)
  || !sourceRoot || !isAbsolute(sourceRoot) || !/^[a-f0-9]{40}$/.test(expectedWorkflowCommit ?? '')) {
  throw Error('Explicit consumer roots, fixed source/workflow SHA and isolated runtime opt-in required; unavailable is not a skip.');
}
const repository = 'FreeTWAI-AI/freedom-growth-automation';
const baseline = 'd1fd7f223efcbed85c95cda18734a33e6528b82a';
const input = (candidateRoot, candidateCommit, selected = repository) => ({ repository: selected,
  candidateRoot, candidateCommit, sourceRoot, expectedWorkflowCommit,
  expectedSourceCommit: '91b943ac61e132fbbce72ea066cb2301aa065600' });
const run = (root, commit) => verifyNativeConsumerRuntime(input(root, commit));
const git = (cwd, args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, env: { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Synthetic', GIT_COMMITTER_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
    GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' }, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
}).trim();
async function mutate(t, rewrite) {
  const directory = await mkdtemp(join(tmpdir(), 'fp-growth-behavior-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = join(directory, 'candidate');
  git(directory, ['clone', '--quiet', '--local', join(roots, 'freedom-growth-automation'), candidate]);
  git(candidate, ['checkout', '--quiet', '--detach', baseline]);
  const path = join(candidate, 'src/index.mjs');
  await writeFile(path, rewrite(await readFile(path, 'utf8')));
  git(candidate, ['add', 'src/index.mjs']); git(candidate, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic source-valid behavior mutation']);
  assert.equal(git(candidate, ['diff', '--name-only', baseline, 'HEAD']), 'src/index.mjs');
  assert.equal(git(candidate, ['diff', '--name-only', baseline, 'HEAD', '--', 'vendor', 'contracts.lock.json']), '');
  return run(candidate, git(candidate, ['rev-parse', 'HEAD']));
}
function failed(result) {
  assert.equal(result.source.status, 'passed');
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.deepEqual(result.failure, { stage: 'workspace', kind: 'behavior_mismatch' });
  assert.equal(result.runtime.cleanup_verified, true);
  assert.equal(result.cli_required, false); assert.equal(result.cli_runtime, null);
  assert.equal(result.library_usage, 'not_checked'); assert.equal(result.library_invocation, 'not_checked');
}

test('real growth export passes source plus isolated reads, 503 and malformed response handling', async () => {
  const result = await run(join(roots, 'freedom-growth-automation'), baseline);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.source.status, 'passed'); assert.equal(result.cli_required, false); assert.equal(result.cli_runtime, null);
  assert.equal(result.runtime.entry, 'src/index.mjs#loadCampaignWorkspace');
  assert.equal(result.runtime.candidate.commit, result.source.candidate_commit);
  assert.equal(result.runtime.candidate.tree, result.source.candidate_tree);
  assert.equal(result.runtime.cleanup_verified, true); assert.equal(result.runtime.check.test_count, 3);
  assert.equal(result.runtime.isolation[0].network, 'none'); assert.equal(result.runtime.isolation[0].readonly_root, true);
  assert.deepEqual(result.runtime.isolation[0].bind_destinations, ['/candidate', '/fixture', '/target.mjs', '/trusted-node']);
  assert.deepEqual(result.runtime.cases.map(c => c.scenario), ['authorized', 'server_error', 'malformed']);
  for (const c of result.runtime.cases) {
    assert.equal(c.status, 'passed'); assert.equal(c.observed_requests, 4);
    assert.deepEqual(c.http_trace.map(x => x.path).sort(), ['/api/v1/protocol', '/api/v1/marketing/campaigns', '/api/v1/opensource/projects', '/api/v1/supplier/products'].sort());
  }
  assert.equal(result.runtime.cases[1].http_trace.find(x => x.path.endsWith('/supplier/products')).status, 503);
  assert.notEqual(result.runtime.cases[0].http_trace[1].response_sha256, result.runtime.cases[1].http_trace[1].response_sha256);
  assert.equal(result.library_invocation, 'not_checked'); assert.equal(result.server_authorization, 'not_checked');
  assert.equal(result.gate_enforced, false); assert.equal(result.merge_authorized, false);
});

test('a source-valid growth stub cannot replace real requests with static rows', async t => {
  const result = await mutate(t, () => 'export async function loadCampaignWorkspace(){return {campaigns:[],projects:[],supplierProducts:[]};}\n');
  failed(result); assert.equal(result.runtime.cases[0].observed_requests, 1);
});
test('real requests with fabricated result rows fail fresh host challenges', async t => {
  const result = await mutate(t, text => text.replace('campaigns: items(result[0], operations[0]),', 'campaigns: [],'));
  failed(result); assert.equal(result.runtime.cases[0].observed_requests, 4);
});
for (const scenario of ['server_error', 'malformed']) test(`hiding growth ${scenario} failure cannot pass on empty results`, async t => {
  const result = await mutate(t, text => text.replace('export async function loadCampaignWorkspace(client)', 'async function originalWorkspace(client)') + `
    export async function loadCampaignWorkspace(client){
      try{return await originalWorkspace(client);}catch(error){
        if(${scenario === 'server_error' ? 'error.status === 503' : 'error.status === undefined'})return {campaigns:[],projects:[],supplierProducts:[]};
        throw error;
      }
    }
  `);
  failed(result); assert.equal(result.runtime.cases[0].status, 'passed');
  assert.equal(result.runtime.cases.at(-1).scenario, scenario); assert.equal(result.runtime.cases.at(-1).status, 'failed');
  assert.equal(result.runtime.cases.at(-1).observed_requests, 4);
});
test('candidate stdout cannot invent host HTTP evidence', async t => {
  const result = await mutate(t, () => `
    const write=process.stdout.write.bind(process.stdout);
    process.stdout.write=()=>{write(JSON.stringify({id:1,status:200,headers:[['content-type','application/json']],body:Buffer.from(JSON.stringify({status:'passed',runtime_observation:'host_observed_http'})).toString('base64')})+'\\n');return true;};
    export async function loadCampaignWorkspace(){return {status:'passed'};}
  `);
  failed(result); assert.equal(result.runtime.cases[0].observed_requests, 1);
});
test('unknown runtime profiles and a CLI request for workspace-only growth fail closed', async () => {
  await assert.rejects(verifyNativeConsumerRuntime(input(join(roots, 'freedom-growth-automation'), baseline, 'FreeTWAI-AI/unknown')), /unsupported_consumer_runtime_profile/);
  await assert.rejects(runIsolatedConsumerCliBehavior({ repository, candidateRepository: join(roots, 'freedom-growth-automation'), candidateCommit: baseline }), /consumer_profile_required/);
});
