import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {CompactSign} from 'jose';
import {nativeBrokerSqlFixture,minimalJwk,profile} from '../tests/worker/private-ai-fixtures/native-broker-sql.js';
import {installNativeMain,nativeCall,nativePair,memberPost,ingestProfile,setupOrigin} from '../tests/worker/private-ai-fixtures/native-main.js';
import {createAcceptanceEgress,durableCreate,privateDirectory,privateKeyBytes,validateBudget,reserveSessionBudget} from './lib/openrouter-acceptance-guard.js';

const Config=z.object({profile:z.literal('private-ai.openrouter-owner-acceptance/v1'),
  acknowledgeRealProvider:z.literal(true),expectedRelease:z.string().regex(/^[a-f0-9]{40}$/),
  keyFile:z.string().min(1),receiptDirectory:z.string().min(1),ledgerDirectory:z.string().min(1),model:z.string(),expiresAt:z.string(),maxUsd:z.number()}).strict();
const check=(value:unknown):void=>{if(!value)throw Error('acceptance_check_failed');};
async function safeJson(response:Response,status=200){check(response.status===status);return response.json() as Promise<any>;}

/** Explicit operator invocation only. No environment contains the model key.
 * Local synthetic owner/pairing/recovery + SQL + native R2 emulator; only the
 * fixed OpenRouter provider endpoints use genuine public HTTPS. */
export async function run(configPath:string) {
  const config=Config.parse(JSON.parse(await readFile(configPath,'utf8')));
  validateBudget(config);await privateDirectory(config.receiptDirectory);
  const {stdout:head}=await promisify(execFile)('git',['rev-parse','HEAD']);check(head.trim()===config.expectedRelease);
  const {stdout:dirty}=await promisify(execFile)('git',['status','--porcelain']);check(dirty==='');
  const source=resolve(fileURLToPath(new URL('..',import.meta.url)));check(resolve(process.cwd())===source);
  const runId=randomUUID(),startedAt=new Date().toISOString();
  await durableCreate(join(config.receiptDirectory,'intent.json'),{profile:config.profile,runId,startedAt,source:config.expectedRelease,
    model:config.model,maxOutputTokens:128,maxProviderPosts:1,maxUsd:config.maxUsd,expiresAt:config.expiresAt,
    owner:'synthetic_local',database:'owned_local_postgresql',objectStore:'native_R2_emulator',provider:'real_https_openrouter',
    remoteR2:'not_run',remoteCloud:'not_run',captureReadiness:'synthetic_local_assertion',rerun:'forbidden_after_intent'});
  let sessionBudget:Awaited<ReturnType<typeof reserveSessionBudget>>|undefined;let cleanupCompleted=false;
  const egress=createAcceptanceEgress(config,config.receiptDirectory,globalThis.fetch);
  let stage='budget_reservation',f:Awaited<ReturnType<typeof nativeBrokerSqlFixture>>|undefined;
  const checks:Record<string,boolean>={};let resultSha256:string|undefined,resultBytes:number|undefined;
  try {
    sessionBudget=await reserveSessionBudget(config.ledgerDirectory,runId,config);stage='fixture';
    const ingestKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
    const responseKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
    const readinessKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
    const selection={providerRef:'openrouter',modelRef:config.model,processingLocation:'provider_remote',artifactCustody:'platform_asset',
      credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
    f=await nativeBrokerSqlFixture(async context=>{
      const {keyId,setupOrigin,issuer,audience}=ingestProfile;
      context.brokerWorker.bindings={...context.brokerWorker.bindings,
        FREEDOM_BROKER_PROFILE:JSON.stringify({...context.workerProfile,ingest:{setupOrigin,issuer,audience,
          requestKeys:[{keyId,publicJwk:await minimalJwk(ingestKeys.publicKey)}],responseIssuer:'synthetic-ingest-response',
          responseAudience:'synthetic-ingest-client',responseKeyId:'ingest-response',readinessAuthority:'synthetic-capture-readiness',
          readinessKeys:[{keyId:'capture-readiness',publicJwk:await minimalJwk(readinessKeys.publicKey)}]}}),
        FREEDOM_BROKER_INGEST_RESPONSE_KEY:JSON.stringify(await minimalJwk(responseKeys.privateKey))};
      context.brokerWorker.serviceBindings={...context.brokerWorker.serviceBindings,CREDENTIAL_INGEST_READINESS:async()=>{
        const now=Date.now();const signedReadiness=await new CompactSign(new TextEncoder().encode(JSON.stringify({profile:'credential-broker.capture-readiness/v1',
          purpose:'credential-broker.capture-readiness',authority:'synthetic-capture-readiness',environment:profile.environment,origin:setupOrigin,captureDisabled:true,
          issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString()})))
          .setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-capture-readiness+jws',kid:'capture-readiness'}).sign(readinessKeys.privateKey);
        return Response.json({signedReadiness});
      }};
      // Remove every synthetic provider/unused broker clone. This handler forwards
      // exact genuine HTTPS; it does not fabricate provider/model/usage responses.
      context.workers.splice(0,context.workers.length,...context.workers.filter(w=>!['synthetic-provider','foreign-profile','swapped-roles'].includes(w.name??'')));
      context.brokerWorker.outboundService=request=>egress.forward(request as unknown as Request) as never;
      await installNativeMain(context,ingestKeys);
      const main=context.workers.find(w=>w.name==='main')!;
      main.bindings={...main.bindings,FREEDOM_RELEASE_SHA:config.expectedRelease,
        FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify({...JSON.parse(String(main.bindings!.FREEDOM_PRIVATE_AI_PROFILE)),settingsSelections:[selection]})};

    },{quiet:true});
    stage='owner_pairing';const human=await f.member(),paired=await nativePair(f,human);
    const get=(path:string)=>nativeCall(f!,'main',path,{headers:{Cookie:human.headers.Cookie}});
    const settings=await safeJson(await get('/api/v1/me/model-settings'));check(settings.setup?.setupOrigin===setupOrigin);
    const model=await memberPost(f,human,'/api/v1/me/model-connections',{connectionId:paired.connectionId,selection},'1',201);
    stage='separate_origin_ingest';
    const handoff=await memberPost(f,human,'/api/v1/me/credential-ingests',{operation:'create',modelConnectionId:model.modelConnectionId,consent:true},'1',201);
    check(handoff.setupOrigin===setupOrigin);
    const bootstrap=await nativeCall(f,'setup','/credential-setup',{method:'POST',headers:{Origin:f.mainOrigin,'Content-Type':'application/x-www-form-urlencoded',
      'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'},body:'assertion='+handoff.assertion});check(bootstrap.status===200);
    const html=await bootstrap.text(),csrf=/data-csrf="([A-Za-z0-9_-]{43})"/.exec(html)?.[1],cookie=bootstrap.headers.get('Set-Cookie')?.split(';')[0];
    check(csrf&&cookie?.startsWith('__Host-fp_broker_setup='));
    const setupHeaders={Origin:setupOrigin,Cookie:cookie!,'X-FP-Broker-CSRF':csrf!,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'same-origin','Sec-Fetch-Dest':'empty'};
    await safeJson(await nativeCall(f,'setup','/credential-setup/prepare',{method:'POST',headers:{...setupHeaders,'Content-Type':'application/json'},body:'{"consent":true}'}));
    const key=await privateKeyBytes(config.keyFile);
    try {await safeJson(await nativeCall(f,'setup','/credential-setup/secret',{method:'POST',headers:{...setupHeaders,'Content-Type':'application/octet-stream','Content-Length':String(key.length)},body:key}));}
    finally{key.fill(0);}
    check((await safeJson(await get('/api/v1/me/credential-ingests/'+handoff.authorizationRef))).state==='committed');checks.separateOriginIngest=true;
    for(const pool of [f.app,f.executor]){let denied=false;try{await pool.query('SELECT envelope FROM broker_credential_vault');}catch(error){denied=(error as {code?:string}).code==='42501';}check(denied);}
    checks.mainExecutorCipherDenied=true;
    await f.owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
      VALUES($1,$2,$3,$4,$5,$6,1,true,16384,128)`,[randomUUID(),human.context.scope.scope_id,human.context.subject_principal.principal_id,profile.environment,profile.clientId,JSON.stringify(selection)]);
    const post=async(path:string,body:unknown,version:string,key:string,status=200)=>safeJson(await nativeCall(f!,'main',path,{method:'POST',
      headers:{...human.headers,'Content-Type':'application/json','Idempotency-Key':key,'If-Match':'"'+version+'"'},body:JSON.stringify(body)}),status);
    async function prepareStep(title:string){
      const work=await memberPost(f!,human,'/api/v1/me/private-work',{title,objective:'Write one brief, harmless greeting for a fictional garden club. No tools, links, personal data or external actions.'},null,201);
      const run=await memberPost(f!,human,'/api/v1/me/execution-runs',{workId:work.workId},work.aggregateVersion,201);
      const grant=await memberPost(f!,human,'/api/v1/me/execution-runs/'+run.runId+'/grants',{expectedWorkVersion:work.aggregateVersion,connectionId:paired.connectionId,
        expectedConnectionVersion:'1',modelConnectionId:model.modelConnectionId,expectedModelVersion:model.aggregateVersion,consent:true},run.aggregateVersion,201);
      const approval=await memberPost(f!,human,'/api/v1/me/model-step-approvals',{runId:run.runId,grantId:grant.grantId,expectedGrantVersion:grant.aggregateVersion,
        expectedWorkVersion:work.aggregateVersion,consent:true,maxOutputTokens:128},run.aggregateVersion,201);
      const activationKey=randomUUID(),activationBody={approvalId:approval.approvalId,expectedRunVersion:run.aggregateVersion};
      const step=await post('/api/v1/me/model-steps',activationBody,approval.aggregateVersion,activationKey,201);
      check(step.evidenceOrigin==='provider_https');return {work,run,grant,approval,step,activationKey,activationBody};
    }
    stage='activation';const first=await prepareStep('Synthetic real-provider acceptance draft');
    await f.restartBroker();checks.brokerRestartBeforeExecution=true;
    const getsBefore=egress.summary().gets;
    await post('/api/v1/me/model-steps',first.activationBody,first.approval.aggregateVersion,first.activationKey,201);
    check(egress.summary().gets===getsBefore);checks.activationAckMetadataOnly=true;
    stage='execute_once';const executeKey=randomUUID();
    await durableCreate(join(config.receiptDirectory,'execution-command.json'),{stepId:first.step.stepId,key:executeKey,expectedVersion:first.step.aggregateVersion,
      note:'Evidence only. Never resubmit an unknown outcome.'});
    const path='/api/v1/me/model-steps/'+first.step.stepId+':execute';
    const final=await post(path,{},first.step.aggregateVersion,executeKey);check(final.state==='succeeded'&&final.evidenceOrigin==='provider_https');
    stage='result';const result=await safeJson(await get('/api/v1/me/private-work/'+first.work.workId+'/results/current'));
    check(typeof result.text==='string'&&result.text.length>0&&result.provenance==='model');
    const bucket=await f.mf.getR2Bucket('MEDIA','main'),objects=await bucket.list();check(objects.objects.length===1);
    check(await(await bucket.get(objects.objects[0].key))!.text()===result.text);
    resultSha256=createHash('sha256').update(result.text).digest('hex');resultBytes=Buffer.byteLength(result.text);
    checks.ownerResultAndNativeR2Read=true;egress.markResultCommitted();
    const foreign=await f.member();check((await nativeCall(f,'main','/api/v1/me/private-work/'+first.work.workId+'/results/current',{headers:{Cookie:foreign.headers.Cookie}})).status===404);checks.foreignOwnerDenied=true;
    await f.restartBroker();const beforeReplay=egress.summary();
    check((await post(path,{},first.step.aggregateVersion,executeKey)).state==='succeeded');
    check(egress.summary().posts===beforeReplay.posts&&egress.summary().gets===beforeReplay.gets);checks.completedReplayMetadataOnly=true;
    stage='owner_result_edit';
    const editedText=result.text+'\nSynthetic owner edit: welcome new gardeners.',editKey=randomUUID();
    const edited=await post('/api/v1/me/private-work/'+first.work.workId+'/results/'+result.resultId+'/edit',
      {text:editedText},result.aggregateVersion,editKey);
    check(edited.provenance==='human'&&edited.revision==='2');
    const revised=await safeJson(await get('/api/v1/me/private-work/'+first.work.workId+'/results/current'));
    check(revised.text===editedText&&revised.provenance==='human');
    const original=await safeJson(await get('/api/v1/me/private-work/'+first.work.workId+'/results/'+result.resultId));
    check(original.text===result.text&&original.provenance==='model');
    check((await bucket.list()).objects.length===2&&egress.summary().posts===1);checks.ownerResultEditPreservesSource=true;
    stage='recovery_stop_revoke';const second=await prepareStep('Synthetic reserved draft to cancel');
    await(await f.mf.getWorker('recovery-state')).fetch('https://freedom-private-ai.internal/unavailable');
    const denied=await nativeCall(f,'main','/api/v1/me/model-steps/'+second.step.stepId+':execute',{method:'POST',headers:{...human.headers,
      'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"'+second.step.aggregateVersion+'"'},body:'{}'});check(denied.status>=400);checks.recoveryWithdrawalDenied=true;
    check((await memberPost(f,human,'/api/v1/me/model-steps/'+second.step.stepId+':stop',{},second.step.aggregateVersion)).state==='cancelled');checks.stop=true;
    await memberPost(f,human,'/api/v1/me/model-step-approvals/'+second.approval.approvalId+':revoke',{},second.approval.aggregateVersion);
    await memberPost(f,human,'/api/v1/me/agent-connections/'+paired.connectionId+':revoke',{},'1');
    check((await f.owner.query('SELECT state FROM bootstrap_refresh_families WHERE family_id=$1',[paired.refresh.familyId])).rows[0].state==='revoked');checks.revoke=true;
    check(egress.summary().posts===1);check((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results')).rows[0].n===1);
    stage='complete';
  }catch { /* Only fixed stage/checks are persisted; never raw errors or bodies. */ }
  finally {
    let cleanup='not_created';if(f){try{await f.cleanup();cleanup='completed';cleanupCompleted=true;}catch{cleanup='unavailable';}}
    await durableCreate(join(config.receiptDirectory,'receipt.json'),{profile:'private-ai.openrouter-owner-receipt/v1',runId,source:config.expectedRelease,
      startedAt,finishedAt:new Date().toISOString(),status:stage==='complete'&&cleanup==='completed'?'pass':'unavailable',stage,checks,
      sessionBudget,provider:egress.summary(),resultSha256,resultBytes,cleanup,remoteR2:'not_run',remoteCloud:'not_run',realBrowserIngress:'not_run',humanResultEdit:checks.ownerResultEditPreservesSource?'synthetic_owner_native_API_pass':'not_run',
      recoveryAuthority:'synthetic_local',owner:'synthetic_local',noAutomaticRetry:true});
  }
  return stage==='complete'&&cleanupCompleted;
}

if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--config'){process.stderr.write('Usage: verify-openrouter-native-owner --config <private-config.json>\n');process.exitCode=2;}
  else try{const passed=await run(args[1]);process.stdout.write(passed?'acceptance_pass\n':'acceptance_unavailable_no_retry\n');process.exitCode=passed?0:2;}
  catch{process.stderr.write('acceptance_unavailable_no_retry\n');process.exitCode=2;}
}
