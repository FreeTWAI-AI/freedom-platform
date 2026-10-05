import { z } from 'zod';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { isAbsolute,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { WorkerPrivateAiProfileSchema,PrivateAiPublicKeySchema } from '../../../apps/platform-api/src/worker-private-ai-profile.js';
import { BrokerWorkerProfileSchema } from '../../../apps/credential-broker/src/worker-profile.js';
import { importPinnedEd25519 } from '../../../apps/credential-broker/src/worker-keys.js';
import { parseBoundedJson } from '../../../packages/execution-state/decode.js';
// @ts-expect-error Existing release library is JavaScript without declarations.
import { loadManifest } from './manifest.mjs';
// @ts-expect-error Existing release library is JavaScript without declarations.
import { parseJsonc } from './wrangler.mjs';

const digest=z.string().regex(/^[0-9a-f]{64}$/),sha=z.string().regex(/^[0-9a-f]{40}$/);
/** Separate operator expectation, obtained from reviewed deployment evidence.
 * This is never inferred from the candidate profiles or the historical manifest. */
export const PrivateAiExpectedBindingsSchema=z.object({
  environment:z.enum(['staging-next','next']),
  media_bucket:z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  source_root:z.string().min(2).max(4096).refine(value=>isAbsolute(value)&&resolve(value)===value),
}).strict();
type ExpectedBindings=z.infer<typeof PrivateAiExpectedBindingsSchema>;
/** Public installation metadata only. Strict schemas reject private d, KEKs,
 * provider credentials and invented owner/device approvals. */
export const PrivateAiPreflightInputSchema=z.object({
  environment:z.enum(['staging-next','next']),
  release:z.object({source_sha:sha,main_artifact_sha256:digest,broker_artifact_sha256:digest}).strict(),
  main:WorkerPrivateAiProfileSchema,broker:BrokerWorkerProfileSchema,
  requestPublicKey:PrivateAiPublicKeySchema,responsePublicKey:PrivateAiPublicKeySchema,
  ingestRequestPublicKey:PrivateAiPublicKeySchema.optional(),ingestResponsePublicKey:PrivateAiPublicKeySchema.optional(),
}).strict();
type Input=z.infer<typeof PrivateAiPreflightInputSchema>;
type Pin={keyId:string;publicJwk:z.infer<typeof PrivateAiPublicKeySchema>};
const unavailable=Object.freeze([
  'release_approval_and_source_artifact_provenance_not_verified',
  'deployed_versions_and_service_binding_identities_not_verified',
  'hyperdrive_cache_database_role_and_grants_not_verified',
  'private_r2_binding_and_persistence_policy_not_verified',
  'private_signer_correspondence_and_kek_installation_not_verified',
  'installed_public_profiles_and_signer_exports_not_verified',
  'recovery_state_floor_agreement_and_outage_behavior_not_verified',
  'protected_capture_controls_and_live_readiness_not_verified',
  'owner_model_choice_device_pairing_and_provider_acceptance_not_run',
  'owner_result_edit_stop_revoke_and_recovery_withdrawal_not_run',
]);
const samePins=(a:Pin[],b:Pin[])=>JSON.stringify(a.map(p=>[p.keyId,p.publicJwk.x]).sort())===JSON.stringify(b.map(p=>[p.keyId,p.publicJwk.x]).sort());
const pinned=(pins:Pin[],kid:string,key:{x:string})=>pins.some(pin=>pin.keyId===kid&&pin.publicJwk.x===key.x);
const exactOrigin=(value:string)=>{try{return value.startsWith('https://')&&new URL(value).origin===value;}catch{return false;}};

/** Offline checks are reusable by release preparation. Actual bytes are supplied
 * by the bounded file reader below, not a caller assertion about their digest.
 * This report never grants deployment or execution authority. */
export async function checkPrivateAiInstallation(raw:unknown,options:{expectedSourceSha:string;expectedBindings:unknown;mainArtifact:Uint8Array;brokerArtifact:Uint8Array;mainConfig:any;brokerConfig:any}){
  const errors:string[]=[];
  const parsed=PrivateAiPreflightInputSchema.safeParse(raw);
  const base={schema:'freedom.private-ai-installation-preflight/v1',deployment_ready:false,enabled_by_this_tool:false,
    deployment_authority:false,execution_authority:false,remote_cloud:'not_run',artifact_bytes_verified:false,
    binding_expectation_source:'separate_operator_input',binding_remote_attestation:'unavailable',operator_binding_correspondence:'not_checked',unavailable:[...unavailable]};
  if(!parsed.success)return {...base,status:'invalid',static_checks_pass:false,errors:['public_installation_input_invalid']};
  const expected=PrivateAiExpectedBindingsSchema.safeParse(options.expectedBindings);
  if(!expected.success)return {...base,status:'invalid',static_checks_pass:false,errors:['operator_expected_bindings_invalid']};
  const input=parsed.data,{main,broker,environment,release}=input;
  const check=(condition:unknown,code:string)=>{if(!condition)errors.push(code);};
  check(sha.safeParse(options.expectedSourceSha).success&&release.source_sha===options.expectedSourceSha,'expected_source_release_mismatch');
  const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
  check(options.mainArtifact.byteLength>0&&hash(options.mainArtifact)===release.main_artifact_sha256,'main_artifact_digest_mismatch');
  check(options.brokerArtifact.byteLength>0&&hash(options.brokerArtifact)===release.broker_artifact_sha256,'broker_artifact_digest_mismatch');
  const manifest=loadManifest(),canonical=manifest.environments[environment],origin='https://'+canonical.hostname;
  check(main.environment===environment&&broker.environment===environment&&main.platformOrigin===origin&&broker.platformOrigin===origin,'profile_environment_origin_mismatch');
  check(broker.databaseName===canonical.database.dbname&&broker.cipherRole===broker.databaseName+'_broker'&&broker.executorRole===broker.databaseName+'_broker_executor','broker_sql_identity_mismatch');
  check(main.clientId===broker.clientId&&main.issuer===broker.issuer&&main.audience===broker.requestAudience&&main.brokerIdentity===broker.brokerId&&main.responseAudience===broker.responseAudience,'execution_identity_mismatch');
  check(main.recoveryAuthority===broker.recoveryAuthority&&samePins(main.recoveryKeys,broker.recoveryKeys),'recovery_trust_mismatch');
  check(pinned(broker.requestKeys,main.requestKid,input.requestPublicKey),'request_signer_not_pinned');
  check(pinned(main.responseKeys,broker.responseKeyId,input.responsePublicKey),'response_signer_not_pinned');
  check(Boolean(main.ingest)===Boolean(broker.ingest),'ingest_profile_pair_missing');
  if(main.bootstrap)check(main.bootstrap.environment===environment&&main.bootstrap.clientId===main.clientId,'bootstrap_identity_mismatch');
  if(main.ingest&&broker.ingest){
    check(exactOrigin(main.ingest.setupOrigin)&&main.ingest.setupOrigin!==origin&&main.ingest.setupOrigin===broker.ingest.setupOrigin&&main.ingest.issuer===broker.ingest.issuer&&main.ingest.audience===broker.ingest.audience,'ingest_identity_mismatch');
    check(input.ingestRequestPublicKey&&pinned(broker.ingest.requestKeys,main.ingest.keyId,input.ingestRequestPublicKey),'ingest_request_signer_not_pinned');
    check(Boolean(input.ingestResponsePublicKey),'ingest_response_public_key_missing');
    check(broker.ingest.responseIssuer!==broker.brokerId&&broker.ingest.responseAudience!==broker.responseAudience,'ingest_response_identity_reused');
  }else{
    check(!input.ingestRequestPublicKey&&!input.ingestResponsePublicKey,'unexpected_ingest_public_key');
    base.unavailable.push('credential_setup_profiles_not_installed');
  }
  // Register each purpose once, including rotation pins. The same legitimate
  // identity in both Workers is deduplicated; reuse across purposes is rejected.
  const groups:Pin[][]=[broker.requestKeys,main.responseKeys,main.recoveryKeys];
  if(broker.ingest){groups.push(broker.ingest.requestKeys,broker.ingest.readinessKeys);
    if(input.ingestResponsePublicKey)groups.push([{keyId:broker.ingest.responseKeyId,publicJwk:input.ingestResponsePublicKey}]);}
  try{const seen=new Set<string>();for(const group of groups)await importPinnedEd25519(group,seen);}
  catch{errors.push('public_key_invalid_duplicate_or_reused_across_purposes');}
  // Parse shapes again for duplicate recovery pins on either side, including
  // inputs whose pin equality check already failed. Never echo key material.
  try{await importPinnedEd25519(broker.recoveryKeys,new Set());}
  catch{errors.push('broker_recovery_keys_invalid');}
  const bindingErrors:string[]=[];
  checkBindings(input,options.mainConfig,options.brokerConfig,canonical,expected.data,(condition,code)=>{if(!condition)bindingErrors.push(code);});
  errors.push(...bindingErrors);
  return {...base,status:errors.length?'invalid':'unavailable',static_checks_pass:errors.length===0,environment,
    release,artifact_bytes_verified:!errors.some(e=>e.endsWith('artifact_digest_mismatch')),
    operator_binding_correspondence:bindingErrors.length?'mismatch':'matched',errors};
}

function checkBindings(input:Input,mainConfig:any,brokerConfig:any,canonical:any,expected:ExpectedBindings,check:(condition:unknown,code:string)=>void){
  const environment=input.environment,m=mainConfig?.env?.[environment],b=brokerConfig?.env?.[environment];
  if(!m||!b){check(false,'selected_worker_config_missing');return;}
  const origin='https://'+canonical.hostname;
  check(expected.environment===environment,'operator_binding_environment_mismatch');
  // Fixed suffixes only: no basename matching, traversal or arbitrary absolute
  // entry. Checkout contents/provenance still require separate release evidence.
  const entry=(actual:unknown,suffix:string)=>actual===suffix||actual===resolve(expected.source_root,suffix);
  check(entry(mainConfig.main,'apps/platform-api/src/worker.ts')&&entry(brokerConfig.main,'apps/credential-broker/src/worker.ts'),'worker_entry_mismatch');
  check(mainConfig.vars?.FREEDOM_PRIVATE_AI_ENABLED==='false'&&brokerConfig.vars?.FREEDOM_BROKER_ENABLED==='false'&&m.vars?.FREEDOM_PRIVATE_AI_ENABLED==='false'&&b.vars?.FREEDOM_BROKER_ENABLED==='false','candidate_flags_must_remain_off');
  check(m.vars?.APP_ORIGIN===origin&&m.vars?.FREEDOM_ENV===(environment==='next'?'public':'staging')&&b.vars?.APP_ORIGIN===origin&&b.vars?.FREEDOM_BROKER_ENVIRONMENT===environment,'worker_environment_origin_mismatch');
  check(m.vars?.FREEDOM_RELEASE_SHA===input.release.source_sha&&b.vars?.FREEDOM_RELEASE_SHA===input.release.source_sha,'worker_release_sha_mismatch');
  for(const [raw,profile] of [[m.vars?.FREEDOM_PRIVATE_AI_PROFILE,input.main],[b.vars?.FREEDOM_BROKER_PROFILE,input.broker]]){
    if(raw!==undefined){try{check(typeof raw==='string'&&isDeepStrictEqual(parseBoundedJson(raw),profile),'configured_public_profile_mismatch');}catch{check(false,'configured_public_profile_mismatch');}}
  }
  for(const [config,block] of [[mainConfig,m],[brokerConfig,b]]){
    check(config.workers_dev===false&&config.preview_urls===false&&block.workers_dev!==true&&block.preview_urls!==true,'public_preview_not_disabled');
    check(!Object.keys({...config.vars,...block.vars}).some(key=>/(?:KEY|KEKS|SECRET|TOKEN|PASSWORD)$/.test(key)),'secret_in_plain_vars');
  }
  check(!(b.routes?.length||b.route||brokerConfig.routes?.length||brokerConfig.route),'broker_public_route_not_reviewed');
  const service=(block:any,name:string)=>{const rows=(block.services??[]).filter((row:any)=>row.binding===name);return rows.length===1?rows[0]:null;};
  const mainServices=['MODEL_BROKER','CREDENTIAL_RECOVERY_STATE','CREDENTIAL_RECOVERY_FLOOR'].map(name=>service(m,name));
  const brokerNames=['CREDENTIAL_RECOVERY_STATE','CREDENTIAL_RECOVERY_FLOOR',...(input.broker.ingest?['CREDENTIAL_INGEST_READINESS']:[])];
  const brokerServices=brokerNames.map(name=>service(b,name));
  const validService=(row:any)=>row&&typeof row.service==='string'&&row.service.length>0&&!/^replace[-_]/.test(row.service)&&!row.environment&&!row.entrypoint;
  check([...mainServices,...brokerServices].every(validService),'service_binding_missing_placeholder_or_override');
  check(mainServices[0]?.service===b.name&&typeof b.name==='string'&&b.name!==m.name&&m.name===canonical.worker.name,'model_broker_service_identity_mismatch');
  check(new Set(mainServices.map(row=>row?.service)).size===3&&new Set(brokerServices.map(row=>row?.service)).size===brokerServices.length,'service_purposes_not_separate');
  check([...mainServices.slice(1),...brokerServices].every(row=>row?.service!==m.name&&row?.service!==b.name),'recovery_or_readiness_bound_to_application_worker');
  check((b.services??[]).length===brokerNames.length,'unexpected_broker_service_binding');
  check(mainServices[1]?.service===brokerServices[0]?.service&&mainServices[2]?.service===brokerServices[1]?.service,'recovery_service_binding_mismatch');
  const bindings=[...(m.hyperdrive??[]),...(b.hyperdrive??[])];
  check((m.hyperdrive??[]).length===1&&m.hyperdrive[0]?.binding==='HYPERDRIVE'&&(b.hyperdrive??[]).length===2&&['CIPHER_HYPERDRIVE','EXECUTOR_HYPERDRIVE'].every(name=>b.hyperdrive.filter((row:any)=>row.binding===name).length===1),'hyperdrive_role_bindings_invalid');
  check(bindings.length===3&&bindings.every((row:any)=>/^[0-9a-f]{32}$/.test(row.id??'')&&!/^0+$/.test(row.id))&&new Set(bindings.map((row:any)=>row.id)).size===3,'hyperdrive_unprovisioned_or_shared');
  const bucket=expected.media_bucket;
  check([m,b].every(block=>{const rows=(block.r2_buckets??[]).filter((row:any)=>row.binding==='MEDIA');return rows.length===1&&rows[0].bucket_name===bucket&&!rows[0].preview_bucket_name;}),'private_media_binding_mismatch');
}

/** Require owned, private, regular input files; no credentials are needed or
 * accepted. Read a bounded buffer from the opened inode; never follow symlinks. */
async function readPrivateFile(path:string,max:number){
  if(!isAbsolute(path))throw Error();
  const initial=await lstat(path);if(!initial.isFile()||(initial.mode&0o077)!==0||initial.uid!==process.getuid?.())throw Error();
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await file.stat();if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.dev!==initial.dev||stat.ino!==initial.ino||stat.size>max)throw Error();
    const buffer=Buffer.alloc(max+1);const {bytesRead}=await file.read(buffer,0,max+1,0);if(bytesRead>max)throw Error();return buffer.subarray(0,bytesRead);
  }finally{await file.close();}
}
export async function privateAiPreflightMain(argv:string[]){
  const names=['--profiles','--main-config','--broker-config','--main-artifact','--broker-artifact','--expected-source-sha','--expected-bindings'];
  if(argv.length!==names.length*2)throw Error();
  const args=new Map<string,string>();for(let i=0;i<argv.length;i+=2){if(!names.includes(argv[i])||args.has(argv[i])||!argv[i+1])throw Error();args.set(argv[i],argv[i+1]);}
  const profiles=parseBoundedJson((await readPrivateFile(args.get('--profiles')!,131072)).toString('utf8'));
  const mainConfig=parseJsonc((await readPrivateFile(args.get('--main-config')!,131072)).toString('utf8'));
  const brokerConfig=parseJsonc((await readPrivateFile(args.get('--broker-config')!,131072)).toString('utf8'));
  const expectedBindings=parseBoundedJson((await readPrivateFile(args.get('--expected-bindings')!,8192)).toString('utf8'));
  const report=await checkPrivateAiInstallation(profiles,{expectedSourceSha:args.get('--expected-source-sha')!,expectedBindings,mainConfig,brokerConfig,
    mainArtifact:await readPrivateFile(args.get('--main-artifact')!,32*1024*1024),brokerArtifact:await readPrivateFile(args.get('--broker-artifact')!,32*1024*1024)});
  process.stdout.write(JSON.stringify(report,null,2)+'\n');return report.static_checks_pass?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  privateAiPreflightMain(process.argv.slice(2)).then(code=>{process.exitCode=code;},()=>{process.stderr.write('Private AI installation preflight unavailable: invalid arguments or private input files. No runtime checks performed.\n');process.exitCode=2;});
}
