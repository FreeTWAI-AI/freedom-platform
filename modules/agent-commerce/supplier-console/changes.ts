import type {Pool} from 'pg';
import {SupplierChangesQuerySchema,SupplierChangesSchema} from '../../../contracts/guild-launchpad/v1/supplier-console.js';
import type {Actor} from '../../identity-membership/service.js';
import {profile,ready,storeRead} from '../hosted/store.js';

// storeFact writers: supply-catalog/products/supply-terms/photo-commands,
// distribution and seller-orders. Operation and aggregate must agree.
const subjects=[
  ['storefront.supply-catalog.setup','storefront','business'],
  ['storefront.supply-profile.update','storefront','business'],
  ['storefront.reservations.configure','storefront','business'],
  ['storefront.supply-product.create','storefront_product','product'],
  ['storefront.product.create','storefront_product','product'],
  ['storefront.supply-product.update','storefront_product','product'],
  ['storefront.product.update','storefront_product','product'],
  ['storefront.supply-terms.update','storefront_product','product'],
  ['storefront.product.photo.upload','storefront_product','product'],
  ['storefront.product.photo.remove','storefront_product','product'],
  ['storefront.supply-offer.publish','hosted_supply_offer','offer'],
  ['storefront.supply-offer.withdraw','hosted_supply_offer','offer'],
  ['storefront.distribution.decide','hosted_distribution','request'],
].map(([operation,aggregate_type,kind])=>({operation,aggregate_type,kind}));

export async function readSupplierChanges(pool:Pool,actor:Actor,tenantId:string,instanceId:string,rawQuery:unknown) {
  const query=SupplierChangesQuerySchema.parse(rawQuery);
  return storeRead(pool,actor,tenantId,instanceId,'store:write',async(q,context)=>{
    const p=await profile(q,tenantId,instanceId);ready(p);
    const row=(await q.query(`/* supplier-console:changes */ WITH clock AS (SELECT statement_timestamp() AS at),own AS (
        SELECT i.item_id,i.title FROM commerce_items i JOIN commerce_selections l ON l.item_id=i.item_id
        JOIN commerce_resource_tenants supply ON supply.resource_kind='shop' AND supply.resource_id=i.shop_id AND supply.mapping_state='confirmed'
        JOIN commerce_resource_tenants retail ON retail.resource_kind='shop' AND retail.resource_id=l.shop_id AND retail.mapping_state='confirmed'
          AND retail.tenant_id=supply.tenant_id AND retail.instance_id=supply.instance_id
        WHERE supply.tenant_id=$1 AND supply.instance_id=$2 AND i.shop_id=$3 AND l.shop_id=$4
      ),offers AS (
        SELECT o.offer_id,o.item_id,i.title FROM commerce_hosted_supply_offers o JOIN own i ON i.item_id=o.item_id
        WHERE o.tenant_id=$1 AND o.instance_id=$2
      ),subjects AS (
        SELECT 'business' AS kind,$2::uuid AS id,NULL::uuid AS product_id,jsonb_build_object('kind','business') AS subject
        UNION ALL SELECT 'product',i.item_id,i.item_id,jsonb_build_object('kind','product','product_id',i.item_id,'title',i.title) FROM own i
        UNION ALL SELECT 'offer',o.offer_id,o.item_id,jsonb_build_object('kind','offer','offer_id',o.offer_id,'product_id',o.item_id,'title',o.title) FROM offers o
        UNION ALL SELECT 'request',l.selection_id,o.item_id,jsonb_build_object('kind','request','selection_id',l.selection_id,
          'product_id',o.item_id,'title',o.title,'partner_id',l.shop_id,'partner_name',s.name)
          FROM offers o JOIN commerce_selections l ON l.hosted_offer_id=o.offer_id AND l.item_id=o.item_id
          JOIN commerce_shops s ON s.shop_id=l.shop_id AND s.origin='hosted'
      ),changes AS (
        SELECT j.transition_id,j.created_at,j.operation,j.aggregate_version::text AS version,s.subject
        FROM scoped_transition_journal j
        JOIN jsonb_to_recordset($7::jsonb) AS allowed(operation text,aggregate_type text,kind text)
          ON allowed.operation=j.operation AND allowed.aggregate_type=j.aggregate_type
        JOIN subjects s ON s.kind=allowed.kind AND s.id=j.aggregate_id
        WHERE j.scope_kind='tenant' AND j.scope_id=$5 AND ($6::uuid IS NULL OR s.product_id=$6)
        ORDER BY j.created_at DESC,j.transition_id DESC LIMIT 21
      ) SELECT to_char(clock.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('change_id',transition_id,
          'at',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'operation',operation,'version',version,'subject',subject) ORDER BY created_at DESC,transition_id DESC) FROM changes),'[]') AS items FROM clock`,
    [tenantId,instanceId,p.supply_shop_id,p.storefront_shop_id,context.scope.scope_id,query.product_id??null,JSON.stringify(subjects)])).rows[0];
    return SupplierChangesSchema.parse({profile:'freedom.supplier-console.changes/v1',as_of:row.as_of,product_id:query.product_id??null,
      items:row.items.slice(0,20),truncated:row.items.length>20});
  });
}
