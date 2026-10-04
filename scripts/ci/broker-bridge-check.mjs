// Candidate diagnostic only; not authenticated host evidence or a merge gate.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
import { parseJson, readBounded } from '../../packages/contribution-tools/io.mjs';

if (process.argv.length !== 2) { console.error('broker_bridge_arguments_rejected'); process.exit(1); }
let database;
try { database = new URL(process.env.TEST_DATABASE_URL); } catch {}
if (!database || database.protocol !== 'postgresql:' || !['localhost','127.0.0.1'].includes(database.hostname) || !/^\/fp_[a-z0-9_]+$/.test(database.pathname) || database.hash || database.searchParams.getAll('host').length > 1 || [...database.searchParams.keys()].some(k=>k!=='host') || (database.searchParams.has('host') && (!database.searchParams.get('host').startsWith('/') || database.hostname!=='localhost'))) { console.error('broker_bridge_database_rejected'); process.exit(1); }
const root = resolve(import.meta.dirname,'../..');
const directory = await mkdtemp(join(tmpdir(),'fp-broker-bridge-check-'));
let okay = false;
try {
  const destination = join(directory,'report.json');
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const reporter = resolve(root,'packages/contribution-tools/test-reporter.mjs');
  const env = {...verificationEnvironment(),TEST_DATABASE_URL:process.env.TEST_DATABASE_URL};
  console.log('broker_bridge_check=candidate_diagnostic trust=unverified');
  const child = spawn(process.execPath,['--import',loader,'--test','--test-concurrency=1',
    '--test-reporter=tap','--test-reporter-destination=stdout',
    '--test-reporter='+reporter,'--test-reporter-destination='+destination,
    'tests/runtime/model-broker-bridge-adversarial.test.ts'],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
  let bytes=0,reason;
  const stop = code => { reason ??= code; try { process.kill(-child.pid,'SIGKILL'); } catch {} };
  const timer = setTimeout(()=>stop('broker_bridge_timeout'),90_000);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>stop('broker_bridge_cancelled'));
  for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{
    bytes+=chunk.length;
    if(bytes>262144)stop('broker_bridge_output_limit');
    else process.stdout.write(chunk); // Only the fixed synthetic fixture is executed.
  });
  const exit = await new Promise(done=>{child.on('error',()=>stop('broker_bridge_start_failed'));child.on('close',(code,signal)=>done({code,signal}));});
  clearTimeout(timer);
  if(reason)throw Error(reason);
  const raw=parseJson(await readBounded(directory,'report.json',262144),{maxBytes:262144,maxNodes:10000});
  const counts=c=>c && c.tests===8 && c.passed===8 && ['failed','skipped','cancelled','todo'].every(key=>c[key]===0) && c.suites===0;
  okay=exit.code===0 && exit.signal===null && raw.success===true && counts(raw.counts) &&
    Array.isArray(raw.files)&&raw.files.length===1&&raw.files[0].file==='tests/runtime/model-broker-bridge-adversarial.test.ts'&&raw.files[0].success===true&&counts(raw.files[0].counts)&&
    Array.isArray(raw.cases)&&raw.cases.length===8&&new Set(raw.cases.map(c=>c.case_sha256)).size===8&&
    raw.cases.every(c=>c.file==='tests/runtime/model-broker-bridge-adversarial.test.ts'&&c.status==='passed'&&/^[a-f0-9]{64}$/.test(c.case_sha256))&&Array.isArray(raw.suites)&&raw.suites.length===0;
  if(!okay)throw Error('broker_bridge_incomplete');
  console.log('broker_bridge_check=pass cases=8 skipped=0 trust=unverified');
} catch(error) {
  console.error(/^broker_bridge_[a-z_]+$/.test(error?.message??'')?error.message:'broker_bridge_unavailable');
} finally { await rm(directory,{recursive:true,force:true}); }
process.exitCode=okay?0:1;
