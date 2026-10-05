import {createFailureDiagnosticDecoder,createFailureDiagnosticEmitter,createIngestBrowserDiagnostic} from '../test-failure-diagnostic.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile,symlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createProgressDecoder} from '../test-reporter.mjs';
import {sha256} from '../io.mjs';
import {verificationEnvironment} from '../process-env.mjs';
import {fixtureRoot,put} from './fixtures.mjs';
const reporter=fileURLToPath(new URL('../test-reporter.mjs',import.meta.url));
const source="import{test}from'node:test';test('PRIVATE_CASE_NAME',()=>{console.log('PRIVATE_STDOUT');console.error('PRIVATE_STDERR');});\n";
async function nodeRun(root,files,{config=files,killOnStart,failureDetail=false,runtimeLoader=false}={}){
 const child=spawn(process.execPath,[...(runtimeLoader?['--import',createRequire(import.meta.url).resolve('tsx')]:[]),'--test','--test-concurrency=1','--test-reporter='+reporter,...files],{cwd:root,detached:process.platform!=='win32',env:{...verificationEnvironment(),PRIVATE_ENV:'PRIVATE_ENV_VALUE',FREEDOM_TEST_PROGRESS_FILES:JSON.stringify(config)},stdio:['ignore','pipe','pipe','pipe',...(failureDetail?['pipe']:[])]});
 let output='',stderr='',progress='',failureDiagnostic='';if(failureDetail)child.stdio[4].on('data',b=>{failureDiagnostic+=b;if(killOnStart&&progress.includes(killOnStart))kill();});const kill=()=>{try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}};
 const timer=setTimeout(kill,5000);child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);child.stdio[3].on('data',b=>{progress+=b;if(killOnStart&&(!failureDetail||failureDiagnostic.includes('\n'))&&progress.split('\n').filter(Boolean).some(line=>{try{const r=JSON.parse(line);return r.event==='started'&&r.path===killOnStart;}catch{return false;}}))kill();});
 const result=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({code,signal}));});clearTimeout(timer);return {...result,output,stderr,progress,failureDiagnostic};
}
test('real Node file progress is source-digest pinned, count-only and separate from unchanged final JSON',async t=>{
 const root=await fixtureRoot(t),files=['tests/first.test.mjs','tests/second.test.mjs'];await put(root,files[0],source);await put(root,files[1],"import{test}from'node:test';test('PRIVATE_FAILURE',()=>{throw Error('https://PRIVATE_URL/?token=PRIVATE_ENV_VALUE');});test.skip('PRIVATE_SKIP',()=>{});\n");
 const ran=await nodeRun(root,files);assert.equal(ran.code,1);const final=JSON.parse(ran.output);assert.equal(final.counts.failed,1);assert.equal(final.counts.skipped,1);assert.deepEqual(Object.keys(final).sort(),['cases','counts','files','success','suites']);
 const records=ran.progress.trim().split('\n').map(JSON.parse);assert.equal(records.length,5);assert.deepEqual(records.filter(r=>r.event!=='failed_case').map(r=>[r.event,r.path]),[['started',files[0]],['completed',files[0]],['started',files[1]],['completed',files[1]]]);
 for(const r of records){assert.equal(r.source_sha256,sha256(await readFile(join(root,r.path))));assert.ok(Number.isSafeInteger(r.elapsed_ms));assert.ok(r.elapsed_ms>=0);}
 assert.equal(records[4].counts.failed,1);assert.equal(records[4].counts.skipped,1);
 const failure=records[3];assert.equal(failure.event,'failed_case');assert.equal(failure.failure_type,'testCodeFailure');assert.equal(failure.source_line,1);assert.equal(failure.case_sha256,final.cases.find(c=>c.status==='failed').case_sha256);assert.ok(!JSON.stringify(ran).includes('PRIVATE_'));
 const accepted=[],decoder=createProgressDecoder(await Promise.all(files.map(async path=>({path,source_sha256:sha256(await readFile(join(root,path))),source_lines:(await readFile(join(root,path),'utf8')).split('\n').length}))),r=>accepted.push(r));decoder.push(Buffer.from(ran.progress));assert.equal(accepted.length,5);assert.equal(decoder.finish().incomplete,false);
});
test('real Node termination retains completed/active file diagnostics while final report stays absent',async t=>{
 const root=await fixtureRoot(t),files=['tests/done.test.mjs','tests/hang.test.mjs'];await put(root,files[0],source);await put(root,files[1],"import{test}from'node:test';test('PRIVATE_HANG',async()=>{await new Promise(()=>{});});setInterval(()=>{},1000);\n");
 const ran=await nodeRun(root,files,{killOnStart:files[1]});assert.notEqual(ran.code,0);assert.equal(ran.output,'');const records=ran.progress.trim().split('\n').map(JSON.parse);assert.deepEqual(records.map(r=>[r.event,r.path]),[['started',files[0]],['completed',files[0]],['started',files[1]]]);assert.ok(!JSON.stringify(ran).includes('PRIVATE_'));
});
test('invalid, duplicate, traversal and symlink progress selections produce no diagnostics or private fragments',async t=>{
 const root=await fixtureRoot(t),file='tests/one.test.mjs';await put(root,file,source);await symlink(join(root,file),join(root,'tests/link.test.mjs'));
 for(const config of [[file,file],['../PRIVATE_PATH.test.mjs'],['/PRIVATE_PATH.test.mjs'],['tests/link.test.mjs'],{PRIVATE_KEY:'PRIVATE_ENV'}]){const ran=await nodeRun(root,[file],{config});assert.equal(ran.code,0);assert.equal(ran.progress,'');assert.ok(!JSON.stringify(ran).includes('PRIVATE_'));}
});
test('parent discards malformed, unexpected, duplicate, digest mismatch and unbounded records without forwarding raw bytes',()=>{
 const path='tests/one.test.mjs',digest='a'.repeat(64),start={schema:'freedom.test-file-progress/v1',event:'started',path,source_sha256:digest,elapsed_ms:1};
 const bad=[{...start,path:'tests/PRIVATE_UNKNOWN.test.mjs'},{...start,source_sha256:'b'.repeat(64)},{...start,PRIVATE_EXTRA:'postgres://PRIVATE_URL'},{...start,elapsed_ms:-1},{...start,event:'completed',counts:{tests:1,passed:0,failed:0,cancelled:0,skipped:0,todo:0,suites:0}}];
 for(const r of bad){const out=[],d=createProgressDecoder([{path,source_sha256:digest}],r=>out.push(r));if(r.event==='completed')d.push(Buffer.from(JSON.stringify(start)+'\n'));d.push(Buffer.from(JSON.stringify(r)+'\n'));assert.equal(out.length,r.event==='completed'?1:0);assert.equal(d.finish().incomplete,true);}
 const out=[],d=createProgressDecoder([{path,source_sha256:digest}],r=>out.push(r));const line=Buffer.from(JSON.stringify(start)+'\n');d.push(line.subarray(0,7));d.push(line.subarray(7));d.push(line);d.push(Buffer.from('PRIVATE_RAW_INVALID_JSON\n'));d.push(Buffer.alloc(1_048_577,65));assert.equal(out.length,1);assert.equal(d.finish().incomplete,true);assert.ok(!JSON.stringify(out).includes('PRIVATE_'));
});
test('actual host timeout keeps sanitized completion/active progress off the failed final verifier JSON',async t=>{
 const root=await fixtureRoot(t),files=['packages/contribution-tools/test/a.test.mjs','packages/contribution-tools/test/b.test.mjs'];await put(root,files[0],source);await put(root,files[1],"import{test}from'node:test';test('PRIVATE_HANG',async()=>{await new Promise(()=>{});});setInterval(()=>{},1000);\n");
 const verify=new URL('../verify.mjs',import.meta.url).href;
 const program=`import{runLocalSuite}from ${JSON.stringify(verify)};process.stdout.write(JSON.stringify(await runLocalSuite(${JSON.stringify(root)},'governance.unit',{timeoutMs:1000})));`;
 const child=spawn(process.execPath,['--input-type=module','--eval',program],{cwd:root,env:verificationEnvironment(),stdio:['ignore','pipe','pipe']});let output='',diagnostics='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>diagnostics+=b);const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});assert.equal(code,0);
 const result=JSON.parse(output);assert.equal(result.status,'failed');assert.equal(result.reason,'test_timeout');assert.equal(result.test_count,undefined);assert.equal(result.progress,undefined);assert.ok(!JSON.stringify(result).includes('completed_count'));
 const records=diagnostics.trim().split('\n').map(line=>{assert.ok(line.startsWith('freedom.test-progress '));return JSON.parse(line.slice('freedom.test-progress '.length));});const summary=records.pop();assert.equal(summary.schema,'freedom.test-file-progress-summary/v1');assert.equal(summary.completed_count,1);assert.equal(summary.incomplete,true);assert.deepEqual(records.map(r=>[r.event,r.path]),[['started',files[0]],['completed',files[0]],['started',files[1]]]);assert.ok(!diagnostics.includes('PRIVATE_'));assert.ok(!output.includes('PRIVATE_'));
});

test('failure admission rejects unselected or invalid source lines, classifications, fields and duplicate case identities',()=>{
 const path='tests/one.test.mjs',digest='a'.repeat(64),start={schema:'freedom.test-file-progress/v1',event:'started',path,source_sha256:digest,elapsed_ms:1};
 const failure={...start,event:'failed_case',case_sha256:'b'.repeat(64),failure_type:'hookFailed',source_line:2};
 const bad=[{...failure,source_line:0},{...failure,source_line:4},{...failure,source_line:1.5},{...failure,path:'tests/PRIVATE_UNKNOWN.test.mjs'},{...failure,failure_type:'PRIVATE_ERROR'},{...failure,stack:'PRIVATE_STACK'},{...failure,case_sha256:'b'.repeat(64)+'\n'}];
 for(const record of bad){const out=[],d=createProgressDecoder([{path,source_sha256:digest,source_lines:3}],r=>out.push(r));d.push(Buffer.from(JSON.stringify(start)+'\n'+JSON.stringify(record)+'\n'));assert.equal(out.length,1);assert.equal(d.finish().incomplete,true);assert.ok(!JSON.stringify(out).includes('PRIVATE_'));}
 const out=[],d=createProgressDecoder([{path,source_sha256:digest,source_lines:3}],r=>out.push(r));
 d.push(Buffer.from([start,failure,failure].map(JSON.stringify).join('\n')+'\n'));assert.equal(out.length,2);assert.deepEqual(out[1],failure);assert.equal(d.finish().incomplete,true);
 const absent=[];const noLines=createProgressDecoder([{path,source_sha256:digest}],r=>absent.push(r));const {source_line,...withoutLine}=failure;
 noLines.push(Buffer.from([start,withoutLine].map(JSON.stringify).join('\n')+'\n'));assert.equal(absent.length,2);assert.equal(absent[1].source_line,undefined);
});
test('real before-hook failure retains finite hook classification and declaration location without private cause',async t=>{
 const root=await fixtureRoot(t),file='tests/hook.test.mjs';await put(root,file,"import{before,test}from'node:test';\nbefore(()=>{throw Error('PRIVATE_HOOK https://private/?token=PRIVATE_SECRET');});\ntest('PRIVATE_CASE',()=>{});\n");
 const ran=await nodeRun(root,[file]);assert.equal(ran.code,1);const final=JSON.parse(ran.output),failure=ran.progress.trim().split('\n').map(JSON.parse).find(r=>r.event==='failed_case');
 assert.equal(failure.failure_type,'hookFailed');assert.equal(failure.source_line,3);assert.equal(failure.case_sha256,final.cases[0].case_sha256);assert.ok(!JSON.stringify(ran).includes('PRIVATE_'));
});
test('failure diagnostics cap at64 independently of final case evidence and mark truncation incomplete',async t=>{
 const root=await fixtureRoot(t),file='tests/many.test.mjs';await put(root,file,"import{test}from'node:test';for(let n=0;n<65;n++)test('PRIVATE_'+n,()=>{throw Error('PRIVATE_SECRET');});\n");
 const ran=await nodeRun(root,[file]);assert.equal(ran.code,1);const final=JSON.parse(ran.output);assert.equal(final.counts.failed,65);assert.equal(final.cases.length,65);
 const records=ran.progress.trim().split('\n').map(JSON.parse);assert.equal(records.filter(r=>r.event==='failed_case').length,64);assert.equal(records.at(-1).event,'completed');
 const out=[],d=createProgressDecoder([{path:file,source_sha256:sha256(await readFile(join(root,file))),source_lines:2}],r=>out.push(r));d.push(Buffer.from(ran.progress));assert.equal(out.length,66);assert.equal(d.finish().incomplete,true);assert.ok(!JSON.stringify(ran).includes('PRIVATE_'));
});
test('failed-case diagnostics survive a later hung file without manufacturing final evidence',async t=>{
 const root=await fixtureRoot(t),files=['tests/failed.test.mjs','tests/hang.test.mjs'];
 await put(root,files[0],"import{test}from'node:test';test('PRIVATE_NAME',()=>{throw Error('PRIVATE_TOKEN https://private/');});\n");
 await put(root,files[1],"import{test}from'node:test';test('PRIVATE_HANG',()=>new Promise(()=>{}));setInterval(()=>{},1000);\n");
 const ran=await nodeRun(root,files,{killOnStart:files[1]});assert.notEqual(ran.code,0);assert.equal(ran.output,'');
 const records=ran.progress.trim().split('\n').map(JSON.parse),failed=records.filter(r=>r.event==='failed_case');
 assert.equal(failed.length,1);assert.equal(failed[0].path,files[0]);assert.equal(failed[0].failure_type,'testCodeFailure');assert.equal(failed[0].source_line,1);
 const accepted=[],d=createProgressDecoder(await Promise.all(files.map(async path=>({path,source_sha256:sha256(await readFile(join(root,path))),source_lines:2}))),r=>accepted.push(r));
 d.push(Buffer.from(ran.progress));assert.equal(accepted.filter(r=>r.event==='failed_case').length,1);assert.equal(d.finish().incomplete,true);assert.ok(!JSON.stringify(ran).includes('PRIVATE_'));
});

test('actual selected fail events expose only finite source classifications and numeric/Boolean comparisons on FD4',async t=>{
 const root=await fixtureRoot(t),files=['tests/runtime/model-broker-bridge-adversarial.test.ts','tests/runtime/media-verify.test.ts'];
 await put(root,files[0],"import{test}from'node:test';import assert from'node:assert/strict';test('PRIVATE_NAME',()=>assert.fail('Actual SQL wait was not observed'));test('PRIVATE_EXPIRY',()=>{const expires=0;assert(expires>Date.now())});test('PRIVATE_FETCH',()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('PRIVATE_BODY'),{code:'UND_ERR_SOCKET'})})});\n");
 await put(root,files[1],"import{test}from'node:test';import assert from'node:assert/strict';test('PRIVATE_READ',()=>assert.ok(false,'actual asset read must reach the trusted port before deadline'));test('PRIVATE_CANCEL',()=>assert.equal(false,true));test('PRIVATE_COUNT',()=>assert.equal(8,7));test('PRIVATE_ERROR',()=>{throw new Error('PRIVATE_ENV_VALUE https://private.example/requestbody')});test('PRIVATE_OBJECT',()=>assert.deepEqual({token:'PRIVATE_ENV_VALUE'},{body:'PRIVATE_BODY'}));\n");
 const ran=await nodeRun(root,files,{failureDetail:true});assert.equal(ran.code,1);assert.equal(JSON.parse(ran.output).counts.failed,8);
 const expected=await Promise.all(files.map(async path=>({path,source_sha256:sha256(await readFile(join(root,path))),source_lines:2}))),records=[],decoder=createFailureDiagnosticDecoder(expected,r=>records.push(r));decoder.push(Buffer.from(ran.failureDiagnostic));assert.equal(records.length,8);
 assert(records.some(r=>r.detail.message_class==='sql_wait_not_observed'));assert(records.some(r=>r.detail.message_class==='asset_read_not_reached'));assert(records.some(r=>r.detail.message_class==='expiry_assertion'));assert(records.some(r=>r.detail.cause_code==='UND_ERR_SOCKET'));assert(records.some(r=>r.detail.comparison?.actual===false&&r.detail.comparison.expected===true));assert(records.some(r=>r.detail.comparison?.actual===8&&r.detail.comparison.expected===7));
 const primary=JSON.parse(ran.output);assert(records.every(r=>primary.cases.some(c=>c.case_sha256===r.case_sha256&&c.status==='failed')));assert.ok(!JSON.stringify(ran).includes('PRIVATE_'));assert.ok(!ran.failureDiagnostic.includes('https:'));assert.ok(!ran.output.includes('failure-diagnostic'));
});

test('FD4 admission rejects foreign paths, hashes, source lines, raw fields and nonfinite comparisons',()=>{
 const path='tests/runtime/media-verify.test.ts',source_sha256='a'.repeat(64),record={schema:'freedom.test-failure-diagnostic/v1',path,source_sha256,case_sha256:'b'.repeat(64),source_line:2,detail:{error_name:'AssertionError',error_code:'ERR_ASSERTION',message_class:'assertion_failed',comparison:{actual:8,expected:7}}};
 const invalid=[{...record,path:'tests/runtime/other.test.ts'},{...record,source_sha256:'c'.repeat(64)},{...record,source_line:3},{...record,source_line:1.5},{...record,stack:'PRIVATE'},{...record,detail:{...record.detail,message:'PRIVATE'}},{...record,detail:{...record.detail,comparison:{actual:{token:'PRIVATE'},expected:7}}},{...record,detail:{...record.detail,cause_code:'PRIVATE'}},{...record,detail:{...record.detail,comparison:{actual:20001,expected:7}}}];
 for(const r of invalid){const emitted=[],decoder=createFailureDiagnosticDecoder([{path,source_sha256,source_lines:2}],x=>emitted.push(x));decoder.push(Buffer.from(JSON.stringify(r)+'\n'));assert.equal(emitted.length,0);}
 const emitted=[],decoder=createFailureDiagnosticDecoder([{path,source_sha256,source_lines:2}],x=>emitted.push(x));decoder.push(Buffer.from(JSON.stringify(record)+'\n'+JSON.stringify(record)+'\n'));assert.deepEqual(emitted,[record]);
 const capped=[],limit=createFailureDiagnosticDecoder([{path,source_sha256,source_lines:2}],x=>capped.push(x));limit.push(Buffer.from(Array.from({length:65},(_,i)=>JSON.stringify({...record,case_sha256:i.toString(16).padStart(64,'0')})).join('\n')+'\n'));assert.equal(capped.length,64);
 const exhausted=[],bytes=createFailureDiagnosticDecoder([{path,source_sha256,source_lines:2}],x=>exhausted.push(x));bytes.push(Buffer.alloc(262145,65));bytes.push(Buffer.from(JSON.stringify(record)+'\n'));assert.equal(exhausted.length,0);
});

test('unselected failure details stay absent and closed final report is byte identical when FD4 is unavailable',async t=>{
 const root=await fixtureRoot(t),file='tests/other.test.mjs';await put(root,file,"import{test}from'node:test';test('PRIVATE_NAME',()=>{throw Error('PRIVATE_BODY')});\n");
 const absent=await nodeRun(root,[file]),enabled=await nodeRun(root,[file],{failureDetail:true});assert.equal(absent.code,1);assert.equal(enabled.code,1);assert.equal(absent.output,enabled.output);assert.equal(enabled.failureDiagnostic,'');
});

test('FD4 failures survive a later hung selected file and cap without reducing final case evidence',async t=>{
 const root=await fixtureRoot(t),files=['tests/runtime/media-verify.test.ts','tests/runtime/model-broker-bridge-adversarial.test.ts'];
 await put(root,files[0],"import{test}from'node:test';import assert from'node:assert/strict';test('PRIVATE_FAIL',()=>assert.fail('Actual SQL wait was not observed'));\n");
 await put(root,files[1],"import{test}from'node:test';test('PRIVATE_HANG',async()=>new Promise(()=>{setInterval(()=>{},1000)}));\n");
 const killed=await nodeRun(root,files,{failureDetail:true,killOnStart:files[1]});assert.notEqual(killed.code,0);assert.equal(killed.output,'');const retained=killed.failureDiagnostic.trim().split('\n').map(JSON.parse);assert.equal(retained.length,1);assert.equal(retained[0].detail.message_class,'sql_wait_not_observed');
 await put(root,files[0],"import{test}from'node:test';import assert from'node:assert/strict';"+Array.from({length:65},(_,i)=>`test('PRIVATE_${i}',()=>assert.equal(8,7));`).join('')+'\n');
 const capped=await nodeRun(root,[files[0]],{failureDetail:true});assert.equal(capped.code,1);assert.equal(JSON.parse(capped.output).counts.failed,65);assert.equal(capped.failureDiagnostic.trim().split('\n').length,64);
 const absent=await nodeRun(root,[files[0]]);assert.equal(absent.output,capped.output);
});


test('ingest process failures expose bounded classes without private response bodies, SQL errors or state strings',async t=>{
 const root=await fixtureRoot(t),files=['tests/runtime/credential-ingest-process.test.ts','tests/runtime/credential-ingest-adversarial.test.ts','tests/runtime/member-model-settings-process.test.ts'];
 for(const path of files)await put(root,path,"import{test}from'node:test';import assert from'node:assert/strict';\n"+
  "test('PRIVATE_INGEST_EXECUTE',()=>{\nassert.equal(503,200,JSON.stringify({body:'PRIVATE_RESPONSE',sqlErrors:['PRIVATE_SQL']}));});\n"+
  "test('PRIVATE_INGEST_COMMIT',()=>assert.equal('PRIVATE_STATE','committed',JSON.stringify({broker:'PRIVATE_KEY',status:'PRIVATE_STATUS'})));\n"+
  "test('PRIVATE_BROWSER',()=>{throw Error('PRIVATE_BROWSER_PATH PRIVATE_ENV_VALUE https://private.example')});\n");
 const ran=await nodeRun(root,files,{failureDetail:true,runtimeLoader:true});assert.equal(ran.code,1);
 const sources=await Promise.all(files.map(async path=>({path,source_sha256:sha256(await readFile(join(root,path))),source_lines:6}))),records=[];
 createFailureDiagnosticDecoder(sources,r=>records.push(r)).push(Buffer.from(ran.failureDiagnostic));
 assert.equal(records.length,9);
 for(const path of files){const selected=records.filter(r=>r.path===path);assert.deepEqual(selected.map(r=>r.source_line),[3,4,5]);
 assert.deepEqual(selected.map(r=>r.detail.message_class),['assertion_failed','custody_outcome_unconfirmed','unknown']);
 assert.deepEqual(selected[0].detail.comparison,{actual:503,expected:200});
 assert.equal(selected[1].detail.comparison,undefined);assert.equal(selected[2].detail.comparison,undefined);}
 const primary=JSON.parse(ran.output);assert.equal(primary.counts.failed,9);
 assert(records.every(r=>primary.cases.some(c=>c.case_sha256===r.case_sha256&&c.status==='failed')));
 for(const secret of ['PRIVATE_','committed','https://','sqlErrors','broker','stack'])assert(!ran.failureDiagnostic.includes(secret));
 const absent=await nodeRun(root,files,{runtimeLoader:true});assert.equal(absent.output,ran.output,'optional diagnostics do not change verdict evidence');
});


test('diagnostic stack locations accept only bounded exact same-file frames and never emit raw stack',()=>{
 const path='tests/runtime/credential-ingest-process.test.ts',source={path,source_sha256:'a'.repeat(64),source_lines:20};
 const absolute=join(process.cwd(),path);
 for(const stack of [
  `PRIVATE\n    at fn (/private/other.test.ts:7:1)`,
  `PRIVATE\n    at fn (${absolute}:21:1)`,
  `PRIVATE\n    at fn (${absolute}.extra:7:1)`,
  `PRIVATE ${absolute}:7:1`,
  'PRIVATE'.repeat(2000),
 ]) {
  const rows=[],emit=createFailureDiagnosticEmitter([source],line=>rows.push(JSON.parse(line)),()=> 'b'.repeat(64));
  emit({type:'test:fail',data:{file:absolute,line:2,details:{type:'test',error:{name:'Error',message:'PRIVATE',stack}}}});
  assert.equal(rows[0].source_line,2);assert(!JSON.stringify(rows).includes('PRIVATE'));assert(!JSON.stringify(rows).includes(absolute));
 }
});


test('ingest fixed classifications admit no private state, timeout message or SQL context',()=>{
 const path='tests/runtime/credential-ingest-process.test.ts',source={path,source_sha256:'a'.repeat(64),source_lines:20};
 for(const [error,expected] of [
  [{name:'AssertionError',code:'ERR_ASSERTION',expected:'committed',actual:'PRIVATE_STATE',message:'PRIVATE_SQL_AND_BROKER_BODY'},'custody_outcome_unconfirmed'],
  [{name:'TimeoutError',message:'PRIVATE_BROWSER_URL_AND_SELECTOR'},'operation_timeout'],
  [{name:'Error',message:'PRIVATE_WRAPPER',cause:{name:'TimeoutError',message:'PRIVATE_BROWSER_URL_AND_SELECTOR'}},'operation_timeout'],
  [{name:'AssertionError',code:'ERR_ASSERTION',message:'Actual SQL wait not observed'},'sql_wait_not_observed'],
 ]) {
  const lines=[],emit=createFailureDiagnosticEmitter([source],line=>lines.push(line),()=> 'b'.repeat(64));
  emit({type:'test:fail',data:{file:join(process.cwd(),path),line:2,details:{type:'test',error}}});
  const decoded=[];createFailureDiagnosticDecoder([source],r=>decoded.push(r)).push(Buffer.from(lines.join('')));
  assert.equal(decoded.length,1);assert.equal(decoded[0].detail.message_class,expected);
  assert.equal(decoded[0].detail.comparison,undefined);assert(!JSON.stringify(decoded).includes('PRIVATE'));assert(!JSON.stringify(decoded).includes('committed'));
  const rejected=[];const tampered={...decoded[0],detail:{...decoded[0].detail,message_class:'PRIVATE_CUSTOM_CLASS'}};
  createFailureDiagnosticDecoder([source],r=>rejected.push(r)).push(Buffer.from(JSON.stringify(tampered)+'\n'));assert.deepEqual(rejected,[]);
 }
});

test('actual Node preserves bounded ingest annotation and TimeoutError through FD4 without raw content',async t=>{
 const root=await fixtureRoot(t),path='tests/runtime/credential-ingest-rate-budget.test.ts';
 const module=new URL('../test-failure-diagnostic.mjs',import.meta.url).href;
 await put(root,path,`import{test}from'node:test';import{createIngestBrowserDiagnostic}from ${JSON.stringify(module)};test('PRIVATE_CASE',()=>{const d=createIngestBrowserDiagnostic();d.phase('ack_wait');d.observe('prepare','response',200);d.observe('secret','failed');d.custody('one_active');const e=Error('PRIVATE_KEY_URL_BODY_COOKIE');e.name='TimeoutError';throw d.annotate(e);});\n`);
 const ran=await nodeRun(root,[path],{failureDetail:true,runtimeLoader:true});assert.equal(ran.code,1);
 const records=ran.failureDiagnostic.trim().split('\n').map(JSON.parse);assert.equal(records.length,1);
 assert.deepEqual(records[0].detail.ingest,{phase:'ack_wait',prepare_state:'response',prepare_status:200,secret_state:'failed',secret_status:null,custody:'one_active'});
 assert.equal(records[0].detail.message_class,'operation_timeout');assert(!JSON.stringify(ran).includes('PRIVATE_'));
 const accepted=[],sources=[{path,source_sha256:sha256(await readFile(join(root,path))),source_lines:2}];createFailureDiagnosticDecoder(sources,r=>accepted.push(r)).push(Buffer.from(ran.failureDiagnostic));assert.deepEqual(accepted,records);
 const without=await nodeRun(root,[path],{runtimeLoader:true});assert.equal(without.output,ran.output);
 for(const patch of [{phase:'PRIVATE_PHASE'},{prepare_status:600},{secret_status:'PRIVATE_STATUS'},{custody:'PRIVATE_STATE'},{key:'PRIVATE_KEY'}]){
  const out=[],r={...records[0],detail:{...records[0].detail,ingest:{...records[0].detail.ingest,...patch}}};createFailureDiagnosticDecoder(sources,v=>out.push(v)).push(Buffer.from(JSON.stringify(r)+'\n'));assert.equal(out.length,0);
 }
});
test('ingest annotation preserves original error identity and ignores unbounded raw inputs',()=>{
 const d=createIngestBrowserDiagnostic(),error=new Error('PRIVATE_BODY');error.name='TimeoutError';
 d.phase('PRIVATE_URL');d.observe('secret','response',Infinity);d.observe('PRIVATE_PATH','failed');d.custody('PRIVATE_SQL');
 assert.equal(d.annotate(error),error);assert.equal(error.name,'TimeoutError');assert.deepEqual(error.freedom_ingest,{phase:'browser_context',prepare_state:'not_seen',prepare_status:null,secret_state:'not_seen',secret_status:null,custody:'not_checked'});
 assert(!JSON.stringify(error.freedom_ingest).includes('PRIVATE_'));
});
