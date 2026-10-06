import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installedConsumerInput, verifyNativeConsumerSource } from '../../packages/contribution-tools/github-consumer-host.mjs';
import { verifyNativeConsumerRuntime } from '../../packages/contribution-tools/github-consumer-runtime-host.mjs';
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
const candidateRoot=process.env.FREEDOM_KIT_CANDIDATE_ROOT,sourceRoot=process.env.FREEDOM_CONSUMER_SOURCE_ROOT;
const current=process.env.FREEDOM_KIT_CANDIDATE_SHA,expectedWorkflowCommit=process.env.FREEDOM_CONSUMER_WORKFLOW_SHA;
const previous='b2227bc36a571084f6c3d5c5ab340ed4485c6738', legacySource='91b943ac61e132fbbce72ea066cb2301aa065600';
if(process.env.FREEDOM_RUN_KIT_DEVICE_RUNTIME!=='1'||![candidateRoot,sourceRoot].every(v=>typeof v==='string'&&isAbsolute(v))
 ||![current,expectedWorkflowCommit].every(v=>/^[a-f0-9]{40}$/.test(v)))throw Error('Explicit full clones and exact commits required');
const repository='FreeTWAI-AI/freedom-agent-kit',identity={repository,candidateRoot,sourceRoot,expectedWorkflowCommit};
const git=(cwd,args)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',timeout:30000,
 env:{...verificationEnvironment(),GIT_AUTHOR_NAME:'Synthetic',GIT_COMMITTER_NAME:'Synthetic',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},stdio:['ignore','pipe','pipe']}).trim();
const script=fileURLToPath(new URL('../../packages/contribution-tools/github-consumer-host.mjs',import.meta.url));
function native(root,sha){return spawnSync(process.execPath,[script,root,sourceRoot],{encoding:'utf8',env:{...verificationEnvironment(),
 GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:repository,GITHUB_SHA:sha,
 FREEDOM_WORKFLOW_SHA:expectedWorkflowCommit,FREEDOM_WORKFLOW_REPOSITORY:'FreeTWAI-AI/freedom-platform',
 FREEDOM_WORKFLOW_PATH:'.github/workflows/trusted-consumer-libraries.yml',FREEDOM_LIBRARY_SOURCE_SHA:'f'.repeat(40),FREEDOM_LIBRARY_PROFILE:'candidate-choice'}});}
async function clone(t,sha){const root=await mkdtemp(join(tmpdir(),'fp-supported-consumer-'));t.after(()=>rm(root,{recursive:true,force:true}));
 git(root,['clone','--quiet','--no-hardlinks',candidateRoot,'.']);git(root,['checkout','--quiet',sha]);return root;}
function commit(root){git(root,['add','.']);git(root,['-c','commit.gpgsign=false','commit','-qm','Synthetic supported consumer probe']);return git(root,['rev-parse','HEAD']);}
function observation(value){if(process.env.FREEDOM_KIT_DEVICE_EVIDENCE==='1')console.log('FREEDOM_CONSUMER_TRANSITION '+JSON.stringify(value));}
test('supported previous candidate passes actual native source CLI and bounded workspace/CLI runtime without device claims',async()=>{
 const input=await installedConsumerInput({...identity,candidateCommit:previous});
 assert.equal(input.expectedSourceCommit,legacySource);assert.equal(input.expectedLibraryProfile,'legacy-v1');
 const cli=native(candidateRoot,previous);assert.equal(cli.status,0,cli.stdout+cli.stderr);
 const source=JSON.parse(cli.stdout);assert.equal(source.source_commit,legacySource);assert.equal(source.launch_closure,null);
 const result=await verifyNativeConsumerRuntime(input);observation(result);assert.equal(result.status,'passed',JSON.stringify(result));
 assert.equal(result.device_required,false);assert.equal(result.device_runtime,null);assert.equal(result.device_library_invocation,'not_checked');
 assert.equal(result.runtime.cleanup_verified,true);assert.equal(result.cli_runtime.cleanup_verified,true);
 assert.equal(result.library_invocation,'not_checked');assert.equal(result.execution_authorized,false);
});
test('supported previous candidate permits ordinary product edits and ignores dirty lock and environment authority',async t=>{
 const root=await clone(t,previous),pkg=JSON.parse(await readFile(join(root,'package.json')));
 pkg.description='Reviewed ordinary edit while previous library remains supported';await writeFile(join(root,'package.json'),JSON.stringify(pkg));
 const entry=join(root,'src/cli.mjs');await writeFile(entry,(await readFile(entry,'utf8'))+'\n// An ordinary product edit keeps its registered command.\n');
 const sha=commit(root);await writeFile(join(root,'consumer-libraries.lock.json'),'{"source_commit":"dirty"}');
 const cli=native(root,sha);assert.equal(cli.status,0,cli.stdout+cli.stderr);observation({kind:'previous_ordinary_edit',candidate:sha,result:'passed'});
});
for(const kind of ['new_profile_old_source','unknown_source','unknown_profile','new_source_legacy_format','old_libraries_new_entry'])test('installed host refuses '+kind+' without candidate execution',async t=>{
 const root=await clone(t,current),path=join(root,'consumer-libraries.lock.json'),lock=JSON.parse(await readFile(path));
 if(kind==='new_profile_old_source')lock.source_commit=legacySource;
 if(kind==='unknown_source')lock.source_commit='f'.repeat(40);
 if(kind==='unknown_profile')lock.profile='candidate-invented';
 if(kind==='new_source_legacy_format'){lock.format='freedom.consumer-libraries/v1';delete lock.profile;}
 if(kind==='old_libraries_new_entry'){
  await rm(join(root,'vendor/freedom-libraries'),{recursive:true,force:true});
  const old=JSON.parse(git(root,['show',previous+':consumer-libraries.lock.json']));
  for(const file of old.files){const dest=join(root,file.path);await mkdir(dirname(dest),{recursive:true});
   await writeFile(dest,execFileSync('/usr/bin/git',['show',previous+':'+file.path],{cwd:root}));}
  await writeFile(path,JSON.stringify(old));
 }else await writeFile(path,JSON.stringify(lock));
 const sha=commit(root),cli=native(root,sha);assert.equal(cli.status,1,cli.stdout+cli.stderr);
 const report=JSON.parse(cli.stdout);assert.equal(report.code,kind==='old_libraries_new_entry'?'consumer_entry_registration_changed':'consumer_supported_tuple_required');
 observation({kind,candidate:sha,result:'rejected',code:report.code,candidate_executed:false});
});
test('native host identity API refuses caller-selected sources and profiles',async()=>{
 await assert.rejects(installedConsumerInput({...identity,candidateCommit:current,expectedSourceCommit:legacySource}),{code:'consumer_host_input_invalid'});
 const input=await installedConsumerInput({...identity,candidateCommit:current});
 const result=await verifyNativeConsumerSource(input);assert.equal(result.library_profile,'agent-kit-device-cli-v1');assert.equal(result.launch_closure.files.length,3);
});
