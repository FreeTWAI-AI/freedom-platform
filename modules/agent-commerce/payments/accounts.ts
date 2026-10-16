import type {PaymentAttemptOptions} from './attempts.js';
import {scheduleDueWork} from '../operations/due-work.js';
import {chargeCommerceBudgets} from '../checkout/limits.js';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {z} from 'zod';
import * as wire from '../../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {checkVersion} from '../../../packages/db/index.js';
import type {TenantScopeContext} from '../../../packages/resource-scopes/index.js';
import {scopedTenantCommand} from '../../../packages/scoped-commands/index.js';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import type {Actor} from '../../identity-membership/service.js';
import {bumpAuthorizationRevision} from '../../tenant-workspaces/facts.js';
import {assertFreshVerificationCurrent,consumeFreshVerification,receiptNamespaceDigest,requireFreshVerification} from '../../tenant-workspaces/high-risk-verification.js';
import {effectiveStoreCapabilities,requireStoreInstance,storeCapabilities,STORE_MISSING} from '../hosted/capabilities.js';
import {instance,storeFact,storeRead} from '../hosted/store.js';
import {recordControlEvent} from '../operations/control-events.js';
import {EcpayKeyPair,newTradeNumber} from '../providers/ecpay/index.js';
import {EcpayCreditCheckCode} from '../providers/ecpay/aio-credit/index.js';
import {CommerceCredentialKeyring,credentialFingerprint,sealCredential,unsealCredential,resealCredential,type CredentialContext} from './credentials.js';
import {createProviderAccountRoute} from './entry-routes.js';
export type ProviderEnvironment='sandbox'|'live';
export type ProviderPurpose=z.infer<typeof wire.ProviderPurposeSchema>;
export interface ProviderAccountOptions {keyring:CommerceCredentialKeyring|null;environment:ProviderEnvironment}
const profiles={payment:'ecpay.aio.credit.v1',logistics:'ecpay.logistics.domestic.v1',invoice:'ecpay.invoice.b2c.v1'} as const;
function keyringOf(options:ProviderAccountOptions):CommerceCredentialKeyring{
  requireCondition(options.keyring,503,'commerce_credentials_unavailable','商務憑證服務尚未設定。');return options.keyring;
}
function parseInput<T>(schema:z.ZodType<T>,raw:unknown):T{
  if(raw&&typeof raw==='object'&&!('fresh_auth_verification_id' in raw))throw new Problem(403,'fresh_auth_required','請重新驗證身分。');
  const result=schema.safeParse(raw);requireCondition(result.success,422,'validation_failed','輸入資料無效。');return result.data;
}
async function account(q:PoolClient,accountId:string,tenantId?:string,instanceId?:string,lock=false){
  const row=(await q.query(`SELECT *,version::text FROM commerce_provider_accounts WHERE account_id=$1
    AND ($2::uuid IS NULL OR tenant_id=$2) AND ($3::uuid IS NULL OR instance_id=$3)${lock?' FOR UPDATE':''}`,[accountId,tenantId??null,instanceId??null])).rows[0];
  requireCondition(row,404,'provider_account_not_found','找不到供應商帳戶。');return row;
}
async function accountView(q:PoolClient,id:string){
  const a=await account(q,id);
  const services=(await q.query(`SELECT s.purpose,s.profile,s.state,s.credential_version,c.created_at AS credential_updated_at,s.activated_at,s.throttled_until
    FROM commerce_provider_account_services s JOIN commerce_provider_credentials c ON c.account_id=s.account_id AND c.purpose=s.purpose AND c.credential_version=s.credential_version
    WHERE s.account_id=$1 ORDER BY s.purpose`,[id])).rows.map(s=>({...s,credential_updated_at:s.credential_updated_at.toISOString(),activated_at:s.activated_at?.toISOString()??null,throttled_until:s.throttled_until?.toISOString()??null}));
  const activation=(await q.query("SELECT attempt_id,state,handed_off_at,created_at FROM commerce_payment_attempts WHERE account_id=$1 AND kind='service_activation' ORDER BY sequence DESC LIMIT 1",[id])).rows[0];
  const payment_activation=activation?{attempt_ref:activation.attempt_id,state:activation.state==='issued'?(activation.handed_off_at?'awaiting_result':'ready'):activation.state==='expired_unpaid'||activation.state==='superseded'?'expired':activation.state,created_at:activation.created_at.toISOString()}:null;
  return wire.ProviderAccountViewSchema.parse({payment_activation,account_id:a.account_id,provider:a.provider,environment:a.environment,merchant_id:a.merchant_id,version:a.version,created_at:a.created_at.toISOString(),services});
}
export function listProviderAccounts(pool:Pool,actor:Actor,tenantId:string,instanceId:string){
  return storeRead(pool,actor,tenantId,instanceId,'store:read',async(q,ctx)=>{
    const keys=await effectiveStoreCapabilities(q,ctx,instanceId);
    requireCondition(keys.includes('store:finance:read')||keys.includes('store:manage'),403,'capability_denied','目前沒有這個操作的權限。');
    const rows=(await q.query('SELECT account_id FROM commerce_provider_accounts WHERE tenant_id=$1 AND instance_id=$2 ORDER BY created_at,account_id',[tenantId,instanceId])).rows;
    const items=[];for(const row of rows)items.push(await accountView(q,row.account_id));return wire.ProviderAccountPageSchema.parse({items});
  });
}
async function command<T extends object>(pool:Pool,actor:Actor,tenantId:string,instanceId:string,accountId:string|undefined,operation:string,body:{fresh_auth_verification_id:string},key:string,expected:string|undefined,run:(q:PoolClient,ctx:TenantScopeContext)=>Promise<T>){
  const namespace=(ctx:TenantScopeContext)=>receiptNamespaceDigest('freedom.scoped-tenant-command/v1',[ctx.principal_id,ctx.authn_kind,ctx.scope.scope_id,operation,key]);
  const authorize=async(q:PoolClient,ctx:TenantScopeContext)=>{
    await instance(q,tenantId,instanceId,false,true);
    await requireStoreInstance(q,ctx,instanceId,'store:read');
    requireCondition(ctx.role==='owner'||ctx.role==='admin',403,'capability_denied','目前沒有這個操作的權限。');
    await instance(q,tenantId,instanceId,true);
    requireCondition(ctx.tenant_status==='active',403,'capability_denied','目前無法使用這個業務空間。');
    if(accountId)await account(q,accountId,tenantId,instanceId,true);
    await requireFreshVerification(q,{userId:actor.user_id,sessionHash:actor.session_hash,principalId:ctx.principal_id,tenantId,
      purpose:'commerce.provider_account.write',verificationId:body.fresh_auth_verification_id,namespaceDigest:namespace(ctx)});
    await assertFreshVerificationCurrent(q,body.fresh_auth_verification_id);
  };
  try{return await scopedTenantCommand(pool,{actor,tenantId,operation,body,key,expected,target:{kind:'commerce_provider_account',id:accountId??instanceId},capabilitiesForRole:storeCapabilities},authorize,async(q,ctx)=>{
    if(accountId)checkVersion((await account(q,accountId,tenantId,instanceId)).version,expected);
    await assertFreshVerificationCurrent(q,body.fresh_auth_verification_id);
    const view=await run(q,ctx);
    await consumeFreshVerification(q,body.fresh_auth_verification_id,namespace(ctx));
    await bumpAuthorizationRevision(q,tenantId);
    // Activation receipts contain only an attempt reference; journal the account
    // aggregate independently rather than putting its bearer handoff in a receipt.
    const fact=accountId?await account(q,accountId):view as z.infer<typeof wire.ProviderAccountViewSchema>;
    await storeFact(q,ctx,fact.account_id,fact.version,operation,'commerce_provider_account');return view;
  },authorize);}catch(e){if(e instanceof Problem&&e.code==='tenant_not_found')throw new Problem(404,'not_found',STORE_MISSING);throw e;}
}
export async function createProviderAccount(pool:Pool,actor:Actor,tenantId:string,instanceId:string,raw:unknown,key:string,options:ProviderAccountOptions){
  keyringOf(options);const input=parseInput(wire.ProviderAccountCreateInputSchema,raw);
  requireCondition(input.environment===options.environment,422,'provider_environment_not_allowed','這個環境不允許指定的供應商環境。');
  return command(pool,actor,tenantId,instanceId,undefined,'commerce.provider_account.create',input,key,undefined,async(q,ctx)=>{
    const id=randomUUID();
    try{await q.query(`INSERT INTO commerce_provider_accounts(account_id,tenant_id,instance_id,provider,environment,merchant_id,created_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,tenantId,instanceId,input.provider,input.environment,input.merchant_id,ctx.principal_id]);}
    catch(e){if((e as {code?:string}).code==='23505')throw new Problem(409,'provider_account_exists','這間商店已有相同的供應商帳戶。');throw e;}
    await createProviderAccountRoute(q,{tenantId,instanceId,accountId:id});
    await recordControlEvent(q,{tenantId,instanceId,kind:'provider_account.created',subjectId:id,detail:{environment:input.environment},actorKind:'person',actorId:ctx.principal_id});
    return accountView(q,id);
  });
}
async function bumpAccount(q:PoolClient,id:string){
  await q.query('UPDATE commerce_provider_accounts SET version=version+1,updated_at=clock_timestamp() WHERE account_id=$1',[id]);
}
export async function putProviderService(pool:Pool,actor:Actor,tenantId:string,instanceId:string,accountId:string,purpose:ProviderPurpose,raw:unknown,key:string,expected:string,options:ProviderAccountOptions){
  const ring=keyringOf(options);
  if(raw&&typeof raw==='object'&&'profile' in raw&&raw.profile!==profiles[purpose])throw new Problem(422,'provider_profile_invalid','供應商設定檔與用途不符。');
  const input=parseInput(wire.ProviderServicePutInputSchema,raw);
  requireCondition(input.profile===profiles[purpose],422,'provider_profile_invalid','供應商設定檔與用途不符。');
  requireCondition(input.credit_check_code===undefined||purpose==='payment',422,'validation_failed','輸入資料無效。');
  try{EcpayKeyPair.of(input.hash_key,input.hash_iv);if(input.credit_check_code!==undefined)EcpayCreditCheckCode.of(input.credit_check_code);}catch{throw new Problem(422,'validation_failed','輸入資料無效。');}
  const safeBody={profile:input.profile,fresh_auth_verification_id:input.fresh_auth_verification_id,
    credential_fingerprint:credentialFingerprint(ring,{account_id:accountId,purpose,profile:input.profile,hash_key:input.hash_key,hash_iv:input.hash_iv,...(input.credit_check_code!==undefined?{credit_check_code:input.credit_check_code}:{})})};
  return command(pool,actor,tenantId,instanceId,accountId,`commerce.provider_service.put.${purpose}`,safeBody,key,expected,async(q,ctx)=>{
    const a=await account(q,accountId,tenantId,instanceId),old=(await q.query('SELECT * FROM commerce_provider_account_services WHERE account_id=$1 AND purpose=$2 FOR UPDATE',[accountId,purpose])).rows[0];
    requireCondition(old?.state!=='retired',409,'provider_service_state','供應商服務狀態不允許這個操作。');
    const version=old?old.credential_version+1:1;
    if(!old)await q.query(`INSERT INTO commerce_provider_account_services(account_id,purpose,tenant_id,instance_id,environment,profile,credential_version)
      VALUES($1,$2,$3,$4,$5,$6,1)`,[accountId,purpose,tenantId,instanceId,a.environment,input.profile]);
    const sealed=sealCredential(ring,{account_id:accountId,purpose,environment:a.environment,credential_version:version},{hash_key:input.hash_key,hash_iv:input.hash_iv,...(input.credit_check_code!==undefined?{credit_check_code:input.credit_check_code}:{})});
    await q.query(`INSERT INTO commerce_provider_credentials(account_id,purpose,credential_version,tenant_id,instance_id,environment,key_id,sealed,created_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[accountId,purpose,version,tenantId,instanceId,a.environment,sealed.key_id,sealed.sealed,ctx.principal_id]);
    if(old)await q.query(`UPDATE commerce_provider_account_services SET credential_version=$3,version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose=$2`,[accountId,purpose,version]);
    await bumpAccount(q,accountId);
    await recordControlEvent(q,{tenantId,instanceId,kind:old?'provider_credential.rotated':'provider_service.created',subjectId:accountId,
      detail:{purpose,profile:input.profile,environment:a.environment,credential_version:version},actorKind:'person',actorId:ctx.principal_id});
    return accountView(q,accountId);
  });
}
export async function changeProviderServiceState(pool:Pool,actor:Actor,tenantId:string,instanceId:string,accountId:string,purpose:ProviderPurpose,action:'suspend'|'resume'|'retire',raw:unknown,key:string,expected:string,options:ProviderAccountOptions){
  keyringOf(options);const input=parseInput(wire.ProviderServiceStateInputSchema,raw);
  return command(pool,actor,tenantId,instanceId,accountId,`commerce.provider_service.${action}.${purpose}`,input,key,expected,async(q,ctx)=>{
    const old=(await q.query('SELECT * FROM commerce_provider_account_services WHERE account_id=$1 AND purpose=$2 FOR UPDATE',[accountId,purpose])).rows[0];
    const target={suspend:'suspended',resume:'active',retire:'retired'}[action];
    requireCondition(old&&(action==='suspend'&&old.state==='active'||action==='resume'&&old.state==='suspended'&&old.activated_at||action==='retire'&&old.state!=='retired'),409,'provider_service_state','供應商服務狀態不允許這個操作。');
    await updateServiceState(q,accountId,purpose,target);
    await recordControlEvent(q,{tenantId,instanceId,kind:'provider_service.state_changed',subjectId:accountId,
      detail:{purpose,from_state:old.state,to_state:target},actorKind:'person',actorId:ctx.principal_id});
    return accountView(q,accountId);
  });
}
async function updateServiceState(q:PoolClient,id:string,purpose:ProviderPurpose,state:string,activationRef?:string){
  try{await q.query(`UPDATE commerce_provider_account_services SET state=$3,version=version+1,updated_at=clock_timestamp(),
    activated_at=CASE WHEN $4::text IS NOT NULL THEN clock_timestamp() ELSE activated_at END,
    activation_ref=coalesce($4,activation_ref) WHERE account_id=$1 AND purpose=$2`,[id,purpose,state,activationRef??null]);}
  catch(e){if((e as {code?:string;constraint?:string}).code==='23505'&&(e as {constraint?:string}).constraint==='commerce_provider_services_one_active')throw new Problem(409,'provider_service_conflict','商店已有相同設定檔的啟用服務。');throw e;}
  await bumpAccount(q,id);
}
/** Internal machine mutations follow the same tenant -> account lock order as
 * setup commands. Their caller owns the transaction and binds tenant context. */
export async function lockMachineAccount(q:PoolClient,id:string){
  const peek=await account(q,id);await q.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE',[peek.tenant_id]);return account(q,id,undefined,undefined,true);
}
async function machineFact(q:PoolClient,a:Record<string,any>,kind:Parameters<typeof recordControlEvent>[1]['kind'],detail:Parameters<typeof recordControlEvent>[1]['detail']){
  await bumpAuthorizationRevision(q,a.tenant_id);
  await recordControlEvent(q,{tenantId:a.tenant_id,instanceId:a.instance_id,kind,subjectId:a.account_id,detail,actorKind:'system',actorId:a.account_id});
}
export async function activateProviderService(q:PoolClient,input:{accountId:string;purpose:ProviderPurpose;activationRef:string}):Promise<void>{
  requireCondition(typeof input.activationRef==='string'&&input.activationRef.length>=1&&input.activationRef.length<=200,422,'validation_failed','啟用參照無效。');
  const a=await lockMachineAccount(q,input.accountId),s=(await q.query('SELECT state FROM commerce_provider_account_services WHERE account_id=$1 AND purpose=$2 FOR UPDATE',[input.accountId,input.purpose])).rows[0];
  requireCondition(s?.state==='draft',409,'provider_service_state','供應商服務狀態不允許這個操作。');
  await updateServiceState(q,input.accountId,input.purpose,'active',input.activationRef);
  await machineFact(q,a,'provider_service.state_changed',{purpose:input.purpose,from_state:'draft',to_state:'active'});
}
export async function retireCredentialVersion(q:PoolClient,input:{accountId:string;purpose:ProviderPurpose;credentialVersion:number}):Promise<void>{
  const a=await lockMachineAccount(q,input.accountId),s=(await q.query('SELECT credential_version FROM commerce_provider_account_services WHERE account_id=$1 AND purpose=$2 FOR UPDATE',[input.accountId,input.purpose])).rows[0];
  requireCondition(s&&s.credential_version!==input.credentialVersion,409,'provider_service_state','目前使用的憑證不能退役。');
  const changed=await q.query(`UPDATE commerce_provider_credentials SET retired_at=clock_timestamp() WHERE account_id=$1 AND purpose=$2 AND credential_version=$3 AND retired_at IS NULL`,[input.accountId,input.purpose,input.credentialVersion]);
  requireCondition(changed.rowCount===1,409,'provider_service_state','憑證版本無法退役。');await bumpAccount(q,input.accountId);
  await machineFact(q,a,'provider_credential.retired',{purpose:input.purpose,credential_version:input.credentialVersion});
}
export async function listUsableCredentialVersions(q:PoolClient,input:{accountId:string;purpose:ProviderPurpose}):Promise<number[]>{
  return (await q.query(`SELECT c.credential_version FROM commerce_provider_credentials c JOIN commerce_provider_account_services s USING(account_id,purpose)
    WHERE c.account_id=$1 AND c.purpose=$2 AND c.retired_at IS NULL ORDER BY (c.credential_version=s.credential_version) DESC,c.credential_version DESC`,[input.accountId,input.purpose])).rows.map(r=>r.credential_version);
}
export async function loadServiceCredentials(q:PoolClient,ring:CommerceCredentialKeyring,input:{accountId:string;purpose:ProviderPurpose;credentialVersion?:number}){
  const c=(await q.query(`SELECT c.* FROM commerce_provider_credentials c JOIN commerce_provider_account_services s USING(account_id,purpose)
    WHERE c.account_id=$1 AND c.purpose=$2 AND c.credential_version=coalesce($3,s.credential_version) AND c.retired_at IS NULL`,[input.accountId,input.purpose,input.credentialVersion??null])).rows[0];
  requireCondition(c,404,'provider_account_not_found','找不到供應商憑證。');
  try{const material=unsealCredential(ring,c as CredentialContext,c);return {credentialVersion:c.credential_version,keys:EcpayKeyPair.of(material.hash_key,material.hash_iv),creditCheckCode:material.credit_check_code!==undefined?EcpayCreditCheckCode.of(material.credit_check_code):null};}
  catch{throw new Problem(503,'commerce_credentials_unavailable','商務憑證服務暫時無法讀取。');}
}
export async function resealProviderCredentials(q:PoolClient,ring:CommerceCredentialKeyring,input:{limit:number}):Promise<{resealed:number}>{
  requireCondition(Number.isInteger(input.limit)&&input.limit>=1&&input.limit<=1000,422,'validation_failed','批次上限無效。');
  const candidates=(await q.query(`SELECT credential_id,account_id FROM commerce_provider_credentials WHERE key_id<>$1 ORDER BY tenant_id,account_id,credential_id LIMIT $2`,[ring.activeKeyId,input.limit])).rows;
  let resealed=0;
  for(const candidate of candidates){
    const a=await lockMachineAccount(q,candidate.account_id),c=(await q.query('SELECT * FROM commerce_provider_credentials WHERE credential_id=$1 AND key_id<>$2 FOR UPDATE SKIP LOCKED',[candidate.credential_id,ring.activeKeyId])).rows[0];
    if(!c)continue;
    let sealed;try{sealed=resealCredential(ring,c as CredentialContext,c);}catch{throw new Problem(503,'commerce_credentials_unavailable','商務憑證服務暫時無法讀取。');}
    await q.query('UPDATE commerce_provider_credentials SET key_id=$2,sealed=$3 WHERE credential_id=$1',[c.credential_id,sealed.key_id,sealed.sealed]);await bumpAccount(q,a.account_id);
    await machineFact(q,a,'provider_credential.resealed',{purpose:c.purpose,credential_version:c.credential_version});resealed++;
  }
  return {resealed};
}

/** Adjustable controlled self-payment amount: NT$10, never refunded here. */
export const SERVICE_ACTIVATION_AMOUNT_MINOR=1000;
export async function createPaymentServiceActivation(pool:Pool,actor:Actor,tenantId:string,instanceId:string,accountId:string,raw:unknown,key:string,expected:string,options:PaymentAttemptOptions){
  keyringOf(options);const input=parseInput(wire.ProviderActivationPaymentInputSchema,raw);
  await chargeCommerceBudgets(pool,accountId,{network:'activationAccount'});
  return command(pool,actor,tenantId,instanceId,accountId,'commerce.provider_service.activation_payment.payment',input,key,expected,async q=>{
    const a=await account(q,accountId,tenantId,instanceId);
    const s=(await q.query(`SELECT s.* FROM commerce_provider_account_services s JOIN commerce_provider_credentials c
      ON c.account_id=s.account_id AND c.purpose=s.purpose AND c.credential_version=s.credential_version
      WHERE s.account_id=$1 AND s.purpose='payment' AND c.retired_at IS NULL FOR UPDATE OF s`,[accountId])).rows[0];
    requireCondition(s?.state==='draft',409,'provider_service_state','供應商服務狀態不允許這個操作。');
    requireCondition(!(await q.query(`SELECT 1 FROM commerce_provider_account_services WHERE instance_id=$1 AND environment=$2
      AND profile=$3 AND purpose='payment' AND state='active' AND account_id<>$4`,[instanceId,a.environment,s.profile,accountId])).rowCount,
      409,'provider_service_conflict','商店已有相同設定檔的啟用服務。');
    requireCondition(options.profiles.includes(s.profile)&&options.gateway&&options.gateway.environment===a.environment&&a.environment===options.environment,
      409,'provider_service_state','供應商服務狀態不允許這個操作。');
    requireCondition(!options.settings.quarantine,503,'commerce_quarantined','商店系統維護中，訂單資料核對中。');
    requireCondition(!(await q.query(`SELECT 1 FROM commerce_payment_attempts WHERE account_id=$1 AND kind='service_activation'
      AND (state='paid' OR (state='issued' AND handed_off_at IS NOT NULL AND created_at+interval '60 minutes'>clock_timestamp()))`,[accountId])).rowCount,
      409,'provider_activation_pending','收款服務驗證結果確認中，請稍後再試。');
    const sequence=(await q.query("SELECT coalesce(max(sequence),0)+1 AS n FROM commerce_payment_attempts WHERE account_id=$1 AND kind='service_activation'",[accountId])).rows[0].n;
    for(let i=0;i<5;i++){
      const attempt=(await q.query(`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,sequence,account_id,environment,merchant_id,credential_version,profile,merchant_trade_no,amount_minor,currency)
        VALUES($1,$2,'service_activation',$3,$4,$5,$6,$7,$8,$9,$10,'TWD') ON CONFLICT(provider,environment,merchant_id,merchant_trade_no) DO NOTHING
        RETURNING attempt_id,(created_at+interval '10 minutes')::text AS query_due,(created_at+interval '60 minutes')::text AS window_due`,
        [tenantId,instanceId,sequence,accountId,a.environment,a.merchant_id,s.credential_version,s.profile,newTradeNumber('F'),SERVICE_ACTIVATION_AMOUNT_MINOR])).rows[0];
      if(!attempt)continue;
      for(const [kind,dueAt] of [['payment_query',attempt.query_due],['payment_window_end',attempt.window_due]] as const)
        await scheduleDueWork(q,{tenantId,instanceId,kind,targetId:attempt.attempt_id,dueAt});
      await bumpAccount(q,accountId);return {attempt_ref:attempt.attempt_id as string};
    }
    throw Error('payment_trade_number_unavailable');
  });
}
