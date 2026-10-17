import type {Pool,PoolClient} from 'pg';
import * as wire from '../../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {adminCommand,audit,type AdminActor,type AdminCommand} from '../../platform-admin/service.js';
import {bindPlatformAdminContext,isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import {bindTenantScope} from '../../tenant-workspaces/facts.js';
import type {CheckoutAdmissionPort} from '../checkout/terms.js';
import {recordControlEvent} from './control-events.js';
import {bindStore as bindCheckoutStore} from '../checkout/authority.js';
export type CommerceProviderEnvironment='sandbox'|'live';
export const providerEnvironment=(environment:'local'|'staging'|'public'):CommerceProviderEnvironment=>environment==='public'?'live':'sandbox';
async function bindStore(q:PoolClient,admin:AdminActor,tenantId:string,instanceId?:string,active=false){
  await bindPlatformAdminContext(q,admin.admin_id);await bindTenantScope(q,tenantId);
  const tenant=(await q.query('SELECT community_id,status FROM tenants WHERE tenant_id=$1 FOR UPDATE',[tenantId])).rows[0];
  requireCondition(tenant?.community_id===admin.community_id,404,'tenant_not_found','找不到這個業務空間。');
  if(instanceId){
    const instance=(await q.query("SELECT status FROM module_instances WHERE tenant_id=$1 AND instance_id=$2 AND module_key='storefront' FOR SHARE",[tenantId,instanceId])).rows[0];
    requireCondition(instance,404,'not_found','找不到這間商店。');
    if(active)requireCondition(tenant.status==='active'&&instance.status==='active',409,'store_admission_unavailable','目前無法准入這間商店。');
  }
  const member=await q.query(`SELECT 1 FROM tenant_memberships m JOIN principals p ON p.principal_id=m.principal_id
    JOIN users u ON u.user_id=p.user_ref WHERE m.tenant_id=$1 AND m.status='active' AND lower(u.email)=lower($2) LIMIT 1`,[tenantId,admin.email]);
  requireCondition(member.rowCount===0,403,'admission_not_independent','准入管理員不能是這個業務空間的成員。');
}
function view(row:Record<string,any>){
  return wire.StoreAdmissionViewSchema.parse({...row,admitted_at:row.admitted_at.toISOString(),revoked_at:row.revoked_at?.toISOString()??null});
}
const load=async(q:PoolClient,id:string)=>{
  const row=(await q.query('SELECT * FROM commerce_store_admissions WHERE admission_id=$1',[id])).rows[0];
  requireCondition(row,404,'store_admission_not_found','找不到商店准入紀錄。');return row;
};
export async function admitStore(pool:Pool,input:AdminCommand,environment:CommerceProviderEnvironment){
  const body=wire.StoreAdmissionCreateInputSchema.parse(input.body);
  const authorize=(q:PoolClient)=>bindStore(q,input.admin,body.tenant_id,body.instance_id,true);
  return adminCommand(pool,{...input,body},authorize,async q=>{
    let row;
    try{row=(await q.query(`INSERT INTO commerce_store_admissions(tenant_id,instance_id,environment,admitted_by,reason)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,[body.tenant_id,body.instance_id,environment,input.admin.admin_id,body.reason])).rows[0];}
    catch(e){if((e as {code?:string;constraint?:string}).code==='23505'&&(e as {constraint?:string}).constraint==='commerce_store_admissions_one_active')throw new Problem(409,'store_admission_exists','這間商店已有有效的准入紀錄。');throw e;}
    const result=view(row);
    await audit(q,input.admin,input.operation,'commerce_store_admission',row.admission_id,body.reason,null,result);
    await recordControlEvent(q,{tenantId:body.tenant_id,instanceId:body.instance_id,kind:'store_admission.admitted',subjectId:row.admission_id,detail:{environment},actorKind:'platform_admin',actorId:input.admin.admin_id});return result;
  },false,authorize,isolatedTransaction);
}
export async function revokeStoreAdmission(pool:Pool,input:AdminCommand,admissionId:string){
  const body=wire.StoreAdmissionRevokeInputSchema.parse(input.body);
  const authorize=async(q:PoolClient)=>{
    const row=await load(q,admissionId);
    try{await bindStore(q,input.admin,row.tenant_id,row.instance_id);}
    catch(error){
      if(error instanceof Problem&&error.status===404&&error.code==='tenant_not_found')throw new Problem(404,'store_admission_not_found','找不到商店准入紀錄。');
      throw error;
    }
  };
  return adminCommand(pool,{...input,body},authorize,async q=>{
    const row=await load(q,admissionId);requireCondition(row.revoked_at===null,409,'admission_revoked','這份商店准入已撤銷。');
    const result=view((await q.query(`UPDATE commerce_store_admissions SET revoked_at=clock_timestamp(),revoked_by=$2,revoke_reason=$3 WHERE admission_id=$1 RETURNING *`,[admissionId,input.admin.admin_id,body.reason])).rows[0]);
    await audit(q,input.admin,input.operation,'commerce_store_admission',admissionId,body.reason,view(row),result);
    await recordControlEvent(q,{tenantId:row.tenant_id,instanceId:row.instance_id,kind:'store_admission.revoked',subjectId:admissionId,detail:{environment:row.environment},actorKind:'platform_admin',actorId:input.admin.admin_id});return result;
  },false,authorize,isolatedTransaction);
}
export async function listStoreAdmissions(pool:Pool,admin:AdminActor,tenantId:string){
  return isolatedTransaction(pool,async q=>{
    requireCondition((await q.query('SELECT 1 FROM platform_admins WHERE admin_id=$1 AND community_id=$2 AND email=$3 AND active FOR SHARE',[admin.admin_id,admin.community_id,admin.email])).rowCount===1,403,'admin_required','管理權限已變更。');
    // Listing is community-scoped; the independence rule applies to decisions.
    await bindPlatformAdminContext(q,admin.admin_id);await bindTenantScope(q,tenantId);
    const tenant=(await q.query('SELECT community_id FROM tenants WHERE tenant_id=$1',[tenantId])).rows[0];
    requireCondition(tenant?.community_id===admin.community_id,404,'tenant_not_found','找不到這個業務空間。');
    return wire.StoreAdmissionPageSchema.parse({items:(await q.query('SELECT * FROM commerce_store_admissions WHERE tenant_id=$1 ORDER BY admitted_at DESC,admission_id DESC LIMIT 100',[tenantId])).rows.map(view)});
  });
}
export function createStoreAdmissionPort(environment:CommerceProviderEnvironment,profiles:readonly string[]):CheckoutAdmissionPort{
  return {async allowed(q,store){
    if(!profiles.length)return false;
    const owner=(await q.query('SELECT tenant_id FROM commerce_storefront_profiles WHERE storefront_shop_id=$1',[store.storefront_shop_id])).rows[0];
    if(!owner)return false;await bindCheckoutStore(q,owner.tenant_id);
    return (await q.query(`SELECT 1 FROM commerce_storefront_profiles p
      JOIN module_instances i ON i.tenant_id=p.tenant_id AND i.instance_id=p.instance_id AND i.module_key='storefront'
      JOIN module_definitions actual ON actual.module_key=i.module_key AND actual.release_ref=i.module_release_ref
      JOIN module_definitions required ON required.module_key='storefront' AND required.release_ref='storefront@1.1.0'
      JOIN commerce_store_admissions a ON a.tenant_id=i.tenant_id AND a.instance_id=i.instance_id AND a.environment=$2 AND a.revoked_at IS NULL
      WHERE p.storefront_shop_id=$1 AND actual.capabilities @> required.capabilities
        AND (EXISTS(SELECT 1 FROM commerce_provider_account_services service WHERE service.tenant_id=p.tenant_id AND service.instance_id=p.instance_id
          AND service.environment=$2 AND service.purpose='payment' AND service.state='active' AND service.profile=ANY($3::text[]))
          OR EXISTS(SELECT 1 FROM commerce_offline_payment_settings s WHERE s.tenant_id=p.tenant_id AND s.instance_id=p.instance_id
            AND s.version=(SELECT max(version) FROM commerce_offline_payment_settings WHERE tenant_id=p.tenant_id AND instance_id=p.instance_id)
            AND ((jsonb_typeof(s.document->'bank_transfer')='object' AND 'offline.bank_transfer.v1'=ANY($3::text[]))
              OR (jsonb_typeof(s.document->'cash_on_meetup')='object' AND 'offline.cash_on_meetup.v1'=ANY($3::text[])))))
      LIMIT 1`,[store.storefront_shop_id,environment,profiles])).rowCount===1;
  }};
}
