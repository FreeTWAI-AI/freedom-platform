import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,symlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createProgressDecoder} from '../test-reporter.mjs';
import {sha256} from '../io.mjs';
import {verificationEnvironment} from '../process-env.mjs';
import {fixtureRoot,put} from './fixtures.mjs';
const reporter=fileURLToPath(new URL('../test-reporter.mjs',import.meta.url));
const source="import{test}from'node:test';test('PRIVATE_CASE_NAME',()=>{console.log('PRIVATE_STDOUT');console.error('PRIVATE_STDERR');});\n";
async function nodeRun(root,files,{config=files,killOnStart}={}){
 const child=spawn(process.execPath,['--test','--test-concurrency=1','--test-reporter='+reporter,...files],{cwd:root,detached:process.platform!=='win32',env:{...verificationEnvironment(),PRIVATE_ENV:'PRIVATE_ENV_VALUE',FREEDOM_TEST_PROGRESS_FILES:JSON.stringify(config)},stdio:['ignore','pipe','pipe','pipe']});
 let output='',stderr='',progress='';const kill=()=>{try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}};
 const timer=setTimeout(kill,5000);child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);child.stdio[3].on('data',b=>{progress+=b;if(killOnStart&&progress.split('\n').filter(Boolean).some(line=>{try{const r=JSON.parse(line);return r.event==='started'&&r.path===killOnStart;}catch{return false;}}))kill();});
 const result=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({code,signal}));});clearTimeout(timer);return {...result,output,stderr,progress};
}
test('real Node file progress is source-digest pinned, count-only and separate from unchanged final JSON',async t=>{
 const root=await fixtureRoot(t),files=['tests/first.test.mjs','tests/second.test.mjs'];await put(root,files[0],source);await put(root,files[1],"import{test}from'node:test';test('PRIVATE_FAILURE',()=>{throw Error('https://PRIVATE_URL/?token=PRIVATE_ENV_VALUE');});test.skip('PRIVATE_SKIP',()=>{});\n");
 const ran=await nodeRun(root,files);assert.equal(ran.code,1);const final=JSON.parse(ran.output);assert.equal(final.counts.failed,1);assert.equal(final.counts.skipped,1);assert.deepEqual(Object.keys(final).sort(),['cases','counts','files','success','suites']);
 const records=ran.progress.trim().split('\n').map(JSON.parse);assert.equal(records.length,4);assert.deepEqual(records.map(r=>[r.event,r.path]),[['started',files[0]],['completed',files[0]],['started',files[1]],['completed',files[1]]]);
 for(const r of records){assert.equal(r.source_sha256,sha256(await readFile(join(root,r.path))));assert.ok(Number.isSafeInteger(r.elapsed_ms));assert.ok(r.elapsed_ms>=0);}
 assert.equal(records[3].counts.failed,1);assert.equal(records[3].counts.skipped,1);assert.ok(!JSON.stringify(ran).includes('PRIVATE_'));
 const accepted=[],decoder=createProgressDecoder(await Promise.all(files.map(async path=>({path,source_sha256:sha256(await readFile(join(root,path)))}))),r=>accepted.push(r));decoder.push(Buffer.from(ran.progress));assert.equal(accepted.length,4);assert.equal(decoder.finish().incomplete,false);
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
