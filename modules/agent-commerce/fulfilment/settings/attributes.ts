import type {Pool,PoolClient} from 'pg';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-shipping.js';
import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives.js';
import {requireCondition} from '../../../../packages/shared/problem.js';
import type {Profile} from '../../hosted/store.js';
import type {ItemShippingAttributes} from '../rules/types.js';
export interface CurrentItemShippingAttributes {readonly version:string;readonly attributes:ItemShippingAttributes}
import {shippingSettingsCommand,shippingSettingsRead,nextSettingsVersion,type SettingsActor} from './command.js';
async function ownItem(q:PoolClient,p:Profile,id:string){
  const row=await q.query(`SELECT i.item_id FROM commerce_items i
    JOIN commerce_shops supply ON supply.shop_id=i.shop_id AND supply.origin='hosted'
    JOIN commerce_resource_tenants sm ON sm.resource_kind='shop' AND sm.resource_id=supply.shop_id AND sm.mapping_state='confirmed'
    JOIN commerce_shops retail ON retail.shop_id=$4 AND retail.origin='hosted'
    JOIN commerce_resource_tenants rm ON rm.resource_kind='shop' AND rm.resource_id=retail.shop_id AND rm.mapping_state='confirmed'
      AND rm.tenant_id=sm.tenant_id AND rm.instance_id=sm.instance_id
    WHERE sm.tenant_id=$1 AND sm.instance_id=$2 AND i.shop_id=$3 AND i.item_id=$5`,[p.tenant_id,p.instance_id,p.supply_shop_id,p.storefront_shop_id,id]);
  requireCondition(row.rowCount,404,'not_found','找不到這項商品。');
}
export async function currentItemShippingAttributes(q:PoolClient,itemIds:readonly string[]):Promise<Map<string,CurrentItemShippingAttributes>>{
  const rows=(await q.query<{item_id:string;version:string;weight_g:number;length_mm:number;width_mm:number;height_mm:number;temperature:'ambient'|'chilled'|'frozen';cvs_allowed:boolean;ship_alone:boolean;max_per_parcel:number|null}>(`SELECT DISTINCT ON(item_id) item_id,version::text AS version,weight_g,length_mm,width_mm,height_mm,temperature,cvs_allowed,ship_alone,max_per_parcel
    FROM commerce_item_shipping_attributes WHERE item_id=ANY($1::uuid[]) ORDER BY item_id,version DESC`,[itemIds])).rows;
  return new Map(rows.map(row=>[row.item_id,{version:row.version,attributes:wire.ItemShippingAttributesInputSchema.parse({weight_g:row.weight_g,length_mm:row.length_mm,width_mm:row.width_mm,height_mm:row.height_mm,temperature:row.temperature,cvs_allowed:row.cvs_allowed,ship_alone:row.ship_alone,max_per_parcel:row.max_per_parcel})}]));
}
async function attributesView(q:PoolClient,p:Profile,id:string){
  await ownItem(q,p,id);
  const row=(await q.query('SELECT * FROM commerce_item_shipping_attributes WHERE item_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
  const attributes=row?wire.ItemShippingAttributesInputSchema.parse(Object.fromEntries(Object.keys(wire.ItemShippingAttributesInputSchema.shape).map(key=>[key,row[key]]))):null;
  return wire.ItemShippingAttributesSchema.parse({product_id:id,version:row?String(row.version):null,attributes,updated_at:row?.created_at.toISOString()??null});
}
export function readItemShippingAttributes(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string,id:string){
  OpaqueId.parse(id);return shippingSettingsRead(pool,actor,tenantId,instanceId,false,(q,ctx)=>attributesView(q,ctx.profile,id));
}
export function saveItemShippingAttributes(pool:Pool,actor:SettingsActor,tenantId:string,instanceId:string,id:string,raw:unknown,key:string,expected:string|undefined){
  OpaqueId.parse(id);const input=wire.ItemShippingAttributesInputSchema.parse(raw);
  return shippingSettingsCommand(pool,actor,tenantId,instanceId,'store:write','commerce.item_shipping_attributes.save',{kind:'commerce_item_shipping_attributes',id},input,key,expected,async(q,ctx)=>{
    const old=await attributesView(q,ctx.profile,id),version=nextSettingsVersion(old.version,expected);
    await q.query(`INSERT INTO commerce_item_shipping_attributes(item_id,version,tenant_id,instance_id,weight_g,length_mm,width_mm,height_mm,temperature,cvs_allowed,ship_alone,max_per_parcel,created_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,version,tenantId,instanceId,input.weight_g,input.length_mm,input.width_mm,input.height_mm,input.temperature,input.cvs_allowed,input.ship_alone,input.max_per_parcel,ctx.tenant.principal_id]);return {id};
  },(q,ctx)=>attributesView(q,ctx.profile,id));
}
