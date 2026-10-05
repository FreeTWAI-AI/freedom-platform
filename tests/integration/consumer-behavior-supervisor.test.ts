import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, copyFile, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Host-installed JavaScript supervisor; candidate imports stay in Docker.
import { runIsolatedConsumerBehavior, materializeBehaviorCandidate } from '../../packages/contribution-tools/behavior-supervisor.mjs';
// @ts-expect-error Existing clean subprocess environment.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

if (process.env.FREEDOM_RUN_ISOLATED_CONSUMERS !== '1') throw Error('Explicit FREEDOM_RUN_ISOLATED_CONSUMERS=1 required; unavailable Docker is not a passing skip.');
const roots = process.env.FREEDOM_CONSUMER_RUNTIME_ROOT;
if (!roots || !isAbsolute(roots)) throw Error('Absolute FREEDOM_CONSUMER_RUNTIME_ROOT required.');
const profiles = [
  ['freedom-agent-kit', 'loadMemberWorkspace', 'b2227bc36a571084f6c3d5c5ab340ed4485c6738'],
  ['freedom-storefront', 'loadConnectedStorefront', '87eda4878fb761deb4f9a1c1d7e421c2701f3dcb'],
  ['freedom-supplier-client', 'loadSupplierWorkspace', '7e98c3733e48aa96517d53de6944e3e365108979'],
];
const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, env: { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Synthetic', GIT_COMMITTER_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' },
  stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
}).toString().trim();

for (const [name, , commit] of profiles) test(`actual merged ${name} entrypoint performs independently observed HTTP`, async () => {
  const result = await runIsolatedConsumerBehavior({ repository: 'FreeTWAI-AI/' + name, candidateRepository: join(roots, name), candidateCommit: commit });
  assert.equal(result.check?.status, 'passed', JSON.stringify(result));
  assert.equal(result.candidate.commit, commit); assert.equal(result.runtime_observation, 'host_observed_http');
  assert.equal(result.library_usage, 'not_checked'); assert.equal(result.library_invocation, 'not_checked');
  assert.equal(result.server_authorization, 'not_checked'); assert.equal(result.status, 'unavailable');
  assert.equal(result.merge_authorized, false); assert.equal(result.cleanup_verified, true);
  assert.equal(result.isolation[0].network, 'none'); assert.equal(result.isolation[0].readonly_root, true);
  assert.deepEqual(result.isolation[0].bind_destinations, ['/candidate', '/fixture', '/target.mjs', '/trusted-node']);
  if (name !== 'freedom-agent-kit') {
    assert.deepEqual(result.cases.map((c: any) => c.scenario), ['authorized', 'wrong_scope', 'revoked']);
    for (const c of result.cases.slice(1)) assert.deepEqual(c.http_trace.map((x: any) => x.path), ['/client-api/v1/connection']);
    assert.equal(result.cases[2].http_trace[0].status, 401);
  }
});

async function mutated(t: any, profile: string[], source: (original: string) => string) {
  const [name, , commit] = profile, directory = await mkdtemp(join(tmpdir(), 'fp-consumer-negative-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidateRepository = join(directory, 'candidate'); await mkdir(candidateRepository);
  await materializeBehaviorCandidate(join(roots!, name), commit, candidateRepository);
  const path = join(candidateRepository, 'src/index.mjs'), original = await readFile(path, 'utf8');
  const lock = await readFile(join(candidateRepository, 'consumer-libraries.lock.json'));
  git(candidateRepository, ['init', '-q']); git(candidateRepository, ['add', '.']); git(candidateRepository, ['commit', '-qm', 'Original approved bytes']);
  await chmod(path, 0o644); await writeFile(path, source(original));
  git(candidateRepository, ['add', '.']); git(candidateRepository, ['commit', '-qm', 'Synthetic entrypoint mutation']);
  assert.equal(git(candidateRepository, ['diff', 'HEAD~', 'HEAD', '--name-only']), 'src/index.mjs');
  assert.deepEqual(await readFile(join(candidateRepository, 'consumer-libraries.lock.json')), lock);
  return runIsolatedConsumerBehavior({ repository: 'FreeTWAI-AI/' + name, candidateRepository,
    candidateCommit: git(candidateRepository, ['rev-parse', 'HEAD']) });
}
for (const profile of profiles) test(`correct vendor bytes do not let a stubbed ${profile[0]} entrypoint pass`, async t => {
  const result = await mutated(t, profile, () => `export async function ${profile[1]}(){return {status:'passed'};}
    export class ScopedReadClient { constructor(){} }`);
  assert.equal(result.check?.status, 'failed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.runtime_observation, 'not_checked');
  // Kit's launcher negotiates its protocol first; none of its five operations runs.
  assert.equal(result.cases[0].observed_requests, profile[0] === 'freedom-agent-kit' ? 1 : 0);
});

test('stdout monkeypatch and a forged passing report cannot replace independently observed requests', async t => {
  const result = await mutated(t, profiles[0], () => `
    const originalWrite=process.stdout.write.bind(process.stdout);
    process.stdout.write=()=>{originalWrite(JSON.stringify({id:1,status:200,headers:[['content-type','application/json']],body:Buffer.from(JSON.stringify({status:'passed',runtime_observation:'host_observed_http'})).toString('base64')})+'\\n');return true;};
    export async function loadMemberWorkspace(){return {status:'passed'};}
  `);
  assert.equal(result.check?.status, 'failed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.runtime_observation, 'not_checked');
});

test('real HTTP requests with altered challenge output still fail the host verdict', async t => {
  const result = await mutated(t, profiles[0], () => `
    import {loadMemberWorkspace as genuine} from '../vendor/freedom-libraries/packages/sdk/member-workspace.mjs';
    export async function loadMemberWorkspace(client){const value=await genuine(client);value.member.display_name='fabricated';return value;}
  `);
  assert.equal(result.check?.status, 'failed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.cases[0].observed_requests, 6); assert.equal(result.cases[0].response_matches_challenge, false);
});

for (const ignored of ['wrong_scope', 'revoked']) test(`consumer that hides ${ignored} failure is rejected despite a valid authorized read`, async t => {
  const result = await mutated(t, profiles[1], () => `
    import {loadConnectedStorefront as genuine} from '../vendor/freedom-libraries/packages/client-connections/storefront-workspace.mjs';
    export async function loadConnectedStorefront(options){try{return await genuine(options);}catch(error){
      if(${ignored === 'revoked' ? 'error.status===401' : 'error.status===undefined'})return {read_only:true};throw error;
    }}
  `);
  assert.equal(result.check?.status, 'failed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.cases[0].status, 'passed'); assert.equal(result.cases.at(-1).scenario, ignored);
  assert.equal(result.cases.at(-1).status, 'failed');
  assert.deepEqual(result.cases.at(-1).http_trace.map((x: any) => x.path), ['/client-api/v1/connection']);
});

test('consumer cannot escape its read-only mounts or network-none isolation', async t => {
  const result = await mutated(t, profiles[0], original => `
    const fs=await import('node:fs/promises');
    for(const path of ['/candidate/src/index.mjs','/target.mjs','/fixture/escape']){
      let escaped=false;try{await fs.writeFile(path,'escape');escaped=true;}catch{}if(escaped)throw Error('writable trusted mount');
    }
    const net=await import('node:net');
    const connected=await new Promise(resolve=>{const socket=net.connect({host:'1.1.1.1',port:443});socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false));socket.setTimeout(200,()=>{socket.destroy();resolve(false)});});
    if(connected)throw Error('external network reachable');
    ${original}
  `);
  assert.equal(result.check?.status, 'passed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
});

test('consumer CLI mounts only the actual host interpreter when Node is outside /usr', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fp-node-toolcache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alternateNode = join(directory, 'node'); await copyFile(process.execPath, alternateNode); await chmod(alternateNode, 0o755);
  const script = fileURLToPath(new URL('../../packages/contribution-tools/behavior-supervisor.mjs', import.meta.url));
  const text = execFileSync(alternateNode, [script, 'consumer', 'FreeTWAI-AI/freedom-agent-kit',
    join(roots, 'freedom-agent-kit'), profiles[0][2]], { env: verificationEnvironment(), encoding: 'utf8', timeout: 20000, maxBuffer: 256000 });
  const result = JSON.parse(text); assert.equal(result.check.status, 'passed', text);
  assert.equal(result.installation.node_executable, alternateNode); assert.equal(result.cleanup_verified, true);
});

test('a completed case timeout cannot abort a later consumer case', async t => {
  const result = await mutated(t, profiles[1], () => `
    import {loadConnectedStorefront as genuine} from '../vendor/freedom-libraries/packages/client-connections/storefront-workspace.mjs';
    export async function loadConnectedStorefront(options){await new Promise(resolve=>setTimeout(resolve,2200));return genuine(options);}
  `);
  assert.equal(result.check?.status, 'passed', JSON.stringify(result));
  assert.equal(result.cases.length, 3); assert.equal(result.cleanup_verified, true);
});


test('consumer host executes with no npm installation or candidate dependencies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fp-consumer-clean-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../../', import.meta.url));
  for (const path of ['packages/contribution-tools', 'governance/schemas', 'contracts', 'migrations', 'package-lock.json']) {
    await cp(join(source, path), join(directory, path), { recursive: true });
  }
  await assert.rejects(access(join(directory, 'node_modules')));
  const script = join(directory, 'packages/contribution-tools/behavior-supervisor.mjs');
  const text = execFileSync(process.execPath, [script, 'consumer', 'FreeTWAI-AI/freedom-agent-kit',
    join(roots, 'freedom-agent-kit'), profiles[0][2]], { cwd: directory, env: verificationEnvironment(), encoding: 'utf8', timeout: 20000, maxBuffer: 256000 });
  const result = JSON.parse(text); assert.equal(result.check.status, 'passed', text); assert.equal(result.cleanup_verified, true);
});
