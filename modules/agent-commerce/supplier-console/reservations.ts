import type {Pool,PoolClient} from 'pg';
import {OpaqueId} from '../../../contracts/guild-launchpad/v1/primitives.js';
import {SupplierReservationQuerySchema,SupplierReservationsSchema,SupplierReservationDetailSchema,
  SupplierConsoleReservationSchema} from '../../../contracts/guild-launchpad/v1/supplier-console.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import {type TenantListCursorCodec,unavailableTenantListCursor} from '../../../packages/shared/tenant-list-cursor.js';
import type {Actor} from '../../identity-membership/service.js';
import {sellerCommand,type SellerContext} from '../hosted/seller-orders.js';
import {closeDirectOrder,type DirectOrderRow} from '../hosted/direct-effects.js';

const ownLines=`FROM commerce_order_lines line JOIN commerce_hosted_supply_offers offer
  ON offer.offer_id=line.hosted_offer_id AND offer.item_id=line.item_id AND offer.tenant_id=$2 AND offer.instance_id=$3
  WHERE line.supplier_shop_id=$1 AND line.hosted_offer_id IS NOT NULL AND line.order_profile='hosted_shared_reservation'`;
// Load only the order fields needed by the existing release helper and our projection.
const orderFields=`order_id,public_shop_id,order_profile,reservation_state,reservation_version::text AS reservation_version,
  created_at,expires_at,closed_at,close_reason`;
type Reference={order_id:string;cursor_at:string;state:DirectOrderRow['reservation_state']};
async function decisionTime(q:PoolClient):Promise<Date> {
  return (await q.query<{at:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")).rows[0].at;
}
async function settle(q:PoolClient,context:SellerContext,ids:string[],asOf:Date) {
  const orders=new Map<string,DirectOrderRow>();
  if(!ids.length)return orders;
  const rows=(await q.query<DirectOrderRow>(`SELECT ${orderFields} FROM commerce_orders
    WHERE order_id=ANY($1::uuid[]) AND order_profile='hosted_shared_reservation' ORDER BY order_id FOR UPDATE`,[ids])).rows;
  requireCondition(rows.length===ids.length,409,'reservation_clock_changed','庫存保留狀態已更新，請重新讀取。');
  await q.query(`SELECT i.item_id FROM commerce_items i WHERE EXISTS(SELECT 1 FROM commerce_order_lines line
    WHERE line.order_id=ANY($1::uuid[]) AND line.item_id=i.item_id) ORDER BY i.item_id FOR UPDATE`,[ids]);
  for(const saved of rows) {
    const row=await closeDirectOrder(q,context,saved,false,asOf);
    if(row.reservation_state==='reserved'&&(!context.reservationDeadline||row.expires_at<context.reservationDeadline))context.reservationDeadline=row.expires_at;
    orders.set(row.order_id,row);
  }
  return orders;
}
async function reservationLines(q:PoolClient,context:SellerContext,ids:string[]) {
  if(!ids.length)return [];
  return (await q.query(`SELECT line.order_id,line.item_id,line.hosted_offer_id,line.acceptance_id,
      line.snapshot->>'sku' AS sku,line.snapshot->>'title' AS title,line.quantity,
      (offer.terms->>'cost_minor')::int AS cost_minor,offer.terms_sha256,offer.state AS offer_state,
      retail.currency,retail.name AS seller_name,seller.slug
    FROM commerce_order_lines line JOIN commerce_orders o ON o.order_id=line.order_id AND o.order_profile=line.order_profile
    JOIN commerce_hosted_supply_offers offer ON offer.offer_id=line.hosted_offer_id AND offer.item_id=line.item_id
      AND offer.tenant_id=$2 AND offer.instance_id=$3
    JOIN commerce_storefront_profiles seller ON seller.storefront_shop_id=o.public_shop_id
    JOIN commerce_shops retail ON retail.shop_id=o.public_shop_id AND retail.origin='hosted'
    WHERE line.order_id=ANY($1::uuid[]) AND line.supplier_shop_id=$4 AND line.hosted_offer_id IS NOT NULL
      AND line.order_profile='hosted_shared_reservation' ORDER BY line.order_id,line.selection_id`,
  [ids,context.profile.tenant_id,context.profile.instance_id,context.profile.supply_shop_id])).rows;
}
function reservationView(row:DirectOrderRow,lines:Record<string,any>[]) {
  const own=lines.filter(line=>line.order_id===row.order_id);
  requireCondition(own.length>0,409,'reservation_inconsistent','供貨訂單來源不一致。');
  return SupplierConsoleReservationSchema.parse({order_id:row.order_id,version:row.reservation_version,partner_id:row.public_shop_id,
    store:{slug:own[0].slug,name:own[0].seller_name},currency:own[0].currency,state:row.reservation_state,
    created_at:row.created_at.toISOString(),reservation_expires_at:row.expires_at.toISOString(),closed_at:row.closed_at?.toISOString()??null,
    items:own.map(line=>({product_id:line.item_id,offer_id:line.hosted_offer_id,acceptance_id:line.acceptance_id,
      sku:line.sku,title:line.title,quantity:line.quantity,unit_supply_price_minor:line.cost_minor,supply_total_minor:line.cost_minor*line.quantity})),
    payment_enabled:false,fulfilment_enabled:false,money_movement_enabled:false});
}
export async function listSupplierConsoleReservations(pool:Pool,actor:Actor,tenantId:string,instanceId:string,rawQuery:unknown,
  cursors:TenantListCursorCodec=unavailableTenantListCursor) {
  const query=SupplierReservationQuerySchema.parse(rawQuery),limit=query.limit??20;
  return sellerCommand(pool,actor,tenantId,instanceId,'storefront.supplier.orders.list',instanceId,`supplier-console-reservations-${instanceId}`,undefined,
    async()=>({id:instanceId}),async(q,context,id)=>{
      requireCondition(id===instanceId,409,'receipt_reference_invalid','訂單讀取狀態無效。');
      const asOf=await decisionTime(q);
      const filter={state:query.state??null,partner_id:query.partner_id??null,product_id:query.product_id??null,from:query.from??null,to:query.to??null};
      const binding={purpose:'supplier-orders' as const,principalId:context.tenant.principal_id,tenantId,
        scopeId:context.tenant.scope.scope_id,resourceId:instanceId,
        filter:JSON.stringify(['freedom.supplier-console.reservations/v1',filter.state,filter.partner_id,filter.product_id,filter.from,filter.to])};
      const after=cursors.decode(query.cursor,binding);
      requireCondition(!after||Object.keys(after).sort().join(',')==='at,id'
        &&typeof after.at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.at)
        &&Number.isFinite(Date.parse(after.at))&&OpaqueId.safeParse(after.id).success,422,'invalid_cursor','分頁游標無效。');
      const snapshot=(await q.query(`/* supplier-console:reservations */ WITH own_lines AS (
          SELECT line.order_id,line.item_id ${ownLines}
        ),classified AS (
          SELECT o.order_id,o.created_at,count(line.item_id)::int AS lines,
            CASE WHEN o.reservation_state='reserved' AND o.expires_at<=$4::timestamptz THEN 'expired' ELSE o.reservation_state END AS state
          FROM commerce_orders o JOIN own_lines line ON line.order_id=o.order_id
          WHERE o.order_profile='hosted_shared_reservation' AND ($6::uuid IS NULL OR o.public_shop_id=$6)
            AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM own_lines product WHERE product.order_id=o.order_id AND product.item_id=$7))
            AND ($8::timestamptz IS NULL OR o.created_at>=$8) AND ($9::timestamptz IS NULL OR o.created_at<$9)
          GROUP BY o.order_id
        ),matching AS (SELECT * FROM classified WHERE $5::text IS NULL OR state=$5),page AS (
          SELECT order_id,created_at,state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
          FROM matching WHERE $10::timestamptz IS NULL OR (created_at,order_id)<($10::timestamptz,$11::uuid)
          ORDER BY created_at DESC,order_id DESC LIMIT $12
        ) SELECT jsonb_build_object('reservations',count(*),'lines',COALESCE(sum(lines),0)) AS totals,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('order_id',order_id,'state',state,'cursor_at',cursor_at)
            ORDER BY created_at DESC,order_id DESC) FROM page),'[]') AS refs FROM matching`,
      [context.profile.supply_shop_id,tenantId,instanceId,asOf,filter.state,filter.partner_id,filter.product_id,filter.from,filter.to,
        after?.at??null,after?.id??null,limit+1])).rows[0];
      const references=snapshot.refs as Reference[],page=references.slice(0,limit),ids=page.map(row=>row.order_id).sort();
      const orders=await settle(q,context,ids,asOf),lines=await reservationLines(q,context,ids);
      const items=page.map(reference=>{
        const row=orders.get(reference.order_id)!;
        requireCondition(row.reservation_state===reference.state,409,'reservation_clock_changed','庫存保留狀態已更新，請重新讀取。');
        return reservationView(row,lines);
      });
      return SupplierReservationsSchema.parse({profile:'freedom.supplier-console.reservations/v1',as_of:asOf.toISOString(),filter,
        totals:snapshot.totals,items,next_cursor:references.length>limit
          ?cursors.encode({at:page[page.length-1].cursor_at,id:page[page.length-1].order_id},binding):null});
    },{includeShared:true});
}
export async function readSupplierConsoleReservation(pool:Pool,actor:Actor,tenantId:string,instanceId:string,orderId:string) {
  return sellerCommand(pool,actor,tenantId,instanceId,'storefront.supplier.orders.list',orderId,`supplier-console-reservation-${orderId}`,undefined,
    async()=>({id:orderId}),async(q,context,id)=>{
      requireCondition(id===orderId,409,'receipt_reference_invalid','訂單讀取狀態無效。');
      const exists=await q.query(`SELECT 1 FROM commerce_orders o WHERE o.order_id=$4 AND o.order_profile='hosted_shared_reservation'
        AND EXISTS(SELECT 1 ${ownLines} AND line.order_id=o.order_id)`,[context.profile.supply_shop_id,tenantId,instanceId,orderId]);
      requireCondition(exists.rowCount===1,404,'hosted_order_not_found','找不到這份訂單。');
      const asOf=await decisionTime(q),orders=await settle(q,context,[orderId],asOf),lines=await reservationLines(q,context,[orderId]);
      const offers=[...new Map(lines.map(line=>[line.hosted_offer_id,{offer_id:line.hosted_offer_id,product_id:line.item_id,
        terms_sha256:line.terms_sha256,state:line.offer_state}])).values()];
      return SupplierReservationDetailSchema.parse({profile:'freedom.supplier-console.reservation/v1',as_of:asOf.toISOString(),
        reservation:reservationView(orders.get(orderId)!,lines),offers});
    },{includeShared:true});
}
