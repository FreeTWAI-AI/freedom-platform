import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,readdir,readFile,chmod,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {authenticateEnvelope,installerPlan,installVerifier,runHostVerification} from '../github-trusted-adapter.mjs';
import {VERIFIER_INSTALLATION_FILES,installedVerifierDigest} from '../trusted-ci.mjs';
import {sha256} from '../io.mjs';
import {verificationEnvironment} from '../process-env.mjs';
import {fixtureRoot,releaseFixture,put,pretty} from './fixtures.mjs';
const repository='FreeTWAI-AI/freedom-platform';
function signer(){const keys=[],privateKeys=new Map();for(const purpose of ['verifier-installation','github-candidate','runner-observations']){const pair=generateKeyPairSync('ed25519');privateKeys.set(purpose,pair.privateKey);keys.push({kid:purpose,purpose,public_jwk:pair.publicKey.export({format:'jwk'}),not_before:new Date(Date.now()-60000).toISOString(),not_after:new Date(Date.now()+60000).toISOString()});}return {trust:{publisher:'synthetic-fixed-host',keys},envelope:(purpose,payload)=>{const bytes=pretty(payload);return pretty({kid:purpose,payload:bytes.toString('base64url'),signature:sign(null,Buffer.concat([Buffer.from(`freedom.github-host/${purpose}/v1\0`),bytes]),privateKeys.get(purpose)).toString('base64url')});}};}
async function fixture(t){
 const f=await releaseFixture(t),host=await mkdtemp(join(tmpdir(),'fp-trusted-host-')),distribution=await fixtureRoot(t),policyRoot=await fixtureRoot(t),s=signer();
 const source=fileURLToPath(new URL('../../../',import.meta.url)),records=[];
 for(const path of VERIFIER_INSTALLATION_FILES){const bytes=await readFile(join(source,path));await put(distribution,path,bytes);records.push({path,sha256:sha256(bytes)});}
 const pin=await installedVerifierDigest(),commit='b'.repeat(40);
 await put(distribution,'installation.proof.json',s.envelope('verifier-installation',{format:'freedom.github-verifier-installation/v1',publisher:s.trust.publisher,commit,sha256:pin,files:records}));
 const config={repository,app_id:123,check_name:'Freedom trusted candidate',trust:s.trust,host_root:host,distribution_root:distribution,candidate_roots:[f.root],verifier_commit:commit,verifier_sha256:pin,policy_root:policyRoot};
 t.after(async()=>{const unseal=async path=>{await chmod(path,0o755);for(const e of await readdir(path,{withFileTypes:true}))if(e.isDirectory())await unseal(join(path,e.name));};await unseal(host);await rm(host,{recursive:true,force:true});});
 return {...f,s,config,distribution,host,policyRoot};
}
test('purpose-separated exact signatures reject candidate fake success and release signing keys',()=>{
 const s=signer(),payload={passed:true};assert.deepEqual({...authenticateEnvelope(s.envelope('runner-observations',payload),s.trust,'runner-observations')},payload);
 assert.throws(()=>authenticateEnvelope(s.envelope('verifier-installation',payload),s.trust,'runner-observations'),{code:'host_key_purpose_mismatch'});
 const fake=JSON.parse(s.envelope('runner-observations',payload));fake.payload=Buffer.from('{"passed":false}').toString('base64url');assert.throws(()=>authenticateEnvelope(pretty(fake),s.trust,'runner-observations'),{code:'invalid_host_signature'});
 assert.throws(()=>authenticateEnvelope(pretty(fake),null,'runner-observations'),{code:'trusted_publisher_unavailable'});
});
test('installer invokes only operator-pinned closure outside candidate roots; changed entry/vendor cannot install',async t=>{
 const f=await fixture(t);assert.equal(await installVerifier(f.config),join(f.host,'verifier-'+f.config.verifier_sha256));
 assert.equal(await installVerifier(f.config),join(f.host,'verifier-'+f.config.verifier_sha256));
 await put(f.distribution,'packages/contribution-tools/trusted-ci.mjs','throw Error("candidate entry must never load")');
 await assert.rejects(installVerifier(f.config),{code:'host_installation_file_mismatch'});
 await assert.rejects(installVerifier({...f.config,distribution_root:f.root}),{code:'candidate_authority_forbidden'});
 const alias=join(f.host,'candidate-alias');await symlink(f.root,alias);await assert.rejects(installVerifier({...f.config,distribution_root:alias}),{code:'candidate_authority_forbidden'});
});
test('dry-run emits App-bound protection config and executable CLI never applies it',async t=>{
 const f=await fixture(t);const plan=installerPlan(f.config);assert.deepEqual(plan.payload,{strict:true,checks:[{context:f.config.check_name,app_id:123}]});assert.equal(plan.gate_enforced,false);
 await put(f.host,'config.json',pretty({repository,app_id:123,check_name:f.config.check_name}));
 const cli=fileURLToPath(new URL('../github-trusted-adapter.mjs',import.meta.url));const result=JSON.parse(execFileSync(process.execPath,[cli,'--dry-run',join(f.host,'config.json')],{env:verificationEnvironment(),timeout:10000}));assert.equal(result.status,'unavailable');assert.equal(result.method,'PATCH');
 assert.throws(()=>installerPlan({...f.config,app_id:-1}),{code:'operator_app_id_required'});
});
test('authenticated host adapter executes external verifier on actual Git objects and candidate forgery stays unavailable',async t=>{
 const f=await fixture(t);for(const path of ['AGENTS.md','README.md','CONTRIBUTING.md'])await put(f.root,path,'# Synthetic\n');
 await put(f.root,'packages/governance/freedom.module.json',pretty({format:'freedom.module/v1',module_id:'governance',owner_role:'foundation',owned_paths:['packages/governance/**'],public_exports:[],dependencies:[],contract_families:['preview'],client_profiles:['member'],instructions:['AGENTS.md'],invariants:[],tests:['governance.unit'],surfaces:[]}));
 const git=(root,args)=>execFileSync('git',args,{cwd:root,env:verificationEnvironment(),timeout:10000}).toString().trim();git(f.root,['-c','init.templateDir=','init','--quiet']);
 const commit=()=>{git(f.root,['add','.']);git(f.root,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic']);return git(f.root,['rev-parse','HEAD']);};
 const base=commit();await put(f.root,'.github/workflows/verify.yml','jobs: {fake: {steps: [{run: "echo success"}]}}\n');await put(f.root,'packages/contribution-tools/trusted-ci.mjs','throw Error("Candidate verifier executed")');const head=commit();const bare=await fixtureRoot(t);git(f.root,['clone','--quiet','--bare','--no-hardlinks',f.root,bare]);f.config.object_repository=bare;
 const policy={format:'freedom.trusted-ci-policy/v1',revision:'synthetic-policy',repository,source:{repository:f.manifest.source_repository,commit:f.manifest.source_commit,release_set_sha256:sha256(f.manifestBytes)},verifier:{commit:f.config.verifier_commit,sha256:f.config.verifier_sha256},workflow:{identity:'fixed-host/verify',commit:'c'.repeat(40),publisher:f.s.trust.publisher},required_suites:['source.approval'],fallback_suites:['runtime.full'],suites:['source.approval','runtime.full','governance.unit'].map(id=>({id,harness_sha256:sha256(id)}))};
 await put(f.policyRoot,'trusted-ci-policy.json',pretty(policy));f.config.expected_policy={revision:policy.revision,sha256:sha256(pretty(policy))};
 const job={format:'freedom.github-candidate/v1',publisher:f.s.trust.publisher,issued_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),event:'pull_request',repository,run_id:'4',run_attempt:1,pull_request:42,base_commit:base,head_commit:head,candidate_commit:head,candidate_tree:git(f.root,['rev-parse','HEAD^{tree}'])};
 const observed={format:'freedom.github-runner-observations/v1',publisher:f.s.trust.publisher,repository,run_id:job.run_id,run_attempt:job.run_attempt,observations:[]};
 const run=(j=job,o=observed)=>runHostVerification(f.config,f.s.envelope('github-candidate',j),f.s.envelope('runner-observations',o));
 const result=await run();assert.equal(result.verification_status,'unavailable');assert.equal(result.gate_enforced,false);assert(result.report.changed_paths.includes('.github/workflows/verify.yml'));assert(result.report.selected_suites.includes('runtime.full'));
 await put(f.host,'host-config.json',pretty(f.config));await put(f.host,'job.proof.json',f.s.envelope('github-candidate',job));await put(f.host,'observations.proof.json',f.s.envelope('runner-observations',observed));
 const cli=fileURLToPath(new URL('../github-trusted-adapter.mjs',import.meta.url));const cliResult=JSON.parse(execFileSync(process.execPath,[cli,'--verify',join(f.host,'host-config.json'),join(f.host,'job.proof.json'),join(f.host,'observations.proof.json')],{env:verificationEnvironment(),timeout:10000}));assert.equal(cliResult.authenticated_inputs,true);assert.equal(cliResult.verification_status,'unavailable');assert.equal(cliResult.gate_enforced,false);
 const {createSignedSupervisorPublisher}=await import('../github-supervisor-publisher.mjs');
 const publisherConfig={repository,repository_id:1,app_id:f.config.app_id,installation_id:3,check_name:f.config.check_name};
 const posts=[];
 const installationRequest=async(method,path,body)=>{
  if(method==='POST'){posts.push(body);return {id:6,app:{id:f.config.app_id},...body};}
  if(path.endsWith('/check-runs/6'))return {id:6,app:{id:f.config.app_id},...posts.at(-1)};
  if(path.includes('/actions/runs/'))return {id:4,run_attempt:1,repository:{id:1},event:'pull_request',head_sha:head,pull_requests:[{number:42}]};
  if(path.endsWith('/pulls/42'))return {number:42,state:'open',merged:false,base:{repo:{id:1},sha:base},head:{sha:head}};
  if(path.includes('/git/commits/'))return {sha:head,tree:{sha:job.candidate_tree}};
  return {id:1,full_name:repository};
 };
 const appRequest=async(_,path)=>path==='/app'?{id:f.config.app_id}:{id:3,app_id:f.config.app_id,suspended_at:null,permissions:{checks:'write'}};
 const complete={...observed,observations:result.report.selected_suites.map(suite_id=>({suite_id,binding:result.report.binding,workflow:policy.workflow,harness_sha256:sha256(suite_id),conclusion:'success',tests:1,failures:0,skipped:0,cancelled:0,evidence_sha256:sha256('actual synthetic '+suite_id)}))};
 const binding=Object.fromEntries(['repository','run_id','run_attempt','pull_request','base_commit','head_commit','candidate_commit','candidate_tree'].map(k=>[k,job[k]]));
 const make=supervisor=>createSignedSupervisorPublisher({adapterConfig:f.config,publisherConfig},{appRequest,installationRequest,supervisor});
 const signed=(j=job,o=complete)=>({jobEnvelope:f.s.envelope('github-candidate',j),observationsEnvelope:f.s.envelope('runner-observations',o)});
 const capturedConfig={adapterConfig:structuredClone(f.config),publisherConfig:{...publisherConfig}};
 const capturedPorts={appRequest,installationRequest,supervisor:async()=>signed()};
 const captured=createSignedSupervisorPublisher(capturedConfig,capturedPorts);
 capturedConfig.adapterConfig.trust.keys[0].purpose='wrong';capturedConfig.adapterConfig.expected_policy.sha256='0'.repeat(64);
 capturedConfig.publisherConfig.app_id=999;capturedPorts.supervisor=async()=>({report:{status:'passed'}});
 const capturedResult=await captured.publish(binding);assert.equal(capturedResult.status,'published');
 posts.length=0;
 assert.throws(()=>createSignedSupervisorPublisher({adapterConfig:f.config,publisherConfig:{...publisherConfig,app_id:999}},{appRequest,installationRequest,supervisor:async()=>signed()}),/publisher_supervisor_configuration_invalid/);
 const accepted=await make(async()=>signed()).publish(binding);assert.equal(accepted.status,'published');assert.equal(accepted.gate_enforced,false);assert.equal(posts.length,1);
 for(const supervisor of [async()=>signed(job,observed),async()=>signed({...job,run_attempt:2}),async()=>({...signed(),report:{status:'passed'}}),async()=>({jobEnvelope:f.s.envelope('runner-observations',job),observationsEnvelope:signed().observationsEnvelope}),async()=>({jobEnvelope:'{"passed":true}',observationsEnvelope:signed().observationsEnvelope}),async()=>({jobEnvelope:'x'.repeat(2_000_001),observationsEnvelope:signed().observationsEnvelope})]){
  const before=posts.length;assert.equal((await make(supervisor).publish(binding)).status,'unavailable');assert.equal(posts.length,before);
 }
 const {createDurableSignedSupervisorPublisher}=await import('../github-durable-publisher.mjs');
 const journals=[];
 const durable=async(options={})=>{
  const journalRoot=await mkdtemp(join(tmpdir(),'fp-publisher-journal-'));journals.push(journalRoot);
  const api={attempt:1,check:null,writes:[],calls:0,supervisors:0,unknown:false,wrongReadback:false,supersede:false};
  const cfg={adapterConfig:structuredClone(f.config),publisherConfig:{...publisherConfig},journalRoot};
  const io={appRequest,installationRequest:async(method,path,body)=>{
   api.calls++;
   if(method==='POST'||method==='PATCH'){
    const persisted=JSON.parse(await readFile(join(journalRoot,head+'.json'),'utf8'));
    assert.equal(persisted.phase,'write_unknown');assert.equal(persisted.operation,body.conclusion);
    api.writes.push({method,body});api.check={...(api.check??{}),id:6,app:{id:f.config.app_id},...body};
    if(body.conclusion==='success'&&api.unknown)throw Error('secret remote lost ACK');
    if(body.conclusion==='success'&&api.supersede)api.attempt++;
    return api.check;
   }
   if(path.endsWith('/check-runs/6')){
    if(api.check?.conclusion==='success'&&api.wrongReadback){api.wrongReadback=false;return {...api.check,app:{id:999}};}
    return api.check;
   }
   if(path.includes('/actions/runs/'))return {id:4,run_attempt:api.attempt,repository:{id:1},event:'pull_request',head_sha:head,pull_requests:[{number:42}]};
   return installationRequest(method,path,body);
  },supervisor:async current=>{
   api.supervisors++;
   if(options.badSigned)return {jobEnvelope:'{"passed":true}',observationsEnvelope:'{}'};
   return signed({...job,run_attempt:current.run_attempt},{...complete,run_attempt:current.run_attempt,observations:complete.observations.map(o=>({...o,binding:{...o.binding,run_attempt:current.run_attempt}}))});
  }};
  return {cfg,io,api,journalRoot,make:()=>createDurableSignedSupervisorPublisher(cfg,io),state:async()=>JSON.parse(await readFile(join(journalRoot,head+'.json'),'utf8'))};
 };
 t.after(async()=>{for(const root of journals)await rm(root,{recursive:true,force:true});});
 await t.test('durable real signed composition barriers, restart replay and newer-attempt failure',async()=>{
  const d=await durable();const publisher=d.make();
  d.cfg.publisherConfig.app_id=999;d.cfg.adapterConfig.trust.keys[0].purpose='wrong'; // Captured before awaits.
  const success=await publisher.publish(binding);assert.equal(success.status,'published');assert.equal(success.gate_enforced,false);
  assert.deepEqual(d.api.writes.map(w=>[w.method,w.body.conclusion]),[['POST','failure'],['PATCH','success']]);
  assert.equal((await d.state()).phase,'success_confirmed');
  d.cfg.publisherConfig={...publisherConfig};d.cfg.adapterConfig=structuredClone(f.config);
  const calls=d.api.calls;assert.equal((await d.make().publish(binding)).code,'publisher_replay_unavailable');assert.equal(d.api.calls,calls);
  assert.equal((await d.make().publish({...binding,run_id:'5'})).code,'publisher_run_supersession_unavailable');assert.equal(d.api.calls,calls);
  d.api.attempt=2;d.io.supervisor=async()=>({jobEnvelope:'{"passed":true}',observationsEnvelope:'{}'});
  assert.equal((await d.make().publish({...binding,run_attempt:2})).status,'unavailable');
  assert.equal(d.api.check.conclusion,'failure');assert.equal((await d.state()).phase,'failure_confirmed');
  assert.equal(d.api.writes.at(-1).method,'PATCH');assert.equal(d.api.check.id,6);
  d.api.attempt=1;const writes=d.api.writes.length;
  assert.equal((await d.make().publish(binding)).status,'unavailable');assert.equal(d.api.writes.length,writes);
 });
 await t.test('corrupt closed journal metadata and foreign App target cannot authorize a write',async()=>{
  for(const mutate of [s=>{s.binding.run_id=4;},s=>{s.check_id=null;},s=>{s.phase='caller-approved';},s=>{s.secret='private';}]){
   const d=await durable();assert.equal((await d.make().publish(binding)).status,'published');
   const state=await d.state();mutate(state);await writeFile(join(d.journalRoot,head+'.json'),JSON.stringify(state));
   d.api.attempt=2;const calls=d.api.calls;
   assert.equal((await d.make().publish({...binding,run_attempt:2})).status,'unavailable');assert.equal(d.api.calls,calls);
  }
  const duplicate=await durable();assert.equal((await duplicate.make().publish(binding)).status,'published');
  const original=await readFile(join(duplicate.journalRoot,head+'.json'),'utf8');
  await writeFile(join(duplicate.journalRoot,head+'.json'),original.replace('"phase":"success_confirmed"','"phase":"write_unknown","phase":"success_confirmed"'));
  duplicate.api.attempt=2;const before=duplicate.api.calls;
  assert.equal((await duplicate.make().publish({...binding,run_attempt:2})).status,'unavailable');assert.equal(duplicate.api.calls,before);
  const d=await durable();assert.equal((await d.make().publish(binding)).status,'published');
  d.api.attempt=2;d.api.check.app.id=999;const writes=d.api.writes.length;
  assert.equal((await d.make().publish({...binding,run_attempt:2})).status,'unavailable');assert.equal(d.api.writes.length,writes);
 });
 await t.test('unknown success ACK persists remote ambiguity without retry or compensation',async()=>{
  const d=await durable();d.api.unknown=true;
  assert.equal((await d.make().publish(binding)).status,'unavailable');assert.equal(d.api.check.conclusion,'success');
  assert.equal((await d.state()).phase,'write_unknown');const calls=d.api.calls;
  assert.equal((await d.make().publish(binding)).code,'publisher_journal_unknown_write');assert.equal(d.api.calls,calls);
  assert.deepEqual(d.api.writes.map(w=>w.body.conclusion),['failure','success']);
  assert(!JSON.stringify(await d.state()).includes('secret'));
 });
 await t.test('known ACK readback failure compensates only a fresh authenticated check target',async()=>{
  const d=await durable();d.api.wrongReadback=true;
  assert.equal((await d.make().publish(binding)).status,'unavailable');
  assert.deepEqual(d.api.writes.map(w=>w.body.conclusion),['failure','success','failure']);assert.equal(d.api.check.conclusion,'failure');
  assert.equal((await d.state()).phase,'failure_confirmed');
  const changed=await durable();changed.api.supersede=true;
  assert.equal((await changed.make().publish(binding)).code,'publisher_compensation_unavailable');
  assert.deepEqual(changed.api.writes.map(w=>w.body.conclusion),['failure','success']);
  assert.equal((await changed.state()).phase,'success_acknowledged');assert.equal(changed.api.check.conclusion,'success');
 });
 await t.test('failure barrier unknown ACK prevents even supervisor invocation',async()=>{
  const d=await durable();const original=d.io.installationRequest;
  d.io.installationRequest=async(...args)=>{if(args[0]==='POST'){await original(...args);throw Error('secret');}return original(...args);};
  assert.equal((await d.make().publish(binding)).status,'unavailable');assert.equal(d.api.supervisors,0);
  assert.equal((await d.state()).phase,'write_unknown');assert.equal((await d.make().publish(binding)).code,'publisher_journal_unknown_write');
 });
 await t.test('two real host instances cannot overlap an active publication',async()=>{
  const d=await durable();let entered,release;
  const ready=new Promise(r=>{entered=r;}),wait=new Promise(r=>{release=r;});
  d.io.supervisor=async()=>{entered();await wait;return {jobEnvelope:'{}',observationsEnvelope:'{}'};};
  const pending=d.make().publish(binding);await ready;const calls=d.api.calls;
  assert.equal((await d.make().publish({...binding,run_attempt:2})).status,'unavailable');assert.equal(d.api.calls,calls);
  release();assert.equal((await pending).status,'unavailable');assert.equal(d.api.check.conclusion,'failure');
 });
 await t.test('real process crash after durable intent leaves exclusive lock, never stale takeover',async()=>{
  const d=await durable(),module=fileURLToPath(new URL('../github-durable-publisher.mjs',import.meta.url));
  const child=join(f.root,'synthetic-publisher-crash.mjs');
  await writeFile(child,`import {readFileSync} from 'node:fs';import {createDurableSignedSupervisorPublisher} from ${JSON.stringify(module)};const config=${JSON.stringify(d.cfg)},binding=${JSON.stringify(binding)};const ports={appRequest:async(_,path)=>path==='/app'?{id:123}:{id:3,app_id:123,suspended_at:null,permissions:{checks:'write'}},installationRequest:async(method,path)=>{if(method==='POST'){const s=JSON.parse(readFileSync(config.journalRoot+'/'+binding.head_commit+'.json'));process.exit(s.phase==='write_unknown'?73:74);}if(path.includes('/actions/runs/'))return {id:4,run_attempt:1,repository:{id:1},event:'pull_request',head_sha:binding.head_commit,pull_requests:[{number:42}]};if(path.endsWith('/pulls/42'))return {number:42,state:'open',merged:false,base:{repo:{id:1},sha:binding.base_commit},head:{sha:binding.head_commit}};if(path.includes('/git/commits/'))return {sha:binding.head_commit,tree:{sha:binding.candidate_tree}};return {id:1,full_name:binding.repository};},supervisor:async()=>{throw Error('must not reach');}};await createDurableSignedSupervisorPublisher(config,ports).publish(binding);`);
  const exited=spawnSync(process.execPath,[child],{env:verificationEnvironment(),timeout:10000});assert.equal(exited.status,73);
  assert.equal((await d.state()).phase,'write_unknown');assert((await readdir(d.journalRoot)).includes('.publisher.lock'));
  assert.equal((await d.make().publish(binding)).status,'unavailable');assert.equal(d.api.calls,0);
 });
 await t.test('unsafe root, foreign files, symlink and FIFO state cannot reach HTTP',async()=>{
  for(const kind of ['world-writable','foreign','symlink','fifo']){
   const d=await durable(),path=join(d.journalRoot,head+'.json');
   if(kind==='world-writable')await chmod(d.journalRoot,0o777);
   if(kind==='foreign')await writeFile(join(d.journalRoot,'unexpected'),'secret');
   if(kind==='symlink')await symlink(join(f.root,'README.md'),path);
   if(kind==='fifo')execFileSync('mkfifo',[path]);
   assert.equal((await d.make().publish(binding)).status,'unavailable',kind);assert.equal(d.api.calls,0,kind);
  }
 });
 const merge=await run({...job,event:'merge_group',pull_request:null});assert.equal(merge.report.binding.pull_request,null);assert.equal(merge.report.binding.candidate_commit,head);
 await assert.rejects(run({...job,base_commit:head}),{code:'candidate_base_equals_candidate'});
 await assert.rejects(run({...job,event:'merge_group',pull_request:null,base_commit:head}),{code:'candidate_base_equals_candidate'});
 await assert.rejects(run({...job,event:'merge_group',pull_request:42}),{code:'host_event_candidate_mismatch'});
 await assert.rejects(run({...job,expires_at:new Date(Date.now()-1).toISOString()}),{code:'host_event_stale'});
 await assert.rejects(run(job,{...observed,run_id:'superseded-run'}),{code:'host_runner_identity_mismatch'});
 await assert.rejects(run(job,{...observed,run_attempt:2}),{code:'host_runner_identity_mismatch'});
 await put(f.vendor,'client/client.mjs','export const candidateForged=true;');const altered=commit();git(f.root,['--git-dir='+bare,'fetch','--quiet',f.root,'+HEAD:refs/heads/candidate']);
 await assert.rejects(run({...job,head_commit:altered,candidate_commit:altered,candidate_tree:git(f.root,['rev-parse','HEAD^{tree}'])}),{code:'host_artifact_integrity_mismatch'});
});
