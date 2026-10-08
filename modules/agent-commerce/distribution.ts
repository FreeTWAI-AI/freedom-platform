import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {command,checkVersion,digest,journal,type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {acceptanceInput} from './schema.js';

function recorder(shop:{owner_id:string;community_id:string}){return {user_id:shop.owner_id,community_id:shop.community_id} as Actor;}

// Launch default is reseller. The six responsibilities are snapshotted; page names do not imply them.
export function resellerArrangement(sellerId:string,supplierId:string){
 return {mode:'reseller' as const,seller_of_record:sellerId,payment_collector:sellerId,invoice_issuer:sellerId,refund_owner:sellerId,price_owner:sellerId,fulfillment_party:supplierId};
}
export function listingDigest(snapshot:unknown){return digest(snapshot);}

async function lockCommunity(q:PoolClient,community:string){await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commerce-orders/${community}`]);}

export async function listAcceptances(pool:Pool,actor:{user_id:string;community_id:string}){
 return (await pool.query(`SELECT l.selection_id,l.listing_sha256,l.acceptance_state,l.aggregate_version,l.retail_price_minor,l.sale_terms,l.snapshot,
  s.name AS public_shop_name,s.currency FROM commerce_selections l
  JOIN commerce_items i ON i.item_id=l.item_id JOIN commerce_shops internal ON internal.shop_id=i.shop_id
  JOIN commerce_shops s ON s.shop_id=l.shop_id
  WHERE internal.origin='imported' AND s.origin='imported' AND internal.owner_id=$1 AND internal.community_id=$2 AND s.community_id=$2
  ORDER BY l.acceptance_state,l.selection_id`,[actor.user_id,actor.community_id])).rows.map(row=>({
  selection_id:row.selection_id,listing_sha256:row.listing_sha256,acceptance_state:row.acceptance_state,aggregate_version:row.aggregate_version,
  retail_price_minor:row.retail_price_minor,supplier_net_minor:row.snapshot.cost_minor,shipping_minor:row.snapshot.shipping_minor,tax_minor:row.snapshot.tax_minor??0,
  currency:row.currency,sale_terms:row.sale_terms,title:row.snapshot.title,public_shop_name:row.public_shop_name,arrangement:row.snapshot.arrangement,
  acceptance_kind:'distribution_acceptance',money_movement_enabled:false,official:false
 }));
}

const nextState:Record<string,string>={accepted:'sellable',declined:'declined',changes_requested:'changes_requested',revoked:'revoked'};
export async function decideAcceptance(pool:Pool,input:Command,selectionId:string){
 const body=acceptanceInput.parse(input.body);
 return command(pool,input,async()=>{},async q=>{
  await lockCommunity(q,input.actor.community_id);
  const row=(await q.query(`SELECT l.*,internal.owner_id AS supplier_user_id,s.owner_id AS seller_user_id FROM commerce_selections l
   JOIN commerce_items i ON i.item_id=l.item_id JOIN commerce_shops internal ON internal.shop_id=i.shop_id
   JOIN commerce_shops s ON s.shop_id=l.shop_id
   WHERE internal.origin='imported' AND s.origin='imported' AND l.selection_id=$1 AND internal.owner_id=$2 AND internal.community_id=$3 AND s.community_id=$3 FOR UPDATE OF l`,[selectionId,input.actor.user_id,input.actor.community_id])).rows[0];
  requireCondition(row,404,'acceptance_not_found','只有供貨的會員可以接受或拒絕這一版售價。');
  checkVersion(String(row.aggregate_version),input.expected);
  requireCondition(row.listing_sha256===body.listing_sha256,409,'snapshot_changed','售價或供貨條件已變更，請重新確認這一版。');
  requireCondition(body.decision!=='revoked'||row.acceptance_state==='sellable',409,'invalid_state','只有已接受的供貨可以撤回未來接單。');
  requireCondition(body.decision==='revoked'||row.acceptance_state!=='sellable',409,'invalid_state','這一版已經接受；要停止新訂單請撤回。');
  const acceptanceId=randomUUID();
  await q.query(`INSERT INTO commerce_distribution_acceptances(acceptance_id,selection_id,community_id,supplier_user_id,seller_user_id,listing_sha256,decision,note,signer_user_id,signed_digest,arrangement)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$10)`,[acceptanceId,selectionId,input.actor.community_id,row.supplier_user_id,row.seller_user_id,body.listing_sha256,body.decision,body.note,input.actor.user_id,JSON.stringify(row.snapshot.arrangement)]);
  const updated=(await q.query(`UPDATE commerce_selections SET acceptance_state=$2,current_acceptance_id=$3,aggregate_version=aggregate_version+1 WHERE selection_id=$1 RETURNING aggregate_version`,[selectionId,nextState[body.decision],acceptanceId])).rows[0];
  await journal(q,input.actor,'commerce_selection',selectionId,updated.aggregate_version,`distribution_acceptance_${body.decision}`,{acceptance_id:acceptanceId,listing_sha256:body.listing_sha256,signer_user_id:input.actor.user_id,acceptance_kind:'distribution_acceptance'},`freedom.commerce.distribution_acceptance.${body.decision}.v1`);
  return {selection_id:selectionId,acceptance_id:acceptanceId,acceptance_state:nextState[body.decision],listing_sha256:body.listing_sha256,acceptance_kind:'distribution_acceptance',signer_user_id:input.actor.user_id,money_movement_enabled:false,official:false,aggregate_version:updated.aggregate_version};
 });
}

function money(value:unknown){const n=Number(value);requireCondition(Number.isSafeInteger(n),422,'amount_overflow','訂單金額過大。');return n;}

export async function accrueSupplierPayables(q:PoolClient,shop:{owner_id:string;community_id:string},orderId:string,paymentEventId:string){
 const lines=(await q.query(`SELECT ol.selection_id,ol.transfer_id,ol.quantity,ol.snapshot,ol.acceptance_id,ol.listing_sha256,o.currency,a.decision,a.supplier_user_id,a.listing_sha256 AS accepted_sha256
  FROM commerce_order_lines ol JOIN commerce_orders o USING(order_id)
  JOIN commerce_distribution_acceptances a ON a.acceptance_id=ol.acceptance_id
  WHERE ol.order_id=$1`,[orderId])).rows;
 requireCondition(lines.length>0,409,'acceptance_required','沒有已簽署的供貨接受，不能建立供應應付。');
 for(const line of lines){
  requireCondition(line.decision==='accepted'&&line.accepted_sha256===line.listing_sha256&&line.listing_sha256===line.snapshot.listing_sha256,409,'acceptance_required','供貨接受與訂單凍結的售價不一致。');
  const net=money(line.snapshot.cost_minor)*line.quantity,shipping=money(line.snapshot.shipping_minor)*line.quantity,tax=money(line.snapshot.tax_minor??0)*line.quantity;
  requireCondition(Number.isSafeInteger(net)&&Number.isSafeInteger(shipping)&&Number.isSafeInteger(tax),422,'amount_overflow','供應應付金額過大。');
  const payableId=randomUUID();
  const inserted=await q.query(`INSERT INTO commerce_supplier_payables(payable_id,order_id,transfer_id,selection_id,acceptance_id,listing_sha256,beneficiary_user_id,supplier_net_minor,shipping_minor,tax_minor,currency,source_payment_event_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(order_id,selection_id) DO NOTHING RETURNING payable_id`,[payableId,orderId,line.transfer_id,line.selection_id,line.acceptance_id,line.listing_sha256,line.supplier_user_id,net,shipping,tax,line.currency,paymentEventId]);
  if(!inserted.rowCount)continue;
  await q.query(`INSERT INTO commerce_settlement_records(settlement_id,payable_id) VALUES($1,$2)`,[randomUUID(),payableId]);
  await journal(q,recorder(shop),'supplier_payable',payableId,1,'accrue_supplier_payable',{order_id:orderId,selection_id:line.selection_id,supplier_net_minor:net,shipping_minor:shipping,tax_minor:tax,settlement_mode:'record_only',money_movement_enabled:false},'freedom.ledger.supplier_payable.accrued.v1');
 }
}

export async function reverseSupplierPayables(q:PoolClient,shop:{owner_id:string;community_id:string},orderId:string,paymentEventId:string){
 const payables=(await q.query('SELECT * FROM commerce_supplier_payables WHERE order_id=$1',[orderId])).rows;
 for(const payable of payables){
  const reversalId=randomUUID();
  const inserted=await q.query(`INSERT INTO commerce_obligation_reversals(reversal_id,payable_id,payment_event_id,amount_minor,currency)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT(payable_id,payment_event_id) DO NOTHING RETURNING reversal_id`,[reversalId,payable.payable_id,paymentEventId,payable.supplier_net_minor,payable.currency]);
  if(inserted.rowCount)await journal(q,recorder(shop),'obligation_reversal',reversalId,1,'reverse_supplier_payable',{payable_id:payable.payable_id,amount_minor:Number(payable.supplier_net_minor),payment_event_id:paymentEventId},'freedom.ledger.obligation.reversed.v1');
 }
}

type PayableView={payable_id:string;selection_id:string;transfer_id:string;supplier_net_minor:number;shipping_minor:number;tax_minor:number;reversed_minor:number;status:'recorded';settlement:{mode:'record_only';state:'recorded';display_label:'已記錄';money_movement_enabled:false;platform_collects:false;auto_debit:false}};
export async function payablesForOrder(q:PoolClient,orderId:string):Promise<PayableView[]>{
 const rows=(await q.query(`SELECT p.*,COALESCE((SELECT sum(amount_minor) FROM commerce_obligation_reversals r WHERE r.payable_id=p.payable_id),0) AS reversed_minor,
  s.mode,s.state,s.display_label,s.money_movement_enabled,s.platform_collects,s.auto_debit
  FROM commerce_supplier_payables p JOIN commerce_settlement_records s USING(payable_id) WHERE p.order_id=$1`,[orderId])).rows;
 return rows.map(p=>({payable_id:p.payable_id,selection_id:p.selection_id,transfer_id:p.transfer_id,supplier_net_minor:Number(p.supplier_net_minor),shipping_minor:Number(p.shipping_minor),tax_minor:Number(p.tax_minor),reversed_minor:Number(p.reversed_minor),status:'recorded',
  settlement:{mode:'record_only',state:'recorded',display_label:'已記錄',money_movement_enabled:false,platform_collects:false,auto_debit:false}}));
}
export function marginProjection(paidMinor:number,payables:PayableView[],lineCount:number){
 if(payables.length!==lineCount||lineCount===0)return null;
 const supplier=payables.reduce((n,p)=>n+p.supplier_net_minor,0),shipping=payables.reduce((n,p)=>n+p.shipping_minor,0),tax=payables.reduce((n,p)=>n+p.tax_minor,0);
 const amount=paidMinor-supplier-shipping-tax;
 if(!Number.isSafeInteger(amount))return null;
 return {amount_minor:amount,paid_minor:paidMinor,supplier_payable_minor:supplier,explicit_cost_minor:shipping,explicit_tax_minor:tax,cash_received:false as const,label:'預估差額' as const,settlement_display:'已記錄' as const,basis:'buyer_paid_minus_supplier_payable_minus_explicit_tax_and_cost' as const};
}
