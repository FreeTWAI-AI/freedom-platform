import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, copyFile, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Host-installed JavaScript supervisor; candidate imports stay in Docker.
import { runIsolatedConsumerBehavior, runIsolatedAgentKitCliBehavior, runIsolatedConsumerCliBehavior, materializeBehaviorCandidate } from '../../packages/contribution-tools/behavior-supervisor.mjs';
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

async function mutated(t: any, profile: string[], source: (original: string) => string,
  { entry = 'src/index.mjs', run = runIsolatedConsumerBehavior } = {}) {
  const [name, , commit] = profile, directory = await mkdtemp(join(tmpdir(), 'fp-consumer-negative-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidateRepository = join(directory, 'candidate'); await mkdir(candidateRepository);
  await materializeBehaviorCandidate(join(roots!, name), commit, candidateRepository);
  const path = join(candidateRepository, entry), original = await readFile(path, 'utf8');
  const lock = await readFile(join(candidateRepository, 'consumer-libraries.lock.json'));
  git(candidateRepository, ['init', '-q']); git(candidateRepository, ['add', '.']); git(candidateRepository, ['commit', '-qm', 'Original approved bytes']);
  await chmod(path, 0o644); await writeFile(path, source(original));
  git(candidateRepository, ['add', '.']); git(candidateRepository, ['commit', '-qm', 'Synthetic entrypoint mutation']);
  assert.equal(git(candidateRepository, ['diff', 'HEAD~', 'HEAD', '--name-only']), entry);
  assert.deepEqual(await readFile(join(candidateRepository, 'consumer-libraries.lock.json')), lock);
  return run({ repository: 'FreeTWAI-AI/' + name, candidateRepository,
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


test('actual kit CLI performs synthetic login, fresh workspace reads and CSRF-protected logout', async () => {
  const result = await runIsolatedAgentKitCliBehavior({ repository: 'FreeTWAI-AI/freedom-agent-kit',
    candidateRepository: join(roots, profiles[0][0]), candidateCommit: profiles[0][2] });
  assert.equal(result.check?.status, 'passed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.entry, 'src/cli.mjs#maker'); assert.equal(result.library_invocation, 'not_checked');
  assert.equal(result.server_authorization, 'not_checked'); assert.equal(result.merge_authorized, false);
  const trace = result.cases[0].http_trace;
  assert.equal(trace.length, 8); assert.equal(result.cases[0].response_matches_challenge, true);
  assert.deepEqual(trace.slice(0, 2).map((x: any) => [x.method, x.path, x.authentication]),
    [['GET', '/api/v1/protocol', 'none'], ['POST', '/api/v1/auth/login', 'none']]);
  assert.deepEqual(trace.slice(2, 7).map((x: any) => x.path).sort(),
    ['/api/v1/session', '/api/v1/dashboard', '/api/v1/work-items', '/api/v1/me/positioning', '/api/v1/guilds'].sort());
  assert.equal(trace.at(-1).path, '/api/v1/auth/logout'); assert.equal(trace.at(-1).method, 'POST');
  assert.equal(trace.at(-1).csrf_checked, true); assert.equal(trace.at(-1).credential_matched, true);
  assert.deepEqual(result.isolation[0].bind_destinations, ['/candidate', '/fixture', '/target.mjs', '/trusted-node']);
  assert(!JSON.stringify(result).includes('freedom_local_session=')); assert(!JSON.stringify(result).includes('freedom-local-demo'));
});

const mutatedCli = (t: any, source: (original: string) => string) => mutated(t, profiles[0], source,
  { entry: 'src/cli.mjs', run: runIsolatedAgentKitCliBehavior });
test('the actual CLI stub is rejected even though vendor, workspace export and locks remain correct', async t => {
  const result = await mutatedCli(t, () => `console.log(JSON.stringify({status:'passed'}));`);
  assert.equal(result.check?.status, 'failed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.reason, 'consumer_behavior_mismatch'); assert.equal(result.cases[0].observed_requests, 0);
});
test('CLI workspace output without its real logout is rejected', async t => {
  const result = await mutatedCli(t, original => {
    assert(original.includes("finally{if(client)await client.call('logout',{body:{}});}"));
    return original.replace("finally{if(client)await client.call('logout',{body:{}});}", 'finally{}');
  });
  assert.equal(result.check?.status, 'failed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.reason, 'consumer_behavior_mismatch'); assert.equal(result.cases[0].observed_requests, 7);
});
for (const header of ['X-CSRF-Token', 'Cookie']) test(`CLI logout with changed ${header} cannot pass`, async t => {
  const result = await mutatedCli(t, original => `
    const realFetch=globalThis.fetch;
    globalThis.fetch=(url,options)=>{if(url.endsWith('/auth/logout'))options.headers[${JSON.stringify(header)}]='forged';return realFetch(url,options);};
    ${original}
  `);
  assert.equal(result.check?.status, 'failed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.runtime_observation, 'not_checked');
  assert.equal(result.phase, 'behavior', JSON.stringify(result));
  assert(['consumer_fixture_invalid', 'consumer_supervisor_failed'].includes(result.reason), JSON.stringify(result));
});
test('CLI with all real requests but corrupted printed workspace fails the fresh challenge comparison', async t => {
  const result = await mutatedCli(t, original => `
    const realLog=console.log;
    console.log=()=>realLog(JSON.stringify({status:'passed'}));
    ${original}
  `);
  assert.equal(result.check?.status, 'failed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.cases[0].observed_requests, 8); assert.equal(result.cases[0].response_matches_challenge, false);
});
test('CLI forged response-port output cannot replace independently observed login or reads', async t => {
  const result = await mutatedCli(t, () => `
    process.stdout.write(JSON.stringify({id:1,status:200,headers:[['content-type','application/json']],body:Buffer.from(JSON.stringify({status:'passed'})).toString('base64')})+'\\n');
  `);
  assert.equal(result.check?.status, 'failed', JSON.stringify(result)); assert.equal(result.cleanup_verified, true);
  assert.equal(result.runtime_observation, 'not_checked');
  assert(result.reason === 'consumer_behavior_mismatch' || (result.phase === 'behavior'
    && result.reason === 'consumer_supervisor_failed'), JSON.stringify(result));
});

for (const profile of profiles.slice(1)) {
  const scopedMutation = (t: any, transform: (original: string) => string) => mutated(t, profile, transform,
    { entry: 'client/cli.mjs', run: runIsolatedConsumerCliBehavior });
  test(`${profile[0]} real CLI requests with forged stdout fail fresh response validation`, async t => {
    const result = await scopedMutation(t, original => `console.log=()=>process.stdout.write('{"status":"passed"}');\n` + original);
    assert.equal(result.check.status, 'failed'); assert.equal(result.reason, 'consumer_behavior_mismatch');
    assert.equal(result.cases[0].observed_requests, 1); assert.equal(result.cases[0].response_matches_challenge, false);
    assert.equal(result.cleanup_verified, true);
  });
  test(`${profile[0]} swallowing CLI errors cannot pass wrong-scope behavior`, async t => {
    const result = await scopedMutation(t, original => `process.on('uncaughtException',()=>{process.exitCode=0;});\n` + original);
    assert.equal(result.check.status, 'failed'); assert.equal(result.reason, 'consumer_behavior_mismatch');
    assert(result.cases.slice(0, -1).every((c: any) => c.status === 'passed'));
    assert.equal(result.cases.at(-1).scenario, 'wrong_scope'); assert.equal(result.cases.at(-1).status, 'failed');
    assert.equal(result.cleanup_verified, true);
  });
  for (const status of [401, 503]) test(`${profile[0]} CLI hiding HTTP ${status} is rejected after successful reads`, async t => {
    const result = await scopedMutation(t, original => `process.on('uncaughtException',error=>{process.exitCode=error.status===${status}?0:1;});\n` + original);
    assert.equal(result.check.status, 'failed'); assert.equal(result.reason, 'consumer_behavior_mismatch');
    assert(result.cases.slice(0, -1).every((c: any) => c.status === 'passed'));
    assert.equal(result.cases.at(-1).scenario, status === 401 ? 'revoked' : 'server_error');
    assert.equal(result.cases.at(-1).http_trace[0].status, status); assert.equal(result.cleanup_verified, true);
  });
}


test('unknown Docker create acknowledgement cannot pass full supervisor cleanup after empty scans', async () => {
  // Trusted test-only host seam. Candidate source cannot install this callback;
  // the production supervisor API still accepts only immutable input identities.
  const original = childProcess.execFileSync;
  let dispatches = 0, ownerLabel: string | undefined;
  const cleanupLabels: string[] = [];
  try {
    childProcess.execFileSync = ((executable: string, args: string[], options: any) => {
      if (executable === '/usr/bin/docker' && args[0] === 'create') {
        dispatches++;
        ownerLabel = args[args.indexOf('--label') + 1]?.replace('freedom.behavior-owner=', '');
        // Do not actually dispatch a create: simulate a CLI losing its daemon
        // acknowledgement. The separate lifecycle test models late completion.
        throw Object.assign(new Error('Synthetic unknown create acknowledgement'), { code: 'ETIMEDOUT' });
      }
      if (executable === '/usr/bin/docker' && args[0] === 'ps' && ownerLabel) {
        const filter = args[args.indexOf('--filter') + 1];
        assert.equal(filter, 'label=freedom.behavior-owner=' + ownerLabel);
        cleanupLabels.push(filter);
        return Buffer.from(''); // Both recovery and final readback appear empty.
      }
      return original(executable, args, options);
    }) as typeof childProcess.execFileSync;
    syncBuiltinESMExports();
    const result = await runIsolatedConsumerBehavior({ repository: 'FreeTWAI-AI/freedom-agent-kit',
      candidateRepository: join(roots!, profiles[0][0]), candidateCommit: profiles[0][2] });
    assert.equal(dispatches, 1, JSON.stringify(result));
    assert.equal(cleanupLabels.length, 2);
    assert.match(ownerLabel!, /^[a-f0-9-]{36}$/);
    assert.equal(result.phase, 'candidate');
    assert.equal(result.reason, 'supervisor_create_outcome_unknown');
    assert.equal(result.operation_failure_reason, 'supervisor_host_command_failed');
    assert.equal(result.cleanup_verified, false);
    assert.equal(result.check.status, 'failed');
    assert.equal(result.runtime_observation, 'not_checked');
    assert.deepEqual(result.cleanup, { status: 'create_pending', cleanup_verified: false,
      pending_creates: [{ kind: 'candidate', operation: 'create', state: 'create_pending' }], owner_label: ownerLabel });
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
});
