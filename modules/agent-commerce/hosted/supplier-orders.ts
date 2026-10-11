import type {Pool} from 'pg';
import {OpaqueId} from '../../../contracts/guild-launchpad/v1/primitives.js';
import {OrderPageQuerySchema} from '../../../contracts/guild-launchpad/v1/hosted-order.js';
import {SupplierReservationPageSchema} from '../../../contracts/guild-launchpad/v1/hosted-shared-order.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import {type TenantListCursorCodec,unavailableTenantListCursor} from '../../../packages/shared/tenant-list-cursor.js';
import type {Actor} from '../../identity-membership/service.js';
import {sellerCommand} from './seller-orders.js';
import {closeDirectOrder,type DirectOrderRow} from './direct-effects.js';

/** Current supplier owner, its exact mapped supply shop, and its retained lines.
 * Never select quote JSON, buyer identity, cart totals or another supplier's lines.
 * Reading can expire a due whole order; it cannot cancel an unexpired order. */
export async function listSupplierOrders(pool:Pool,actor:Actor,tenantId:string,instanceId:string,rawQuery:unknown,
  cursors:TenantListCursorCodec=unavailableTenantListCursor) {
  const query=OrderPageQuerySchema.parse(rawQuery),limit=query.limit??20;
  return sellerCommand(pool,actor,tenantId,instanceId,'storefront.supplier.orders.list',instanceId,`supplier-orders-${instanceId}`,undefined,
    async()=>({id:instanceId}),async(q,context,id)=>{
      requireCondition(id===instanceId,409,'receipt_reference_invalid','訂單讀取狀態無效。');
      const binding={purpose:'supplier-orders' as const,principalId:context.tenant.principal_id,tenantId,
        scopeId:context.tenant.scope.scope_id,resourceId:instanceId,filter:'{}'};
      const after=cursors.decode(query.cursor,binding);
      requireCondition(!after || Object.keys(after).sort().join(',')==='at,id'
        && typeof after.at==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.at)
        && Number.isFinite(Date.parse(after.at)) && OpaqueId.safeParse(after.id).success,422,'invalid_cursor','分頁游標無效。');
      const references=(await q.query<{order_id:string;cursor_at:string}>(`SELECT o.order_id,
        to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM commerce_orders o
        WHERE o.order_profile='hosted_shared_reservation' AND EXISTS(SELECT 1 FROM commerce_order_lines line
          WHERE line.order_id=o.order_id AND line.supplier_shop_id=$1 AND line.hosted_offer_id IS NOT NULL)
        AND ($2::timestamptz IS NULL OR (o.created_at,o.order_id)<($2::timestamptz,$3::uuid))
        ORDER BY o.created_at DESC,o.order_id DESC LIMIT $4`,[context.profile.supply_shop_id,after?.at??null,after?.id??null,limit+1])).rows;
      const page=references.slice(0,limit),ids=page.map(row=>row.order_id).sort(),orders=new Map<string,DirectOrderRow>();
      if(ids.length) {
        const rows=(await q.query<DirectOrderRow>(`SELECT *,reservation_version::text AS reservation_version FROM commerce_orders
          WHERE order_id=ANY($1::uuid[]) AND order_profile='hosted_shared_reservation' ORDER BY order_id FOR UPDATE`,[ids])).rows;
        await q.query(`SELECT i.item_id FROM commerce_items i WHERE EXISTS(SELECT 1 FROM commerce_order_lines line
          WHERE line.order_id=ANY($1::uuid[]) AND line.item_id=i.item_id) ORDER BY i.item_id FOR UPDATE`,[ids]);
        for(const saved of rows) {
          const row=await closeDirectOrder(q,context,saved);
          if(row.reservation_state==='reserved' && (!context.reservationDeadline || row.expires_at<context.reservationDeadline)) context.reservationDeadline=row.expires_at;
          orders.set(row.order_id,row);
        }
      }
      const lines=ids.length?(await q.query(`SELECT line.order_id,line.item_id,line.hosted_offer_id,line.acceptance_id,line.snapshot,line.quantity,
          offer.terms,retail.currency,retail.name AS seller_name,seller.slug
        FROM commerce_order_lines line JOIN commerce_orders o ON o.order_id=line.order_id AND o.order_profile=line.order_profile
        JOIN commerce_hosted_supply_offers offer ON offer.offer_id=line.hosted_offer_id AND offer.item_id=line.item_id
          AND offer.tenant_id=$2 AND offer.instance_id=$3
        JOIN commerce_storefront_profiles seller ON seller.storefront_shop_id=o.public_shop_id
        JOIN commerce_shops retail ON retail.shop_id=o.public_shop_id AND retail.origin='hosted'
        WHERE line.order_id=ANY($1::uuid[]) AND line.supplier_shop_id=$4 ORDER BY line.order_id,line.selection_id`,
      [ids,tenantId,instanceId,context.profile.supply_shop_id])).rows:[];
      const items=page.map(reference=>{
        const row=orders.get(reference.order_id)!,own=lines.filter(line=>line.order_id===row.order_id);
        requireCondition(own.length>0,409,'reservation_inconsistent','供貨訂單來源不一致。');
        return {profile:'freedom.hosted-supplier-reservations/v1',order_id:row.order_id,version:row.reservation_version,
          store:{slug:own[0].slug,name:own[0].seller_name},currency:own[0].currency,state:row.reservation_state,
          created_at:row.created_at.toISOString(),reservation_expires_at:row.expires_at.toISOString(),closed_at:row.closed_at?.toISOString()??null,
          items:own.map(line=>({product_id:line.item_id,offer_id:line.hosted_offer_id,acceptance_id:line.acceptance_id,
            sku:line.snapshot.sku,title:line.snapshot.title,quantity:line.quantity,unit_supply_price_minor:line.terms.cost_minor,
            supply_total_minor:line.terms.cost_minor*line.quantity})),payment_enabled:false,fulfilment_enabled:false,money_movement_enabled:false};
      });
      return SupplierReservationPageSchema.parse({items,next_cursor:references.length>limit
        ?cursors.encode({at:page[page.length-1].cursor_at,id:page[page.length-1].order_id},binding):null});
    },{includeShared:true});
}
