import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {z} from 'zod';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-offline-payment.js';
import {assertCurrentSessionClock} from '../../../../packages/db/member-session.js';
import {withTenantRead,type TenantScopeContext} from '../../../../packages/resource-scopes/index.js';
import {isolatedTransaction} from '../../../../packages/resource-scopes/tenant-transaction.js';
import {scopedTenantCommand} from '../../../../packages/scoped-commands/index.js';
import {Problem,requireCondition} from '../../../../packages/shared/problem.js';
import {bumpAuthorizationRevision} from '../../../tenant-workspaces/facts.js';
import {assertFreshVerificationCurrent,consumeFreshVerification,receiptNamespaceDigest,requireFreshVerification} from '../../../tenant-workspaces/high-risk-verification.js';
import {requireStoreInstance,storeCapabilities,STORE_MISSING} from '../../hosted/capabilities.js';
import {instance,profile,ready} from '../../hosted/store.js';
import {recordControlEvent} from '../../operations/control-events.js';
import {canonicalJSON} from '../../checkout/terms.js';
import type {Actor} from '../../../identity-membership/service.js';

export const OFFLINE_BANK_PROFILE='offline.bank_transfer.v1';
export const OFFLINE_MEETUP_PROFILE='offline.cash_on_meetup.v1';
const OPERATION='commerce.offline_payment_settings.save';
type FieldCode='required'|'format'|'too_short'|'too_long'|'out_of_range';
export type OfflineSettingsFieldError=z.infer<typeof wire.OfflineSettingsFieldErrorSchema>;
export class OfflineSettingsProblem extends Problem {
  readonly fields:OfflineSettingsFieldError[];
  constructor(fields:OfflineSettingsFieldError[]){super(422,'offline_settings_invalid','收款設定有誤。');this.fields=fields.slice(0,20);}
}
export interface OfflineBankBlock {bank_code:string;bank_name:string;branch_name:string|null;account_number:string;account_name:string;deadline_days:number;note:string|null}
export interface OfflineSettingsDocument {
  schema:'freedom.offline-payment-settings/v1';
  bank_transfer:OfflineBankBlock|null;
  cash_on_meetup:{deadline_days:number}|null;
}
type SettingsContext={tenant:TenantScopeContext};
type Visibility='full'|'last4';

/** Same gate as provider-account commands: a missing proof is 403 before schema validation. */
export function parseOfflineSettingsInput(raw:unknown):z.infer<typeof wire.OfflinePaymentSettingsInputSchema>{
  if(raw&&typeof raw==='object'&&!('fresh_auth_verification_id' in raw))throw new Problem(403,'fresh_auth_required','請重新驗證身分。');
  const result=wire.OfflinePaymentSettingsInputSchema.safeParse(raw);
  requireCondition(result.success,422,'validation_failed','輸入資料無效。');
  return result.data;
}
function codePoints(value:string){return Array.from(value).length;}
function hasControl(value:string){
  return Array.from(value).some(char=>{const point=char.codePointAt(0)!;return point>=0x0001&&point<=0x001f||point>=0x007f&&point<=0x009f;});
}
function fail(fields:OfflineSettingsFieldError[],path:string,code:FieldCode){fields.push({path,code});}
function textField(fields:OfflineSettingsFieldError[],path:string,raw:string,max:number,required:boolean):string|null{
  if(hasControl(raw)){fail(fields,path,'format');return required?raw:null;}
  const value=raw.trim();
  if(!value){if(required)fail(fields,path,'required');return null;}
  if(codePoints(value)>max)fail(fields,path,'too_long');
  return value;
}
function deadline(fields:OfflineSettingsFieldError[],path:string,value:number|undefined,min:number,max:number,fallback:number){
  if(value===undefined)return fallback;
  if(value<min||value>max)fail(fields,path,'out_of_range');
  return value;
}
/** Length, format and range are field errors. Structural type checks stay on the schema. */
export function normalizeOfflineSettings(input:z.infer<typeof wire.OfflinePaymentSettingsInputSchema>):OfflineSettingsDocument{
  const fields:OfflineSettingsFieldError[]=[];
  let bank:OfflineBankBlock|null=null;
  if(input.bank_transfer){
    const source=input.bank_transfer,bank_code=source.bank_code.trim();
    if(hasControl(source.bank_code)||!/^[0-9]{3}$/.test(bank_code))fail(fields,'bank_transfer.bank_code','format');
    const account=source.account_number.trim().replace(/[ -]/g,'');
    if(hasControl(source.account_number)||!/^[0-9]+$/.test(account))fail(fields,'bank_transfer.account_number','format');
    else if(account.length<6)fail(fields,'bank_transfer.account_number','too_short');
    else if(account.length>16)fail(fields,'bank_transfer.account_number','too_long');
    bank={bank_code,bank_name:textField(fields,'bank_transfer.bank_name',source.bank_name,20,true)??'',
      branch_name:source.branch_name===undefined?null:textField(fields,'bank_transfer.branch_name',source.branch_name,20,false),
      account_number:account,account_name:textField(fields,'bank_transfer.account_name',source.account_name,40,true)??'',
      deadline_days:deadline(fields,'bank_transfer.deadline_days',source.deadline_days,1,7,3),
      note:source.note===undefined?null:textField(fields,'bank_transfer.note',source.note,200,false)};
  }
  const meetup=input.cash_on_meetup?{deadline_days:deadline(fields,'cash_on_meetup.deadline_days',input.cash_on_meetup.deadline_days,1,14,7)}:null;
  if(fields.length)throw new OfflineSettingsProblem(fields);
  const document:OfflineSettingsDocument={schema:'freedom.offline-payment-settings/v1',bank_transfer:bank,cash_on_meetup:meetup};
  requireCondition(Buffer.byteLength(canonicalJSON(document))<=4096,422,'validation_failed','輸入資料無效。');
  return document;
}
export function offlineMethodList(document:OfflineSettingsDocument|null){
  const methods=[document?.bank_transfer?'bank_transfer':null,document?.cash_on_meetup?'cash_on_meetup':null].filter((method):method is string=>method!==null);
  return methods.length?methods.join(','):'none';
}
export async function currentOfflineSettings(q:PoolClient,instanceId:string):Promise<{version:string;document:OfflineSettingsDocument;created_at:Date}|null>{
  return (await q.query('SELECT version::text,document,created_at FROM commerce_offline_payment_settings WHERE instance_id=$1 ORDER BY version DESC LIMIT 1',[instanceId])).rows[0]??null;
}
export function hostOfflineProfiles(profiles:readonly string[]){
  return {bank_transfer:profiles.includes(OFFLINE_BANK_PROFILE),cash_on_meetup:profiles.includes(OFFLINE_MEETUP_PROFILE)};
}
export async function offlineSettingsView(q:PoolClient,instanceId:string,profiles:readonly string[],visibility:Visibility){
  const current=await currentOfflineSettings(q,instanceId),bank=current?.document.bank_transfer??null;
  return wire.OfflinePaymentSettingsViewSchema.parse({version:current?.version??null,saved_at:current?.created_at.toISOString()??null,account_visibility:visibility,
    host_profiles:hostOfflineProfiles(profiles),settings:current?{bank_transfer:bank?{...bank,account_number:visibility==='last4'?null:bank.account_number,account_number_last4:bank.account_number.slice(-4)}:null,
      cash_on_meetup:current.document.cash_on_meetup}:null});
}
function visibilityOf(role:TenantScopeContext['role'],keys:readonly string[]):Visibility{
  if(role==='owner'||role==='admin')return 'full';
  requireCondition(keys.includes('store:manage')||keys.includes('store:finance:read'),403,'capability_denied','目前沒有這個操作的權限。');
  return 'last4';
}
function nextSettingsVersion(actual:string|null,expected:string|undefined):number{
  if(expected===undefined){requireCondition(actual===null,428,'version_required','請提供 If-Match 版本。');return 1;}
  requireCondition(actual!==null&&actual===expected,412,'version_conflict','資料已更新，請重新整理後再操作。');
  requireCondition(Number(actual)<2147483647,409,'version_conflict','收款設定版本已達上限。');
  return Number(actual)+1;
}
export async function readOfflinePaymentSettings(pool:Pool,actor:Actor,tenantId:string,instanceId:string,profiles:readonly string[]){
  try{return await withTenantRead(pool,{actor,tenantId,capabilitiesForRole:storeCapabilities},async(q,tenant)=>{
    await instance(q,tenantId,instanceId,false);
    const keys=await requireStoreInstance(q,tenant,instanceId,'store:read');
    const p=await profile(q,tenantId,instanceId);ready(p);
    return offlineSettingsView(q,instanceId,profiles,visibilityOf(tenant.role,keys));
  });}catch(error){if(error instanceof Problem&&error.code==='tenant_not_found')throw new Problem(404,'not_found',STORE_MISSING);throw error;}
}
export async function saveOfflinePaymentSettings(pool:Pool,actor:Actor,tenantId:string,instanceId:string,raw:unknown,key:string,expected:string|undefined,profiles:readonly string[]){
  const input=parseOfflineSettingsInput(raw);
  let context!:SettingsContext,output!:Awaited<ReturnType<typeof offlineSettingsView>>;
  const namespace=(ctx:TenantScopeContext)=>receiptNamespaceDigest('freedom.scoped-tenant-command/v1',[ctx.principal_id,ctx.authn_kind,ctx.scope.scope_id,OPERATION,key]);
  const authorize=async(q:PoolClient,tenant:TenantScopeContext)=>{
    await instance(q,tenantId,instanceId,false,true);
    await requireStoreInstance(q,tenant,instanceId,'store:read');
    requireCondition(tenant.role==='owner'||tenant.role==='admin',403,'capability_denied','目前沒有這個操作的權限。');
    await instance(q,tenantId,instanceId,true);
    requireCondition(tenant.tenant_status==='active',403,'capability_denied','目前無法使用這個業務空間。');
    const p=await profile(q,tenantId,instanceId);ready(p);
    await requireFreshVerification(q,{userId:actor.user_id,sessionHash:actor.session_hash,principalId:tenant.principal_id,tenantId,
      purpose:'commerce.provider_account.write',verificationId:input.fresh_auth_verification_id,namespaceDigest:namespace(tenant)});
    await assertFreshVerificationCurrent(q,input.fresh_auth_verification_id);
    context={tenant};
  };
  try{
    await scopedTenantCommand(pool,{actor,tenantId,operation:OPERATION,target:{kind:'commerce_offline_payment_settings',id:instanceId},body:input,key,expected,capabilitiesForRole:storeCapabilities},authorize,async q=>{
      await assertFreshVerificationCurrent(q,input.fresh_auth_verification_id);
      const document=normalizeOfflineSettings(input),current=await currentOfflineSettings(q,instanceId),version=nextSettingsVersion(current?.version??null,expected);
      await q.query(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
        VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,instanceId,version,document,createHash('sha256').update(canonicalJSON(document)).digest('hex'),context.tenant.principal_id]);
      await recordControlEvent(q,{tenantId,instanceId,kind:'offline_payment_settings.changed',subjectId:instanceId,
        detail:{settings_version:version,methods:offlineMethodList(document)},actorKind:'person',actorId:context.tenant.principal_id});
      await consumeFreshVerification(q,input.fresh_auth_verification_id,namespace(context.tenant));
      await bumpAuthorizationRevision(q,tenantId);
      return {id:String(version)};
    },authorize,undefined,(source,command)=>isolatedTransaction(source,async q=>{
      const reference=await command(q);
      output=await offlineSettingsView(q,instanceId,profiles,'full');
      await authorize(q,context.tenant);await assertCurrentSessionClock(q,actor);return reference;
    }));
    return output;
  }catch(error){if(error instanceof Problem&&error.code==='tenant_not_found')throw new Problem(404,'not_found',STORE_MISSING);throw error;}
}
