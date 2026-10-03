import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createIsolatedCliProbe } from '../../modules/agent-execution/adapters/cli-probe.js';
import { AdapterFault, type CliArtifact } from '../../modules/agent-execution/adapters/common.js';

let directory: string, marker: string;
const binaries = new Map<number, CliArtifact>();
let unavailable: string | undefined;
before(async () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') { unavailable = 'Actual fixture needs Linux x86-64 namespaces.'; return; }
  const compiler = spawnSync('/usr/bin/cc', ['--version'], { env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
  const isolation = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/usr/bin/true', '/true', '/true'],
    { env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
  // /usr/bin/true is dynamically linked and this availability check intentionally
  // has no loader. A loader error proves bwrap ran; namespace errors do not.
  if (compiler.status !== 0 || isolation.error || isolation.stderr.includes('Creating new namespace failed')) {
    unavailable = 'Actual cc/bwrap namespace environment unavailable.'; return;
  }
  directory = await mkdtemp(join(tmpdir(), 'fp-cli-probe-fixture-'));
  marker = `fp_${directory.slice(-8)}`;
  const sentinel = join(directory, 'host-synthetic-secret');
  await writeFile(sentinel, 'SYNTHETIC HOST DATA MUST NOT BE MOUNTED');
  const outputFormat = JSON.stringify('{"argc":%d,"arg1":"%s","arg2":"%s","cwd":"%s","pwd":"%s","home":"%s","hostname":"%s","env_count":%d,"parent_env_denied":%d,"auth_env_denied":%d,"host_file_denied":%d,"network_denied":%d,"fresh_home":%d,"snapshot":"original"}\n');
  const source = `#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/prctl.h>
#include <arpa/inet.h>
#include <sys/types.h>
extern char **environ;
int main(int argc,char **argv) {
  prctl(PR_SET_NAME,${JSON.stringify(marker)},0,0,0);
  if (MODE==1) { char buffer[4096];memset(buffer,'x',sizeof(buffer));for(int n=0;n<32;n++)write(1,buffer,sizeof(buffer));return 0; }
  if (MODE==2||MODE==3) { if(fork()==0){setsid();for(;;)pause();}if(MODE==2)return 0;for(;;)pause(); }
  if (MODE==4) usleep(300000);
  char cwd[256]={0},host[256]={0};getcwd(cwd,sizeof(cwd));gethostname(host,sizeof(host));
  int secret=open(${JSON.stringify(sentinel)},O_RDONLY);int secret_denied=(secret<0);if(secret>=0)close(secret);
  int parent_env=(getenv("FP_CLI_PROBE_TEST_SENTINEL")==NULL);
  int auth_env=(getenv("OPENAI_API_KEY")==NULL&&getenv("ANTHROPIC_API_KEY")==NULL&&getenv("HTTP_PROXY")==NULL);
  int fresh=(access("/home/probe/state",F_OK)!=0);int state=open("/home/probe/state",O_CREAT|O_WRONLY,0600);if(state>=0)close(state);
  struct sockaddr_in address={0};address.sin_family=AF_INET;address.sin_port=htons(9);inet_pton(AF_INET,"198.51.100.1",&address.sin_addr);
  int connection=socket(AF_INET,SOCK_STREAM,0);int flags=fcntl(connection,F_GETFL,0);fcntl(connection,F_SETFL,flags|O_NONBLOCK);
  errno=0;int result=connect(connection,(struct sockaddr*)&address,sizeof(address));int network_denied=(result<0&&errno==ENETUNREACH);close(connection);
  int count=0;for(char **value=environ;*value;value++)count++;
  printf(${outputFormat},
    argc,argc>1?argv[1]:"",argc>2?argv[2]:"",cwd,getenv("PWD"),getenv("HOME"),host,count,parent_env,auth_env,secret_denied,network_denied,fresh);
  return 0;
}`;
  const path = join(directory, 'fixture.c');
  await writeFile(path, source);
  for (const mode of [0, 1, 2, 3, 4]) {
    const executable = join(directory, `fixture-${mode}`);
    const compilation = spawnSync('/usr/bin/cc', ['-O2', `-DMODE=${mode}`, '-o', executable, path],
      { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 15000, maxBuffer: 16384 });
    assert.equal(compilation.status, 0, 'Actual native fixture compile failed: ' + compilation.stderr);
    const bytes = await readFile(executable);
    binaries.set(mode, { executable, sha256: createHash('sha256').update(bytes).digest('hex'), version: '0.0.1' });
  }
});
after(async () => { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); });
function actual(t: { skip(reason?: string): void }): boolean {
  if (unavailable === undefined) return true;
  t.skip(unavailable); return false;
}
async function rejects(code: string, action: Promise<unknown>) {
  await assert.rejects(action, (error: unknown) => error instanceof AdapterFault && error.code === code);
}
async function fixtureProcesses(): Promise<string[]> {
  const entries = (await readdir('/proc')).filter(name => /^[0-9]+$/.test(name));
  const values = await Promise.all(entries.map(async pid => ({ pid, comm: await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '') })));
  return values.filter(value => value.comm.trim() === marker).map(value => value.pid);
}
async function noOwnedFixtureProcesses() {
  for (let n = 0; n < 50; n++) { if (!(await fixtureProcesses()).length) return; await delay(20); }
  assert.deepEqual(await fixtureProcesses(), [], 'Probe left a fixture descendant alive.');
}

test('actual native probe has fixed args, a fresh HOME/workspace/environment and denied host files/network', async t => {
  if (!actual(t)) return;
  const old = process.env.FP_CLI_PROBE_TEST_SENTINEL;
  process.env.FP_CLI_PROBE_TEST_SENTINEL = 'SYNTHETIC NOT A CREDENTIAL';
  try {
    const probe = createIsolatedCliProbe(binaries.get(0)!, 'codex');
    for (const [operation, expected] of [['version', ['--version', '']], ['help', ['exec', '--help']], ['auth_status', ['login', 'status']]] as const) {
      const observation = await probe.probe(operation);
      assert.equal(observation.exitCode, 0, new TextDecoder().decode(observation.stderr)); assert.equal(observation.signal, null); assert.equal(observation.stderr.length, 0);
      const facts = JSON.parse(new TextDecoder().decode(observation.stdout));
      assert.deepEqual([facts.arg1, facts.arg2], expected);
      assert.equal(facts.cwd, '/workspace'); assert.equal(facts.pwd, '/workspace'); assert.equal(facts.home, '/home/probe'); assert.equal(facts.hostname, 'fp-model-probe');
      // bubblewrap itself adds PWD after its fixed --chdir.
      assert.equal(facts.env_count, 6);
      for (const field of ['parent_env_denied', 'auth_env_denied', 'host_file_denied', 'network_denied', 'fresh_home']) assert.equal(facts[field], 1, field);
    }
    const claude = createIsolatedCliProbe(binaries.get(0)!, 'claude');
    const help = JSON.parse(new TextDecoder().decode((await claude.probe('help')).stdout));
    const auth = JSON.parse(new TextDecoder().decode((await claude.probe('auth_status')).stdout));
    assert.deepEqual([help.arg1, help.arg2], ['--help', '']);
    assert.deepEqual([auth.arg1, auth.arg2], ['auth', 'status']);
    await noOwnedFixtureProcesses();
  } finally {
    if (old === undefined) delete process.env.FP_CLI_PROBE_TEST_SENTINEL; else process.env.FP_CLI_PROBE_TEST_SENTINEL = old;
  }
});

test('isolated probe input rejects script/interpreter paths, symlinks, wrong hashes and caller operations', async t => {
  if (!actual(t)) return;
  let invoked = 0;
  const accessor = { ...binaries.get(0)! };
  Object.defineProperty(accessor, 'executable', { enumerable: true, get() { invoked++; throw Error('PRIVATE GETTER'); } });
  assert.throws(() => createIsolatedCliProbe(accessor, 'codex'), (error: unknown) => error instanceof AdapterFault && error.code === 'invalid_input');
  assert.equal(invoked, 0);
  const probe = createIsolatedCliProbe(binaries.get(0)!, 'codex');
  for (const operation of ['login', 'logout', 'execute', '--version', '', undefined]) await rejects('invalid_input', probe.probe(operation as 'version'));
  await rejects('artifact_mismatch', createIsolatedCliProbe({ ...binaries.get(0)!, sha256: 'f'.repeat(64) }, 'codex').probe('version'));
  const link = join(directory, 'native-symlink'); await symlink(binaries.get(0)!.executable, link);
  await rejects('artifact_mismatch', createIsolatedCliProbe({ ...binaries.get(0)!, executable: link }, 'codex').probe('version'));
  const script = join(directory, 'script'); await writeFile(script, '#!/bin/sh\necho unsafe\n'); await chmod(script, 0o700);
  await rejects('artifact_mismatch', createIsolatedCliProbe({ executable: script, sha256: createHash('sha256').update(await readFile(script)).digest('hex'), version: '0.0.1' }, 'codex').probe('version'));
  const mutable = { ...binaries.get(0)! }, captured = createIsolatedCliProbe(mutable, 'codex');
  mutable.executable = script; mutable.sha256 = 'f'.repeat(64);
  assert.equal((await captured.probe('version')).exitCode, 0);
});

test('actual oversized native output is bounded and its owned process namespace is killed', async t => {
  if (!actual(t)) return;
  const started = Date.now();
  await rejects('response_limit', createIsolatedCliProbe(binaries.get(1)!, 'codex').probe('version'));
  assert.ok(Date.now() - started < 5000);
  await noOwnedFixtureProcesses();
});

test('actual descendant holding stdout after parent exit cannot keep diagnostic open', async t => {
  if (!actual(t)) return;
  const started = Date.now();
  const observation = await createIsolatedCliProbe(binaries.get(2)!, 'codex').probe('version');
  assert.equal(observation.exitCode, 0);
  assert.ok(Date.now() - started < 2500, 'Immediate child exit should close its owned namespace without waiting for deadline.');
  await noOwnedFixtureProcesses();
});

test('actual hung native process and setsid descendant meet deadline and leave no fixture processes', async t => {
  if (!actual(t)) return;
  const started = Date.now();
  await rejects('probe_unavailable', createIsolatedCliProbe(binaries.get(3)!, 'codex').probe('version'));
  assert.ok(Date.now() - started < 5000, 'Process hard timer was extended by a descendant-held pipe.');
  await noOwnedFixtureProcesses();
});

test('actual artifact mutation after preparation is rejected and mutation after copy cannot change the bound snapshot', async t => {
  if (!actual(t)) return;
  const original = binaries.get(4)!, replacement = join(directory, 'replacement');
  await writeFile(replacement, await readFile(original.executable)); await chmod(replacement, 0o700);
  const entry = { ...original, executable: replacement }, probe = createIsolatedCliProbe(entry, 'codex');
  const pending = probe.probe('version');
  // Observe the actual sandboxed native process before mutating its original
  // inode. This proves the verified snapshot has reached exec, without timing
  // assumptions about the filesystem copy or namespace startup.
  let running = false;
  for (let n = 0; n < 100; n++) { if ((await fixtureProcesses()).length) { running = true; break; } await delay(5); }
  assert.equal(running, true, 'Native snapshot never reached the observed exec barrier.');
  await writeFile(replacement, 'mutated original inode after snapshot');
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(new TextDecoder().decode(result.stdout)).snapshot, 'original');
  await rejects('artifact_mismatch', probe.probe('version'));
  const replacePath = join(directory, 'replace-path');
  await writeFile(replacePath, await readFile(original.executable)); await chmod(replacePath, 0o700);
  const beforeReplace = createIsolatedCliProbe({ ...original, executable: replacePath }, 'codex');
  const other = join(directory, 'different-native'); await writeFile(other, await readFile(binaries.get(0)!.executable)); await chmod(other, 0o700);
  await rename(other, replacePath);
  await rejects('artifact_mismatch', beforeReplace.probe('version'));
  await noOwnedFixtureProcesses();
});
