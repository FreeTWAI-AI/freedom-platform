// Candidate diagnostic only; not authenticated host evidence or a merge gate.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, readlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
import { parseJson, readBounded } from '../../packages/contribution-tools/io.mjs';

if (process.argv.length !== 2) { console.error('native_snapshot_arguments_rejected'); process.exit(1); }
const root = resolve(import.meta.dirname,'../..');
const directory = await mkdtemp(join(tmpdir(),'fp-native-snapshot-check-'));
let okay = false;
try {
  // Fixed public system metadata only, matching the adapter's current filter.
  // Admission here does not establish that a file was mounted in the sandbox.
  const libraries = [
    '/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    '/lib/x86_64-linux-gnu/libc.so.6', '/lib/x86_64-linux-gnu/libm.so.6',
    '/lib/x86_64-linux-gnu/libdl.so.2', '/lib/x86_64-linux-gnu/libpthread.so.0',
    '/lib/x86_64-linux-gnu/librt.so.1', '/lib/x86_64-linux-gnu/libgcc_s.so.1',
    '/lib/x86_64-linux-gnu/libstdc++.so.6',
  ];
  for (const path of libraries) {
    const info = await stat(path).catch(() => undefined);
    const target = await readlink(path).catch(() => undefined);
    const resolved = await realpath(path).catch(() => undefined);
    const admitted = !!info?.isFile() && info.uid === 0 && !(info.mode & 0o022);
    console.log('native_snapshot_library ' + JSON.stringify({path,
      admission: !info ? 'missing' : admitted ? 'admitted' : 'rejected',
      ...(info ? {uid:info.uid,mode:(info.mode & 0o7777).toString(8).padStart(4,'0'),isFile:info.isFile(),size:info.size} : {}),
      ...(target !== undefined ? {readlink:target} : {}),
      ...(resolved !== undefined ? {realpath:resolved} : {}),
      sandbox_mount_verified:false}));
  }
  const destination = join(directory,'report.json');
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const reporter = resolve(root,'packages/contribution-tools/test-reporter.mjs');
  const env = verificationEnvironment();
  console.log('native_snapshot_check=candidate_diagnostic trust=unverified');
  const child = spawn(process.execPath,['--import',loader,'--test','--test-concurrency=1',
    '--test-reporter=tap','--test-reporter-destination=stdout',
    '--test-reporter='+reporter,'--test-reporter-destination='+destination,
    'tests/runtime/model-cli-probe.test.ts'],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
  let bytes=0,reason;
  const stop = code => { reason ??= code; try { process.kill(-child.pid,'SIGKILL'); } catch {} };
  const timer = setTimeout(()=>stop('native_snapshot_timeout'),30_000);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>stop('native_snapshot_cancelled'));
  for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{
    bytes+=chunk.length;
    if(bytes>262144)stop('native_snapshot_output_limit');
    else process.stdout.write(chunk); // Only the fixed synthetic fixture is executed.
  });
  const exit = await new Promise(done=>{child.on('error',()=>stop('native_snapshot_start_failed'));child.on('close',(code,signal)=>done({code,signal}));});
  clearTimeout(timer);
  if(reason)throw Error(reason);
  const raw=parseJson(await readBounded(directory,'report.json',262144),{maxBytes:262144,maxNodes:10000});
  const counts=c=>c && c.tests===6 && c.passed===6 && ['failed','skipped','cancelled','todo'].every(key=>c[key]===0) && c.suites===0;
  okay=exit.code===0 && exit.signal===null && raw.success===true && counts(raw.counts) &&
    Array.isArray(raw.files)&&raw.files.length===1&&raw.files[0].file==='tests/runtime/model-cli-probe.test.ts'&&raw.files[0].success===true&&counts(raw.files[0].counts)&&
    Array.isArray(raw.cases)&&raw.cases.length===6&&new Set(raw.cases.map(c=>c.case_sha256)).size===6&&
    raw.cases.every(c=>c.file==='tests/runtime/model-cli-probe.test.ts'&&c.status==='passed'&&/^[a-f0-9]{64}$/.test(c.case_sha256))&&Array.isArray(raw.suites)&&raw.suites.length===0;
  if(!okay)throw Error('native_snapshot_incomplete');
  console.log('native_snapshot_check=pass cases=6 skipped=0 trust=unverified');
} catch(error) {
  console.error(/^native_snapshot_[a-z_]+$/.test(error?.message??'')?error.message:'native_snapshot_unavailable');
} finally { await rm(directory,{recursive:true,force:true}); }
process.exitCode=okay?0:1;
