import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID,createHash} from 'node:crypto';
import {runPrivateAiExecute,validatePrivateAiExecute,validatePrivateAiBudget,type PrivateAiExecuteConfig} from '../../scripts/verify-cloud-private-ai-execute.js';
import {CandidateClient,Secrets,candidateTarget,runCandidate,selectPhases,type Transport} from '../../scripts/verify-cloud-candidate-lib.js';
const origin='https://staging.freetwai.com',release='a'.repeat(40),account={label:'synthetic-owner',email:'synthetic@example.invalid',password:'synthetic-password'};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(mode:'pass'|'unknown'|'expiry'|'wrong_context'|'missing_policy'|'crossed_final'|'crossed_source'|'expiry_after_result'='pass',advance?:()=>void){
 const dir=await mkdtemp(join(tmpdir(),'fp-paid-http-')),receiptDirectory=join(dir,'attempt'),ledgerDirectory=join(dir,'ledger');await mkdir(receiptDirectory,{mode:0o700});await mkdir(ledgerDirectory,{mode:0o700});
 const stamp=new Date().toISOString(),future=new Date(Date.now()+3600000).toISOString(),modelConnectionId=randomUUID(),connectionId=randomUUID(),runtimeDeviceId=randomUUID(),familyId=randomUUID();
 const c:PrivateAiExecuteConfig={profile:'private-ai.staging-owner-execute/v1',mainOrigin:origin,environment:'staging-next',setupOrigin:'https://synthetic-broker.freetwai.com',mainReleaseSha:release,brokerReleaseSha:release,bindingReviewSha256:'b'.repeat(64),accountLabel:account.label,clientId:'synthetic-client',model:'synthetic/model',receiptDirectory,paidExecution:true,syntheticOwner:true,acknowledgeOnePaidDispatch:true,modelConnectionId,modelVersion:'1',budgetEvidenceFile:join(dir,'budget.json'),ledgerDirectory,expiresAt:future,maxUsd:10,maxOutputTokens:128,maxExecuteRequests:1};
 const evidence={profile:'private-ai.operator-budget-evidence/v1',model:c.model,mainReleaseSha:release,brokerReleaseSha:release,observedAt:stamp,expiresAt:new Date(Date.parse(stamp)+60000).toISOString(),keyExpiresAt:future,keyLimit:10,keyUsage:0.01,promptPrice:'0.000001',completionPrice:'0.000002',requestPrice:'0'};
 await writeFile(join(ledgerDirectory,'session.json'),JSON.stringify({profile:'private-ai.provider-session-ledger/v1',maxUsd:10,expiresAt:future,priorReservedUsd:0.10,priorKnownCostUsd:0.0001}),{mode:0o600});
 const selection={providerRef:'openrouter',modelRef:c.model,processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
 const model={modelConnectionId,connectionId,runtimeDeviceId,familyId,environment:c.environment,clientId:c.clientId,selection,state:'unverified',aggregateVersion:'1',createdAt:stamp,operational_authority:false};
 const connection={connectionId,runtimeDeviceId,state:'active',aggregateVersion:'1',expiresAt:future};
 const settings={profile:'member-model-settings/v1',connections:[connection],models:[model],credentials:[{credentialId:randomUUID(),modelConnectionId,modelVersion:'1',generation:'1',aggregateVersion:'1',state:'active',selection,recoveryGeneration:'1',issuedAt:stamp,expiresAt:future,terminalAt:null,replacementCredentialId:null,operational_authority:false}],selectionOptions:[selection],setup:{state:'installed',setupOrigin:c.setupOrigin},limit:50,operational_authority:false};
 const requests:any[]=[],works:any[]=[],steps:any[]=[],approvals:any[]=[];let run:any,grant:any,original:any,current:any,logout=false,logins=0;
 const privateText='Synthetic private model result, never printed.';
 const transport:Transport=async req=>{
  const path=new URL(req.url).pathname,body=req.body?JSON.parse(String(req.body)):undefined,h=new Headers(req.headers);requests.push({path,method:req.method,body});assert.equal(new URL(req.url).origin,origin);
  const reply=(value:unknown,status=200,headers:Record<string,string>={})=>({status,headers:new Headers({'Content-Type':'application/json','Cache-Control':'no-store',...(value&&typeof value==='object'&&'aggregateVersion'in value?{ETag:'"'+value.aggregateVersion+'"'}:{}),...headers}),body:Buffer.from(JSON.stringify(value))});
  if(path==='/api/v1/health')return reply({status:'ok',mode:'staging',version:'1.0.0',money_movement_enabled:false,official:false,runtime:'cloudflare-workers',release_sha:release});
  if(path==='/api/v1/auth/login'){await readFile(join(receiptDirectory,'execute-intent.json'));assert.equal((await readdir(ledgerDirectory)).filter(v=>v.startsWith('reservation-')).length,1);logins++;return reply({user:{user_id:randomUUID(),email:account.email},csrf_token:'synthetic-csrf'},200,{'set-cookie':'freedom_local_session=synthetic-cookie; Path=/; HttpOnly; Secure'});}
  if(path==='/api/v1/auth/logout'){logout=true;return reply({},200,{'set-cookie':'freedom_local_session=; Path=/; Max-Age=0; HttpOnly; Secure'});}
  if(path==='/api/v1/session'){assert(logout);return reply({code:'session_expired'},401);}
  if(req.method==='GET'){
   if(path==='/api/v1/me/model-settings')return reply(settings);
   if(path==='/api/v1/me/model-step-overview')return reply({works:[],runs:[],connections:[connection],models:[model],grants:[],approvals:[],steps:[],allowedSelections:mode==='missing_policy'?[]:[{selection,maxOutputTokens:128}],persistenceAvailable:true,configuration:'configured',limit:50,operational_authority:false});
   if(path.endsWith('/results/current')){if(mode==='expiry_after_result')advance!();return reply(current);}
   assert.equal(path,'/api/v1/me/private-work/'+works[0].workId+'/results/'+original.resultId);return reply(mode==='crossed_source'?{...original,resultId:randomUUID()}:original);
  }
  assert.equal(h.get('Origin'),origin);assert.equal(h.get('X-CSRF-Token'),'synthetic-csrf');assert(h.get('Idempotency-Key'));
  // Every remotely mutating command has a persisted private intent beforehand.
  const intents=(await readdir(receiptDirectory)).filter(v=>v.startsWith('command-'));assert(intents.length>0);
  const intent=JSON.parse(await readFile(join(receiptDirectory,intents.sort().at(-1)!),'utf8'));assert.equal(intent.path,path);assert.equal(intent.key,h.get('Idempotency-Key'));
  if(path==='/api/v1/me/private-work'){assert.equal(h.get('If-Match'),null);assert(body.title.startsWith('Synthetic remote'));const work={workId:randomUUID(),aggregateVersion:'1',state:'draft'};works.push({...work,context:JSON.stringify({schema:'model-step.context/v1',title:body.title,objective:body.objective})});return reply(work,201);}
  const work=works.at(-1);
  if(path==='/api/v1/me/execution-runs'){assert.deepEqual(body,{workId:work.workId});run={runId:randomUUID(),workId:work.workId,inputWorkVersion:'1',aggregateVersion:'1',state:'created',taskLeaseEpoch:'1',controlEpoch:'1',operational_authority:false};return reply(run,201);}
  if(path.endsWith('/grants')){assert.equal(body.connectionId,connectionId);assert.equal(body.expectedModelVersion,'1');grant={grantId:randomUUID(),runId:run.runId,workId:work.workId,inputWorkVersion:'1',runVersion:'1',taskLeaseEpoch:'1',controlEpoch:'1',connectionId,connectionVersion:'1',runtimeDeviceId,familyId,modelConnectionId,modelVersion:'1',selection,policyRevision:'private-work.v1',state:'active',aggregateVersion:'1',issuedAt:stamp,expiresAt:future,purpose:'model.private-draft',operational_authority:false};return reply(grant,201);}
  if(path==='/api/v1/me/model-step-approvals'){assert.equal(body.maxOutputTokens,128);assert.equal(body.grantId,grant.grantId);const approval={approvalId:randomUUID(),runId:run.runId,workId:work.workId,grantId:grant.grantId,inputWorkVersion:'1',selection,exportPolicyRevision:'1',maxOutputTokens:128,contextSha256:mode==='wrong_context'?'a'.repeat(64):digest(work.context),inputByteSize:Buffer.byteLength(work.context),aggregateVersion:'1',state:'active',issuedAt:stamp,expiresAt:future,operational_authority:false};approvals.push(approval);return reply(approval,201);}
  if(path==='/api/v1/me/model-steps'){const approval=approvals.at(-1);assert.equal(body.approvalId,approval.approvalId);const step={stepId:randomUUID(),attemptId:randomUUID(),attemptNumber:1,runId:run.runId,workId:work.workId,inputWorkVersion:'1',approvalId:approval.approvalId,state:'reserved',aggregateVersion:'1',activatedRunVersion:'2',taskLeaseEpoch:'2',controlEpoch:'1',selection,evidenceOrigin:'provider_https',expiresAt:future,usageStatus:'not_dispatched',costStatus:'unknown',operational_authority:false};steps.push(step);if(mode==='expiry')advance!();return reply(step,201);}
  if(path.endsWith(':execute')){
   assert.equal(requests.filter(r=>r.path.endsWith(':execute')).length,1);assert.deepEqual(body,{});assert.equal(h.get('If-Match'),'"1"');if(mode==='unknown')throw Error(privateText);
   const step=steps[0];original={resultId:randomUUID(),workId:works[0].workId,revision:'1',workVersion:'1',aggregateVersion:'2',contentType:'text/plain',byteSize:Buffer.byteLength(privateText),sha256:digest(privateText),createdAt:stamp,provenance:'model',text:privateText,model:{stepId:step.stepId,attemptId:step.attemptId,dispatchIntentId:randomUUID(),selection,evidenceOrigin:'provider_https',usage:{inputTokens:10,outputTokens:8,totalTokens:18},costStatus:'unknown'}};current=original;return reply({...step,...(mode==='crossed_final'?{attemptId:randomUUID()} : {}),state:'succeeded',aggregateVersion:'3',usageStatus:'known'});
  }
  if(path.endsWith('/edit')){assert.equal(h.get('If-Match'),'"2"');const resultId=randomUUID();current={...original,resultId,revision:'2',aggregateVersion:'3',provenance:'human',text:body.text,sha256:digest(body.text),byteSize:Buffer.byteLength(body.text)};delete current.model;return reply({intentId:randomUUID(),assetId:randomUUID(),resultId,workId:works[0].workId,revision:'2',aggregateVersion:'3',provenance:'human'});}
  if(path.endsWith(':stop'))return reply({...steps.at(-1),state:'cancelled',aggregateVersion:'2'});
  if(path.includes('/model-step-approvals/'))return reply({...approvals.at(-1),state:'revoked',aggregateVersion:'2'});
  assert.equal(path,'/api/v1/me/agent-connections/'+connectionId+':revoke');return reply({...connection,environment:c.environment,clientId:c.clientId,state:'revoked',aggregateVersion:'2',issuedAt:stamp,operational_authority:false});
 };
 const secrets=new Secrets(),client=new CandidateClient(candidateTarget('staging'),transport,null,secrets);client.csrf='synthetic-csrf';const metrics:Record<string,unknown>={};
 const runDirect=()=>runPrivateAiExecute({config:c,budgetEvidence:evidence,client,secrets,ctx:{check:(id,ok)=>assert(ok,id),metric:(k,v)=>{metrics[k]=v;},cleanup:()=>{}},authenticate:async()=>{await client.request('POST','/api/v1/auth/login',{json:account,csrf:null});return{userId:randomUUID()};}});
 const integrated=()=>runCandidate({run:'execute',target:candidateTarget('staging'),expectedVersion:'1.0.0',expectedReleaseSha:release,contract:{protocol:'synthetic'},account,privateAiExecute:c,privateAiBudgetEvidence:evidence,phases:selectPhases(['private-ai-execute']),transport});
 return{c,evidence,dir,receiptDirectory,ledgerDirectory,requests,metrics,runDirect,integrated,privateText,logins:()=>logins,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
test('operator budget evidence rejects stale, future, crossed release, expired key, excessive estimate and exhausted limit',async()=>{const f=await fixture();try{
 const now=Date.parse(f.evidence.observedAt);assert(validatePrivateAiBudget(f.evidence,f.c,now).reviewedUpperEstimateUsd<0.10);
 for(const patch of [{model:'different/model'},{brokerReleaseSha:'c'.repeat(40)},{observedAt:new Date(now+1).toISOString()},{expiresAt:new Date(now+60001).toISOString()},{keyExpiresAt:new Date(now-1).toISOString()},{promptPrice:'1'},{keyUsage:10},{keyLimit:11},{requestPrice:'NaN'}])assert.throws(()=>validatePrivateAiBudget({...f.evidence,...patch},f.c,now));
 assert.throws(()=>validatePrivateAiBudget(f.evidence,f.c,now+60000));assert.throws(()=>validatePrivateAiBudget(f.evidence,f.c,now+60001));
 assert.throws(()=>validatePrivateAiExecute({...f.c,keyFile:'/not-allowed'},candidateTarget('staging'),release,account));assert.throws(()=>validatePrivateAiExecute(f.c,candidateTarget('public'),release,account));
 assert.deepEqual(selectPhases(['private-ai-execute']),['preflight','health','private-ai-execute','logout']);assert.throws(()=>selectPhases(['private-ai-execute','private-ai-owner']));assert(!selectPhases(null).includes('private-ai-execute'));
}finally{await f.cleanup();}});
test('remote HTTP subset makes one execute, preserves source edit, stops/revokes and reports unavailable independent evidence',async()=>{const f=await fixture();try{
 const report=await f.integrated();assert.equal(report.phases.find(p=>p.id==='private-ai-execute')?.status,'pass');assert.equal(report.phases.find(p=>p.id==='logout')?.status,'pass');assert.equal(report.overall,'incomplete');assert.equal(report.cloud_proof,false);
 assert.equal(f.requests.filter(r=>r.path.endsWith(':execute')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith(':stop')).length,1);
 const receipt=JSON.parse(await readFile(join(f.receiptDirectory,'execute-receipt.json'),'utf8'));assert.equal(receipt.status,'http_subset_pass');assert.equal(receipt.providerPosts,'unavailable');assert.equal(receipt.independentRemoteR2,'unavailable');assert.equal(receipt.guaranteedProviderUsdCap,false);assert.equal(receipt.budget.sessionReservedUsd,0.20);
 for(const name of await readdir(f.receiptDirectory)){const text=await readFile(join(f.receiptDirectory,name),'utf8');assert(!text.includes(f.privateText));assert(!text.includes(account.password));}
 for(const value of [f.privateText,account.email,account.password,f.dir,f.c.modelConnectionId])assert(!JSON.stringify(report).includes(value));
 const count=f.requests.length;await assert.rejects(f.runDirect(),{code:'EEXIST'});assert.equal(f.requests.length,count);assert.equal(f.logins(),1);
}finally{await f.cleanup();}});
test('lost execute ACK consumes permanent reservation and blocks all automatic retry/control',async()=>{const f=await fixture('unknown');try{
 const report=await f.integrated();assert.equal(report.overall,'fail');assert.equal(report.phases.find(p=>p.id==='logout')?.status,'pass');assert(!JSON.stringify(report).includes(f.privateText));
 const receipt=JSON.parse(await readFile(join(f.receiptDirectory,'execute-receipt.json'),'utf8'));assert.equal(receipt.unknownCommand,'execute');assert.equal(receipt.dispatchOutcomeUnknown,true);assert.equal(receipt.executeRequests,1);assert.equal(f.requests.filter(r=>r.path.endsWith(':stop')).length,0);
 const count=f.requests.length;await assert.rejects(f.runDirect(),{code:'EEXIST'});assert.equal(f.requests.length,count);assert.equal((await readdir(f.ledgerDirectory)).filter(v=>v.startsWith('reservation-')).length,1);
}finally{await f.cleanup();}});
test('evidence expiry after activation ACK prevents execute fetch even after command intent',async t=>{const realNow=Date.now;let offset=0;t.mock.method(Date,'now',()=>realNow()+offset);const f=await fixture('expiry',()=>{offset=61000;});try{
 await assert.rejects(f.runDirect());assert.equal(f.requests.filter(r=>r.path.endsWith(':execute')).length,0);
 assert((await readdir(f.receiptDirectory)).some(v=>/^command-\d+-execute.json$/.test(v)));const receipt=JSON.parse(await readFile(join(f.receiptDirectory,'execute-receipt.json'),'utf8'));assert.equal(receipt.executeRequests,0);assert.equal(receipt.dispatchOutcomeUnknown,false);
}finally{await f.cleanup();}});
for(const mode of ['wrong_context','missing_policy'] as const)test(mode+' blocks before activation and execution',async()=>{const f=await fixture(mode);try{await assert.rejects(f.runDirect());assert.equal(f.requests.filter(r=>r.path==='/api/v1/me/model-steps'||r.path.endsWith(':execute')).length,0);}finally{await f.cleanup();}});

for(const mode of ['crossed_final','crossed_source'] as const)test(mode+' fails exact returned bindings without another execute',async()=>{const f=await fixture(mode);try{await assert.rejects(f.runDirect());assert.equal(f.requests.filter(r=>r.path.endsWith(':execute')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith(':stop')).length,0);const count=f.requests.length;await assert.rejects(f.runDirect(),{code:'EEXIST'});assert.equal(f.requests.length,count);}finally{await f.cleanup();}});

test('budget evidence expiry after Result read still permits cancel-only activation and Stop/Revoke',async t=>{const realNow=Date.now;let offset=0;t.mock.method(Date,'now',()=>realNow()+offset);const f=await fixture('expiry_after_result',()=>{offset=61000;});try{await f.runDirect();assert.equal(f.metrics.owner_http_subset,'pass');assert.equal(f.requests.filter(r=>r.path.endsWith(':execute')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith(':stop')).length,1);assert.equal(f.requests.filter(r=>r.path.includes('/agent-connections/')&&r.path.endsWith(':revoke')).length,1);}finally{await f.cleanup();}});
