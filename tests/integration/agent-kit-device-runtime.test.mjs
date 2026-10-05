import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyNativeConsumerRuntime } from '../../packages/contribution-tools/github-consumer-runtime-host.mjs';
import { verifyNativeConsumerSource } from '../../packages/contribution-tools/github-consumer-host.mjs';
import { consumerHostTuple } from '../../packages/contribution-tools/consumer-host-tuples.mjs';
import { DEVICE_CASES } from '../../packages/contribution-tools/agent-kit-device-fixture.mjs';
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
const candidateRoot=process.env.FREEDOM_KIT_CANDIDATE_ROOT,sourceRoot=process.env.FREEDOM_CONSUMER_SOURCE_ROOT;
const candidateCommit=process.env.FREEDOM_KIT_CANDIDATE_SHA,expectedWorkflowCommit=process.env.FREEDOM_CONSUMER_WORKFLOW_SHA;
if(process.env.FREEDOM_RUN_KIT_DEVICE_RUNTIME!=='1'||![candidateRoot,sourceRoot].every(value=>typeof value==='string'&&isAbsolute(value))
 ||![candidateCommit,expectedWorkflowCommit].every(value=>/^[a-f0-9]{40}$/.test(value)))throw Error('Explicit Kit/source full clones and exact commits required');
const repository='FreeTWAI-AI/freedom-agent-kit',tuple=consumerHostTuple(repository);
const input={repository,candidateRoot,candidateCommit,sourceRoot,expectedWorkflowCommit,expectedSourceCommit:tuple.source,expectedLibraryProfile:tuple.library_profile};
const git=(cwd,args)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',timeout:30000,
 env:{...verificationEnvironment(),GIT_AUTHOR_NAME:'Synthetic',GIT_COMMITTER_NAME:'Synthetic',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},stdio:['ignore','pipe','pipe']}).trim();
function evidence(value){if(process.env.FREEDOM_KIT_DEVICE_EVIDENCE==='1')console.log('FREEDOM_KIT_DEVICE_OBSERVATION '+JSON.stringify(value));}
test('exact Kit candidate invokes canonical CLI and SDK in the isolated host, retaining legacy workspace and CLI checks',async()=>{
 const result=await verifyNativeConsumerRuntime(input);evidence(result);assert.equal(result.status,'passed',JSON.stringify(result));
 assert.equal(result.device_required,true);assert.equal(result.device_library_invocation,'closed_canonical_cli_observed');
 assert.equal(result.runtime.check.status,'passed');assert.equal(result.cli_runtime.check.status,'passed');
 const d=result.device_runtime;assert.equal(d.check.test_count,DEVICE_CASES.length);assert.equal(d.cleanup_verified,true);
 assert.equal(d.candidate.commit,candidateCommit);assert.equal(d.candidate.tree,result.source.candidate_tree);
 assert.equal(d.launch_closure.files.length,3);assert.equal(d.real_tls,'not_checked');
 assert(d.cases.every(c=>c.response_matches_challenge&&c.secret_output_absent&&c.allowed_request_counts.includes(c.observed_requests)));
 assert.deepEqual(d.cases.find(c=>c.scenario==='cancelled').allowed_request_counts,[1,2]);
 assert.equal(result.execution_authorized,false);assert.equal(result.server_authorization,'not_checked');
 assert.equal(result.library_invocation,'not_checked'); // Other Kit entrypoints are still not attested.
});
test('actual native source executable selects its reviewed tuple independently of environment overrides',()=>{
 const script=fileURLToPath(new URL('../../packages/contribution-tools/github-consumer-host.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[script,candidateRoot,sourceRoot],{encoding:'utf8',env:{...verificationEnvironment(),
  GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:repository,GITHUB_SHA:candidateCommit,
  FREEDOM_WORKFLOW_SHA:expectedWorkflowCommit,FREEDOM_WORKFLOW_REPOSITORY:'FreeTWAI-AI/freedom-platform',
  FREEDOM_WORKFLOW_PATH:'.github/workflows/trusted-consumer-libraries.yml',FREEDOM_LIBRARY_SOURCE_SHA:'f'.repeat(40),FREEDOM_LIBRARY_PROFILE:'candidate-choice'}});
 assert.equal(result.status,0,result.stdout+result.stderr);const report=JSON.parse(result.stdout);
 assert.equal(report.source_commit,tuple.source);assert.equal(report.library_profile,tuple.library_profile);assert.equal(report.launch_closure.files.length,3);
});
for(const kind of ['unused_import','dead_call_private_client','private_same_shape_client','wrong_source_pin','sdk_replaced','command_retarget','candidate_preload','package_scope'])test('real immutable source rejects '+kind+' before any candidate execution',async t=>{
 const root=await mkdtemp(join(tmpdir(),'fp-kit-device-negative-'));t.after(()=>rm(root,{recursive:true,force:true}));
 git(root,['clone','--quiet','--no-hardlinks',candidateRoot,'.']);git(root,['checkout','--quiet',candidateCommit]);
 if(kind==='unused_import')await writeFile(join(root,'src/device-cli.mjs'),'import "../vendor/freedom-libraries/packages/sdk/machine-device-cli.mjs"; console.log("passed");\n');
 if(kind==='dead_call_private_client'||kind==='private_same_shape_client'){
  // Runnable same-shape private copies, not a missing-file stub. The approved
  // vendor bytes remain untouched; their mere import cannot establish usage.
  await writeFile(join(root,'src/private-command.mjs'),await readFile(join(root,'vendor/freedom-libraries/packages/sdk/machine-device-cli.mjs')));
  await writeFile(join(root,'src/machine-device-client.mjs'),await readFile(join(root,'vendor/freedom-libraries/packages/sdk/machine-device-client.mjs')));
  await writeFile(join(root,'src/device-cli.mjs'),'import {deviceCliMain} from "../vendor/freedom-libraries/packages/sdk/machine-device-cli.mjs"; '
    +(kind==='dead_call_private_client'?'if(false)await deviceCliMain(); ':'')
    +'const own=await import("./private-command.mjs"); process.exitCode=await own.deviceCliMain();\n');
 }
 if(kind==='wrong_source_pin'){
  const path=join(root,'consumer-libraries.lock.json'),lock=JSON.parse(await readFile(path));lock.source_commit='91b943ac61e132fbbce72ea066cb2301aa065600';await writeFile(path,JSON.stringify(lock));
 }
 if(kind==='sdk_replaced')await writeFile(join(root,'vendor/freedom-libraries/packages/sdk/machine-device-client.mjs'),'export const createMachineDeviceClient=()=>({});\n');
 if(kind==='command_retarget'||kind==='candidate_preload'){
  const path=join(root,'package.json'),p=JSON.parse(await readFile(path));p.scripts[kind==='command_retarget'?'device:status':'predevice:status']='node src/private-client.mjs';await writeFile(path,JSON.stringify(p));
 }
 if(kind==='package_scope')await writeFile(join(root,'src/package.json'),'{"type":"module","imports":{"#sdk":"./private-client.mjs"}}');
 git(root,['add','.']);git(root,['-c','commit.gpgsign=false','commit','-qm','Synthetic device invocation boundary mutation']);
 const changed=git(root,['rev-parse','HEAD']);
 await assert.rejects(verifyNativeConsumerSource({...input,candidateRoot:root,candidateCommit:changed}),error=>{
  evidence({format:'freedom.kit-device-source-negative/v1',kind,candidate_commit:changed,source_commit:tuple.source,workflow_commit:expectedWorkflowCommit,
   result:'rejected',code:error.code,environment:'local-immutable-git',candidate_executed:false});
  assert.equal(error.code,kind==='sdk_replaced'?'library_bytes_mismatch':kind==='wrong_source_pin'?'library_source_mismatch':kind==='command_retarget'||kind==='candidate_preload'?'consumer_entry_registration_changed':kind==='package_scope'?'consumer_entry_registry_set_changed':'library_entry_source_mismatch');return true;
 });
});
