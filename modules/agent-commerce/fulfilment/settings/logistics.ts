import type {PoolClient} from 'pg';
import {SERVICE_KEYS,type ServiceKey} from '../rules/types.js';
export type ShippingEnvironment='sandbox'|'live';
type Availability={service_key:ServiceKey;state:'active'|'suspended'|'draft'|'not_configured'};
/** The sole availability policy: activated sub-types under a retained purpose may
 * be configured; quotes require both rows active. No account locks are taken. */
export async function logisticsAvailability(q:PoolClient,input:{instanceId:string;environment:ShippingEnvironment}):Promise<{logistics:Availability[];profileServiceKeys:Set<ServiceKey>}>{
  const rows=(await q.query(`SELECT l.service_key,l.state,l.activated_at,p.state AS purpose_state
    FROM commerce_logistics_services l JOIN commerce_provider_account_services p
      ON p.account_id=l.account_id AND p.purpose=l.purpose AND p.tenant_id=l.tenant_id
      AND p.instance_id=l.instance_id AND p.environment=l.environment
    WHERE l.instance_id=$1 AND l.environment=$2 AND l.state<>'retired' AND p.state<>'retired'`,[input.instanceId,input.environment])).rows;
  const profileServiceKeys=new Set<ServiceKey>();
  const logistics=SERVICE_KEYS.map(service_key=>{
    let state:Availability['state']='not_configured';
    for(const row of rows.filter(row=>row.service_key===service_key)){
      if(row.activated_at)profileServiceKeys.add(service_key);
      const candidate=row.state==='active'&&row.purpose_state==='active'?'active':row.activated_at&&(row.state==='suspended'||row.purpose_state==='suspended')?'suspended':'draft';
      const rank={not_configured:0,draft:1,suspended:2,active:3};if(rank[candidate]>rank[state])state=candidate;
    }
    return {service_key,state};
  });
  return {logistics,profileServiceKeys};
}
export async function resolveLogisticsService(q:PoolClient,input:{instanceId:string;environment:ShippingEnvironment;serviceKey:ServiceKey}):Promise<{accountId:string;logisticsServiceId:string;credentialVersion:number}|null>{
  const row=(await q.query(`SELECT l.account_id,l.logistics_service_id,p.credential_version
    FROM commerce_logistics_services l JOIN commerce_provider_account_services p
      ON p.account_id=l.account_id AND p.purpose=l.purpose AND p.tenant_id=l.tenant_id
      AND p.instance_id=l.instance_id AND p.environment=l.environment
    WHERE l.instance_id=$1 AND l.environment=$2 AND l.service_key=$3 AND l.state='active' AND p.state='active'`,[input.instanceId,input.environment,input.serviceKey])).rows[0];
  return row?{accountId:row.account_id,logisticsServiceId:row.logistics_service_id,credentialVersion:row.credential_version}:null;
}
