import {confirmOfflinePayment,completeMeetup,recordMeetupHandover} from '../../../../modules/agent-commerce/payments/offline/confirm.js';
import {listSellerRefunds,recordSellerRefund} from '../../../../modules/agent-commerce/payments/refunds.js';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives.js';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import {requireCondition} from '../../../../packages/shared/problem.js';
import {listSellerCheckoutOrders,readSellerCheckoutOrder,readSellerOrderContact,cancelSellerCheckoutOrder,querySellerPayment,type SellerCheckoutReadOptions} from '../../../../modules/agent-commerce/checkout/seller-orders.js';
import {listSellerExceptions,readSellerException,actOnSellerException} from '../../../../modules/agent-commerce/checkout/seller-exceptions.js';
import type {PlatformEnv} from '../module-context.js';
import {commandHeaders,etag,privateCache,singleQuery} from './tenant-http.js';

export function createHostedSellerCheckoutRoutes(pool:Pool,options:SellerCheckoutReadOptions&{network?:(c:Parameters<typeof singleQuery>[0])=>string}={}) {
  const app=new Hono<PlatformEnv>();
  app.use('*',async(c,next)=>{try{if(c.req.method!=='GET')wire.SellerCheckoutEmptyInputSchema.parse(singleQuery(c));await next();}finally{privateCache(c);}});
  const root='/tenants/:tenant_id/storefronts/:instance_id',orders=root+'/checkout-orders',cases=root+'/exception-cases';
  const ids=(c:Parameters<typeof singleQuery>[0])=>[OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))] as const;
  app.get(orders,async c=>{const [t,i]=ids(c);return c.json(wire.SellerCheckoutOrderPageSchema.parse(await listSellerCheckoutOrders(pool,c.get('actor'),t,i,singleQuery(c),options)));});
  app.get(orders+'/:order_id',async c=>{
    wire.SellerCheckoutEmptyInputSchema.parse(singleQuery(c));const [t,i]=ids(c),id=OpaqueId.parse(c.req.param('order_id'));
    const view=wire.SellerCheckoutOrderSchema.parse(await readSellerCheckoutOrder(pool,c.get('actor'),t,i,id,options));etag(c,view.version);return c.json(view);
  });
  app.get(orders+'/:order_id/contact',async c=>{wire.SellerCheckoutEmptyInputSchema.parse(singleQuery(c));const [t,i]=ids(c);return c.json(wire.SellerOrderContactSchema.parse(await readSellerOrderContact(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('order_id')))));});
  app.post(orders+'/:order_id/cancel',async c=>{
    const h=commandHeaders(c,true),[t,i]=ids(c);wire.SellerCheckoutEmptyInputSchema.parse(await c.req.json());
    const view=wire.SellerCheckoutOrderSchema.parse(await cancelSellerCheckoutOrder(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('order_id')),h.key,h.expected!,options));etag(c,view.version);return c.json(view);
  });
  app.post(orders+'/:order_id/offline-payments',async c=>{
    const h=commandHeaders(c,true),[t,i]=ids(c),id=OpaqueId.parse(c.req.param('order_id'));
    const view=wire.SellerCheckoutOrderSchema.parse(await confirmOfflinePayment(pool,c.get('actor'),t,i,id,await c.req.json(),h.key,h.expected!,options));etag(c,view.version);return c.json(view);
  });
  app.post(orders+'/:order_id/meetup-completion',async c=>{
    const h=commandHeaders(c,true),[t,i]=ids(c),id=OpaqueId.parse(c.req.param('order_id'));
    const view=wire.SellerCheckoutOrderSchema.parse(await completeMeetup(pool,c.get('actor'),t,i,id,await c.req.json(),h.key,h.expected!,options));etag(c,view.version);return c.json(view);
  });
  app.post(orders+'/:order_id/meetup-handover',async c=>{
    const h=commandHeaders(c,true),[t,i]=ids(c),id=OpaqueId.parse(c.req.param('order_id'));
    const view=wire.SellerCheckoutOrderSchema.parse(await recordMeetupHandover(pool,c.get('actor'),t,i,id,await c.req.json(),h.key,h.expected!,options));etag(c,view.version);return c.json(view);
  });
  app.post(orders+'/:order_id/payment-queries',async c=>{wire.SellerCheckoutEmptyInputSchema.parse(await c.req.json());const [t,i]=ids(c);const view=wire.SellerCheckoutOrderSchema.parse(await querySellerPayment(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('order_id')),options.network?.(c)??'unknown',options));return c.json(view);});
  app.get(orders+'/:order_id/refunds',async c=>{wire.SellerCheckoutEmptyInputSchema.parse(singleQuery(c));const [t,i]=ids(c);return c.json(wire.SellerRefundListSchema.parse(await listSellerRefunds(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('order_id')))));});
  app.post(orders+'/:order_id/refunds',async c=>{const h=commandHeaders(c,false),[t,i]=ids(c);return c.json(wire.SellerRefundSchema.parse(await recordSellerRefund(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('order_id')),await c.req.json(),h.key,options)),201);});
  app.get(cases,async c=>{const [t,i]=ids(c);return c.json(wire.ExceptionCasePageSchema.parse(await listSellerExceptions(pool,c.get('actor'),t,i,singleQuery(c),options)));});
  app.get(cases+'/:case_id',async c=>{
    wire.SellerCheckoutEmptyInputSchema.parse(singleQuery(c));const [t,i]=ids(c);
    const view=wire.ExceptionCaseViewSchema.parse(await readSellerException(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('case_id'))));etag(c,view.version);return c.json(view);
  });
  app.post(cases+'/:case_id/actions/:action',async c=>{
    const action=c.req.param('action');requireCondition(action==='resolve_with_evidence'||action==='retry_allocation',404,'not_found','找不到這個操作。');
    const h=commandHeaders(c,true),[t,i]=ids(c);
    const view=wire.ExceptionCaseViewSchema.parse(await actOnSellerException(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('case_id')),action,await c.req.json(),h.key,h.expected!,options));etag(c,view.version);return c.json(view);
  });
  return app;
}
