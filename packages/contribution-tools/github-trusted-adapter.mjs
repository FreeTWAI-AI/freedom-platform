#!/usr/bin/env node
// Bootstrap MUST itself be installed/pinned by the operator outside candidate authority.
// No network writes, GitHub credentials, candidate commands or candidate imports.
import { createPublicKey, verify } from 'node:crypto';
import { lstat, realpath, mkdir, copyFile, chmod } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBounded, parseJson, sha256 } from './io.mjs';
import { requireCondition as check, VerificationError, safeFailure } from './errors.mjs';

// Bootstrap-approved closure; no manifest-selected entrypoints or dependencies.
const FILES = Object.freeze([
  ...['trusted-ci','context','workspace','process-env','contracts','formats','schema','io','errors'].map(n=>`packages/contribution-tools/${n}.mjs`),
  ...['release-set','contract-pin-v1','contract-pin-v2','release-proof','release-trust','module','coding-context','verifier-report'].map(n=>`governance/schemas/${n}.schema.json`),
].sort());
const sha = value => check(typeof value==='string' && /^[a-f0-9]{40}$/.test(value),'invalid_host_commit');
const digest = value => check(typeof value==='string' && /^[a-f0-9]{64}$/.test(value),'invalid_host_digest');
function exact(value,fields){check(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===fields.length && fields.every(k=>Object.hasOwn(value,k)),'invalid_adapter_input');}
function inside(root,path){const r=relative(root,path);return r===''||(!r.startsWith('../')&&!isAbsolute(r));}
async function outside(path,candidates){check(isAbsolute(path),'absolute_host_path_required');const actual=await realpath(path);for(const root of candidates)check(!inside(await realpath(root),actual),'candidate_authority_forbidden');return actual;}

export function authenticateEnvelope(bytes,trust,purpose,now=Date.now()) {
  if(!trust)throw new VerificationError('trusted_publisher_unavailable',true);
  exact(trust,['publisher','keys']);check(typeof trust.publisher==='string' && trust.publisher.length<160 && Array.isArray(trust.keys)&&trust.keys.length<=16,'invalid_operator_trust');
  const e=parseJson(bytes,{maxBytes:2_000_000});exact(e,['kid','payload','signature']);
  const key=trust.keys.find(k=>k.kid===e.kid);check(key && key.purpose===purpose,'host_key_purpose_mismatch');
  exact(key,['kid','purpose','public_jwk','not_before','not_after']);
  check(now>=Date.parse(key.not_before)&&now<Date.parse(key.not_after),'host_key_inactive');
  check(key.public_jwk?.kty==='OKP'&&key.public_jwk.crv==='Ed25519'&&!Object.hasOwn(key.public_jwk,'d'),'invalid_host_public_key');
  const payload=Buffer.from(e.payload,'base64url'),signature=Buffer.from(e.signature,'base64url');
  check(payload.toString('base64url')===e.payload&&signature.length===64&&signature.toString('base64url')===e.signature,'invalid_host_signature');
  check(verify(null,Buffer.concat([Buffer.from(`freedom.github-host/${purpose}/v1\0`),payload]),createPublicKey({key:key.public_jwk,format:'jwk'}),signature),'invalid_host_signature');
  return parseJson(payload);
}

export function installerPlan(config) {
  check(config && typeof config.repository==='string'&&/^[\w.-]+\/[\w.-]+$/.test(config.repository),'invalid_host_repository');
  check(Number.isSafeInteger(config.app_id)&&config.app_id>0,'operator_app_id_required');
  check(typeof config.check_name==='string'&&/^[A-Za-z0-9 ._/-]{1,100}$/.test(config.check_name),'invalid_check_name');
  return {format:'freedom.github-host-install-plan/v1',status:'unavailable',gate_enforced:false,
    method:'PATCH',path:`/repos/${config.repository}/branches/main/protection/required_status_checks`,
    // Review alongside the existing branch protection; this plan is never applied here.
    payload:{strict:true,checks:[{context:config.check_name,app_id:config.app_id}]},
    fixed_host:{events:['pull_request','merge_group'],candidate_execution:'isolated-no-publisher-credentials',publisher:'separate-app-installation'},
    blockers:['operator_bootstrap_install_required','authenticated_github_event_delivery_required','isolated_runner_install_required','github_app_publisher_not_implemented','branch_enforcement_not_applied','real_negative_pr_required']};
}

export async function installVerifier(config) {
  if(!config.trust)throw new VerificationError('trusted_publisher_unavailable',true);
  check(Array.isArray(config.candidate_roots)&&config.candidate_roots.length>0&&config.candidate_roots.length<=16,'candidate_roots_required');
  const host=await outside(config.host_root,config.candidate_roots),distribution=await outside(config.distribution_root,config.candidate_roots);
  const envelope=await readBounded(distribution,'installation.proof.json');
  const manifest=authenticateEnvelope(envelope,config.trust,'verifier-installation');
  exact(manifest,['format','publisher','commit','sha256','files']);
  check(manifest.format==='freedom.github-verifier-installation/v1'&&manifest.publisher===config.trust.publisher,'host_installation_identity_mismatch');
  sha(manifest.commit);digest(manifest.sha256);sha(config.verifier_commit);digest(config.verifier_sha256);
  check(manifest.commit===config.verifier_commit&&manifest.sha256===config.verifier_sha256,'host_verifier_pin_mismatch');
  check(Array.isArray(manifest.files)&&manifest.files.length===FILES.length,'host_installation_closure_mismatch');
  const records=[];let total=0;
  for(let i=0;i<FILES.length;i++){
    const record=manifest.files[i];exact(record,['path','sha256']);check(record.path===FILES[i],'host_installation_closure_mismatch');digest(record.sha256);
    const bytes=await readBounded(distribution,record.path);total+=bytes.length;check(total<=8_000_000,'host_installation_size_limit');check(sha256(bytes)===record.sha256,'host_installation_file_mismatch');records.push([record.path,record.sha256]);
  }
  check(sha256(JSON.stringify(records))===config.verifier_sha256,'host_verifier_digest_mismatch');
  // Fresh directory; never overwrite an existing installed verifier. Operator must
  // prevent concurrent untrusted writers to distribution and host directories.
  const target=join(host,'verifier-'+config.verifier_sha256);let fresh=true;
  try{await mkdir(target);}catch(error){if(error.code!=='EEXIST')throw error;fresh=false;const entry=await lstat(target);check(entry.isDirectory()&&!entry.isSymbolicLink(),'invalid_host_installation');}
  if(fresh)for(const path of FILES){const dest=join(target,path);await mkdir(dirname(dest),{recursive:true});await copyFile(join(distribution,path),dest);await chmod(dest,0o444);}
  // Recheck copied bytes before import; no distribution file becomes executable first.
  for(const [path,expected]of records)check(sha256(await readBounded(target,path))===expected,'host_installation_file_mismatch');
  if(fresh){for(const path of FILES)await chmod(dirname(join(target,path)),0o555);await chmod(target,0o555);}
  return target;
}

export async function runHostVerification(config,jobEnvelope,observationsEnvelope) {
  installerPlan(config);
  const job=authenticateEnvelope(jobEnvelope,config.trust,'github-candidate');
  exact(job,['format','publisher','issued_at','expires_at','event','repository','run_id','pull_request','base_commit','head_commit','candidate_commit','candidate_tree']);
  check(job.format==='freedom.github-candidate/v1'&&job.publisher===config.trust.publisher&&job.repository===config.repository,'host_event_identity_mismatch');
  const now=Date.now(),issued=Date.parse(job.issued_at),expires=Date.parse(job.expires_at);
  check(Number.isFinite(issued)&&issued<=now&&now<expires&&expires-issued<=300_000,'host_event_stale');
  check(['pull_request','merge_group'].includes(job.event),'unsupported_host_event');
  for(const key of ['base_commit','head_commit','candidate_commit','candidate_tree'])sha(job[key]);
  check(job.base_commit!==job.candidate_commit,'candidate_base_equals_candidate');
  check(job.event==='merge_group'?job.pull_request===null&&job.candidate_commit===job.head_commit:Number.isSafeInteger(job.pull_request)&&job.pull_request>0,'host_event_candidate_mismatch');
  const observed=authenticateEnvelope(observationsEnvelope,config.trust,'runner-observations');
  exact(observed,['format','publisher','repository','run_id','observations']);
  check(observed.format==='freedom.github-runner-observations/v1'&&observed.publisher===config.trust.publisher&&observed.repository===job.repository&&observed.run_id===job.run_id,'host_runner_identity_mismatch');
  const target=await installVerifier(config);
  const objects=await outside(config.object_repository,config.candidate_roots);
  const policyRoot=await outside(config.policy_root,config.candidate_roots);
  const policyBytes=await readBounded(policyRoot,'trusted-ci-policy.json');
  const verifier=await import(pathToFileURL(join(target,'packages/contribution-tools/trusted-ci.mjs')).href);
  const binding=Object.fromEntries(['repository','run_id','pull_request','base_commit','head_commit','candidate_commit','candidate_tree'].map(k=>[k,job[k]]));
  const report=await verifier[job.event==='merge_group'?'verifyHostMergeGroupCandidate':'verifyHostCandidate']({objectRepository:objects,binding,policyBytes,expectedPolicy:config.expected_policy,observations:observed.observations});
  // Authentication is real, but no App publisher or GitHub enforcement is installed
  // by this executable. Never turn a local verifier pass into a green merge check.
  return {format:'freedom.github-host-adapter-report/v1',status:'unavailable',verification_status:report.status,
    gate_enforced:false,merge_authorized:false,publisher_trust:'unverified',authenticated_inputs:true,
    check_identity:{name:config.check_name,app_id:config.app_id,head_sha:job.candidate_commit},report,
    blockers:['github_app_publisher_not_implemented','branch_enforcement_not_applied','real_negative_pr_required']};
}

async function cli(){
  const [mode,configPath,jobPath,observationsPath]=process.argv.slice(2);
  check(['--dry-run','--install','--verify'].includes(mode)&&isAbsolute(configPath??''),'host_cli_usage');
  // CLI input paths are operator-owned, not workflow/candidate arguments.
  const config=parseJson(await readBounded(dirname(configPath),resolve(configPath).split('/').at(-1)));
  if(mode==='--dry-run')return installerPlan(config);
  installerPlan(config);
  if(!config.trust)throw new VerificationError('trusted_publisher_unavailable',true);
  check(Array.isArray(config.candidate_roots)&&config.candidate_roots.length>0,'candidate_roots_required');
  await outside(configPath,config.candidate_roots);
  if(mode==='--install')return {status:'installed',gate_enforced:false,installation:await installVerifier(config)};
  check(isAbsolute(jobPath??'')&&isAbsolute(observationsPath??''),'absolute_host_path_required');
  for(const path of [configPath,jobPath,observationsPath])await outside(path,config.candidate_roots);
  const read=path=>readBounded(dirname(path),path.split('/').at(-1));
  return runHostVerification(config,await read(jobPath),await read(observationsPath));
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
  try{console.log(JSON.stringify(await cli(),null,2));}catch(error){console.log(JSON.stringify({...safeFailure(error),gate_enforced:false,merge_authorized:false}));process.exitCode=1;}
}
