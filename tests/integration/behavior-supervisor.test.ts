import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, chmod, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Host-owned ESM module, never a candidate-provided port.
import { runIsolatedMemberBehavior, materializeBehaviorCandidate } from '../../packages/contribution-tools/behavior-supervisor.mjs';
// @ts-expect-error Existing host-only clean subprocess environment.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

if (process.env.FREEDOM_RUN_ISOLATED_BEHAVIOR !== '1') throw new Error('Explicit FREEDOM_RUN_ISOLATED_BEHAVIOR=1 is required; unavailable isolation is not a passing skip.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const dependencies = await realpath(join(root, 'node_modules'));
const gitEnv = { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic isolation test', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
  GIT_COMMITTER_NAME: 'Synthetic isolation test', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 64 * 1024 * 1024 }).toString().trim();
let directory: string, repo: string, app: string, original: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fp-supervisor-integration-')); repo = join(directory, 'candidate'); await mkdir(repo);
  await materializeBehaviorCandidate(root, git(root, ['rev-parse', 'HEAD']), repo);
  app = join(repo, 'apps/platform-api/src/app.ts'); original = await readFile(app, 'utf8'); await chmod(app, 0o644);
  git(repo, ['init', '-q']); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Synthetic candidate snapshot']);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: false }); });
async function run(prefix = '') {
  await writeFile(app, prefix + '\n' + original); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Synthetic candidate mutation', '--allow-empty']);
  return runIsolatedMemberBehavior({ candidateRepository: repo, candidateCommit: git(repo, ['rev-parse', 'HEAD']), dependencyRoot: dependencies });
}
test('real isolated createApp passes all fixed requests with authenticated DB role and no fixture changes', async () => {
  const result = await run(); assert.equal(result.check?.status, 'passed', JSON.stringify(result)); assert.equal(result.check.test_count, 27);
  assert.equal(result.status, 'unavailable'); assert.equal(result.merge_authorized, false); assert.equal(result.execution_authorized, false);
  assert.equal(result.cleanup_verified, true); assert.match(result.installation.supervisor_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.installation.dependency_sha256, /^[a-f0-9]{64}$/); assert.equal(result.isolation.length, 2);
  const isolation: Array<{ulimits:Array<{Name:string;Soft:number;Hard:number}>}> = result.isolation;
  assert.deepEqual(isolation.map(item=>item.ulimits.find(limit=>limit.Name==='nofile')!.Soft).sort((a,b)=>a-b),[256,512]);
  assert(isolation.every(item=>item.ulimits.find(limit=>limit.Name==='core')!.Hard===0));
});
test('actual candidate cannot reach host files/network, overwrite RO mounts, or authenticate as postgres', async () => {
  const result = await run(`
    const probeFs = await import('node:fs/promises');
    const actualLimits=await probeFs.readFile('/proc/self/limits','utf8');
    if(!/^Max open files\\s+512\\s+512\\s+files[ ]*$/m.test(actualLimits)) throw Error('isolation_probe_failed');
    for (const path of ['/home/ted-h', '/root/.ssh', '/var/run/docker.sock', '/proc/1/root/home/ted-h']) {
      if (await probeFs.access(path).then(()=>true,()=>false)) throw Error('isolation_probe_failed');
    }
    for (const path of ['/target.mjs', '/candidate/package.json', '/candidate/node_modules/pg/package.json', '/usr/bin/node']) {
      if (await probeFs.writeFile(path, 'tamper').then(()=>true,()=>false)) throw Error('isolation_probe_failed');
    }
    if (process.env.POSTGRES_PASSWORD || !process.env.FP_BEHAVIOR_DB_PASSWORD) throw Error('isolation_probe_failed');
    const ProbePg = (await import('pg')).default;
    for (const user of ['postgres', 'not_a_role']) for (const password of ['', process.env.FP_BEHAVIOR_DB_PASSWORD]) {
      const probePool = new ProbePg.Pool({host:'/database',database:'fp_behavior_supervisor',user,password,connectionTimeoutMillis:500});
      try { if (await probePool.query('SELECT 1').then(()=>true,()=>false)) throw Error('isolation_probe_failed'); } finally { await probePool.end(); }
    }
    const ownPool = new ProbePg.Pool({host:'/database',database:'fp_behavior_supervisor',user:'behavior_app',password:process.env.FP_BEHAVIOR_DB_PASSWORD});
    for (const sql of ["SET ROLE postgres", "SELECT pg_read_file('/proc/self/environ')", "CREATE ROLE unexpected_role LOGIN"]) {
      if (await ownPool.query(sql).then(()=>true,()=>false)) throw Error('isolation_probe_failed');
    }
    await ownPool.end();
    const probeNet = await import('node:net');
    const connected = await new Promise(resolve=>{const socket=probeNet.createConnection({host:'192.0.2.1',port:443});
      const done=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(500,()=>done(false));});
    if (connected) throw Error('isolation_probe_failed');
  `);
  assert.equal(result.check?.status, 'passed', JSON.stringify(result)); assert.equal(result.check.test_count, 27); assert.equal(result.cleanup_verified, true);
});
for (const [name, code] of [
  ['forged candidate result', `process.stdout.write(JSON.stringify({check:{status:'passed'},observation:{tests:27}})+'\\n');`],
  ['unbounded candidate output', `process.stdout.write('x'.repeat(600000));`],
  ['blocked candidate event loop', `while(true){}`],
] as const) test(`isolated supervisor rejects ${name} and kills only its owned containers`, async () => {
  const start = Date.now(), result = await run(code);
  assert.notEqual(result.check?.status, 'passed'); assert.equal(result.observation ?? null, null);
  assert.equal(result.cleanup_verified, true); assert(Date.now() - start < 45000, JSON.stringify(result));
});
test('candidate DML cannot silently change fixture authorization or other retained rows', async () => {
  const result = await run(`
    const TamperPg = (await import('pg')).default;
    const tamperPool = new TamperPg.Pool({host:'/database',database:'fp_behavior_supervisor',user:'behavior_app',password:process.env.FP_BEHAVIOR_DB_PASSWORD});
    await tamperPool.query('UPDATE users SET active=false');await tamperPool.end();
  `);
  assert.equal(result.reason, 'supervisor_fixture_changed', JSON.stringify(result)); assert.equal(result.observation ?? null, null);
  assert.equal(result.cleanup_verified, true);
});
