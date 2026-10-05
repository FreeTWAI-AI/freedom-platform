// Staging-only, operator-invoked ingest subset. No SQL, provider transport,
// inference activation, execution or automatic mutation retry exists here.
import {join,isAbsolute} from 'node:path';
import {z} from 'zod';
import {MemberModelSettingsOverviewSchema} from '../contracts/execution/v2/member-model-settings.js';
import {durableCreate,privateDirectory,privateKeyBytes} from './lib/openrouter-acceptance-guard.js';
import type {Account,AccessCredential,BrowserLike,CandidateClient,Secrets,Target} from './verify-cloud-candidate-lib.js';

const staging='https://staging.freetwai.com';
const sha=z.string().regex(/^[a-f0-9]{40}$/);
export const PrivateAiOwnerConfigSchema=z.object({
  profile:z.literal('private-ai.staging-ingest-acceptance/v1'),
  mainOrigin:z.literal(staging),setupOrigin:z.string().url(),environment:z.literal('staging-next'),
  mainReleaseSha:sha,brokerReleaseSha:sha,bindingReviewSha256:z.string().regex(/^[a-f0-9]{64}$/),
  accountLabel:z.string().regex(/^[a-z0-9-]{3,48}$/),clientId:z.string().min(1).max(128),
  modelConnectionId:z.uuid(),modelVersion:z.string().regex(/^[1-9][0-9]*$/),model:z.string().min(1).max(96),
  keyFile:z.string().refine(isAbsolute),receiptDirectory:z.string().refine(isAbsolute),
  paidExecution:z.literal(false),syntheticOwner:z.literal(true),
}).strict().superRefine((value,ctx)=>{
  const u=new URL(value.setupOrigin);
  if(u.protocol!=='https:'||u.origin!==value.setupOrigin||u.origin===staging||u.port||u.username||u.password
    ||!u.hostname.endsWith('.freetwai.com')||!/^https:\/\/[a-z0-9-]+\.freetwai\.com$/.test(value.setupOrigin))ctx.addIssue({code:'custom',message:'Invalid pinned setup origin'});
});
export type PrivateAiOwnerConfig=z.infer<typeof PrivateAiOwnerConfigSchema>;
type Context={check(id:string,condition:boolean):void;metric(key:string,value:unknown):void;cleanup(item:string,state:'restored'|'cleanup_required'|'residual_expected'|'restore_failed'):void};
export function validatePrivateAiOwner(raw:unknown,target:Target,release:string|null|undefined,account:Account|null|undefined):PrivateAiOwnerConfig {
  const c=PrivateAiOwnerConfigSchema.parse(raw);
  if(target.name!=='staging'||target.origin!==staging||target.mode!=='staging'||target.harness!=='cloud_candidate'
    ||c.mainReleaseSha!==release||c.brokerReleaseSha!==release||c.accountLabel!==account?.label)throw Error('private_ai_owner_binding_mismatch');
  return c;
}
/** Closed route grammar; no arbitrary write, execute, activation or provider URL. */
export function ownerRequestAllowed(origin:string,path:string,method:string,setupOrigin:string):boolean {
  if(origin===staging){
    if(method==='GET')return !path.startsWith('/execution-api/')&&!path.startsWith('/api/v1/me/direct-messages');
    return method==='POST'&&['/api/v1/auth/login','/api/v1/auth/logout','/api/v1/me/credential-ingests'].includes(path);
  }
  return origin===setupOrigin&&(method==='GET'&&['/credential-setup.js','/credential-setup.css','/credential-setup-brand.webp'].includes(path)
    ||method==='POST'&&['/credential-setup','/credential-setup/prepare','/credential-setup/secret'].includes(path));
}
export async function runPrivateAiOwner(input:{config:PrivateAiOwnerConfig;account:Account;access:AccessCredential|null;browser:BrowserLike;
  client:CandidateClient;secrets:Secrets;ctx:Context}) {
  const {config:c,account,access,browser,client,secrets,ctx}=input;
  ctx.metric('scope','synthetic_staging_owner_ingest_only');ctx.metric('paid_execution','disabled');
  ctx.metric('pairing','preexisting_owner_connection');ctx.metric('grant_execution','not_run');
  ctx.metric('full_owner_acceptance','incomplete');ctx.metric('result_edit_stop_revoke','not_run');ctx.metric('remote_r2','not_run');
  ctx.metric('broker_binding_evidence','operator_review_record_only');
  const overview=async()=>{const r=await client.request('GET','/api/v1/me/model-settings');ctx.check('owner_metadata_http',r.status===200);return MemberModelSettingsOverviewSchema.parse(r.json());};
  const before=await overview(),model=before.models.find(m=>m.modelConnectionId===c.modelConnectionId),connection=before.connections.find(v=>v.connectionId===model?.connectionId);
  ctx.check('pinned_setup',before.setup.state==='installed'&&before.setup.setupOrigin===c.setupOrigin);
  ctx.check('genuine_existing_owner_model',!!model&&model.state==='unverified'&&model.aggregateVersion===c.modelVersion
    &&model.selection.providerRef==='openrouter'&&model.selection.modelRef===c.model&&model.selection.credentialCustody==='platform_vault'
    &&model.selection.engineLocation==='platform'&&model.selection.billingSource==='user_byok'&&model.selection.processingLocation==='provider_remote');
  ctx.check('genuine_existing_owner_connection',!!connection&&connection.state==='active'&&model?.environment===c.environment&&model.clientId===c.clientId&&Date.parse(connection.expiresAt)>Date.now());
  ctx.check('model_has_no_prior_credential',!before.credentials.some(v=>v.modelConnectionId===c.modelConnectionId));
  await privateDirectory(c.receiptDirectory);
  // Permanent intent before any browser write. Reusing this directory fails;
  // unknown outcomes never cause automatic bootstrap/secret submission retries.
  await durableCreate(join(c.receiptDirectory,'ingest-intent.json'),{profile:c.profile,release:c.mainReleaseSha,brokerRelease:c.brokerReleaseSha,
    bindingReviewSha256:c.bindingReviewSha256,accountLabel:c.accountLabel,modelConnectionId:c.modelConnectionId,modelVersion:c.modelVersion,setupOrigin:c.setupOrigin,at:new Date().toISOString(),paidExecution:false,providerPosts:0});
  const context=await browser.newContext({serviceWorkers:'block'});let bytes:Uint8Array|undefined,loggedOut=false,blocked=false;
  const writes=new Map<string,number>();
  try {
    await context.route('**/*',async(route:any)=>{try{
      const req=route.request(),url=new URL(req.url()),method=req.method();
      const allowed=ownerRequestAllowed(url.origin,url.pathname,method,c.setupOrigin)&&!url.username&&!url.password;
      if(!allowed){blocked=true;await route.abort();return;}
      if(method==='POST'){
        const count=(writes.get(url.pathname)??0)+1;writes.set(url.pathname,count);
        if(count>1){blocked=true;await route.abort();return;}
      }
      const headers={...req.headers()};
      // Never forward Access credentials across origins, including redirects.
      delete headers['cf-access-client-id'];delete headers['cf-access-client-secret'];
      if(url.origin===staging&&access){headers['CF-Access-Client-Id']=access.clientId;headers['CF-Access-Client-Secret']=access.clientSecret;}
      const response=await route.fetch({headers,maxRedirects:0,timeout:15000});
      await route.fulfill({response});
    }catch{blocked=true;await route.abort().catch(()=>{});}});
    const page=await context.newPage();page.setDefaultTimeout(15000);
    await page.goto(staging+'/#private-ai');
    await page.getByLabel('電子郵件',{exact:true}).fill(account.email);await page.getByLabel('密碼',{exact:true}).fill(account.password);
    await page.getByRole('button',{name:'登入',exact:true}).click();
    const panel=page.getByRole('region',{name:'模型與憑證設定'});
    await panel.getByRole('button',{name:'重新讀取模型設定',exact:true}).waitFor();
    await panel.getByLabel('管理的模型設定').selectOption(c.modelConnectionId);
    await panel.getByRole('checkbox',{name:`我同意為 openrouter / ${c.model} 前往獨立保管頁，另行輸入金鑰並確認加密保管。`,exact:true}).check();
    await panel.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();
    await page.waitForURL(c.setupOrigin+'/credential-setup');
    bytes=await privateKeyBytes(c.keyFile);const key=new TextDecoder().decode(bytes);secrets.add(key);
    await page.locator('#credential-key').fill(key);await page.locator('#credential-consent').check();await page.locator('#credential-submit').click();
    await page.locator('#credential-status').filter({hasText:'已收到設定服務回覆'}).waitFor();
    ctx.check('key_input_cleared',await page.locator('#credential-key').inputValue()==='');
    const after=await overview(),created=after.credentials.filter(v=>v.modelConnectionId===c.modelConnectionId);
    ctx.check('owner_credential_committed',created.length===1&&created[0].state==='active'&&created[0].selection.providerRef==='openrouter'&&created[0].selection.modelRef===c.model&&created[0].modelVersion===c.modelVersion&&created[0].generation==='1');
    ctx.check('other_owner_metadata_preserved',before.credentials.every(old=>after.credentials.some(v=>v.credentialId===old.credentialId&&v.aggregateVersion===old.aggregateVersion&&v.state===old.state)));
    ctx.check('exactly_one_ingest',!blocked&&writes.get('/api/v1/me/credential-ingests')===1&&writes.get('/credential-setup')===1&&writes.get('/credential-setup/prepare')===1&&writes.get('/credential-setup/secret')===1);
    ctx.metric('browser_ingest','pass');ctx.metric('owner_metadata','pass');
    await durableCreate(join(c.receiptDirectory,'ingest-receipt.json'),{profile:c.profile,status:'ingest_subset_pass',fullOwnerAcceptance:'incomplete',paidExecution:false});
  } finally {
    bytes?.fill(0);
    // Revoke only this browser's session through the real authenticated route.
    try {const pages=context.pages();if(pages.length){const p=pages[0];await p.goto(staging+'/#private-ai');loggedOut=await p.evaluate(async()=>{
      const session=await fetch('/api/v1/session',{credentials:'same-origin'});if(!session.ok)return false;
      const body=await session.json();const response=await fetch('/api/v1/auth/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':body.csrf_token},body:'{}'});return response.ok;
    });}}catch{}
    try{await context.close();}catch{loggedOut=false;}
    ctx.cleanup('browser member session',loggedOut?'restored':'cleanup_required');
    ctx.cleanup('synthetic owner ingest intent and credential history; no automatic retry or deletion','residual_expected');
  }
}
