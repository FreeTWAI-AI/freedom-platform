import type {SupplierChange,SupplierMetric,SupplierProduct,SupplierPartner,SupplierProductSelection,SupplierTodo} from '../../../../contracts/guild-launchpad/v1/supplier-console';
import {SUPPLY_MATERIAL_IMAGE_MAX_BYTES,SUPPLY_MATERIAL_VIDEO_MAX_BYTES} from '../../../../contracts/guild-launchpad/v1/supplier-console';
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

export const CHANGE_LABELS={
 'storefront.supply-catalog.setup':'建立供貨商品庫',
 'storefront.supply-profile.update':'更新商品庫資料',
 'storefront.reservations.configure':'變更預留設定',
 'storefront.supply-product.create':'新增商品',
 'storefront.product.create':'在商店新增商品',
 'storefront.supply-product.update':'更新商品內容或庫存',
 'storefront.product.update':'在商店更新商品',
 'storefront.supply-terms.update':'更新供貨條件',
 'storefront.product.photo.upload':'上傳商品照片',
 'storefront.product.photo.remove':'移除商品照片',
 'storefront.supply-offer.publish':'公開新的供貨版本',
 'storefront.supply-offer.withdraw':'撤回供貨版本',
 'storefront.distribution.decide':'處理售價申請',
} satisfies Record<SupplierChange['operation'],string>;
export const changeLabel=(change:Pick<SupplierChange,'operation'|'version'>)=>change.operation==='storefront.supply-offer.publish'&&change.version!=='1'?'供貨版本由新版本取代':CHANGE_LABELS[change.operation];
export const changeSubject=(subject:SupplierChange['subject'])=>subject.kind==='business'?'商品庫設定':subject.kind==='request'?`${subject.partner_name}・${subject.title}`:subject.title;
export const reservationState=(state:'reserved'|'cancelled'|'expired')=>({reserved:'預留中',cancelled:'已取消',expired:'已到期'})[state];

export const materialKind=(kind:'image'|'video'|'copy')=>({image:'圖片',video:'影片',copy:'文案'})[kind];
export const materialAccess=(access:'partners'|'public_use')=>access==='partners'?'僅授權的合作店家':'可用於合作店家的公開店面';
export function materialSubject(subject:import('../../../../contracts/guild-launchpad/v1/supplier-console').SupplyMaterial['subject']){return subject.kind==='brand'?'品牌素材':subject.sku===null||subject.title===null?'商品已移除':`商品 ${subject.sku}・${subject.title}`;}
export const materialTime=(at:string)=>new Date(at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
export const materialSize=(bytes:number)=>`${(bytes/1048576).toFixed(1)} MB`;
export function materialCapacityText(capacity:import('../../../../contracts/guild-launchpad/v1/supplier-console').SupplyMaterials['capacity']|undefined){
 return capacity?.state==='ready'?`業務空間已用 ${materialSize(capacity.used_bytes)}，處理中 ${materialSize(capacity.reserved_bytes)}，上限 ${materialSize(capacity.limit_bytes)}，還可使用 ${materialSize(capacity.remaining_bytes)}。`:'目前無法讀取業務空間容量。';
}
export function materialCapacityProblem(capacity:import('../../../../contracts/guild-launchpad/v1/supplier-console').SupplyMaterials['capacity']|undefined,kind:'image'|'video'){
 return capacity?.state==='ready'&&capacity.remaining_bytes<(kind==='image'?SUPPLY_MATERIAL_IMAGE_MAX_BYTES:SUPPLY_MATERIAL_VIDEO_MAX_BYTES)?`剩餘容量不足；處理${kind==='image'?'圖片需預留 1 MB':'影片需預留 20 MB'}。`:null;
}
export function materialVersionSummary(version:import('../../../../contracts/guild-launchpad/v1/supplier-console').SupplyMaterialVersion){const c=version.content;return c.kind==='copy'?Array.from(c.body).slice(0,60).join(''):c.kind==='image'?`${c.width}×${c.height}・${materialSize(c.byte_size)}`:`${c.content_type}・${materialSize(c.byte_size)}`;}
export function sellableMaterialPartners(partners:import('../../../../contracts/guild-launchpad/v1/supplier-console').SupplyMaterialDetail['partners']){return partners.filter(p=>!p.granted&&p.cooperation==='sellable').map(p=>p.partner_id);}
export const materialContentPath=(scope:import('./route').ConsoleScope,id:string,versionId:string)=>`/api/v1/tenants/${scope.tenantId}/storefronts/${scope.instanceId}/supply-materials/${id}/versions/${versionId}/content`;
export function acceptedMaterialPreview<T extends {tenant_id:string;instance_id:string;material:{material_id:string;current:{version_id:string}|null}}>(
 slot:{state:string;data:T|null},scope:{tenantId:string;instanceId:string},materialId:string,versionId:string):T|null {
 const data=slot.state==='ready'?slot.data:null;
 if(!data||data.tenant_id!==scope.tenantId||data.instance_id!==scope.instanceId||data.material.material_id!==materialId||data.material.current?.version_id!==versionId)return null;
 return data;
}
