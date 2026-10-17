import type {PoolClient} from 'pg';
import {z} from 'zod';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import {CartQuoteResponseSchema,type CartQuoteInput} from '../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {sharedLines} from '../hosted/shared-quotes.js';
import {readCheckoutStore,type CheckoutStore} from './authority.js';
import {validateShippingQuote,type CheckoutPorts,type ShippingQuoteLine} from './terms.js';
const cartPortResult=z.object({delivery_options:CartQuoteResponseSchema.shape.delivery_options,shipping:CartQuoteResponseSchema.shape.shipping}).strict();

/** Called only in a READ ONLY transaction. In particular, due holds are ignored
 * in availability without settling them or touching the materialized balance. */
export async function cartQuote(q:PoolClient,store:CheckoutStore,input:CartQuoteInput,ports:CheckoutPorts) {
  const context=await readCheckoutStore(q,store,input.lines.map(l=>l.sku)),p=context.profile;
  const publication=p.projection as {revision:string;products:{sku:string;title:string;price_minor:number}[]};
  const quoteLines:ShippingQuoteLine[]=[];
  const lines=[];
  for(const wanted of input.lines) {
    const published=publication.products.find(l=>l.sku===wanted.sku);
    const base={sku:wanted.sku,title:published?.title??null,options:[],unit_price_minor:published?.price_minor??null,quantity:wanted.quantity,
      line_total_minor:published?published.price_minor*wanted.quantity:null};
    try {
      const resolved=await sharedLines(q,{profile:p,shared:{}},[wanted],async id=>{
        const supplier=context.parties.get(id);
        requireCondition(supplier&&supplier.currency===p.currency,409,'supply_unavailable','供貨來源無法使用。');return supplier;
      });
      const b=resolved.bindings[0],priced=resolved.lines[0];
      quoteLines.push({sku:b.sku,item_id:b.item_id,quantity:b.quantity,unit_price_minor:priced.unit_price_minor,supplier_shop_id:b.supplier_shop_id,own:b.supplier_instance_id===p.instance_id});
      const available=(await q.query<{available:number}>(`SELECT greatest(0,i.stock
        -coalesce((SELECT sum(h.quantity) FROM commerce_inventory_reservations h WHERE h.item_id=i.item_id AND h.state='held' AND h.expires_at>clock_timestamp()),0)
        -coalesce((SELECT sum(a.quantity-a.shipped_quantity-a.released_quantity) FROM commerce_inventory_allocations a WHERE a.item_id=i.item_id),0))::int AS available
        FROM commerce_items i WHERE i.item_id=$1`,[b.item_id])).rows[0].available;
      lines.push({...base,state:available<wanted.quantity?'insufficient':publication.revision!==input.publication_revision?'revision_changed':'ok',...(available<wanted.quantity?{available}:{})});
    } catch(error) {
      if(!(error instanceof Problem&&['publication_changed','supply_unavailable'].includes(error.code)))throw error;
      lines.push({...base,state:'unavailable'});
    }
  }
  let delivery_options:z.infer<typeof cartPortResult>['delivery_options']=[];
  let shipping:z.infer<typeof cartPortResult>['shipping']={state:'not_configured',groups:[],total_minor:null};
  if(ports.shipping&&quoteLines.length===input.lines.length) {
    const merchandiseNet=quoteLines.reduce((sum,line)=>sum+line.unit_price_minor*line.quantity,0);
    if(ports.shipping.cart) {
      const parsed=cartPortResult.safeParse(await ports.shipping.cart(q,p,{lines:quoteLines,merchandise_net_minor:merchandiseNet,delivery:input.delivery??null}));
      if(!parsed.success)throw new Error('shipping_quote_invalid');
      delivery_options=parsed.data.delivery_options;shipping=parsed.data.shipping;
    } else if(!input.delivery)shipping={state:'needs_delivery_data',groups:[],total_minor:null};
    else {
      const quoted=validateShippingQuote(await ports.shipping.quote(q,p,{lines:quoteLines,merchandise_net_minor:merchandiseNet,delivery:input.delivery}),quoteLines);
      shipping={state:'quoted',method:quoted.groups[0].method_ref,groups:quoted.groups.map(group=>({group_ref:group.group_ref,amount_minor:group.amount_minor})),total_minor:quoted.groups.reduce((sum,group)=>sum+group.amount_minor,0)};
    }
  }
  const merchandise=lines.reduce((n,l)=>n+(['ok','revision_changed'].includes(l.state)?l.line_total_minor??0:0),0);
  return CartQuoteResponseSchema.parse({publication_revision:publication.revision,currency:p.currency,lines,merchandise_total_minor:merchandise,discounts:[],delivery_options,shipping,
    total_minor:shipping.total_minor===null||lines.some(l=>l.state==='insufficient'||l.state==='unavailable')?null:merchandise+shipping.total_minor});
}
