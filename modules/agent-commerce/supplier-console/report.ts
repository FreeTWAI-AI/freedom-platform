import type {Pool,PoolClient} from 'pg';
import {SupplierReportSchema,SUPPLIER_REPORT_MAX_ROWS,type SupplierReportQuery,type SupplierReport} from '../../../contracts/guild-launchpad/v1/supplier-console.js';
import type {TenantScopeContext} from '../../../packages/resource-scopes/index.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import type {Actor} from '../../identity-membership/service.js';
import {effectiveStoreCapabilities} from '../hosted/capabilities.js';
import {profile,ready,storeRead} from '../hosted/store.js';
import {own,offers,selections,cooperation,products,partners,params,productView,partnerView,type Row} from './reads.js';

// Match hosted/seller-orders.ts authorize, without its command locks or receipt:
// a manage grant alone cannot admit a caller to line-level reservation data.
async function reservationOwner(q:PoolClient,actor:Actor,context:TenantScopeContext,instanceId:string) {
  if(context.role!=='owner'||!(await effectiveStoreCapabilities(q,context,instanceId)).includes('store:manage'))return false;
  const eligible=await q.query(`SELECT 1 FROM users u
    JOIN module_instances i ON i.tenant_id=$2 AND i.instance_id=$3 AND i.module_key='storefront'
    JOIN module_definitions d ON d.module_key=i.module_key AND d.release_ref=i.module_release_ref AND d.capabilities ? 'store:manage'
    JOIN deployment_bindings b ON b.tenant_id=i.tenant_id AND b.instance_id=i.instance_id AND b.binding_id=i.binding_id
    WHERE u.user_id=$1 AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND NOT is_verification_test_account(u.user_id)`,[actor.user_id,context.tenant_id,instanceId]);
  return eligible.rowCount===1;
}
function reportSql({owner,detail}:{owner:boolean;detail:boolean}) {
  // Keep the order lookup parameterized by each scoped line. Without this
  // boundary, stale statistics can choose a supplier-wide line scan for every
  // order (quadratic work), even though both sides have exact-key indexes.
  const lines=owner?`,report_lines AS (
    SELECT o.order_id,o.created_at,o.expires_at,o.closed_at,o.public_shop_id AS partner_id,retail.name AS partner_name,
      line.item_id,line.selection_id,line.hosted_offer_id AS offer_id,line.snapshot->>'sku' AS sku,line.snapshot->>'title' AS title,
      line.quantity,(offer.terms->>'cost_minor')::bigint AS unit_supply_price_minor,offer.terms->>'currency' AS currency,
      CASE WHEN o.reservation_state='reserved' AND o.expires_at<=report_clock.at THEN 'expired' ELSE o.reservation_state END AS state
    FROM report_clock,commerce_order_lines line
    JOIN LATERAL (
      SELECT o.order_id,o.created_at,o.expires_at,o.closed_at,o.public_shop_id,o.reservation_state
      FROM commerce_orders o WHERE o.order_id=line.order_id AND o.order_profile=line.order_profile
        AND o.created_at>=$5::timestamptz AND o.created_at<$6::timestamptz OFFSET 0
    ) o ON true
    JOIN offers offer ON offer.offer_id=line.hosted_offer_id AND offer.item_id=line.item_id
    JOIN commerce_shops retail ON retail.shop_id=o.public_shop_id AND retail.origin='hosted'
    WHERE line.supplier_shop_id=$3 AND line.hosted_offer_id IS NOT NULL AND line.order_profile='hosted_shared_reservation')` : '';
  return `/* supplier-console:${detail?'report-csv':'report'} */ WITH report_clock AS (
      SELECT date_trunc('milliseconds',statement_timestamp()) AS at,$5::timestamptz AS period_start,$6::timestamptz AS period_end),
    ${own},${offers},${selections},${products},${partners}${lines}
    SELECT to_char(report_clock.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of,
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sku,i.item_id) FROM products i),'[]') AS products,
      (SELECT ${cooperation} FROM selections) AS cooperation,
      (SELECT count(*) FROM partners) AS partner_count,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.awaiting DESC,p.name,p.partner_id) FROM (
        SELECT * FROM partners ORDER BY awaiting DESC,name,partner_id LIMIT 200) p),'[]') AS partners
      ${owner?`,COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM (
        SELECT state,count(DISTINCT order_id) AS reservations,count(*) AS lines,COALESCE(sum(quantity),0) AS quantity,
          COALESCE(sum(quantity*unit_supply_price_minor),0) AS supply_total_minor FROM report_lines GROUP BY state) s),'[]') AS reservation_totals,
        (SELECT count(*) FILTER (WHERE currency IS DISTINCT FROM $7) FROM report_lines) AS currency_mismatch`:''}
      ${detail?`,COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.awaiting DESC,p.name,p.partner_id) FROM (
        SELECT * FROM partners ORDER BY awaiting DESC,name,partner_id LIMIT 10001) p),'[]') AS partner_rows`:''}
      ${owner&&detail?`,COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at,l.order_id,l.selection_id) FROM (
        SELECT * FROM report_lines ORDER BY created_at,order_id,selection_id LIMIT 10001) l),'[]') AS line_rows`:''}
    FROM report_clock`;
}
const consistent=(condition:unknown)=>requireCondition(condition,500,'supplier_report_inconsistent','報表資料不一致，請稍後再試。');
function integer(value:unknown) {
  const n=Number(value);consistent(Number.isSafeInteger(n)&&n>=0);return n;
}
async function reportRead(pool:Pool,actor:Actor,tenantId:string,instanceId:string,query:SupplierReportQuery,detail:boolean) {
  return storeRead(pool,actor,tenantId,instanceId,'store:write',async(q,context)=>{
    const p=await profile(q,tenantId,instanceId);ready(p);
    const owner=await reservationOwner(q,actor,context,instanceId);
    const start=new Date(Date.parse(query.from+'T00:00:00+08:00')).toISOString();
    const end=new Date(Date.parse(query.to+'T00:00:00+08:00')+86400000).toISOString();
    const row=(await q.query(reportSql({owner,detail}),[...params(p),start,end,...(owner?[p.currency]:[])])).rows[0];
    requireCondition(row.products.length<=200,500,'supplier_product_limit','供貨商品數量超出上限。');
    const items=(row.products as Row[]).map(r=>productView(r,p.currency));
    const counts={total:items.length,offered:items.filter(i=>i.offer!==null).length,not_offered:items.filter(i=>i.offer===null).length,
      outdated:items.filter(i=>i.offer!==null&&!i.offer.matches_current_terms).length,out_of_stock:items.filter(i=>i.available===0).length};
    const stateTotals=(state:string)=>{
      const s=(row.reservation_totals as Row[]).find(s=>s.state===state);
      return {reservations:integer(s?.reservations??0),lines:integer(s?.lines??0),quantity:integer(s?.quantity??0),supply_total_minor:integer(s?.supply_total_minor??0)};
    };
    if(owner)consistent(integer(row.currency_mismatch)===0);
    const reservations=owner?{state:'ready' as const,reserved:stateTotals('reserved'),cancelled:stateTotals('cancelled'),expired:stateTotals('expired')}
      :{state:'unavailable' as const,reason:'owner_required' as const};
    const partnerCount=integer(row.partner_count),lineCount=reservations.state==='ready'
      ?integer(reservations.reserved.lines+reservations.cancelled.lines+reservations.expired.lines):0;
    const csvRows=integer(items.length+partnerCount+lineCount);
    requireCondition(csvRows<=SUPPLIER_REPORT_MAX_ROWS,409,'report_too_large','這段期間的報表超過 10,000 列，請縮短期間。');
    if(detail)consistent(row.partner_rows.length===partnerCount&&(!owner||row.line_rows.length===lineCount));
    const report=SupplierReportSchema.parse({profile:'freedom.supplier-console.report/v1',tenant_id:tenantId,instance_id:instanceId,as_of:row.as_of,
      business:{name:p.name,currency:p.currency},period:{...query,time_zone:'Asia/Taipei',start,end},products:counts,
      cooperation:{totals:row.cooperation,partner_count:partnerCount,partners:row.partners.map(partnerView)},reservations,csv_rows:csvRows});
    return {report,items,partnerRows:((row.partner_rows??[]) as Row[]).map(partnerView),lineRows:(row.line_rows??[]) as Row[]};
  });
}
export async function readSupplierReport(pool:Pool,actor:Actor,tenantId:string,instanceId:string,query:SupplierReportQuery) {
  return (await reportRead(pool,actor,tenantId,instanceId,query,false)).report;
}
const taipei=(value:string|null)=>value===null?'':new Date(Date.parse(value)+8*3600000).toISOString().slice(0,19).replace('T',' ');
function cell(value:string|number) {
  const text=typeof value==='number'?String(integer(value)):(/^[=+\-@\t\r]/.test(value)?"'"+value:value);
  return '"'+text.replaceAll('"','""')+'"';
}
const stateLabels={reserved:'預留中',cancelled:'已取消',expired:'已到期'} as const;
function csvHeader(r:SupplierReport):(string|number)[][] {
  return [['報表','供應商營運報表'],['產生時間（台灣時間）',taipei(r.as_of)],['產生時間（UTC）',r.as_of],
    ['事業名稱',r.business.name],['業務空間 ID',r.tenant_id],['商品庫 ID',r.instance_id],
    ['期間（台灣時間，含首尾）',`${r.period.from} 至 ${r.period.to}`],['幣別',r.business.currency],
    ['金額單位',`最小單位 1/100（例如 12345 代表 123.45 ${r.business.currency}）`],
    ['定義','商品與合作是產生時間當下的狀態；預留只計期間內建立、含本供應商行項的預留，狀態以產生時間判斷，已過到期時間但尚未結算的預留算已到期。'],
    ['說明','預留供貨金額是數量乘以供貨單價，不是營收、請款、付款或佣金。'],
    ['說明','本檔不是完整資料匯出，也不是備份或搬家用的資料包。']];
}
export async function readSupplierReportCsv(pool:Pool,actor:Actor,tenantId:string,instanceId:string,query:SupplierReportQuery) {
  const {report:r,items,partnerRows,lineRows}=await reportRead(pool,actor,tenantId,instanceId,query,true);
  const rows=csvHeader(r),p=r.products,c=r.cooperation.totals;
  if(r.reservations.state==='unavailable')rows.push(['預留','只有業務空間擁有者可以查看預留，本檔不含預留資料。']);
  rows.push([],['摘要'],['項目','數量'],['商品總數',p.total],['公開中',p.offered],['尚未公開',p.not_offered],['需更新版本',p.outdated],
    ['缺貨',p.out_of_stock],['合作店家',r.cooperation.partner_count],['選品待確認',c.awaiting],['選品可售',c.sellable],['選品需修改',c.changes_requested],['選品停用',c.inactive]);
  if(r.reservations.state==='ready') {
    rows.push([],['預留狀態','預留筆數','行項數','數量','預留供貨金額（1/100）']);
    for(const state of ['reserved','cancelled','expired'] as const) {
      const s=r.reservations[state];rows.push([stateLabels[state],s.reservations,s.lines,s.quantity,s.supply_total_minor]);
    }
  }
  rows.push([],['商品'],['商品 ID','SKU','商品名稱','供貨狀態','需更新版本','缺貨','庫存','已預留','可用','供貨單價（1/100）','每件運費（1/100）','選品待確認','選品可售','選品需修改','選品停用']);
  for(const i of items)rows.push([i.product_id,i.sku,i.title,i.offer?'公開中':'尚未公開',i.offer&&!i.offer.matches_current_terms?'是':'否',i.available===0?'是':'否',
    i.stock,i.reserved,i.available,i.supply_price_minor,i.shipping_minor,i.cooperation.awaiting,i.cooperation.sellable,i.cooperation.changes_requested,i.cooperation.inactive]);
  rows.push([],['合作店家'],['合作店家 ID','店家名稱','商品數','選品待確認','選品可售','選品需修改','選品停用']);
  for(const p of partnerRows)rows.push([p.partner_id,p.name,p.products,p.cooperation.awaiting,p.cooperation.sellable,p.cooperation.changes_requested,p.cooperation.inactive]);
  if(r.reservations.state==='ready') {
    rows.push([],['預留行項'],['預留 ID','建立時間（台灣時間）','狀態','到期時間（台灣時間）','結束時間（台灣時間）','合作店家 ID','店家名稱','商品 ID','SKU','商品名稱','供貨版本 ID','數量','供貨單價（1/100）','預留供貨金額（1/100）']);
    for(const l of lineRows)rows.push([l.order_id,taipei(l.created_at),stateLabels[l.state as keyof typeof stateLabels],taipei(l.expires_at),taipei(l.closed_at),
      l.partner_id,l.partner_name,l.item_id,l.sku,l.title,l.offer_id,integer(l.quantity),integer(l.unit_supply_price_minor),integer(Number(l.quantity)*Number(l.unit_supply_price_minor))]);
  }
  return {filename:`supplier-report-${query.from}_${query.to}.csv`,body:'\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n'};
}
