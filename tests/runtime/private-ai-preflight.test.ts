import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkPrivateAiInstallation} from '../../deploy/cloudflare/lib/private-ai-preflight.js';

const source='a'.repeat(40),mainArtifact=Buffer.from('synthetic main artifact'),brokerArtifact=Buffer.from('synthetic broker artifact');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){
  const keys=await Promise.all(Array.from({length:6},async()=>{const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);const {kty,crv,x}=await crypto.subtle.exportKey('jwk',pair.publicKey);return {kty,crv,x} as {kty:'OKP';crv:'Ed25519';x:string};}));
  const [request,response,recovery,ingestRequest,ingestResponse,readiness]=keys;
  const pin=(keyId:string,publicJwk:typeof request)=>({keyId,publicJwk});
  const input={environment:'staging-next',release:{source_sha:source,main_artifact_sha256:hash(mainArtifact),broker_artifact_sha256:hash(brokerArtifact)},
    main:{environment:'staging-next',platformOrigin:'https://staging.freetwai.com',clientId:'private-ai-preflight-test',issuer:'main',audience:'broker',brokerIdentity:'broker',responseAudience:'main',requestKid:'request',responseKeys:[pin('response',response)],recoveryAuthority:'recovery',recoveryKeys:[pin('recovery',recovery)],settingsSelections:[],ingest:{setupOrigin:'https://setup.example.invalid',issuer:'main-ingest',audience:'broker-ingest',keyId:'ingest-request'}},
    broker:{environment:'staging-next',platformOrigin:'https://staging.freetwai.com',clientId:'private-ai-preflight-test',issuer:'main',requestAudience:'broker',brokerId:'broker',responseAudience:'main',responseKeyId:'response',requestKeys:[pin('request',request)],recoveryAuthority:'recovery',recoveryKeys:[pin('recovery',recovery)],databaseName:'freedom_staging_next',cipherRole:'freedom_staging_next_broker',executorRole:'freedom_staging_next_broker_executor',currentKekId:'kek',ingest:{setupOrigin:'https://setup.example.invalid',issuer:'main-ingest',audience:'broker-ingest',requestKeys:[pin('ingest-request',ingestRequest)],responseIssuer:'broker-ingest-response',responseAudience:'setup',responseKeyId:'ingest-response',readinessAuthority:'readiness',readinessKeys:[pin('readiness',readiness)]}},
    requestPublicKey:request,responsePublicKey:response,ingestRequestPublicKey:ingestRequest,ingestResponsePublicKey:ingestResponse};
  // Read only public canonical bindings from the existing operator manifest.
  // @ts-expect-error Existing release library is JavaScript without declarations.
  const {loadManifest}=await import('../../deploy/cloudflare/lib/manifest.mjs');
  // @ts-expect-error Existing release library is JavaScript without declarations.
  const {purposeBuckets}=await import('../../deploy/cloudflare/lib/r2-purposes.mjs');
  const canonical=loadManifest().environments['staging-next'];
  const shared={workers_dev:false,preview_urls:false,r2_buckets:[{binding:'MEDIA',bucket_name:purposeBuckets(canonical).MEDIA.name}]};
  const recoveryServices=[{binding:'CREDENTIAL_RECOVERY_STATE',service:'synthetic-recovery-state'},{binding:'CREDENTIAL_RECOVERY_FLOOR',service:'synthetic-recovery-floor'}];
  const mainConfig={main:'apps/platform-api/src/worker.ts',workers_dev:false,preview_urls:false,vars:{FREEDOM_PRIVATE_AI_ENABLED:'false'},env:{'staging-next':{...shared,name:canonical.worker.name,vars:{FREEDOM_PRIVATE_AI_ENABLED:'false',FREEDOM_ENV:'staging',APP_ORIGIN:'https://staging.freetwai.com',FREEDOM_RELEASE_SHA:source},services:[{binding:'MODEL_BROKER',service:'synthetic-broker'},...recoveryServices],hyperdrive:[{binding:'HYPERDRIVE',id:'1'.repeat(32)}]}}};
  const brokerConfig={main:'apps/credential-broker/src/worker.ts',workers_dev:false,preview_urls:false,vars:{FREEDOM_BROKER_ENABLED:'false'},env:{'staging-next':{...shared,name:'synthetic-broker',vars:{FREEDOM_BROKER_ENABLED:'false',FREEDOM_BROKER_ENVIRONMENT:'staging-next',APP_ORIGIN:'https://staging.freetwai.com',FREEDOM_RELEASE_SHA:source},services:[...recoveryServices,{binding:'CREDENTIAL_INGEST_READINESS',service:'synthetic-readiness'}],hyperdrive:[{binding:'CIPHER_HYPERDRIVE',id:'2'.repeat(32)},{binding:'EXECUTOR_HYPERDRIVE',id:'3'.repeat(32)}]}}};
  return {input,options:{expectedSourceSha:source,mainArtifact,brokerArtifact,mainConfig,brokerConfig}};
}
test('matching public installation metadata verifies bytes but cannot claim deployed, enabled or owner-ready',async()=>{
  const f=await fixture(),report=await checkPrivateAiInstallation(f.input,f.options);
  assert.equal(report.static_checks_pass,true);assert.equal(report.status,'unavailable');
  for(const field of ['deployment_ready','enabled_by_this_tool','deployment_authority','execution_authority'] as const)assert.equal(report[field],false);
  assert.equal(report.remote_cloud,'not_run');assert.equal(report.artifact_bytes_verified,true);
  assert(report.unavailable.includes('owner_model_choice_device_pairing_and_provider_acceptance_not_run'));
  const rendered=JSON.stringify(report);assert(!rendered.includes(f.input.requestPublicKey.x));assert(!rendered.includes('synthetic-broker'));
});
test('production uses its own canonical origin, SQL roles, Worker and private bucket',async()=>{
  const f:any=await fixture();
  // @ts-expect-error Existing release library is JavaScript without declarations.
  const {loadManifest}=await import('../../deploy/cloudflare/lib/manifest.mjs');
  // @ts-expect-error Existing release library is JavaScript without declarations.
  const {purposeBuckets}=await import('../../deploy/cloudflare/lib/r2-purposes.mjs');
  const canonical=loadManifest().environments.next;
  f.input.environment='next';
  for(const profile of [f.input.main,f.input.broker]){profile.environment='next';profile.platformOrigin='https://freetwai.com';}
  Object.assign(f.input.broker,{databaseName:'freedom_next',cipherRole:'freedom_next_broker',executorRole:'freedom_next_broker_executor'});
  for(const config of [f.options.mainConfig,f.options.brokerConfig]){const block=config.env['staging-next'];delete config.env['staging-next'];config.env.next=block;block.vars.APP_ORIGIN='https://freetwai.com';block.r2_buckets=[{binding:'MEDIA',bucket_name:purposeBuckets(canonical).MEDIA.name}];}
  f.options.mainConfig.env.next.name=canonical.worker.name;f.options.mainConfig.env.next.vars.FREEDOM_ENV='public';f.options.brokerConfig.env.next.vars.FREEDOM_BROKER_ENVIRONMENT='next';
  assert.equal((await checkPrivateAiInstallation(f.input,f.options)).static_checks_pass,true);
  f.options.mainConfig.env.next.vars.APP_ORIGIN='https://staging.freetwai.com';
  assert.equal((await checkPrivateAiInstallation(f.input,f.options)).static_checks_pass,false);
});
test('exact bytes, source identity and OFF flags are required independently',async()=>{
  for(const mutate of [
    (f:any)=>f.options.mainArtifact=Buffer.from('different main'),
    (f:any)=>f.options.brokerArtifact=Buffer.from('different broker'),
    (f:any)=>f.options.expectedSourceSha='b'.repeat(40),
    (f:any)=>f.options.mainConfig.env['staging-next'].vars.FREEDOM_PRIVATE_AI_ENABLED='true',
    (f:any)=>f.options.brokerConfig.env['staging-next'].vars.FREEDOM_BROKER_ENABLED='true',
    (f:any)=>f.options.mainConfig.env['staging-next'].vars.FREEDOM_RELEASE_SHA='c'.repeat(40),
    (f:any)=>f.options.mainConfig.env['staging-next'].vars.FREEDOM_PRIVATE_AI_PROFILE=JSON.stringify({...f.input.main,issuer:'wrong'}),
  ]){const f=await fixture();mutate(f);assert.equal((await checkPrivateAiInstallation(f.input,f.options)).static_checks_pass,false);}
});
test('rejects wrong directions, mismatched authority/pins, duplicate keys, cross-purpose material and noncanonical aliases',async()=>{
  const changes=[
    (f:any)=>f.input.main.audience='wrong',
    (f:any)=>f.input.broker.environment='next',
    (f:any)=>f.input.main.recoveryAuthority='wrong',
    (f:any)=>f.input.main.recoveryKeys[0].keyId='wrong',
    (f:any)=>f.input.broker.requestKeys[0].keyId='wrong',
    (f:any)=>f.input.main.responseKeys[0].keyId='wrong',
    (f:any)=>f.input.broker.requestKeys.push(f.input.broker.requestKeys[0]),
    (f:any)=>f.input.broker.ingest.readinessKeys[0].publicJwk=f.input.requestPublicKey,
    (f:any)=>f.input.ingestResponsePublicKey=f.input.responsePublicKey,
    (f:any)=>f.input.broker.ingest.requestKeys[0].publicJwk=f.input.responsePublicKey,
    (f:any)=>f.input.broker.ingest.setupOrigin='https://other.example.invalid',
    (f:any)=>f.input.main.ingest.setupOrigin=f.input.main.platformOrigin,
    (f:any)=>delete f.input.broker.ingest,
    (f:any)=>{const x=f.input.broker.ingest.readinessKeys[0].publicJwk.x;const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';f.input.broker.ingest.readinessKeys[0].publicJwk.x=x.slice(0,-1)+alphabet[alphabet.indexOf(x.at(-1))+1];},
  ];
  for(const mutate of changes){const f=await fixture();mutate(f);assert.equal((await checkPrivateAiInstallation(f.input,f.options)).static_checks_pass,false);}
});
test('binding correspondence rejects wrong broker, recovery collapse, shared SQL, bucket drift and plain secrets',async()=>{
  for(const mutate of [
    (m:any,b:any)=>m.services[0].service='other-broker',
    (m:any,b:any)=>b.services[0].service=b.services[1].service,
    (m:any,b:any)=>b.services[2].service=b.services[0].service,
    (m:any,b:any)=>b.services[2].service=b.name,
    (m:any,b:any)=>b.hyperdrive[0].id=m.hyperdrive[0].id,
    (m:any,b:any)=>b.hyperdrive[0].id='0'.repeat(32),
    (m:any,b:any)=>m.r2_buckets=[{binding:'MEDIA',bucket_name:'wrong'}],
    (m:any,b:any)=>b.vars.FREEDOM_BROKER_KEKS='synthetic-secret-must-not-echo',
    (m:any,b:any)=>b.routes=[{pattern:'setup.example.invalid/*'}],
  ]){const f=await fixture();mutate(f.options.mainConfig.env['staging-next'],f.options.brokerConfig.env['staging-next']);const report=await checkPrivateAiInstallation(f.input,f.options);assert.equal(report.static_checks_pass,false);assert(!JSON.stringify(report).includes('synthetic-secret-must-not-echo'));}
});
test('private secret fields are rejected with fixed diagnostics, missing setup remains explicitly unavailable',async()=>{
  const f=await fixture();(f.input.requestPublicKey as any).d='DO_NOT_ECHO_SECRET';
  const report=await checkPrivateAiInstallation(f.input,f.options);assert.deepEqual(report.errors,['public_installation_input_invalid']);assert(!JSON.stringify(report).includes('DO_NOT_ECHO_SECRET'));
  const noSetup=await fixture();delete (noSetup.input.main as any).ingest;delete (noSetup.input.broker as any).ingest;delete (noSetup.input as any).ingestRequestPublicKey;delete (noSetup.input as any).ingestResponsePublicKey;
  noSetup.options.brokerConfig.env['staging-next'].services.pop();
  const absent=await checkPrivateAiInstallation(noSetup.input,noSetup.options);assert.equal(absent.static_checks_pass,true);assert(absent.unavailable.includes('credential_setup_profiles_not_installed'));
});
test('existing broker CLI runs filled mode, hashes private artifact files and sanitizes malformed/private path failures',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fp-private-ai-preflight-'));
  try{
    const f=await fixture(),files=[['profiles',JSON.stringify(f.input)],['main-config',JSON.stringify(f.options.mainConfig)],['broker-config',JSON.stringify(f.options.brokerConfig)],['main-artifact',mainArtifact],['broker-artifact',brokerArtifact]] as const;
    for(const [name,bytes]of files)await writeFile(join(directory,name),bytes,{mode:0o600});
    const args=['--installation',...files.flatMap(([name])=>['--'+name,join(directory,name)]),'--expected-source-sha',source];
    const run=()=>spawnSync(process.execPath,[resolve('deploy/cloudflare/broker-preflight.mjs'),...args],{encoding:'utf8'});
    let result=run();assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'unavailable');
    await writeFile(join(directory,'main-artifact'),'changed');result=run();assert.equal(result.status,1);assert(JSON.parse(result.stdout).errors.includes('main_artifact_digest_mismatch'));
    await chmod(join(directory,'profiles'),0o644);result=run();assert.equal(result.status,2);assert(!result.stderr.includes(directory));assert.equal(result.stdout,'');
    await chmod(join(directory,'profiles'),0o600);await rm(join(directory,'main-artifact'));await symlink(join(directory,'broker-artifact'),join(directory,'main-artifact'));result=run();assert.equal(result.status,2);assert(!result.stderr.includes(directory));
  }finally{await rm(directory,{recursive:true,force:true});}
});
