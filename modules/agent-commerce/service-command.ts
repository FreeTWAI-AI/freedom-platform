import type {Pool} from 'pg';
import {OpaqueId} from '../../contracts/common/v1/identity.js';
import {runCommandCore} from '../../packages/db/command-core.js';
import {digest} from '../../packages/db/legacy-digest.js';
import {scopedJournal} from '../../packages/scoped-commands/index.js';
import {registerScopedCommand,authorizeScopedCommand,forgetScopedCommand} from '../../packages/scoped-commands/command-context.js';
import {lockShopService,assertShopServiceClock,forgetShopService,type ShopServiceContext,type ShopServiceHost} from '../../packages/resource-scopes/shop-service.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {machine,cancelOrder} from './orders.js';

const operation='shop.order.cancel',profile='freedom.shop-order-cancel/v1';
type Cancelled={cancelled:true};
function response(value:unknown):Cancelled{
 requireCondition(value!==null&&typeof value==='object'&&Object.keys(value).length===1
  &&(value as Cancelled).cancelled===true,500,'shop_receipt_invalid','訂單操作紀錄無效。');
 return Object.freeze({cancelled:true});
}
/** One closed existing operation. Token syntax only selects the adapter; each
 * adapter still authenticates the actual current credential on its own single
 * transaction. Legacy compatibility never manufactures a common principal.
 * Create/payment retain their existing dynamic domain replay contracts. */
export async function cancelShopOrder(pool:Pool,host:ShopServiceHost,authorization:string|undefined,orderId:string):Promise<Cancelled>{
 const id=OpaqueId.parse(orderId);
 if(typeof authorization==='string'&&/^Bearer fw_shop_[A-Za-z0-9_-]{43}$/.test(authorization))
  return response(await machine(pool,host,authorization,(q,shop)=>cancelOrder(q,shop,id)));
 let context:ShopServiceContext|undefined,pending=false;
 const namespace=()=>[context!.subject_principal.principal_id,context!.authn_kind,context!.scope.scope_id,operation,id];
 try{return await runCommandCore(pool,{
  async authenticateAndLock(q){
   const verified=await lockShopService(q,authorization,host);
   requireCondition(verified.authn_kind==='shop_service_key',401,'shop_key_invalid','商店連線已失效。');
   context=verified;
   registerScopedCommand(context,q,operation,{aggregate_type:'commerce_order_cancellation',id});
  },
  async lockReceipt(q){
   await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([profile,...namespace()])]);
   await assertShopServiceClock(q,context!);
  },
  requestDigest:()=>digest({profile,scope:context!.scope,target:{kind:'commerce_order',id},body:{}}),
  async readReceipt(q){
   const prior=(await q.query(`SELECT request_sha256,response FROM scoped_command_receipts
    WHERE principal_id=$1 AND authn_kind=$2 AND scope_id=$3 AND operation=$4 AND idempotency_key=$5`,namespace())).rows[0];
   await assertShopServiceClock(q,context!);
   return prior?{request_sha256:prior.request_sha256,response:response(prior.response)}:null;
  },
  async writeReceipt(q,hash,result){
   await q.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,
    principal_kind,scope_kind,target_kind,target_id,request_sha256,response)
    VALUES($1,$2,$3,$4,$5,'service','site','commerce_order',$6,$7,$8)`,[...namespace(),id,hash,JSON.stringify(response(result))]);
   await assertShopServiceClock(q,context!);
  },
 },async q=>{
  const order=(await q.query('SELECT buyer_payment FROM commerce_orders WHERE order_id=$1 AND public_shop_id=$2 FOR UPDATE',[id,context!.shop.shop_id])).rows[0];
  requireCondition(order,404,'order_not_found','找不到訂單。');
  requireCondition(order.buyer_payment==='pending'||order.buyer_payment==='cancelled',409,'already_paid','已付款訂單不能取消，請使用退款流程。');
  pending=order.buyer_payment==='pending';
  await assertShopServiceClock(q,context!);authorizeScopedCommand(context!);
 },async q=>{
  const result=response(await cancelOrder(q,context!.shop,id));
  if(pending)await scopedJournal(q,context!,{aggregate_type:'commerce_order_cancellation',id,version:1,operation});
  await assertShopServiceClock(q,context!);return result;
 });}finally{if(context){forgetScopedCommand(context);forgetShopService(context);}}
}
