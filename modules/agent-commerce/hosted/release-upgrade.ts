import type {Pool,PoolClient} from 'pg';
import {StoreReleaseSchema,CommerceSetupEmptyInputSchema} from '../../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {checkVersion} from '../../../packages/db/index.js';
import type {TenantScopeContext} from '../../../packages/resource-scopes/index.js';
import {scopedTenantCommand} from '../../../packages/scoped-commands/index.js';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import type {Actor} from '../../identity-membership/service.js';
import {bumpAuthorizationRevision} from '../../tenant-workspaces/facts.js';
import {recordControlEvent} from '../operations/control-events.js';
import {effectiveStoreCapabilities,requireStoreInstance,storeCapabilities,STORE_MISSING} from './capabilities.js';
import {instance,storeFact,storeRead} from './store.js';
async function releaseView(q:PoolClient,ctx:TenantScopeContext,id:string){
  const row=(await q.query(`SELECT module_release_ref,application_release_ref,version::text,status FROM module_instances
    WHERE tenant_id=$1 AND instance_id=$2 AND module_key='storefront'`,[ctx.tenant_id,id])).rows[0];
  requireCondition(row,404,'not_found',STORE_MISSING);
  const path=(await q.query(`SELECT to_release_ref AS module_release_ref,to_application_release_ref AS application_release_ref
    FROM module_release_upgrades WHERE module_key='storefront' AND from_release_ref=$1 AND from_application_release_ref=$2`,[row.module_release_ref,row.application_release_ref])).rows[0]??null;
  return StoreReleaseSchema.parse({module_release_ref:row.module_release_ref,application_release_ref:row.application_release_ref,
    version:row.version,capabilities:await effectiveStoreCapabilities(q,ctx,id),upgrade:path,
    can_upgrade:ctx.role==='owner'&&path!==null&&ctx.tenant_status==='active'&&row.status==='active'});
}
export function readStoreRelease(pool:Pool,actor:Actor,tenantId:string,instanceId:string){
  return storeRead(pool,actor,tenantId,instanceId,'store:read',(q,ctx)=>releaseView(q,ctx,instanceId));
}
export async function upgradeStoreRelease(pool:Pool,actor:Actor,tenantId:string,instanceId:string,raw:unknown,key:string,expected:string){
  const body=CommerceSetupEmptyInputSchema.parse(raw);
  const authorize=async(q:PoolClient,ctx:TenantScopeContext)=>{
    const inst=await instance(q,tenantId,instanceId,false,true);
    await requireStoreInstance(q,ctx,instanceId,'store:read');
    requireCondition(ctx.role==='owner',403,'capability_denied','目前沒有這個操作的權限。');
    requireCondition(ctx.tenant_status==='active'&&inst.status==='active',409,'store_upgrade_unavailable','目前無法升級這間商店。');
  };
  try{return await scopedTenantCommand(pool,{actor,tenantId,operation:'commerce.storefront.upgrade',body,key,expected,
    target:{kind:'storefront',id:instanceId},capabilitiesForRole:storeCapabilities},authorize,async(q,ctx)=>{
    await q.query('SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND instance_id=$2 FOR NO KEY UPDATE',[tenantId,instanceId]);
    const current=await releaseView(q,ctx,instanceId);
    checkVersion(current.version,expected);
    requireCondition(current.upgrade,409,'store_upgrade_unavailable','目前無法升級這間商店。');
    const updated=(await q.query(`UPDATE module_instances SET module_release_ref=$3,application_release_ref=$4,version=version+1
      WHERE tenant_id=$1 AND instance_id=$2 RETURNING version::text`,[tenantId,instanceId,current.upgrade.module_release_ref,current.upgrade.application_release_ref])).rows[0];
    await bumpAuthorizationRevision(q,tenantId);
    // Instance and profile versions are independent journal aggregates.
    await storeFact(q,ctx,instanceId,updated.version,'commerce.storefront.upgrade','storefront_release');
    await recordControlEvent(q,{tenantId,instanceId,kind:'storefront.upgraded',subjectId:instanceId,
      detail:{module_release_ref:current.upgrade.module_release_ref},actorKind:'person',actorId:ctx.principal_id});
    return releaseView(q,ctx,instanceId);
  },authorize);}catch(e){if(e instanceof Problem&&e.code==='tenant_not_found')throw new Problem(404,'not_found',STORE_MISSING);throw e;}
}
