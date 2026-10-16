import type {Pool,PoolClient} from 'pg';
import {SupplyCatalogSetupInputSchema,SupplyCatalogViewSchema,SupplyProductInputSchema,SupplyProductUpdateInputSchema,
  SupplyProductPageSchema,SupplyProductViewSchema,SupplyCatalogReceiptSchema,SupplyProductReceiptSchema} from '../../../contracts/guild-launchpad/v1/hosted-supply-catalog.js';
import {SupplyProfileUpdateInputSchema,SupplyProfileReceiptSchema} from '../../../contracts/guild-launchpad/v1/supplier-console.js';
import {checkVersion} from '../../../packages/db/index.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import type {TenantScopeContext} from '../../../packages/resource-scopes/index.js';
import type {Actor} from '../../identity-membership/service.js';
import {effectiveStoreCapabilities} from './capabilities.js';
import {profile,ready,createHostedProfile,productCount,storeRead,storeCommand,storeFact,type Instance,type Profile} from './store.js';
import {addProduct} from './products.js';

export async function supplyCatalogView(q:PoolClient,context:TenantScopeContext,inst:Instance) {
  const p=await profile(q,context.tenant_id,inst.instance_id),keys=await effectiveStoreCapabilities(q,context,inst.instance_id);
  return SupplyCatalogViewSchema.parse({tenant_id:context.tenant_id,instance_id:inst.instance_id,
    setup_state:p?'ready':'setup_required',catalog:p?{name:p.name,description:p.description,currency:p.currency}:null,
    retail_enabled:p?.slug!=null,product_count:p?await productCount(q,p):0,product_limit:200,
    writable:context.tenant_status==='active'&&inst.status==='active'&&inst.deployment_state==='active'&&keys.some(key=>key!=='store:read'),
    capabilities:keys,version:p?.version??null});
}
export async function readSupplyCatalog(pool:Pool,actor:Actor,tenantId:string,instanceId:string) {
  return storeRead(pool,actor,tenantId,instanceId,'store:read',(q,context,inst)=>supplyCatalogView(q,context,inst));
}
/** Same instance and resource mappings as retail, without retail activation. */
export async function setupSupplyCatalog(pool:Pool,actor:Actor,tenantId:string,instanceId:string,raw:unknown,key:string) {
  const parsed=SupplyCatalogSetupInputSchema.parse(raw),input={...parsed,description:parsed.description??''};
  return storeCommand(pool,actor,tenantId,instanceId,'store:manage','storefront.supply-catalog.setup',input,key,undefined,async(q,context,inst)=>{
    const prior=await profile(q,tenantId,instanceId,true);
    if(prior)return SupplyCatalogReceiptSchema.parse({instance_id:instanceId,version:prior.version,created:false});
    await createHostedProfile(q,context,actor,instanceId,{...input,slug:null,brand:null});
    await storeFact(q,context,instanceId,'1','storefront.supply-catalog.setup');
    return SupplyCatalogReceiptSchema.parse({instance_id:instanceId,version:'1',created:true});
  });
}
async function supplyProducts(q:PoolClient,p:Profile) {
  const rows=(await q.query(`SELECT i.item_id AS product_id,i.sku,i.title,i.description,i.price_minor AS cost_minor,i.stock,s.currency,l.aggregate_version::text AS version
    FROM commerce_items i JOIN commerce_selections l ON l.item_id=i.item_id
    JOIN commerce_resource_tenants supply ON supply.resource_kind='shop' AND supply.resource_id=i.shop_id AND supply.mapping_state='confirmed'
    JOIN commerce_resource_tenants retail ON retail.resource_kind='shop' AND retail.resource_id=l.shop_id AND retail.mapping_state='confirmed'
      AND retail.tenant_id=supply.tenant_id AND retail.instance_id=supply.instance_id
    JOIN commerce_shops s ON s.shop_id=i.shop_id AND s.origin='hosted'
    WHERE supply.tenant_id=$1 AND supply.instance_id=$2 AND i.shop_id=$3 AND l.shop_id=$4 ORDER BY i.sku LIMIT 201`,
  [p.tenant_id,p.instance_id,p.supply_shop_id,p.storefront_shop_id])).rows;
  return rows.map(row=>SupplyProductViewSchema.parse({...row,cost_minor:Number(row.cost_minor)}));
}
export async function listSupplyProducts(pool:Pool,actor:Actor,tenantId:string,instanceId:string) {
  // Costs retain the existing private supply-terms write-capability boundary.
  return storeRead(pool,actor,tenantId,instanceId,'store:write',async q=>{
    const p=await profile(q,tenantId,instanceId);ready(p);
    return SupplyProductPageSchema.parse({items:await supplyProducts(q,p),limit:200});
  });
}
export async function addSupplyProduct(pool:Pool,actor:Actor,tenantId:string,instanceId:string,raw:unknown,key:string) {
  const {cost_minor,...input}=SupplyProductInputSchema.parse(raw);
  return SupplyProductReceiptSchema.parse(await addProduct(pool,actor,tenantId,instanceId,{...input,price_minor:cost_minor},key,true));
}
export async function updateSupplyProduct(pool:Pool,actor:Actor,tenantId:string,instanceId:string,productId:string,raw:unknown,key:string,expected:string) {
  const input=SupplyProductUpdateInputSchema.parse(raw);
  return storeCommand(pool,actor,tenantId,instanceId,'store:write','storefront.supply-product.update',input,key,expected,async(q,context)=>{
    const p=await profile(q,tenantId,instanceId,true);ready(p);
    const old=(await supplyProducts(q,p)).find(product=>product.product_id===productId);
    requireCondition(old,404,'not_found','找不到這項商品。');checkVersion(old.version,expected);
    const next=SupplyProductViewSchema.parse({...old,...input,version:String(BigInt(old.version)+1n)});
    const stock=(await q.query<{reserved:number}>('SELECT reserved FROM commerce_items WHERE item_id=$1 FOR UPDATE',[productId])).rows[0];
    requireCondition(stock&&next.stock>=stock.reserved,409,'stock_below_reserved','庫存不能低於已保留的數量。');
    if(input.cost_minor!==undefined) {
      const foreign=await q.query('SELECT 1 FROM commerce_selections WHERE item_id=$1 AND shop_id<>$2 AND hosted_offer_id IS NULL LIMIT 1',[productId,p.storefront_shop_id]);
      requireCondition(!foreign.rowCount,409,'supply_terms_in_use','這項商品已有其他商店選用，請先處理既有供貨版本。');
    }
    await q.query(`UPDATE commerce_items i SET title=$4,description=$5,price_minor=$6,stock=$7
      FROM commerce_resource_tenants m WHERE m.resource_kind='shop' AND m.resource_id=i.shop_id AND m.mapping_state='confirmed'
      AND m.tenant_id=$1 AND m.instance_id=$2 AND i.item_id=$3`,[tenantId,instanceId,productId,next.title,next.description,next.cost_minor,next.stock]);
    // Keep the established own-selection fence, but never copy supply cost into
    // an activated listing's retail price or implicitly opt into publication.
    await q.query('UPDATE commerce_selections SET aggregate_version=aggregate_version+1 WHERE shop_id=$1 AND item_id=$2',[p.storefront_shop_id,productId]);
    await storeFact(q,context,productId,next.version,'storefront.supply-product.update','storefront_product');
    return SupplyProductReceiptSchema.parse({product_id:productId,version:next.version});
  },productId);
}

export async function updateSupplyProfile(pool:Pool,actor:Actor,tenantId:string,instanceId:string,raw:unknown,key:string,expected:string) {
  const input=SupplyProfileUpdateInputSchema.parse(raw);
  return storeCommand(pool,actor,tenantId,instanceId,'store:manage','storefront.supply-profile.update',input,key,expected,async(q,context)=>{
    const p=await profile(q,tenantId,instanceId,true);ready(p);
    requireCondition(p.slug===null,409,'retail_profile_settings','這個商品庫已開零售商店，請在商店資料修改名稱與說明。');
    checkVersion(p.version,expected);
    await q.query(`UPDATE commerce_shops s SET name=$3,description=$4 FROM commerce_resource_tenants m
      WHERE m.resource_kind='shop' AND m.resource_id=s.shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND m.mapping_state='confirmed' AND s.origin='hosted'`,
    [tenantId,instanceId,input.name??p.name,input.description??p.description]);
    await q.query(`UPDATE commerce_storefront_profiles p SET version=p.version+1,updated_at=clock_timestamp()
      FROM commerce_resource_tenants m WHERE m.resource_id=p.storefront_shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND p.instance_id=m.instance_id`,
    [tenantId,instanceId]);
    const version=String(BigInt(p.version)+1n);
    await storeFact(q,context,instanceId,version,'storefront.supply-profile.update');
    return SupplyProfileReceiptSchema.parse({instance_id:instanceId,version});
  });
}
