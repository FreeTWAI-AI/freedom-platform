import type {ShippingQuoteLine} from '../../checkout/terms.js';

const bySku=(a:string,b:string)=>a<b?-1:a>b?1:0;

/**
 * Meetup quoting stays outside the rules library, which only knows ECPay methods.
 * Production passes `self` or `not_agreed` only. `drop_ship` is rejected here with
 * `method_unsupported` so the agreements job can keep this branch; this function
 * never builds a drop-ship meetup group.
 */
export type MeetupLineFulfilment={readonly kind:'self'}|{readonly kind:'not_agreed'}|{readonly kind:'drop_ship'};
export interface MeetupQuoteLine {
  readonly sku:string;
  readonly quantity:number;
  readonly unit_price_minor:number;
  readonly supplier_shop_id:string;
  readonly fulfilment:MeetupLineFulfilment;
}
export interface MeetupQuoteRequest {
  readonly lines:readonly MeetupQuoteLine[];
  readonly sellerShopId:string;
  readonly profileVersion:string;
  readonly note:string;
}
export type MeetupQuoteResult=
  |{readonly kind:'plan';readonly group:{
      readonly group_ref:'g1';readonly supplier_shop_id:string;readonly method_ref:'meetup';readonly fulfilment_mode:'self';
      readonly agreement:null;readonly profile_version:string;readonly logistics:null;readonly meetup:{readonly note:string};
      readonly parcels:readonly [{readonly parcel_ref:'g1-p1';readonly lines:readonly {readonly sku:string;readonly quantity:number}[];readonly weight_g:null;readonly declared_value_minor:number}];
      readonly attribute_versions:readonly [];readonly fee_per_parcel_minor:0;readonly outlying_surcharge_per_parcel_minor:0;readonly amount_minor:0;
    }}
  |{readonly kind:'unavailable';readonly lines:readonly {readonly sku:string;readonly reason:'fulfilment_not_agreed'|'method_unsupported'}[]};

export function meetupQuote(input:MeetupQuoteRequest):MeetupQuoteResult {
  if(input.lines.length<1)throw new Error('shipping_quote_invalid');
  const lines=[...input.lines].sort((a,b)=>bySku(a.sku,b.sku));
  const failing:{sku:string;reason:'fulfilment_not_agreed'|'method_unsupported'}[]=[];
  for(const line of lines){
    if(line.fulfilment.kind==='not_agreed')failing.push({sku:line.sku,reason:'fulfilment_not_agreed'});
    else if(line.fulfilment.kind==='drop_ship')failing.push({sku:line.sku,reason:'method_unsupported'});
  }
  if(failing.length)return {kind:'unavailable',lines:failing};
  const declared=lines.reduce((sum,line)=>sum+line.unit_price_minor*line.quantity,0);
  if(!Number.isSafeInteger(declared)||declared<0)throw new Error('shipping_quote_invalid');
  return {kind:'plan',group:{
    group_ref:'g1',supplier_shop_id:input.sellerShopId,method_ref:'meetup',fulfilment_mode:'self',agreement:null,profile_version:input.profileVersion,
    logistics:null,meetup:{note:input.note},
    parcels:[{parcel_ref:'g1-p1',lines:lines.map(line=>({sku:line.sku,quantity:line.quantity})),weight_g:null,declared_value_minor:declared}],
    attribute_versions:[],fee_per_parcel_minor:0,outlying_surcharge_per_parcel_minor:0,amount_minor:0,
  }};
}

export function meetupLines(lines:readonly ShippingQuoteLine[]):MeetupQuoteLine[] {
  return lines.map(line=>({sku:line.sku,quantity:line.quantity,unit_price_minor:line.unit_price_minor,supplier_shop_id:line.supplier_shop_id,fulfilment:line.own?{kind:'self' as const}:{kind:'not_agreed' as const}}));
}
