import type {ShippingQuoteLine} from '../../checkout/terms.js';
import {availableMethods,planDelivery,type AvailableMethodOption,type DeliveryGroup,type DeliveryMethod,type DeliveryOption,type ItemShippingAttributes,type PlanDeliveryResult,type PlanInput,type QuoteLine,type ServiceKey,type ShippingProfile,type UnavailableReason} from '../rules/index.js';

const bySku=(a:string,b:string)=>a<b?-1:a>b?1:0;
const byLine=(a:{sku:string},b:{sku:string})=>bySku(a.sku,b.sku);

export function sortedLines(lines:readonly ShippingQuoteLine[]) {
  return [...lines].sort(byLine);
}
export function unsupported(lines:readonly ShippingQuoteLine[]) {
  return sortedLines(lines).map(line=>({sku:line.sku,reason:'method_unsupported' as const}));
}
export function quoteLines(lines:readonly ShippingQuoteLine[],attributes:ReadonlyMap<string,{readonly version:string;readonly attributes:ItemShippingAttributes}>):QuoteLine[] {
  return sortedLines(lines).map(line=>({
    line_ref:line.sku,quantity:line.quantity,unit_price_minor:line.unit_price_minor,
    attributes:attributes.get(line.item_id)?.attributes??null,
    fulfilment:line.own?{kind:'self' as const}:{kind:'not_agreed' as const},
  }));
}
export function versionsBySku(lines:readonly ShippingQuoteLine[],attributes:ReadonlyMap<string,{readonly version:string}>) {
  const versions=new Map<string,string>();
  for(const line of lines){const version=attributes.get(line.item_id)?.version;if(version)versions.set(line.sku,version);}
  return versions;
}
export function sellerProfile(shopId:string,version:string,workingDays:readonly number[],services:ShippingProfile['services']):ShippingProfile {
  return {shop_id:shopId,version,working_days:[...workingDays],services:[...services]};
}
export function planFor(input:{
  sellerShopId:string;profile:ShippingProfile;options:readonly DeliveryOption[];lines:readonly QuoteLine[];
  merchandiseNetMinor:number;outlying:boolean;
}):PlanInput {
  return {
    seller_shop_id:input.sellerShopId,
    delivery_options:input.options,
    profiles:{[input.profile.shop_id]:input.profile},
    lines:input.lines,
    merchandise_net_minor:input.merchandiseNetMinor,
    destination:{outlying:input.outlying},
  };
}
export function optionResults(input:PlanInput):ReadonlyMap<DeliveryMethod,PlanDeliveryResult> {
  return new Map(availableMethods(input).map((option:AvailableMethodOption)=>[option.method,option.result]));
}
export function frozenFromPlan(plan:Extract<PlanDeliveryResult,{kind:'plan'}>,versions:ReadonlyMap<string,string>,deliveryProfileVersion:string,destination:'complete'|'store_required') {
  return {
    delivery_profile_version:deliveryProfileVersion,destination_state:destination,
    groups:plan.groups.map(group=>frozenGroup(group,plan.method,versions)),
  };
}
function frozenGroup(group:DeliveryGroup,method:DeliveryMethod,versions:ReadonlyMap<string,string>) {
  const skus=[...new Set(group.parcels.flatMap(parcel=>parcel.lines.map(line=>line.line_ref)))].sort(bySku);
  return {
    group_ref:group.group_ref,supplier_shop_id:group.executor_shop_id,method_ref:method,fulfilment_mode:group.fulfilment_mode,
    agreement:group.agreement_id===null?null:{agreement_id:group.agreement_id,version:group.agreement_version},
    profile_version:group.profile_version,
    logistics:{service_key:group.service_key as ServiceKey,logistics_sub_type:group.logistics_sub_type,ship_from_location_id:group.ship_from_location_id,temperature:group.temperature,handling_days:group.handling_days,cutoff_time:group.cutoff_time,working_days:[...group.working_days]},
    meetup:null,
    parcels:group.parcels.map(parcel=>({parcel_ref:parcel.parcel_ref,lines:parcel.lines.map(line=>({sku:line.line_ref,quantity:line.quantity})),weight_g:parcel.weight_g,declared_value_minor:parcel.declared_value_minor})),
    attribute_versions:skus.map(sku=>({sku,version:versions.get(sku)})),
    fee_per_parcel_minor:group.fee_per_parcel_minor,outlying_surcharge_per_parcel_minor:group.outlying_surcharge_per_parcel_minor,amount_minor:group.shipping_minor,
  };
}
export function unavailableFromPlan(result:Extract<PlanDeliveryResult,{kind:'unavailable'}>) {
  return [...result.lines].map(line=>({sku:line.line_ref,reason:line.reason as UnavailableReason})).sort(byLine);
}
export function quotePlan(input:PlanInput,method:DeliveryMethod) {
  return planDelivery(input,method);
}
