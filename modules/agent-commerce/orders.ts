import {randomBytes,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {command,digest,transaction,journal,type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {tokenHash,type Actor} from '../identity-membership/service.js';
import {ownShop} from './imports.js';
import {orderInput,paymentInput,shipmentInput,httpsUrl} from './schema.js';

export async function issueKey(pool:Pool,input:Command,id:string){
 let token:string|undefined;
 const result=await command(pool,input,q=>ownShop(q,input.actor,id),async q=>{
  token='fw_shop_'+randomBytes(32).toString('base64url');
  await q.query(`INSERT INTO commerce_shop_keys(shop_id,token_hash,expires_at) VALUES($1,$2,now()+interval '90 days')
   ON CONFLICT(shop_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,revoked_at=NULL`,[id,tokenHash(token)]);
  const version=(await q.query('UPDATE commerce_shops SET aggregate_version=aggregate_version+1 WHERE shop_id=$1 RETURNING aggregate_version',[id])).rows[0].aggregate_version;
  await journal(q,input.actor,'commerce_shop',id,version,'rotate_shop_key');return {shop_id:id};
 });
 // The raw credential is not put into command_receipts, logs or a downloadable MD.
 return {...result,token:token??null,expires_in_days:90};
}
export async function revokeKey(pool:Pool,input:Command,id:string){
 return command(pool,input,q=>ownShop(q,input.actor,id),async q=>{
  await q.query('UPDATE commerce_shop_keys SET revoked_at=now() WHERE shop_id=$1',[id]);
  const version=(await q.query('UPDATE commerce_shops SET aggregate_version=aggregate_version+1 WHERE shop_id=$1 RETURNING aggregate_version',[id])).rows[0].aggregate_version;
  await journal(q,input.actor,'commerce_shop',id,version,'revoke_shop_key');return {revoked:true};
 });
}
async function authenticateShop(q:PoolClient,authorization:string|undefined){
 requireCondition(authorization&&/^Bearer fw_shop_[A-Za-z0-9_-]{43}$/.test(authorization),401,'shop_key_invalid','商店連線已失效。');
 const hash=tokenHash(authorization.slice(7));
 const owner=(await q.query('SELECT s.owner_id,s.community_id FROM commerce_shop_keys k JOIN commerce_shops s USING(shop_id) WHERE k.token_hash=$1',[hash])).rows[0];
 requireCondition(owner,401,'shop_key_invalid','商店連線已失效。');
 const user=await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) FOR SHARE',[owner.owner_id,owner.community_id]);
 requireCondition(user.rowCount===1,401,'shop_key_invalid','商店連線已失效。');
 const shop=(await q.query(`SELECT s.* FROM commerce_shop_keys k JOIN commerce_shops s USING(shop_id)
  WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>now() FOR SHARE OF k`,[hash])).rows[0];
 requireCondition(shop,401,'shop_key_invalid','商店連線已失效。');return shop;
}
async function lockCommunity(q:PoolClient,community:string){await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commerce-orders/${community}`]);}
export async function machine<T>(pool:Pool,authorization:string|undefined,run:(q:PoolClient,shop:any)=>Promise<T>){
 return transaction(pool,async q=>{const shop=await authenticateShop(q,authorization);await lockCommunity(q,shop.community_id);
  // Authentication may wait behind a pause. Re-read mutable state after acquiring the shared ordering lock.
  const current=(await q.query('SELECT * FROM commerce_shops WHERE shop_id=$1',[shop.shop_id])).rows[0];
  return run(q,current);});
}
async function release(q:PoolClient,orderId:string){
 await q.query(`UPDATE commerce_items i SET reserved=reserved-x.quantity FROM
 (SELECT item_id,sum(quantity)::int AS quantity FROM commerce_order_lines WHERE order_id=$1 GROUP BY item_id)x WHERE i.item_id=x.item_id`,[orderId]);
}
async function expireOrders(q:PoolClient,community:string){
 const expired=(await q.query(`SELECT o.order_id FROM commerce_orders o JOIN commerce_shops s ON s.shop_id=o.public_shop_id
  WHERE s.community_id=$1 AND o.buyer_payment='pending' AND o.expires_at<=now() FOR UPDATE OF o`,[community])).rows;
 for(const o of expired){await release(q,o.order_id);await q.query("UPDATE commerce_orders SET buyer_payment='cancelled' WHERE order_id=$1",[o.order_id]);}
}
export async function createOrder(q:PoolClient,shop:any,raw:unknown){
 requireCondition(shop.accepting_orders,409,'shop_paused','商店已暫停接單。');
 requireCondition(shop.kind==='public',403,'public_shop_required','只有公開商店可建立買家訂單。');
 const body=orderInput.parse(raw),hash=digest(body);
 await expireOrders(q,shop.community_id);
 const prior=(await q.query('SELECT * FROM commerce_orders WHERE public_shop_id=$1 AND external_id=$2',[shop.shop_id,body.external_id])).rows[0];
 if(prior){requireCondition(prior.request_sha256===hash,409,'order_conflict','相同訂單代號的內容不可改變。');return orderView(q,shop,prior.order_id);}
 const lines=[];let total=0;
 for(const line of body.items){
  const selected=(await q.query(`SELECT l.*,i.stock,i.reserved,s.shop_id AS internal_shop_id FROM commerce_selections l
   JOIN commerce_items i USING(item_id) JOIN commerce_shops s ON s.shop_id=i.shop_id JOIN users u ON u.user_id=s.owner_id
   WHERE l.selection_id=$1 AND l.shop_id=$2 AND s.community_id=$3 AND s.accepting_orders AND s.mode=$4 AND u.active`,[line.selection_id,shop.shop_id,shop.community_id,shop.mode])).rows[0];
  requireCondition(selected,404,'selection_not_found','商品不可選購。');
  requireCondition(selected.stock-selected.reserved>=line.quantity,409,'out_of_stock','商品可供數量不足，請勿向買家收款。');
  const snapshot=selected.snapshot;
  const cost=(snapshot.cost_minor+snapshot.shipping_minor)*line.quantity,retail=Number(selected.retail_price_minor)*line.quantity;
  requireCondition(Number.isSafeInteger(cost)&&Number.isSafeInteger(retail),422,'amount_overflow','訂單金額過大。');
  total+=retail;lines.push({...line,...selected,cost,retail});
 }
 requireCondition(total<=100000000000,422,'amount_overflow','訂單金額過大。');
 const id=randomUUID();
 await q.query('INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor) VALUES($1,$2,$3,$4,$5,$6)',[id,shop.shop_id,body.external_id,hash,shop.currency,total]);
 const groups=new Map<string,typeof lines>();
 for(const line of lines)groups.set(line.internal_shop_id,[...(groups.get(line.internal_shop_id)??[]),line]);
 for(const [internalId,group] of groups){
  requireCondition(new Set(group.map(l=>l.delivery_ref)).size===1,422,'delivery_ref_mismatch','同一張供貨單必須使用相同交付參照。');
  const transfer=randomUUID(),cost=group.reduce((n,l)=>n+l.cost,0);
  requireCondition(cost<=100000000000,422,'amount_overflow','商品成本過大。');
  await q.query('INSERT INTO commerce_transfers(transfer_id,order_id,internal_shop_id,total_minor,delivery_ref) VALUES($1,$2,$3,$4,$5)',[transfer,id,internalId,cost,group[0].delivery_ref]);
  for(const l of group){
   await q.query('INSERT INTO commerce_order_lines(order_id,selection_id,transfer_id,item_id,quantity,snapshot) VALUES($1,$2,$3,$4,$5,$6)',[id,l.selection_id,transfer,l.item_id,l.quantity,l.snapshot]);
   await q.query('UPDATE commerce_items SET reserved=reserved+$2 WHERE item_id=$1',[l.item_id,l.quantity]);
  }
 }
 return orderView(q,shop,id);
}
export async function orderView(q:PoolClient,shop:any,id:string){
 const order=(await q.query(`SELECT o.*,s.name AS public_shop_name,s.website_url AS public_website_url,s.contact AS public_shop_contact FROM commerce_orders o JOIN commerce_shops s ON s.shop_id=o.public_shop_id WHERE o.order_id=$1 AND
 (o.public_shop_id=$2 OR (o.buyer_payment IN ('reported_paid','reported_refunded') AND EXISTS(SELECT 1 FROM commerce_transfers t WHERE t.order_id=o.order_id AND t.internal_shop_id=$2)))`,[id,shop.shop_id])).rows[0];
 requireCondition(order,404,'order_not_found','找不到此商店的訂單。');
 const transfers=(await q.query(`SELECT t.*,s.website_url AS internal_website_url,s.name AS internal_shop_name FROM commerce_transfers t
 JOIN commerce_shops s ON s.shop_id=t.internal_shop_id WHERE t.order_id=$1${shop.kind==='internal'?' AND t.internal_shop_id=$2':''}`,shop.kind==='internal'?[id,shop.shop_id]:[id])).rows;
 for(const t of transfers){t.lines=(await q.query('SELECT selection_id,item_id,quantity,snapshot FROM commerce_order_lines WHERE transfer_id=$1',[t.transfer_id])).rows;
  if(shop.kind==='internal')for(const l of t.lines){delete l.snapshot.retail_price_minor;delete l.snapshot.sale_terms;}
 }
 // The internal merchant sees only its own fulfillment, not other merchants or the seller's revenue.
 return {order_id:order.order_id,public_shop_id:order.public_shop_id,public_shop_name:order.public_shop_name,public_website_url:order.public_website_url,public_shop_contact:order.public_shop_contact,buyer_payment:order.buyer_payment,currency:order.currency,expires_at:order.expires_at,
  ...(shop.kind==='public'?{external_id:order.external_id,total_minor:order.total_minor}:{}),transfers,
  mode:shop.mode,payment_evidence:'merchant_backend_report',platform_bank_verified:false,platform_collects_money:false};
}
export async function shopOrders(q:PoolClient,shop:any,offset=0){
 const rows=(await q.query(`SELECT DISTINCT o.order_id,o.created_at FROM commerce_orders o LEFT JOIN commerce_transfers t USING(order_id)
 WHERE o.public_shop_id=$1 OR (t.internal_shop_id=$1 AND o.buyer_payment IN ('reported_paid','reported_refunded')) ORDER BY o.created_at DESC,o.order_id DESC LIMIT 100 OFFSET $2`,[shop.shop_id,offset])).rows;
 const result=[];for(const row of rows)result.push(await orderView(q,shop,row.order_id));return result;
}
export async function memberOrders(pool:Pool,actor:Actor,id:string){
 return transaction(pool,async q=>shopOrders(q,await ownShop(q,actor,id)));
}
export async function payment(q:PoolClient,shop:any,id:string,transferId:string|undefined,raw:unknown){
 const body=paymentInput.parse(raw),hash=digest({id,transferId,body});
 const order=(await q.query('SELECT * FROM commerce_orders WHERE order_id=$1 FOR UPDATE',[id])).rows[0];
 requireCondition(order,404,'order_not_found','找不到訂單。');
 let transfer:any;
 if(transferId){transfer=(await q.query('SELECT * FROM commerce_transfers WHERE transfer_id=$1 AND order_id=$2 AND internal_shop_id=$3',[transferId,id,shop.shop_id])).rows[0];requireCondition(shop.kind==='internal'&&transfer,404,'transfer_not_found','找不到可回報的供貨單。');}
 else requireCondition(shop.kind==='public'&&order.public_shop_id===shop.shop_id,404,'order_not_found','找不到可回報的買家訂單。');
 requireCondition(body.mode===shop.mode,422,'payment_mode_mismatch','測試與正式付款不能混用。');
 requireCondition(body.currency===order.currency&&body.amount_minor===Number(transfer?transfer.total_minor:order.total_minor),422,'payment_mismatch','幣別或金額不符，未更新付款狀態。');
 const prior=(await q.query('SELECT request_sha256 FROM commerce_payment_events WHERE shop_id=$1 AND external_event_id=$2',[shop.shop_id,body.event_id])).rows[0];
 if(prior){requireCondition(prior.request_sha256===hash,409,'event_conflict','付款事件內容不一致。');return orderView(q,shop,id);}
 const reused=await q.query('SELECT 1 FROM commerce_payment_events WHERE shop_id=$1 AND provider=$2 AND transaction_ref=$3 AND event_type=$4',[shop.shop_id,body.provider,body.transaction_ref,body.type]);
 requireCondition(!reused.rowCount,409,'transaction_reused','這筆金流交易已被登記，請使用原事件代號重送。');
 const state=transfer?transfer.payment_state:order.buyer_payment;
 if(body.type==='paid'){
  requireCondition(state==='pending',409,'payment_state_conflict','目前狀態不可登記收款。');
  if(transfer)requireCondition(order.buyer_payment==='reported_paid',409,'buyer_not_paid','買家尚未完成付款或已退款。');
  else requireCondition(new Date(order.expires_at).getTime()>Date.now(),409,'order_expired','訂單保留時間已過，請由商店處理退款，不自動轉單。');
 }else{
  requireCondition(state==='reported_paid',409,'payment_state_conflict','先有收款紀錄才能登記全額退款。');
  const paid=(await q.query(`SELECT transaction_ref,provider FROM commerce_payment_events WHERE order_id=$1 AND shop_id=$2 AND transfer_id IS NOT DISTINCT FROM $3 AND event_type='paid'`,[id,shop.shop_id,transferId??null])).rows[0];
  requireCondition(paid?.transaction_ref===body.transaction_ref&&paid?.provider===body.provider,422,'refund_reference_mismatch','退款必須對應原收款交易。');
 }
 await q.query(`INSERT INTO commerce_payment_events(event_id,shop_id,external_event_id,request_sha256,order_id,transfer_id,event_type,provider,transaction_ref,amount_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),shop.shop_id,body.event_id,hash,id,transferId??null,body.type,body.provider,body.transaction_ref,body.amount_minor]);
 const next=body.type==='paid'?'reported_paid':'reported_refunded';
 if(transfer)await q.query('UPDATE commerce_transfers SET payment_state=$2 WHERE transfer_id=$1',[transferId,next]);
 else await q.query('UPDATE commerce_orders SET buyer_payment=$2 WHERE order_id=$1',[id,next]);
 // Paid/refunded orders retain their reservation: reselling returned goods requires a new confirmed catalog.
 return orderView(q,shop,id);
}
export async function setPaymentUrl(q:PoolClient,shop:any,id:string,url:string){
 httpsUrl.parse(url);
 requireCondition(new URL(url).origin===new URL(shop.website_url).origin,422,'payment_origin_mismatch','付款入口必須位於自己的商店，由商店後台產生金流交易。');
 const transfer=(await q.query(`SELECT t.* FROM commerce_transfers t JOIN commerce_orders o USING(order_id)
 WHERE t.transfer_id=$1 AND t.internal_shop_id=$2 AND o.buyer_payment='reported_paid'`,[id,shop.shop_id])).rows[0];
 requireCondition(shop.kind==='internal'&&transfer,404,'transfer_not_found','找不到可收款的供貨單。');
 requireCondition(transfer.payment_state==='pending',409,'already_paid','商品成本已收款，不能替換付款入口。');
 await q.query('UPDATE commerce_transfers SET payment_url=$2 WHERE transfer_id=$1',[id,url]);return {recorded:true};
}
export async function recordShipment(pool:Pool,input:Command,id:string){
 const shipment=shipmentInput.parse(input.body);
 return command(pool,input,async()=>{},async q=>{
  await lockCommunity(q,input.actor.community_id);
  const t=(await q.query(`SELECT t.*,o.buyer_payment FROM commerce_transfers t JOIN commerce_shops s ON s.shop_id=t.internal_shop_id JOIN commerce_orders o USING(order_id)
   WHERE t.transfer_id=$1 AND s.owner_id=$2 AND s.community_id=$3`,[id,input.actor.user_id,input.actor.community_id])).rows[0];
  requireCondition(t,404,'transfer_not_found','只有出貨方可以登記。');
  requireCondition(t.payment_state==='reported_paid'&&t.buyer_payment==='reported_paid',409,'payment_required','兩筆付款都收到後才能登記出貨；退款訂單請另行處理。');
  requireCondition(new Date(shipment.shipped_at).getTime()<=Date.now(),422,'future_shipment','出貨日期不能是未來。');
  const version=(await q.query('UPDATE commerce_transfers SET shipment=$2,aggregate_version=aggregate_version+1 WHERE transfer_id=$1 RETURNING aggregate_version',[id,{...shipment,source:'shipper_entered',registered_at:new Date().toISOString()}])).rows[0].aggregate_version;
  await journal(q,input.actor,'commerce_transfer',id,version,'register_shipment',{method:shipment.method});return {recorded:true};
 });
}
export async function cancelOrder(q:PoolClient,shop:any,id:string){
 const o=(await q.query('SELECT * FROM commerce_orders WHERE order_id=$1 AND public_shop_id=$2',[id,shop.shop_id])).rows[0];
 requireCondition(o,404,'order_not_found','找不到訂單。');
 if(o.buyer_payment==='cancelled')return {cancelled:true};
 requireCondition(o.buyer_payment==='pending',409,'already_paid','已付款訂單不能取消，請使用退款流程。');
 await release(q,id);await q.query("UPDATE commerce_orders SET buyer_payment='cancelled' WHERE order_id=$1",[id]);return {cancelled:true};
}

export async function setAcceptingOrders(pool:Pool,input:Command,id:string,accepting:boolean){
 return command(pool,input,q=>ownShop(q,input.actor,id),async q=>{
  await lockCommunity(q,input.actor.community_id);
  const row=(await q.query('UPDATE commerce_shops SET accepting_orders=$2,aggregate_version=aggregate_version+1 WHERE shop_id=$1 RETURNING aggregate_version',[id,accepting])).rows[0];
  await journal(q,input.actor,'commerce_shop',id,row.aggregate_version,'set_accepting_orders',{accepting});return {accepting_orders:accepting};
 });
}
