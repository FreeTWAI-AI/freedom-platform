import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {CompactSign} from 'jose';
import {nativeBrokerSqlFixture,minimalJwk,profile,modelSelection,secret,output} from './private-ai-fixtures/native-broker-sql.js';
import {installNativeMain,nativeCall,nativePair,memberPost,expectJson,ingestProfile,setupOrigin} from './private-ai-fixtures/native-main.js';

/** Every member/key/consent and provider response below is synthetic. Both
 * production Worker bundles run in local workerd with network interception;
 * this is not actual owner, provider, capture-policy or deployment evidence. */
test('local synthetic native main and broker: owner handoff, direct credential ingest, private R2 Result, Stop/Revoke and recovery outage',{timeout:180000},async()=>{
  const ingestKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const ingestResponseKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const readinessKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const fixture=await nativeBrokerSqlFixture(async context=>{
    const {keyId,setupOrigin,issuer,audience}=ingestProfile;
    context.brokerWorker.bindings={...context.brokerWorker.bindings,
      FREEDOM_BROKER_PROFILE:JSON.stringify({...context.workerProfile,ingest:{setupOrigin,issuer,audience,
        requestKeys:[{keyId,publicJwk:await minimalJwk(ingestKeys.publicKey)}],responseIssuer:'synthetic-ingest-response',responseAudience:'synthetic-ingest-client',responseKeyId:'ingest-response',
        readinessAuthority:'synthetic-capture-readiness',readinessKeys:[{keyId:'capture-readiness',publicJwk:await minimalJwk(readinessKeys.publicKey)}]}}),
      FREEDOM_BROKER_INGEST_RESPONSE_KEY:JSON.stringify(await minimalJwk(ingestResponseKeys.privateKey))};
    context.brokerWorker.serviceBindings={...context.brokerWorker.serviceBindings,CREDENTIAL_INGEST_READINESS:async(request)=>{
      assert.equal(request.url,'https://freedom-private-ai.internal/internal/credential-ingest/readiness');assert.equal(request.method,'GET');
      const now=Date.now(),signedReadiness=await new CompactSign(new TextEncoder().encode(JSON.stringify({profile:'credential-broker.capture-readiness/v1',
        purpose:'credential-broker.capture-readiness',authority:'synthetic-capture-readiness',environment:profile.environment,origin:setupOrigin,captureDisabled:true,
        issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString()})))
        .setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-capture-readiness+jws',kid:'capture-readiness'}).sign(readinessKeys.privateKey);
      return Response.json({signedReadiness});
    }};
    await installNativeMain(context,ingestKeys);
  });
  const f=fixture;
  try{
    const human=await f.member(),paired=await nativePair(f,human);
    const get=(path:string)=>nativeCall(f,'main',path,{headers:{Cookie:human.headers.Cookie}});
    const settings=await expectJson(await get('/api/v1/me/model-settings'));assert.deepEqual(settings.setup,{state:'installed',setupOrigin});
    const model=await memberPost(f,human,'/api/v1/me/model-connections',{connectionId:paired.connectionId,selection:modelSelection},'1',201);
    const handoff=await memberPost(f,human,'/api/v1/me/credential-ingests',{operation:'create',modelConnectionId:model.modelConnectionId,consent:true},'1',201);
    assert.equal(handoff.setupOrigin,setupOrigin);assert.equal(handoff.operational_authority,false);
    const bootstrap=await nativeCall(f,'setup','/credential-setup',{method:'POST',headers:{Origin:f.mainOrigin,'Content-Type':'application/x-www-form-urlencoded',
      'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'},body:'assertion='+handoff.assertion});
    assert.equal(bootstrap.status,200,await bootstrap.clone().text());
    const html=await bootstrap.text(),csrf=/data-csrf="([A-Za-z0-9_-]{43})"/.exec(html)?.[1],cookie=bootstrap.headers.get('Set-Cookie')?.split(';')[0];
    assert(csrf);assert(cookie);assert(cookie.startsWith('__Host-fp_broker_setup='));assert(!cookie.includes('freedom_local_session'));
    const setupHeaders={Origin:setupOrigin,Cookie:cookie,'X-FP-Broker-CSRF':csrf,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'same-origin','Sec-Fetch-Dest':'empty'};
    await expectJson(await nativeCall(f,'setup','/credential-setup/prepare',{method:'POST',headers:{...setupHeaders,'Content-Type':'application/json'},body:'{"consent":true}'}));
    await expectJson(await nativeCall(f,'setup','/credential-setup/secret',{method:'POST',headers:{...setupHeaders,'Content-Type':'application/octet-stream','Content-Length':String(secret.length)},body:secret}));
    const outcome=await expectJson(await get('/api/v1/me/credential-ingests/'+handoff.authorizationRef));assert.equal(outcome.state,'committed');
    assert(!JSON.stringify(outcome).includes(secret));assert(!JSON.stringify((await f.cipher.query('SELECT envelope FROM broker_credential_vault')).rows).includes(secret));
    for(const pool of [f.app,f.executor])await assert.rejects(pool.query('SELECT envelope FROM broker_credential_vault'),{code:'42501'});
    // Only a synthetic operator installs this fixture's exact personal export policy.
    await f.owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
      VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`,[randomUUID(),human.context.scope.scope_id,human.context.subject_principal.principal_id,profile.environment,profile.clientId,JSON.stringify(modelSelection)]);
    async function prepareStep(title:string){
      const work=await memberPost(f,human,'/api/v1/me/private-work',{title,objective:'SYNTHETIC_NATIVE_OWNER_OBJECTIVE'},null,201);
      const run=await memberPost(f,human,'/api/v1/me/execution-runs',{workId:work.workId},work.aggregateVersion,201);
      const grant=await memberPost(f,human,'/api/v1/me/execution-runs/'+run.runId+'/grants',{expectedWorkVersion:work.aggregateVersion,
        connectionId:paired.connectionId,expectedConnectionVersion:'1',modelConnectionId:model.modelConnectionId,expectedModelVersion:model.aggregateVersion,consent:true},run.aggregateVersion,201);
      const approval=await memberPost(f,human,'/api/v1/me/model-step-approvals',{runId:run.runId,grantId:grant.grantId,expectedGrantVersion:grant.aggregateVersion,
        expectedWorkVersion:work.aggregateVersion,consent:true,maxOutputTokens:20},run.aggregateVersion,201);
      const step=await memberPost(f,human,'/api/v1/me/model-steps',{approvalId:approval.approvalId,expectedRunVersion:run.aggregateVersion},approval.aggregateVersion,201);
      return {work,run,grant,approval,step};
    }
    const first=await prepareStep('Synthetic native private draft');
    const final=await memberPost(f,human,'/api/v1/me/model-steps/'+first.step.stepId+':execute',{},first.step.aggregateVersion);assert.equal(final.state,'succeeded');
    const result=await expectJson(await get('/api/v1/me/private-work/'+first.work.workId+'/results/current'));assert.equal(result.text,output);assert.equal(result.provenance,'model');
    const bucket=await f.mf.getR2Bucket('MEDIA','main'),objects=await bucket.list();assert.equal(objects.objects.length,1);assert.equal(await(await bucket.get(objects.objects[0].key))!.text(),output);
    const foreign=await f.member();assert.equal((await nativeCall(f,'main','/api/v1/me/private-work/'+first.work.workId+'/results/current',{headers:{Cookie:foreign.headers.Cookie}})).status,404);
    const currentWork=await expectJson(await get('/api/v1/me/private-work/'+first.work.workId));
    await memberPost(f,human,'/api/v1/me/private-work/'+first.work.workId+'/edit',{title:'Synthetic owner edited draft',objective:'SYNTHETIC_UPDATED_OBJECTIVE'},String(currentWork.aggregate_version));
    const second=await prepareStep('Synthetic draft to stop');
    await(await f.mf.getWorker('recovery-state')).fetch('https://freedom-private-ai.internal/unavailable');
    await expectJson(await get('/api/v1/me/model-settings'));await expectJson(await get('/api/v1/me/credential-ingests/'+handoff.authorizationRef));
    const denied=await nativeCall(f,'main','/api/v1/me/model-steps/'+second.step.stepId+':execute',{method:'POST',headers:{...human.headers,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"'+second.step.aggregateVersion+'"'},body:'{}'});
    assert(denied.status>=400,'Recovery outage must block execution');
    const stopped=await memberPost(f,human,'/api/v1/me/model-steps/'+second.step.stepId+':stop',{},second.step.aggregateVersion);assert.equal(stopped.state,'cancelled');
    await memberPost(f,human,'/api/v1/me/model-step-approvals/'+second.approval.approvalId+':revoke',{},second.approval.aggregateVersion);
    await memberPost(f,human,'/api/v1/me/agent-connections/'+paired.connectionId+':revoke',{},'1');
    assert.equal((await f.owner.query('SELECT state FROM bootstrap_refresh_families WHERE family_id=$1',[paired.refresh.familyId])).rows[0].state,'revoked');
    assert.equal((await expectJson(await(await f.mf.getWorker('synthetic-provider')).fetch('https://api.openai.com/counts') as unknown as Response)).posts,1);
    assert.equal((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results')).rows[0].n,1);
  }finally{await f.cleanup();}
});
