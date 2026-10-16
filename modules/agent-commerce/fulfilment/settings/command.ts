import type {Pool,PoolClient} from 'pg';
import type {z} from 'zod';
import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives.js';
import type {ShippingFieldErrorSchema} from '../../../../contracts/guild-launchpad/v1/hosted-shipping.js';
import {assertCurrentSessionClock} from '../../../../packages/db/member-session.js';
import {withTenantRead,type TenantScopeContext} from '../../../../packages/resource-scopes/index.js';
import {isolatedTransaction} from '../../../../packages/resource-scopes/tenant-transaction.js';
import {scopedTenantCommand} from '../../../../packages/scoped-commands/index.js';
import {Problem,requireCondition} from '../../../../packages/shared/problem.js';
import {requireStoreInstance,storeCapabilities,STORE_MISSING} from '../../hosted/capabilities.js';
import {instance,profile,ready,storeRead,type Profile} from '../../hosted/store.js';

export type SettingsActor=Parameters<typeof storeRead>[1];
export type ShippingFieldError=z.infer<typeof ShippingFieldErrorSchema>;
export class ShippingSettingsProblem extends Problem {
  readonly fields:ShippingFieldError[];
  constructor(status:number,code:string,fields:ShippingFieldError[]){super(status,code,'配送設定無法儲存，請檢查標示的欄位。');this.fields=fields.slice(0,20);}
}
export interface ShippingSettingsContext {tenant:TenantScopeContext;profile:Profile}
type Operation='commerce.ship_from_location.create'|'commerce.ship_from_location.retire'|'commerce.shipping_profile.save'|'commerce.item_shipping_attributes.save';
/** Reference-only receipts; current projections, including replays, use this
 * transaction. The store row serializes saves without the order advisory lock. */
export async function shippingSettingsCommand<T>(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string,capability:string,
  operation:Operation,target:{kind:'commerce_ship_from_location'|'commerce_shipping_profile'|'commerce_item_shipping_attributes';id:string},
  body:unknown,key:string,expected:string|undefined,run:(q:PoolClient,context:ShippingSettingsContext)=>Promise<{id:string}>,
  project:(q:PoolClient,context:ShippingSettingsContext,id:string)=>Promise<T>):Promise<T>{
  OpaqueId.parse(tenantId);OpaqueId.parse(instanceId);OpaqueId.parse(target.id);
  let context!:ShippingSettingsContext,output!:T;
  const authorize=async(q:PoolClient,tenant:TenantScopeContext)=>{
    await instance(q,tenantId,instanceId,false,true);
    await requireStoreInstance(q,tenant,instanceId,capability,true);
    await instance(q,tenantId,instanceId,true);
    const p=await profile(q,tenantId,instanceId);ready(p);context={tenant,profile:p};
  };
  try{
    await scopedTenantCommand(pool,{actor,tenantId,tenantLock:'share',capabilitiesForRole:storeCapabilities,operation,target,body,key,expected},authorize,
      q=>run(q,context),authorize,undefined,(source,command)=>isolatedTransaction(source,async q=>{
        const reference=await command(q);output=await project(q,context,(reference as {id:string}).id);
        await authorize(q,context.tenant);await assertCurrentSessionClock(q,actor);return reference;
      }));
    return output;
  }catch(e){if(e instanceof Problem&&e.code==='tenant_not_found')throw new Problem(404,'not_found',STORE_MISSING);throw e;}
}
export async function shippingSettingsRead<T>(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string,management:boolean,run:(q:PoolClient,context:ShippingSettingsContext)=>Promise<T>):Promise<T>{
  OpaqueId.parse(tenantId);OpaqueId.parse(instanceId);
  try{return await withTenantRead(pool,{actor,tenantId,capabilitiesForRole:storeCapabilities},async(q,tenant)=>{
    await instance(q,tenantId,instanceId,false);
    const keys=await requireStoreInstance(q,tenant,instanceId,'store:read');
    if(management)requireCondition(keys.includes('store:manage')||keys.includes('store:fulfil'),403,'capability_denied','目前沒有這個操作的權限。');
    const p=await profile(q,tenantId,instanceId);ready(p);return run(q,{tenant,profile:p});
  });}catch(e){if(e instanceof Problem&&e.code==='tenant_not_found')throw new Problem(404,'not_found',STORE_MISSING);throw e;}
}
export function nextSettingsVersion(actual:string|null,expected:string|undefined):number{
  if(expected===undefined){requireCondition(actual===null,428,'version_required','請提供 If-Match 版本。');return 1;}
  requireCondition(actual!==null&&actual===expected,412,'version_conflict','資料已更新，請重新整理後再操作。');
  requireCondition(Number(actual)<2147483647,409,'version_conflict','配送設定版本已達上限。');return Number(actual)+1;
}
