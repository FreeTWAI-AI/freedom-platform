import type {Pool} from 'pg';
import {SupplierOverviewSchema, SupplierProductsSchema, SupplierProductDetailSchema, SupplierPartnersSchema,
  SupplierPartnerDetailSchema, SupplierRequestDetailSchema, SupplierSummarySchema, type SupplierProduct, type SupplierTodo} from '../../../contracts/guild-launchpad/v1/supplier-console.js';
import {digest} from '../../../packages/db/index.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import type {Actor} from '../../identity-membership/service.js';
import {effectiveStoreCapabilities} from '../hosted/capabilities.js';
import {offerView, selectionView, supplyOfferTerms} from '../hosted/distribution.js';
import {profile, ready, storeRead, type Profile} from '../hosted/store.js';

// Each composed statement below owns its clock and all domain rows. Capability,
// profile and the final storeRead session fence remain outside this snapshot.
const clock = `clock AS (SELECT statement_timestamp() AS at)`;
const asOf = `to_char(clock.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of`;
const capacity = `(SELECT count(*)::int FROM commerce_selections l
  JOIN commerce_resource_tenants m ON m.resource_kind='shop' AND m.resource_id=l.shop_id
  WHERE m.tenant_id=$1 AND m.instance_id=$2 AND m.resource_id=$4 AND m.mapping_state='confirmed') AS product_count`;
// Availability is derived only in this column (stock minus the reserved counter), so a
// commerce-owned availability rule can replace it here without touching the projections.
export const own = `own AS (
  SELECT i.*,i.stock-i.reserved AS available,l.aggregate_version::text AS product_version,s.currency
  FROM commerce_items i JOIN commerce_selections l ON l.item_id=i.item_id
  JOIN commerce_resource_tenants supply ON supply.resource_kind='shop' AND supply.resource_id=i.shop_id AND supply.mapping_state='confirmed'
  JOIN commerce_resource_tenants retail ON retail.resource_kind='shop' AND retail.resource_id=l.shop_id AND retail.mapping_state='confirmed'
    AND retail.tenant_id=supply.tenant_id AND retail.instance_id=supply.instance_id
  JOIN commerce_shops s ON s.shop_id=i.shop_id AND s.origin='hosted'
  WHERE supply.tenant_id=$1 AND supply.instance_id=$2 AND i.shop_id=$3 AND l.shop_id=$4
)`;
export const offers = `offers AS (
  SELECT o.offer_id,o.item_id,o.supplier_name,o.source_version::text AS source_version,
    o.terms,o.terms_sha256,o.state,o.version::text AS version FROM commerce_hosted_supply_offers o
  JOIN commerce_items i ON i.item_id=o.item_id AND i.shop_id=$3
  JOIN commerce_storefront_profiles source ON source.tenant_id=o.tenant_id AND source.instance_id=o.instance_id
    AND source.supply_shop_id=$3 AND source.storefront_shop_id=$4
  WHERE o.tenant_id=$1 AND o.instance_id=$2
)`;
export const selections = `selections AS (
  SELECT o.*,l.selection_id,l.shop_id AS partner_id,l.hosted_sku,l.retail_price_minor,l.listing_sha256,l.acceptance_state,
    l.aggregate_version::text AS selection_version,s.name AS seller_name,
    CASE WHEN o.state='withdrawn' OR l.acceptance_state IN ('declined','revoked') THEN 'inactive'
      WHEN l.acceptance_state='awaiting_supply_acceptance' THEN 'awaiting'
      ELSE l.acceptance_state END AS bucket,
    CASE l.acceptance_state WHEN 'awaiting_supply_acceptance' THEN 0 WHEN 'sellable' THEN 1 WHEN 'changes_requested' THEN 2 ELSE 3 END AS rank
  FROM offers o JOIN commerce_selections l ON l.hosted_offer_id=o.offer_id AND l.item_id=o.item_id
  JOIN commerce_shops s ON s.shop_id=l.shop_id AND s.origin='hosted'
)`;
export const cooperation = `jsonb_build_object('awaiting',count(*) FILTER (WHERE bucket='awaiting'),
  'sellable',count(*) FILTER (WHERE bucket='sellable'),'changes_requested',count(*) FILTER (WHERE bucket='changes_requested'),
  'inactive',count(*) FILTER (WHERE bucket='inactive'))`;
export const products = `products AS (
  SELECT i.*, (SELECT to_jsonb(o) FROM offers o WHERE o.item_id=i.item_id AND o.state='offered') AS current_offer,
    (SELECT ${cooperation} FROM selections l WHERE l.item_id=i.item_id) AS cooperation FROM own i
)`;
export const partners = `partners AS (
  SELECT partner_id,seller_name AS name,${cooperation} AS cooperation,count(DISTINCT item_id)::int AS products,
    count(*) FILTER (WHERE bucket='awaiting') AS awaiting FROM selections GROUP BY partner_id,seller_name
)`;
const productCtes = `${clock},${own},${offers},${selections},${products}`;
const partnerCtes = `${clock},${offers},${selections},${partners}`;
export const params = (p: Profile) => [p.tenant_id,p.instance_id,p.supply_shop_id,p.storefront_shop_id];
export type Row = Record<string, any>;
export function productView(row: Row, currency: Profile['currency']): SupplierProduct {
  const o = row.current_offer;
  return {product_id:row.item_id,sku:row.sku,title:row.title,description:row.description,currency,
    supply_price_minor:Number(row.price_minor),shipping_minor:Number(row.shipping_minor),stock:row.stock,reserved:row.reserved,
    available:row.available,version:row.product_version,cooperation:row.cooperation,
    offer:o?{offer_id:o.offer_id,version:String(o.version),terms_sha256:o.terms_sha256,
      matches_current_terms:digest(supplyOfferTerms(row as Parameters<typeof supplyOfferTerms>[0],currency))===o.terms_sha256}:null};
}
export function partnerView(row: Row) {
  return {partner_id:row.partner_id,name:row.name,cooperation:row.cooperation,products:row.products};
}

export async function readSupplierOverview(pool: Pool, actor: Actor, tenantId: string, instanceId: string) {
  return storeRead(pool,actor,tenantId,instanceId,'store:read',async(q,context)=>{
    const p = await profile(q, tenantId, instanceId); ready(p);
    const writable=(await effectiveStoreCapabilities(q,context,instanceId)).includes('store:write');
    const unavailable={state:'unavailable',reason:'store_write_required'} as const;
    const base={profile:'freedom.supplier-console.overview/v1',tenant_id:tenantId,instance_id:instanceId,product_limit:200};
    if(!writable) {
      const row=(await q.query(`/* supplier-console:overview-reader */ WITH ${clock} SELECT ${asOf},${capacity.replaceAll('$4','$3')} FROM clock`,
        [tenantId,instanceId,p.storefront_shop_id])).rows[0];
      return SupplierOverviewSchema.parse({...base,...row,metrics:{offered_products:unavailable,pending_requests:unavailable,
        active_reservation_lines:unavailable,out_of_stock_products:unavailable},todos:unavailable});
    }
    // Do not even include order relations in a non-owner's statement.
    const reservations=context.role==='owner'?`(SELECT count(*)::int FROM commerce_order_lines line
      JOIN commerce_orders o ON o.order_id=line.order_id AND o.order_profile=line.order_profile
      JOIN offers offer ON offer.offer_id=line.hosted_offer_id AND offer.item_id=line.item_id
      WHERE line.supplier_shop_id=$3 AND line.hosted_offer_id IS NOT NULL AND line.order_profile='hosted_shared_reservation'
        AND o.reservation_state='reserved' AND o.expires_at>clock.at)`:'NULL::int';
    const row=(await q.query(`/* supplier-console:overview */ WITH ${productCtes}
      SELECT ${asOf},${capacity},${reservations} AS active_reservation_lines,
        (SELECT count(*)::int FROM selections WHERE bucket='awaiting') AS pending_requests,
        COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sku,i.item_id) FROM products i),'[]') AS products,
        COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.sku,r.item_id,r.selection_id) FROM (
          SELECT l.selection_id,l.partner_id,l.seller_name,i.sku,i.item_id,i.title FROM selections l JOIN commerce_items i ON i.item_id=l.item_id AND i.shop_id=$3
          WHERE l.bucket='awaiting' ORDER BY i.sku,i.item_id,l.selection_id LIMIT 21) r),'[]') AS requests FROM clock`,params(p))).rows[0];
    const items=(row.products as Row[]).map(row=>productView(row,p.currency)),todos:SupplierTodo[]=(row.requests as Row[]).map(r=>({kind:'request_pending',
      selection_id:r.selection_id,product_id:r.item_id,title:r.title,partner_id:r.partner_id,partner_name:r.seller_name}));
    // Products arrive in SKU/ID order; concatenate kinds to keep the specified priority.
    for(const item of items)if(item.offer&&!item.offer.matches_current_terms)todos.push({kind:'offer_outdated',offer_id:item.offer.offer_id,product_id:item.product_id,title:item.title});
    for(const item of items)if(item.available===0)todos.push({kind:'out_of_stock',product_id:item.product_id,title:item.title});
    for(const item of items)if(!item.offer)todos.push({kind:'not_offered',product_id:item.product_id,title:item.title});
    const metric=(count:number)=>({state:'ready',count});
    return SupplierOverviewSchema.parse({...base,as_of:row.as_of,product_count:row.product_count,
      metrics:{offered_products:metric(items.filter(i=>i.offer).length),pending_requests:metric(row.pending_requests),
        active_reservation_lines:context.role==='owner'?metric(row.active_reservation_lines):{state:'unavailable',reason:'owner_required'},
        out_of_stock_products:metric(items.filter(i=>i.available===0).length)},todos:{state:'ready',items:todos.slice(0,20),truncated:todos.length>20}});
  });
}
export async function readSupplierSummary(pool: Pool, actor: Actor, tenantId: string, instanceId: string) {
  return storeRead(pool,actor,tenantId,instanceId,'store:read',async(q,context)=>{
    const p=await profile(q,tenantId,instanceId);ready(p);
    const base={profile:'freedom.supplier-console.summary/v1',tenant_id:tenantId,instance_id:instanceId};
    if(!(await effectiveStoreCapabilities(q,context,instanceId)).includes('store:write')) {
      const row=(await q.query(`/* supplier-console:summary-reader */ WITH ${clock} SELECT ${asOf} FROM clock`)).rows[0];
      return SupplierSummarySchema.parse({...base,as_of:row.as_of,todos:{state:'unavailable',reason:'store_write_required'}});
    }
    const row=(await q.query(`/* supplier-console:summary */ WITH ${productCtes} SELECT ${asOf},
      (SELECT count(*)::int FROM selections WHERE bucket='awaiting') AS pending_requests,
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sku,i.item_id) FROM products i),'[]') AS products FROM clock`,params(p))).rows[0];
    const items=(row.products as Row[]).map(row=>productView(row,p.currency));
    return SupplierSummarySchema.parse({...base,as_of:row.as_of,todos:{state:'ready',pending_requests:row.pending_requests,
      outdated_offers:items.filter(i=>i.offer&&!i.offer.matches_current_terms).length,out_of_stock_products:items.filter(i=>i.available===0).length}});
  });
}
export async function listSupplierProducts(pool: Pool, actor: Actor, tenantId: string, instanceId: string) {
  return storeRead(pool,actor,tenantId,instanceId,'store:write',async q=>{
    const p = await profile(q, tenantId, instanceId); ready(p);
    const row=(await q.query(`/* supplier-console:products */ WITH ${productCtes} SELECT ${asOf},
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sku) FROM products i),'[]') AS items FROM clock`,params(p))).rows[0];
    requireCondition(row.items.length<=200,500,'supplier_product_limit','供貨商品數量超出上限。');
    return SupplierProductsSchema.parse({profile:'freedom.supplier-console.products/v1',as_of:row.as_of,items:row.items.map((row:Row)=>productView(row,p.currency)),limit:200});
  });
}
export async function readSupplierProduct(pool: Pool, actor: Actor, tenantId: string, instanceId: string, productId: string) {
  return storeRead(pool,actor,tenantId,instanceId,'store:write',async q=>{
    const p = await profile(q, tenantId, instanceId); ready(p);
    const row=(await q.query(`/* supplier-console:product */ WITH ${productCtes} SELECT ${asOf},
      (SELECT to_jsonb(i) FROM products i WHERE i.item_id=$5) AS product,
      COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.rank,l.selection_id) FROM (
        SELECT * FROM selections WHERE item_id=$5 ORDER BY rank,selection_id LIMIT 201) l),'[]') AS selections FROM clock`,[...params(p),productId])).rows[0];
    requireCondition(row.product,404,'not_found','找不到這項商品。');
    return SupplierProductDetailSchema.parse({profile:'freedom.supplier-console.product/v1',as_of:row.as_of,product:productView(row.product,p.currency),
      shipping_terms:row.product.shipping_terms,return_terms:row.product.return_terms,
      current_offer:row.product.current_offer?offerView(row.product.current_offer):null,
      selections:row.selections.slice(0,200).map((l:Record<string,any>)=>({...selectionView(l),partner_id:l.partner_id})),truncated:row.selections.length>200});
  });
}
export async function readSupplierRequest(pool: Pool, actor: Actor, tenantId: string, instanceId: string, selectionId: string) {
  return storeRead(pool,actor,tenantId,instanceId,'store:write',async q=>{
    const p = await profile(q, tenantId, instanceId); ready(p);
    const row=(await q.query(`/* supplier-console:request */ WITH ${productCtes} SELECT ${asOf},
      (SELECT to_jsonb(l) FROM selections l WHERE l.selection_id=$5) AS request,
      (SELECT to_jsonb(i) FROM products i JOIN selections l ON l.item_id=i.item_id WHERE l.selection_id=$5) AS product
      FROM clock`,[...params(p),selectionId])).rows[0];
    requireCondition(row.request&&row.product,404,'not_found','找不到這筆申請。');
    const product=productView(row.product,p.currency);
    return SupplierRequestDetailSchema.parse({profile:'freedom.supplier-console.request/v1',as_of:row.as_of,
      request:{...selectionView(row.request),partner_id:row.request.partner_id},
      product:{product_id:product.product_id,offer:product.offer}});
  });
}
export async function listSupplierPartners(pool: Pool, actor: Actor, tenantId: string, instanceId: string) {
  return storeRead(pool,actor,tenantId,instanceId,'store:write',async q=>{
    const p = await profile(q, tenantId, instanceId); ready(p);
    const row=(await q.query(`/* supplier-console:partners */ WITH ${partnerCtes} SELECT ${asOf},
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.awaiting DESC,p.name,p.partner_id) FROM (
        SELECT * FROM partners ORDER BY awaiting DESC,name,partner_id LIMIT 201) p),'[]') AS items FROM clock`,params(p))).rows[0];
    return SupplierPartnersSchema.parse({profile:'freedom.supplier-console.partners/v1',as_of:row.as_of,
      items:row.items.slice(0,200).map(partnerView),truncated:row.items.length>200});
  });
}
export async function readSupplierPartner(pool: Pool, actor: Actor, tenantId: string, instanceId: string, partnerId: string) {
  return storeRead(pool,actor,tenantId,instanceId,'store:write',async q=>{
    const p = await profile(q, tenantId, instanceId); ready(p);
    const row=(await q.query(`/* supplier-console:partner */ WITH ${partnerCtes} SELECT ${asOf},
      (SELECT to_jsonb(p) FROM partners p WHERE p.partner_id=$5) AS partner,
      COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.rank,l.selection_id) FROM (
        SELECT * FROM selections WHERE partner_id=$5 ORDER BY rank,selection_id LIMIT 201) l),'[]') AS selections FROM clock`,[...params(p),partnerId])).rows[0];
    requireCondition(row.partner,404,'not_found','找不到這間合作店家。');
    return SupplierPartnerDetailSchema.parse({profile:'freedom.supplier-console.partner/v1',as_of:row.as_of,partner:partnerView(row.partner),
      selections:row.selections.slice(0,200).map(selectionView),truncated:row.selections.length>200});
  });
}
