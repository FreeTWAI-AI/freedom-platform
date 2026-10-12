import {spawn} from 'node:child_process';
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
 if(process.argv[3]==='full'){
  const fs=require('node:fs');let saturated=false;
  for(let i=0;i<1024;i++)try{fs.writeSync(2,Buffer.alloc(65536));}catch(error){if(error.code!=='EAGAIN')throw error;saturated=true;break;}
  if(!saturated)throw Error('fixture_stderr_not_saturated');
  process.stdout.write('stderr saturated\\n');
 }
 const {createRuntimeDatabases}=await import(process.argv[1]);
 const created=await createRuntimeDatabases('postgresql://review@localhost/fp_review',1);
 process.stdout.write('cleanup result='+await created.cleanup()+' remaining_databases='+dbs.size+'\\n');
 process.disconnect();
 setTimeout(()=>process.stdout.write('process remained alive\\n'),50);
});
`;
for (const scenario of [
  {closed:false, retain:false}, {closed:true, retain:false}, {closed:true, retain:true},
  {closed:false, retain:false, full:true},
]) test(`cleanup remains fail-closed with diagnostic pipe closed=${scenario.closed}, retained=${scenario.retain}, full=${Boolean(scenario.full)}`, {timeout:10000}, async () => {
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',childCode,new URL('../runtime-databases.mjs',import.meta.url).href,scenario.retain?'retain':'drop',scenario.full?'full':'normal'],
      {stdio:['ignore','pipe','pipe','ipc']});
    let out='',diagnostics='';
    child.stdout.on('data',chunk=>{out+=chunk;});
    child.on('error',reject);
    child.on('close',(code,signal)=>resolve({code,signal,out,diagnostics}));
    if(scenario.closed){child.stderr.once('close',()=>child.send('run'));child.stderr.destroy();}
    else if(scenario.full){child.once('exit',()=>child.stderr.destroy());child.send('run');}
    else {child.stderr.on('data',chunk=>{diagnostics+=chunk;});child.send('run');}
  });
  assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.signal,null);
  assert.match(result.out,scenario.retain?/cleanup result=false remaining_databases=1/:/cleanup result=true remaining_databases=0/);
  assert.match(result.out,/process remained alive/);
  if(scenario.full)assert.match(result.out,/stderr saturated/);
  if(!scenario.closed&&!scenario.full){
    const events=result.diagnostics.trim().split('\n').map(line=>JSON.parse(line));
    assert(events.some(event=>event.phase==='absence'&&event.result==='verified_absent'));
    assert.doesNotMatch(result.diagnostics,/fp_suite_|postgresql:|DROP DATABASE|password/);
  }
});
