import type {Pool,PoolClient} from 'pg';
import * as wire from '../../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {LogisticsServiceKeySchema} from '../../../contracts/guild-launchpad/v1/hosted-shipping.js';
import {requireCondition,Problem} from '../../../packages/shared/problem.js';
import type {Actor} from '../../identity-membership/service.js';
import type {ServiceKey} from '../fulfilment/rules/types.js';
import {recordControlEvent} from '../operations/control-events.js';
import {account,accountView,bumpAccount,command,lockMachineAccount,machineFact,parseInput,updateServiceState} from './accounts.js';

async function changeState(q:PoolClient,id:string,state:string,activationRef?:string){
  try{await q.query(`UPDATE commerce_logistics_services SET state=$2,version=version+1,updated_at=clock_timestamp(),
    activated_at=CASE WHEN $3::text IS NOT NULL THEN clock_timestamp() ELSE activated_at END,
    activation_ref=coalesce($3,activation_ref) WHERE logistics_service_id=$1`,[id,state,activationRef??null]);}
  catch(e){if((e as {code?:string;constraint?:string}).code==='23505'&&(e as {constraint?:string}).constraint==='commerce_logistics_services_one_active')throw new Problem(409,'logistics_service_conflict','這間商店已有相同的啟用物流服務。');throw e;}
}
export async function createLogisticsService(pool:Pool,actor:Actor,tenantId:string,instanceId:string,accountId:string,raw:unknown,key:string,expected:string){
  const input=parseInput(wire.LogisticsServiceCreateInputSchema,raw);
  return command(pool,actor,tenantId,instanceId,accountId,'commerce.logistics_service.create',input,key,expected,async(q,ctx)=>{
    const a=await account(q,accountId,tenantId,instanceId),purpose=(await q.query("SELECT state FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='logistics' FOR UPDATE",[accountId])).rows[0];
    requireCondition(purpose,409,'logistics_credentials_required','請先設定物流服務憑證。');
    requireCondition(purpose.state!=='retired',409,'provider_service_state','供應商服務狀態不允許這個操作。');
    requireCondition(!(await q.query("SELECT 1 FROM commerce_logistics_services WHERE account_id=$1 AND service_key=$2 AND state<>'retired'",[accountId,input.service_key])).rowCount,409,'logistics_service_exists','這個帳戶已有相同的物流服務。');
    try{await q.query(`INSERT INTO commerce_logistics_services(account_id,service_key,tenant_id,instance_id,environment,created_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6)`,[accountId,input.service_key,tenantId,instanceId,a.environment,ctx.principal_id]);}
    catch(e){if((e as {code?:string;constraint?:string}).code==='23505'&&(e as {constraint?:string}).constraint==='commerce_logistics_services_current')throw new Problem(409,'logistics_service_exists','這個帳戶已有相同的物流服務。');throw e;}
    await bumpAccount(q,accountId);
    await recordControlEvent(q,{tenantId,instanceId,kind:'logistics_service.created',subjectId:accountId,detail:{service_key:input.service_key,environment:a.environment},actorKind:'person',actorId:ctx.principal_id});return accountView(q,accountId);
  });
}
export async function changeLogisticsServiceState(pool:Pool,actor:Actor,tenantId:string,instanceId:string,accountId:string,serviceKey:ServiceKey,action:'suspend'|'resume'|'retire',raw:unknown,key:string,expected:string){
  LogisticsServiceKeySchema.parse(serviceKey);const input=parseInput(wire.ProviderServiceStateInputSchema,raw);
  const body={...input,service_key:serviceKey};
  return command(pool,actor,tenantId,instanceId,accountId,`commerce.logistics_service.${action}`,body,key,expected,async(q,ctx)=>{
    const purpose=(await q.query("SELECT state FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='logistics' FOR UPDATE",[accountId])).rows[0];
    const old=(await q.query("SELECT * FROM commerce_logistics_services WHERE account_id=$1 AND service_key=$2 AND state<>'retired' FOR UPDATE",[accountId,serviceKey])).rows[0];
    requireCondition(old,404,'logistics_service_not_found','找不到物流服務。');
    const target={suspend:'suspended',resume:'active',retire:'retired'}[action];
    requireCondition(action==='suspend'&&old.state==='active'||action==='resume'&&old.state==='suspended'&&old.activated_at||action==='retire',409,'logistics_service_state','物流服務狀態不允許這個操作。');
    if(action==='resume')requireCondition(purpose&&purpose.state!=='retired',409,'provider_service_state','供應商服務狀態不允許這個操作。');
    await changeState(q,old.logistics_service_id,target);await bumpAccount(q,accountId);
    await recordControlEvent(q,{tenantId,instanceId,kind:'logistics_service.state_changed',subjectId:accountId,detail:{service_key:serviceKey,from_state:old.state,to_state:target},actorKind:'person',actorId:ctx.principal_id});return accountView(q,accountId);
  });
}
/** Caller owns the transaction and has bound its stored tenant. Verification
 * shipment orchestration in wp05-activation is responsible for the evidence. */
export async function activateLogisticsService(q:PoolClient,input:{accountId:string;serviceKey:ServiceKey;activationRef:string}):Promise<void>{
  LogisticsServiceKeySchema.parse(input.serviceKey);
  requireCondition(typeof input.activationRef==='string'&&input.activationRef.length>=1&&input.activationRef.length<=200,422,'validation_failed','啟用參照無效。');
  const a=await lockMachineAccount(q,input.accountId);
  const purpose=(await q.query("SELECT state FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='logistics' FOR UPDATE",[input.accountId])).rows[0];
  requireCondition(purpose&&(purpose.state==='draft'||purpose.state==='active'),409,'provider_service_state','供應商服務狀態不允許這個操作。');
  const row=(await q.query("SELECT * FROM commerce_logistics_services WHERE account_id=$1 AND service_key=$2 AND state<>'retired' FOR UPDATE",[input.accountId,input.serviceKey])).rows[0];
  requireCondition(row?.state==='draft',409,'logistics_service_state','物流服務狀態不允許這個操作。');
  if(purpose.state==='draft'){
    await updateServiceState(q,input.accountId,'logistics','active',input.activationRef);
    await machineFact(q,a,'provider_service.state_changed',{purpose:'logistics',from_state:'draft',to_state:'active'});
  }
  await changeState(q,row.logistics_service_id,'active',input.activationRef);await bumpAccount(q,input.accountId);
  await machineFact(q,a,'logistics_service.state_changed',{service_key:input.serviceKey,from_state:'draft',to_state:'active'});
}
