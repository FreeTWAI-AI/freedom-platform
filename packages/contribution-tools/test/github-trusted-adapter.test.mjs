import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,readdir,readFile,chmod,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
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
 const job={format:'freedom.github-candidate/v1',publisher:f.s.trust.publisher,issued_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),event:'pull_request',repository,run_id:'synthetic-run',run_attempt:1,pull_request:42,base_commit:base,head_commit:head,candidate_commit:head,candidate_tree:git(f.root,['rev-parse','HEAD^{tree}'])};
 const observed={format:'freedom.github-runner-observations/v1',publisher:f.s.trust.publisher,repository,run_id:job.run_id,run_attempt:job.run_attempt,observations:[]};
 const run=(j=job,o=observed)=>runHostVerification(f.config,f.s.envelope('github-candidate',j),f.s.envelope('runner-observations',o));
 const result=await run();assert.equal(result.verification_status,'unavailable');assert.equal(result.gate_enforced,false);assert(result.report.changed_paths.includes('.github/workflows/verify.yml'));assert(result.report.selected_suites.includes('runtime.full'));
 await put(f.host,'host-config.json',pretty(f.config));await put(f.host,'job.proof.json',f.s.envelope('github-candidate',job));await put(f.host,'observations.proof.json',f.s.envelope('runner-observations',observed));
 const cli=fileURLToPath(new URL('../github-trusted-adapter.mjs',import.meta.url));const cliResult=JSON.parse(execFileSync(process.execPath,[cli,'--verify',join(f.host,'host-config.json'),join(f.host,'job.proof.json'),join(f.host,'observations.proof.json')],{env:verificationEnvironment(),timeout:10000}));assert.equal(cliResult.authenticated_inputs,true);assert.equal(cliResult.verification_status,'unavailable');assert.equal(cliResult.gate_enforced,false);
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
