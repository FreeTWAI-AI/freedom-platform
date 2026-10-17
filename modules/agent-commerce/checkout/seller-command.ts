import type {Pool,PoolClient} from 'pg';
import {OpaqueId} from '../../../contracts/guild-launchpad/v1/primitives.js';
import {assertCurrentSessionClock} from '../../../packages/db/member-session.js';
import type {TenantScopeContext} from '../../../packages/resource-scopes/index.js';
import {isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {scopedTenantCommand} from '../../../packages/scoped-commands/index.js';
import type {Actor} from '../../identity-membership/service.js';
import {requireStoreInstance,storeCapabilities} from '../hosted/capabilities.js';
import {instance,profile,ready,type Profile} from '../hosted/store.js';

export interface SellerCheckoutContext {tenant:TenantScopeContext;profile:Profile}
export type SellerCheckoutOperation='commerce.checkout_order.cancel'|'commerce.checkout_order.confirm_offline_payment'|'commerce.checkout_order.complete_meetup'|'commerce.checkout_order.record_meetup_handover'|'commerce.exception_case.resolve_with_evidence'|'commerce.exception_case.retry_allocation'|'commerce.refund.record';

/** Retained obligations remain serviceable when selling stops. The domain owns
 * its lock order; authorization does not take commerce row locks. Receipts hold
 * only a reference, and both fresh commands and replays project current rows on
 * this same transaction/client after scoped-command revalidation. */
export async function sellerCheckoutCommand<T>(pool:Pool,actor:Actor,tenantId:string,instanceId:string,capability:string|readonly string[],
  operation:SellerCheckoutOperation,target:{kind:'hosted_checkout_order'|'commerce_exception_case';id:string},body:unknown,
  key:string,expected:string|undefined,run:(q:PoolClient,context:SellerCheckoutContext)=>Promise<{id:string}>,
  project:(q:PoolClient,context:SellerCheckoutContext,id:string)=>Promise<T>):Promise<T> {
  OpaqueId.parse(tenantId);OpaqueId.parse(instanceId);OpaqueId.parse(target.id);
  let context!:SellerCheckoutContext,output!:T;
  const authorize=async(q:PoolClient,tenant:TenantScopeContext)=>{
    await instance(q,tenantId,instanceId,false);
    for(const key of typeof capability==='string'?[capability]:capability)await requireStoreInstance(q,tenant,instanceId,key,true);
    const p=await profile(q,tenantId,instanceId);ready(p);context={tenant,profile:p};
  };
  await scopedTenantCommand(pool,{actor,tenantId,tenantLock:'share',capabilitiesForRole:storeCapabilities,operation,target,body,key,expected},
    authorize,q=>run(q,context),authorize,undefined,(source,command)=>isolatedTransaction(source,async q=>{
      const reference=await command(q);
      output=await project(q,context,(reference as {id:string}).id);
      await authorize(q,context.tenant);await assertCurrentSessionClock(q,actor);
      return reference;
    }));
  return output;
}
