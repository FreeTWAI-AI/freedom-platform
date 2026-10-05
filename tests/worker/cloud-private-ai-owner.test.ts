import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {runPrivateAiOwner,validatePrivateAiOwner,ownerRequestAllowed,ownerKeyRequestAllowed,type PrivateAiOwnerConfig} from '../../scripts/verify-cloud-private-ai-owner.js';
import {CandidateClient,Secrets,candidateTarget,runCandidate,selectPhases} from '../../scripts/verify-cloud-candidate-lib.js';
const origin='https://staging.freetwai.com',setup='https://synthetic-broker.freetwai.com',release='a'.repeat(40);
const account={email:'dedicated@example.invalid',password:'private-password-synthetic',label:'test-owner'};
async function fixture(lost=false,forged:false|'body'|'header'=false){
 const directory=await mkdtemp(join(tmpdir(),'fp-owner-acceptance-')),keyFile=join(directory,'key');
 await mkdir(join(directory,'receipt'),{mode:0o700});
 const secret='sk-or-v1-SYNTHETIC_PRIVATE_KEY_ONLY';await writeFile(keyFile,secret,{mode:0o600});
 const c:PrivateAiOwnerConfig={profile:'private-ai.staging-ingest-acceptance/v1',mainOrigin:origin,setupOrigin:setup,environment:'staging-next',mainReleaseSha:release,brokerReleaseSha:release,bindingReviewSha256:'b'.repeat(64),accountLabel:account.label,clientId:'synthetic-client',modelConnectionId:randomUUID(),modelVersion:'1',model:'synthetic/model',keyFile,receiptDirectory:join(directory,'receipt'),paidExecution:false,syntheticOwner:true};
 const connectionId=randomUUID(),runtimeDeviceId=randomUUID(),now=new Date().toISOString(),future=new Date(Date.now()+60000).toISOString();
 const selection={providerRef:'openrouter',modelRef:c.model,credentialCustody:'platform_vault',artifactCustody:'platform_asset',engineLocation:'platform',billingSource:'user_byok',processingLocation:'provider_remote'};
 const model={modelConnectionId:c.modelConnectionId,connectionId,runtimeDeviceId,familyId:randomUUID(),environment:c.environment,clientId:c.clientId,selection,state:'unverified',aggregateVersion:'1',createdAt:now,operational_authority:false};
 const credential={credentialId:randomUUID(),modelConnectionId:c.modelConnectionId,modelVersion:'1',generation:'1',aggregateVersion:'1',state:'active',selection,recoveryGeneration:'1',issuedAt:now,expiresAt:future,terminalAt:null,replacementCredentialId:null,operational_authority:false};
 let committed=false,handler:any,key='',closed=0;const requests:any[]=[],metrics:Record<string,unknown>={},checks:string[]=[];
 const overview=()=>({profile:'member-model-settings/v1',connections:[{connectionId,runtimeDeviceId,state:'active',aggregateVersion:'1',expiresAt:future}],models:[model],credentials:committed?[credential]:[],selectionOptions:[selection],setup:{state:'installed',setupOrigin:setup},limit:50,operational_authority:false});
 const client=new CandidateClient(candidateTarget('staging'),async req=>{requests.push({kind:'api',method:req.method,url:req.url});return{status:200,headers:new Headers(),body:Buffer.from(JSON.stringify(overview()))};},null,new Secrets());
 const request=async(url:string,method='GET',body:string|null=null,headers:Record<string,string>={})=>{let aborted=false;await handler({request:()=>({url:()=>url,method:()=>method,headers:()=>({}),allHeaders:async()=>headers,postData:()=>body}),abort:async()=>{aborted=true;},fetch:async(opts:any)=>{requests.push({kind:'browser',url,method,headers:opts.headers,maxRedirects:opts.maxRedirects});if(url===setup+'/credential-setup/secret'){committed=true;if(lost)throw Error('private response body must never appear');}return{};},fulfill:async()=>{}});return !aborted;};
 const locator=(name:string):any=>({getByRole:(_:string,o:any)=>locator(o.name),getByLabel:(n:string)=>locator(n),locator,filter:()=>locator(name),waitFor:async()=>{if(lost&&name==='#credential-status')throw Error('private synthetic key leaked error');},fill:async(v:string)=>{if(name==='#credential-key')key=v;},inputValue:async()=>'',selectOption:async()=>{},check:async()=>{},click:async()=>{
  if(name==='登入')await request(origin+'/api/v1/auth/login','POST');
  if(name==='前往金鑰保管頁'){await request(origin+'/api/v1/me/credential-ingests','POST');await request(setup+'/credential-setup','POST');for(const path of ['/credential-setup.js','/credential-setup.css','/credential-setup-brand.webp'])assert(await request(setup+path));}
  if(name==='#credential-submit'){assert.equal(key,secret);if(forged){assert.equal(await request(origin+'/api/v1/me/credential-ingests','POST',forged==='body'?JSON.stringify({credential:key}):'{}',forged==='header'?{cookie:'hidden='+key}:{}),false);return;}await request(setup+'/credential-setup/prepare','POST');await request(setup+'/credential-setup/secret','POST',JSON.stringify({key}));key='';}
 }});
 const page:any={...locator('page'),setDefaultTimeout(){},goto:async(url:string)=>request(url),waitForURL:async()=>{},evaluate:async()=>request(origin+'/api/v1/auth/logout','POST')};
 const browser={newContext:async()=>({route:async(_:string,h:any)=>{handler=h;},newPage:async()=>page,pages:()=>[page],close:async()=>{closed++;}})};
 const ctx={check:(id:string,ok:boolean)=>{assert(ok,id);checks.push(id);},metric:(k:string,v:unknown)=>{metrics[k]=v;},cleanup:()=>{}};
 return{directory,c,secret,client,browser,ctx,metrics,requests,request,overview,closed:()=>closed,staleMetadata:()=>{committed=false;},cleanup:()=>rm(directory,{recursive:true,force:true})};
}
test('closed staging binding and route grammar deny public, mismatched release, paid execution and foreign dispatch',async()=>{
 const f=await fixture();try{
  assert.deepEqual(validatePrivateAiOwner(f.c,candidateTarget('staging'),release,account),f.c);
  for(const patch of [{paidExecution:true},{brokerReleaseSha:'c'.repeat(40)},{accountLabel:'other'},{environment:'next'},{setupOrigin:'https://evil.example'}])assert.throws(()=>validatePrivateAiOwner({...f.c,...patch},candidateTarget('staging'),release,account));
  assert.throws(()=>validatePrivateAiOwner(f.c,candidateTarget('public'),release,account));
  for(const path of ['/api/v1/me/model-steps','/api/v1/me/model-steps/x:execute','/api/v1/me/model-connections'])assert.equal(ownerRequestAllowed(origin,path,'POST',setup),false);
  for(const path of ['/credential-setup.js','/credential-setup.css','/credential-setup-brand.webp'])assert.equal(ownerRequestAllowed(setup,path,'GET',setup),true);
  assert.equal(ownerRequestAllowed(setup,'/arbitrary.js','GET',setup),false);
  assert.equal(ownerRequestAllowed('https://openrouter.ai','/api/v1/chat/completions','POST',setup),false);
 }finally{await f.cleanup();}
});
test('ingest subset uses one real-shaped browser command sequence, isolates Access and exposes bounded metadata only',async()=>{
 const f=await fixture();try{
  await runPrivateAiOwner({config:f.c,account,access:{clientId:'synthetic-access',clientSecret:'synthetic-secret'},browser:f.browser,client:f.client,secrets:new Secrets(),ctx:f.ctx});
  assert.equal(f.closed(),1);assert.equal(f.metrics.full_owner_acceptance,'incomplete');assert.equal(f.metrics.paid_execution,'disabled');assert.equal(f.metrics.owner_metadata,'pass');
  assert(!JSON.stringify(f.metrics).includes(f.secret));assert(!JSON.stringify(f.metrics).includes(f.c.model));
  assert(f.requests.filter(r=>r.kind==='browser').every(r=>r.maxRedirects===0));
  assert(f.requests.filter(r=>r.url.startsWith(setup)).every(r=>!r.headers?.['CF-Access-Client-Secret']));
  assert.equal(f.requests.filter(r=>r.url.endsWith('/credential-setup/secret')).length,1);
  assert.equal(JSON.parse(await readFile(join(f.c.receiptDirectory,'ingest-receipt.json'),'utf8')).paidExecution,false);
  // Existing intent is permanent even if metadata reads are reset or stale.
  const writes=f.requests.filter(r=>r.method==='POST').length;f.staleMetadata();
  await assert.rejects(runPrivateAiOwner({config:f.c,account,access:null,browser:f.browser,client:f.client,secrets:new Secrets(),ctx:f.ctx}));
  assert.equal(f.requests.filter(r=>r.method==='POST').length,writes);
 }finally{await f.cleanup();}
});
test('lost secret ACK retains permanent intent and never retries key submission',async()=>{
 const f=await fixture(true);try{
  await assert.rejects(runPrivateAiOwner({config:f.c,account,access:null,browser:f.browser,client:f.client,secrets:new Secrets(),ctx:f.ctx}));
  assert.equal(f.requests.filter(r=>r.url.endsWith('/credential-setup/secret')).length,1);assert.equal(f.closed(),1);
  await readFile(join(f.c.receiptDirectory,'ingest-intent.json'));assert.equal(f.metrics.full_owner_acceptance,'incomplete');
  f.staleMetadata();await assert.rejects(runPrivateAiOwner({config:f.c,account,access:null,browser:f.browser,client:f.client,secrets:new Secrets(),ctx:f.ctx}),{code:'EEXIST'});
  assert.equal(f.requests.filter(r=>r.url.endsWith('/credential-setup/secret')).length,1);assert.equal(f.closed(),1);
 }finally{await f.cleanup();}
});
test('invalid or missing staging config stops in preflight before any HTTP request',async()=>{
 let calls=0;const report=await runCandidate({run:'execute',target:candidateTarget('staging'),expectedVersion:'1.0.0',expectedReleaseSha:release,contract:{protocol:'synthetic'},account,phases:selectPhases(['private-ai-owner']),transport:async()=>{calls++;throw Error();}});
 assert.equal(calls,0);assert.equal(report.overall,'fail');assert.equal(report.cloud_proof,false);
});

test('public report keeps successful ingest incomplete and hides failed browser messages',async()=>{
 for(const lost of [false,true]){
  const f=await fixture(lost);let revoked=false;const token='synthetic-csrf-private',cookie='synthetic-session-private';
  try{
   const report=await runCandidate({run:'execute',target:candidateTarget('staging'),expectedVersion:'1.0.0',expectedReleaseSha:release,contract:{protocol:'synthetic'},account,privateAiOwner:f.c,browser:f.browser,phases:selectPhases(['private-ai-owner']),transport:async req=>{
    const path=new URL(req.url).pathname;let status=200,body:unknown={},setCookie:string|undefined;
    if(path==='/api/v1/health')body={status:'ok',mode:'staging',version:'1.0.0',money_movement_enabled:false,official:false,runtime:'cloudflare-workers',release_sha:release};
    else if(path==='/api/v1/auth/login'){body={csrf_token:token,user:{user_id:'synthetic-owner-id',email:account.email}};setCookie=`freedom_local_session=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict`;}
    else if(path==='/api/v1/session'){status=revoked?401:200;body=revoked?{code:'session_expired'}:{csrf_token:token,user:{user_id:'synthetic-owner-id',email:account.email}};}
    else if(path==='/api/v1/auth/logout'){
     if(req.headers.Origin!==origin){status=403;body={code:'origin_rejected'};}
     else if(req.headers['X-CSRF-Token']!==token){status=403;body={code:'csrf_rejected'};}
     else{revoked=true;setCookie='freedom_local_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';}
    }else if(path==='/api/v1/me/model-settings')body=f.overview();else throw Error('unexpected synthetic request');
    const headers=new Headers({'Content-Type':'application/json','Cache-Control':'no-store'});if(setCookie)headers.set('set-cookie',setCookie);
    return{status,headers,body:Buffer.from(JSON.stringify(body))};
   }});
   assert.equal(report.phases.find(p=>p.id==='private-ai-owner')?.status,lost?'fail':'pass');
   assert.equal(report.overall,lost?'fail':'incomplete');assert.equal(report.cloud_proof,false);
   for(const forbidden of [f.secret,account.password,account.email,token,cookie,'private synthetic key leaked error','private response body must never appear',f.c.modelConnectionId,f.c.model])assert(!JSON.stringify(report).includes(forbidden),forbidden);
   assert.equal(f.requests.filter(r=>r.url.endsWith('/credential-setup/secret')).length,1);
  }finally{await f.cleanup();}
 }
});

test('key route guard permits only exact broker secret body and rejects URL/header/main copies',()=>{
 const key='sk-or-v1-SYNTHETIC_PRIVATE_KEY_ONLY';
 assert.equal(ownerKeyRequestAllowed(setup+'/credential-setup/secret','POST',{},JSON.stringify({key}),key,setup),true);
 for(const [url,method,headers,body] of [
  [origin+'/api/v1/auth/login','POST',{},JSON.stringify({password:key})],
  [origin+'/api/v1/me/credential-ingests','POST',{},JSON.stringify({credential:key})],
  [origin+'/?q='+key,'GET',{},null],
  [setup+'/credential-setup/secret?q=1','POST',{},JSON.stringify({key})],
  [setup+'/credential-setup/secret','POST',{'x-key':key},JSON.stringify({key})],
  [origin+'/api/v1/auth/login','POST',{},JSON.stringify({key}).replace('sk-or','\\u0073k-or')],
 ] as const)assert.equal(ownerKeyRequestAllowed(url,method,headers,body,key,setup),false);
});
for(const mode of ['body','header'] as const)test('forged main key '+mode+' is aborted before fetch and cannot produce ingest receipt',async()=>{const f=await fixture(false,mode);try{
 await assert.rejects(runPrivateAiOwner({config:f.c,account,access:null,browser:f.browser,client:f.client,secrets:new Secrets(),ctx:f.ctx}));
 assert.equal(f.metrics.key_route_guard,'blocked');assert.equal(f.requests.filter(r=>r.kind==='browser'&&r.url===origin+'/api/v1/me/credential-ingests').length,1);
 assert.equal(f.requests.filter(r=>r.url===setup+'/credential-setup/secret').length,0);
 await assert.rejects(readFile(join(f.c.receiptDirectory,'ingest-receipt.json')),{code:'ENOENT'});
 assert(!JSON.stringify(f.metrics).includes(f.secret));
}finally{await f.cleanup();}});
