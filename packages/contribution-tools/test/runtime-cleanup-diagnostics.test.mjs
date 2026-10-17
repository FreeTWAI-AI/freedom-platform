import {spawn, spawnSync} from 'node:child_process';
import {verificationEnvironment} from '../process-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeCleanupDiagnostic} from '../runtime-databases.mjs';

test('cleanup diagnostics retain only reviewed phases, outcomes and stable error codes', () => {
  assert.deepEqual(runtimeCleanupDiagnostic('drop', 'unknown_ack', {code:'57014'}, 16001.9), {
    event:'runtime_database_cleanup', phase:'drop', result:'unknown_ack', code:'57014', elapsed_ms:16001,
  });
  for (const [message, code] of [
    ['Query read timeout','query_read_timeout'], ['Connection terminated unexpectedly','connection_terminated'],
    ['timeout expired','connection_timeout'], ['ownership_mismatch','ownership_mismatch'],
    ['database_backend_unsettled','database_backend_unsettled'], ['database_present','database_present'],
  ]) assert.equal(runtimeCleanupDiagnostic('absence','failed',Error(message), 1).code,code);
  assert.equal(runtimeCleanupDiagnostic('absence','verified_absent',undefined,100).code,'none');
});

test('cleanup diagnostics cannot disclose arbitrary server, SQL, connection or member text', () => {
  const secret='postgresql://private:password@example.invalid/member-secret';
  const value=runtimeCleanupDiagnostic(secret,secret,{code:secret,message:secret,detail:secret,stack:secret,query:secret},Infinity);
  assert.deepEqual(value,{event:'runtime_database_cleanup',phase:'unknown',result:'unverified',code:'unclassified',elapsed_ms:0});
  assert.equal(JSON.stringify(value).includes(secret),false);
  assert.equal(runtimeCleanupDiagnostic('drop','failed',Error('__proto__'),-10).code,'unclassified');
  assert.equal(runtimeCleanupDiagnostic('drop','failed',null,30000).elapsed_ms,20000);
});

// Run the real cleanup control flow with an in-memory pg transport, in a
// subprocess so a closed diagnostic pipe exercises the actual EPIPE behavior.
const childCode = `
const Module=require('node:module');
const oldLoad=Module._load;
const dbs=new Set();let pid=0;
class Client {
 constructor(config) {this.config=config;this.pid=++pid;this.connection={stream:{destroy(){}}};}
 on(){} async connect(){} async end(){}
 async query(q) {
  const text=typeof q==='string'?q:q.text, values=q.values||[];
  if(text.startsWith('SELECT current_database()'))return {rows:[{database:'fp_review',owner:'review',session:'review',pid:this.pid}],rowCount:1};
  if(text.startsWith('SELECT 1 FROM pg_database'))return {rows:[],rowCount:0};
  if(text.startsWith('CREATE DATABASE')){dbs.add(text.match(/^CREATE DATABASE "([^"]+)"/)[1]);return {rows:[],rowCount:0};}
  if(text.startsWith('SELECT pg_get_userbyid'))return {rows:dbs.has(values[0])?[{owner:'review'}]:[],rowCount:dbs.has(values[0])?1:0};
  if(text.startsWith('DROP DATABASE')){if(process.argv[2]!=='retain')dbs.delete(text.match(/^DROP DATABASE "([^"]+)"/)[1]);return {rows:[],rowCount:0};}
  if(text.startsWith('SELECT datname FROM pg_database')){const found=[...dbs].filter(name=>values[0].includes(name));return {rows:found.map(datname=>({datname})),rowCount:found.length};}
  return {rows:[],rowCount:0};
 }
}
Module._load=function(request,...rest){return request==='pg'?{Client}:oldLoad.call(this,request,...rest)};
process.once('message',async()=> {
 if(process.argv[4]==='hang'){setInterval(()=>{},1000);return;}
 let diagnosticAttempted=false,diagnosticEagain=false;
 if(process.argv[3]==='full'){
  // Deliberately initialize the fixture pipe before filling it. The normal
  // scenario leaves stderr untouched until the product writer initializes it.
  process.stderr._handle.setBlocking(false);
  const fs=require('node:fs');
  const flags=/^flags:[ \t]+([0-7]+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/2','utf8'));
  if(!flags||!(Number.parseInt(flags[1],8)&fs.constants.O_NONBLOCK))throw Error('fixture_stderr_not_nonblocking');
  for(let pass=0;pass<2;pass++){
   if(pass)await new Promise(resolve=>setTimeout(resolve,100));
   let saturated=false;
   for(let i=0;i<1024;i++)try{fs.writeSync(2,Buffer.alloc(65536));}catch(error){if(error.code!=='EAGAIN')throw error;saturated=true;break;}
   if(!saturated)throw Error('fixture_stderr_not_saturated');
  }
  const originalWrite=fs.writeSync;
  fs.writeSync=function(fd,chunk,...args){
   if(fd===2&&String(chunk).startsWith('{"event":"runtime_database_cleanup"')){
    diagnosticAttempted=true;
    try{return originalWrite.call(this,fd,chunk,...args);}catch(error){if(error.code==='EAGAIN')diagnosticEagain=true;throw error;}
   }
   return originalWrite.call(this,fd,chunk,...args);
  };
  process.stdout.write('stderr saturated\\n');
  if(process.argv[5]==='blocking'){process.stderr._handle.setBlocking(true);process.stdout.write('stderr blocking\\n');}
 }
 const {createRuntimeDatabases}=await import(process.argv[1]);
 const created=await createRuntimeDatabases('postgresql://review@localhost/fp_review',1);
 process.stdout.write('cleanup result='+await created.cleanup()+' remaining_databases='+dbs.size+'\\n');
 process.stdout.write('diagnostic attempted='+diagnosticAttempted+' eagain='+diagnosticEagain+'\\n');
 process.disconnect();
 setTimeout(()=>process.stdout.write('process remained alive\\n'),50);
});
`;
function runFixture(scenario, signal, budgetMs = 5000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',childCode,new URL('../runtime-databases.mjs',import.meta.url).href,
      scenario.retain?'retain':'drop',scenario.full?'full':'normal',scenario.hang?'hang':'run',scenario.blocking?'blocking':'normal'],
      {env:verificationEnvironment(),stdio:['ignore','pipe','pipe','ipc']});
    let out='',diagnostics='',failure;
    const dispose=()=>{
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
      child.stdout.destroy();child.stderr.destroy();
    };
    const stop=error=>{failure??=error;dispose();};
    const abort=()=>stop(Error('cleanup_fixture_aborted'));
    const timer=setTimeout(()=>stop(Error('cleanup_fixture_deadline')),budgetMs);
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    child.stdout.on('data',chunk=>{out+=chunk;});
    child.on('error',stop);
    child.on('close',(code,exitSignal)=>{
      clearTimeout(timer);signal.removeEventListener('abort',abort);
      try {if(failure)reject(failure);else resolve({code,signal:exitSignal,out,diagnostics});}
      finally {dispose();}
    });
    const run=()=>{if(!failure)child.send('run',error=>{if(error)stop(error);});};
    if(scenario.closed){child.stderr.once('close',run);child.stderr.destroy();}
    else if(scenario.full){child.once('exit',()=>child.stderr.destroy());run();}
    else {child.stderr.on('data',chunk=>{diagnostics+=chunk;});run();}
  });
}
for (const scenario of [
  {closed:false, retain:false}, {closed:true, retain:false}, {closed:true, retain:true},
  {closed:false, retain:false, full:true},
  {closed:false, retain:false, full:true, blocking:true},
]) test(`cleanup remains fail-closed with diagnostic pipe closed=${scenario.closed}, retained=${scenario.retain}, full=${Boolean(scenario.full)}, blocking=${Boolean(scenario.blocking)}`, {timeout:10000}, async t => {
  const result=await runFixture(scenario,t.signal);
  assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.signal,null);
  assert.match(result.out,scenario.retain?/cleanup result=false remaining_databases=1/:/cleanup result=true remaining_databases=0/);
  assert.match(result.out,/process remained alive/);
  if(scenario.full)assert.match(result.out,/stderr saturated/);
  if(scenario.blocking){assert.match(result.out,/stderr blocking/);assert.match(result.out,/diagnostic attempted=false eagain=false/);}
  else if(scenario.full)assert.match(result.out,/diagnostic attempted=true eagain=true/);
  if(!scenario.closed&&!scenario.full){
    const events=result.diagnostics.trim().split('\n').map(line=>JSON.parse(line));
    assert(events.some(event=>event.phase==='absence'&&event.result==='verified_absent'));
    assert.doesNotMatch(result.diagnostics,/fp_suite_|postgresql:|DROP DATABASE|password/);
  }
});

test('a stalled transport child is killed and reaped at the fixture deadline', {timeout:10000}, async t => {
  await assert.rejects(runFixture({hang:true},t.signal,100),/cleanup_fixture_deadline/);
});

test('test cancellation kills and reaps the transport child', {timeout:10000}, async () => {
  const controller=new AbortController();
  const pending=runFixture({hang:true},controller.signal);
  controller.abort();
  await assert.rejects(pending,/cleanup_fixture_aborted/);
});

// Controlled transport/clock evidence, not a reproduction of PostgreSQL I/O.
// Run the actual helper with DROP's ACK lost at 16.057s and a nonce-bound
// cleaner whose termination is delayed beyond pg_terminate_backend's 1s wait.
const settlementCode = String.raw`
const assert=require('node:assert/strict'),Module=require('node:module');
const scenario=process.argv[2],originalLoad=Module._load;
let now=0,pid=0,polls=0,terminations=0,absence=0,database,cleanupApplication;
Object.defineProperty(performance,'now',{value:()=>now});
const realTimeout=setTimeout;
global.setTimeout=(callback,delay,...args)=>{
 if(delay===100){now+=delay;return realTimeout(callback,0,...args);}
 return realTimeout(callback,delay,...args);
};
class Client {
 constructor(config){this.config=config;this.pid=++pid;this.connection={stream:{destroy(){}}};
  if(config.application_name.endsWith('_cleanup'))cleanupApplication=config.application_name;}
 on(){} async connect(){} async end(){}
 async query(q){
  const text=typeof q==='string'?q:q.text,values=q.values||[];
  if(text.startsWith('SELECT current_database()'))return {rows:[{database:'fp_review',owner:'review',session:'review',pid:this.pid}],rowCount:1};
  if(text.startsWith('SELECT 1 FROM pg_database'))return {rows:[],rowCount:0};
  if(text.startsWith('CREATE DATABASE')){database=text.match(/^CREATE DATABASE "([^"]+)"/)[1];return {rows:[],rowCount:0};}
  if(text.startsWith('SELECT pg_get_userbyid'))return {rows:[{owner:'review'}],rowCount:1};
  if(text.startsWith('DROP DATABASE')){now=16057;throw Error('Query read timeout');}
  if(text.includes('FROM pg_stat_activity WHERE pid=$1')){
   assert.match(text,/usename=\$2 AND application_name=\$3$/);
   assert.equal(values[1],'review');
   if(values[0]===1){assert.match(values[2],/^fp_suite_\d+_[a-f0-9]{16}_owner$/);return {rows:[],rowCount:0};}
   assert.equal(values[0],2);assert.equal(values[2],cleanupApplication);
   if(text.startsWith('SELECT pg_terminate_backend')){terminations++;now+=1000;return {rows:[{stopped:false}],rowCount:1};}
   polls++;now+=50;
   const present=scenario==='never'||now<(scenario==='late'?19500:18700);
   return {rows:present?[{}]:[],rowCount:present?1:0};
  }
  if(text.startsWith('SELECT datname FROM pg_database')){
   absence++;assert.deepEqual(values,[[database]]);
   if(scenario==='absence-deadline')now=20001;
   return {rows:scenario==='present'?[{datname:database}]:[],rowCount:scenario==='present'?1:0};
  }
  return {rows:[],rowCount:0};
 }
}
Module._load=function(request,...rest){return request==='pg'?{Client}:originalLoad.call(this,request,...rest)};
(async()=>{const {createRuntimeDatabases}=await import(process.argv[1]);
 const created=await createRuntimeDatabases('postgresql://review@localhost/fp_review',1);
 const verified=await created.cleanup();console.log(JSON.stringify({verified,now,polls,terminations,absence}));
})().catch(()=>{process.exitCode=1;});
`;
for (const scenario of ['delayed', 'never', 'present', 'late', 'absence-deadline']) {
  test(`nonce cleaner settlement ${scenario} preserves the absolute deadline and positive absence proof`, () => {
    const child=spawnSync(process.execPath,['-e',settlementCode,new URL('../runtime-databases.mjs',import.meta.url).href,scenario],
      {env:verificationEnvironment(),encoding:'utf8',timeout:5000});
    assert.equal(child.status,0,child.stderr);
    const result=JSON.parse(child.stdout);
    assert.equal(result.verified,scenario==='delayed',JSON.stringify(result));
    assert.equal(result.terminations,1,'poll settlement; never resend termination');
    assert.ok(result.polls>1,JSON.stringify(result));
    assert.equal(result.absence,['never','late'].includes(scenario)?0:1,JSON.stringify(result));
    assert.ok(result.now <= (scenario==='absence-deadline'?20001:20000),JSON.stringify(result));
    if(scenario==='delayed')assert.ok(result.now>=18700&&result.now<19000);
    assert.doesNotMatch(child.stderr,/fp_suite_|postgresql:|DROP DATABASE/);
  });
}
