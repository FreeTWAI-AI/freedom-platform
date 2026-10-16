import type {SupplierMetric,SupplierProduct,SupplierPartner,SupplierProductSelection,SupplierTodo} from '../../../../contracts/guild-launchpad/v1/supplier-console';
import type {Distribution} from '../../../../contracts/guild-launchpad/v1/hosted-distribution';
import {productMatches} from '../../hosted-ui/CommerceTools';
import {parseMajorToMinor,formatMinor} from '../../../../apps/portal-web/src/format';
import type {ProductState,ProductSort} from './route';
import type {Fields} from '../state/drafts';
import type {AttemptKind} from '../state/attempt';
export const PRICE_GAP_NOTE='價格差屬於賣家的定價，不是你的佣金、收入或利潤。';
export const REVIEW_NOTE='同意的是這個售價與供貨版本；不代表同意代出貨，也不會取得買家收件資料。';
export const RESERVATION_NOTE='預留最多 30 分鐘，尚未付款或安排出貨；供貨金額不是請款或營收。';
export const permissionReason=(reason:'store_write_required'|'owner_required')=>reason==='owner_required'?'只有業務空間擁有者可以查看預留':'需要商品編輯權限才能查看';
export const metricText=(metric:SupplierMetric)=>metric.state==='ready'?String(metric.count):`無法取得：${permissionReason(metric.reason)}`;
export const todoText=(todo:SupplierTodo)=>todo.kind==='request_pending'?'待確認售價申請':todo.kind==='offer_outdated'?'供貨條件已修改，需重新公開':todo.kind==='out_of_stock'?'可用庫存已用完':'尚未公開供貨版本';
export function filterProducts(items:SupplierProduct[],state:ProductState|undefined,sort:ProductSort='sku',search='') {
 return items.filter(p=>(!state||(state==='offered'?p.offer!==null:state==='not_offered'?p.offer===null:state==='outdated'?p.offer!==null&&!p.offer.matches_current_terms:p.available===0))&&productMatches(p,search))
  .sort((a,b)=>sort==='available'?a.available-b.available||a.sku.localeCompare(b.sku):sort==='title'?a.title.localeCompare(b.title,'zh-TW')||a.sku.localeCompare(b.sku):a.sku.localeCompare(b.sku));
}
export function partnerLabel(partner:Pick<SupplierPartner,'partner_id'|'name'>,peers:Pick<SupplierPartner,'partner_id'|'name'>[]){return partner.name+(peers.some(p=>p.partner_id!==partner.partner_id&&p.name===partner.name)?`（店家 ID …${partner.partner_id.slice(-6)}）`:'');}
export const selectionPartnerLabel=(s:SupplierProductSelection,peers:SupplierProductSelection[])=>partnerLabel({partner_id:s.partner_id,name:s.seller_name},peers.map(p=>({partner_id:p.partner_id,name:p.seller_name})));
export function selectionShopLabel(s:Distribution,peers:Distribution[]){return s.seller_name+(peers.some(p=>p.selection_id!==s.selection_id&&p.seller_name===s.seller_name)?`（申請 ID …${s.selection_id.slice(-6)}）`:'');}
export const selectionState=(s:Distribution)=>s.offer.state==='withdrawn'?'供貨版本已撤回':({awaiting_supply_acceptance:'待確認',sellable:'可售',declined:'未同意',changes_requested:'需修改',revoked:'停用'})[s.state];
export const offerState=(p:SupplierProduct)=>!p.offer?'尚未公開':p.offer.matches_current_terms?'公開中':'需要重新公開';
export const priceGap=(s:Distribution)=>formatMinor(s.retail_price_minor-s.offer.terms.cost_minor-s.offer.terms.shipping_minor,s.offer.terms.currency);
export function commandFields(kind:AttemptKind,fields:Fields):Fields {
 return Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,k==='cost_minor'||k==='shipping_minor'?k==='shipping_minor'&&/^0+(?:\.0{1,2})?$/.test(String(v).trim())?0:parseMajorToMinor(String(v)):k==='stock'?/^\d+$/.test(String(v))?Number(v):NaN:v]));
}
export const fieldLabels:Record<string,string>={title:'商品名稱',description:'說明',stock:'庫存',cost_minor:'供貨單價',shipping_minor:'每件運費',shipping_terms:'出貨條件',return_terms:'退貨條件',name:'商品庫名稱',currency:'幣別',decision:'決定',listing_sha256:'申請內容摘要',reservation_enabled:'開放新預留'};
export function attemptFieldText(field:string,value:unknown,currency:string){return typeof value==='number'&&(field==='cost_minor'||field==='shipping_minor')?formatMinor(value,currency):typeof value==='boolean'?value?'是':'否':field==='decision'?(({accepted:'同意',declined:'不同意',revoked:'撤回同意'} as Record<string,string>)[String(value)]??String(value)):String(value??'（空白）');}
