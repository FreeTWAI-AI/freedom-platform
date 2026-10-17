import type {PoolClient} from 'pg';
import {z} from 'zod';
import {CartQuoteResponseSchema,type ShippingMethodRef} from '../../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {CheckoutDeliveryProblem,validateShippingQuote,type ShippingQuoteInput,type ShippingQuoteLine,type ShippingQuotePort} from '../../checkout/terms.js';
import type {StoreContext} from '../../checkout/authority.js';
import {currentItemShippingAttributes} from '../settings/attributes.js';
import {logisticsAvailability,type ShippingEnvironment} from '../settings/logistics.js';
import {currentShippingProfile,type ShippingDocument} from '../settings/profile.js';
import type {DeliveryMethod} from '../rules/index.js';
import {parseCartDelivery,parseCheckoutDelivery} from './delivery-input.js';
import {frozenFromPlan,optionResults,planFor,quoteLines,quotePlan,sellerProfile,unavailableFromPlan,unsupported,versionsBySku} from './ecpay.js';
import {meetupLines,meetupQuote} from './meetup.js';

const cartResult=z.object({delivery_options:CartQuoteResponseSchema.shape.delivery_options,shipping:CartQuoteResponseSchema.shape.shipping}).strict();
type StoreProfile=StoreContext['profile'];
type LogisticsOption=Extract<ShippingDocument['delivery_options'][number],{method:DeliveryMethod}>;
type MeetupOption=Extract<ShippingDocument['delivery_options'][number],{method:'meetup'}>;

function notConfigured():never {
  throw new CheckoutDeliveryProblem(409,'shipping_not_configured','尚未設定配送。');
}
function invalidDelivery(fields:readonly {path:string;code:'required'|'format'|'too_short'|'too_long'|'unknown_postal_code'|'blocked_term'}[]):never {
  throw new CheckoutDeliveryProblem(422,'delivery_invalid','配送資料有誤，請檢查標示的欄位。',fields);
}
function unavailable(lines:readonly {sku:string;reason:'fulfilment_not_agreed'|'shipping_attributes_missing'|'method_unsupported'|'temperature_unsupported'|'too_large'|'cvs_value_limit'|'outlying_unsupported'}[]):never {
  throw new CheckoutDeliveryProblem(422,'shipping_unavailable','部分商品無法用這個方式配送。',undefined,lines);
}
function logisticsOptions(options:ShippingDocument['delivery_options']):LogisticsOption[] {
  return options.filter((option):option is LogisticsOption=>option.method!=='meetup');
}
function meetupOption(options:ShippingDocument['delivery_options']):MeetupOption|undefined {
  return options.find((option):option is MeetupOption=>option.method==='meetup');
}
async function loadSeller(q:PoolClient,store:StoreProfile,environment:ShippingEnvironment) {
  const current=await currentShippingProfile(q,store.instance_id);
  if(!current||current.document.delivery_options.length===0)return null;
  const availability=await logisticsAvailability(q,{instanceId:store.instance_id,environment});
  const active=new Set(availability.logistics.filter(row=>row.state==='active').map(row=>row.service_key));
  return {version:current.version,document:current.document,services:current.document.services.filter(service=>active.has(service.service_key))};
}
function shippingView(raw:unknown,lines:readonly ShippingQuoteLine[]) {
  return validateShippingQuote(raw,lines);
}
function cartOption(method:ShippingMethodRef,available:boolean,total:number|null,parcels:number|null,freeOver:number|null,outlying:{kind:'excluded'}|{kind:'surcharge';surcharge_per_parcel_minor:number}|null,note:string|null,lines:readonly {sku:string;reason:string}[]) {
  return {method,available,shipping_total_minor:available?total:null,parcel_count:available?parcels:null,free_over_minor:freeOver,outlying,note,lines:available?[]:lines};
}

/** SQL-local hosted shipping quotes. Supplied lines stay `not_agreed` until agreements exist. */
export function createShippingQuotePort({environment}:{environment:ShippingEnvironment}):ShippingQuotePort {
  async function prepared(q:PoolClient,store:StoreProfile,input:ShippingQuoteInput) {
    const seller=await loadSeller(q,store,environment);
    if(!seller)return null;
    const attributes=await currentItemShippingAttributes(q,input.lines.map(line=>line.item_id));
    const lines=quoteLines(input.lines,attributes);
    const profile=sellerProfile(store.supply_shop_id,seller.version,seller.document.working_days,seller.services);
    const options=logisticsOptions(seller.document.delivery_options);
    return {seller,attributes,lines,profile,options,versions:versionsBySku(input.lines,attributes)};
  }
  function build(loaded:NonNullable<Awaited<ReturnType<typeof prepared>>>,input:ShippingQuoteInput,method:ShippingMethodRef,outlying:boolean) {
    if(method==='meetup') {
      const note=meetupOption(loaded.seller.document.delivery_options)?.note;
      if(!note)return {kind:'unavailable' as const,lines:unsupported(input.lines)};
      const meetup=meetupQuote({lines:meetupLines(input.lines),sellerShopId:loaded.profile.shop_id,profileVersion:loaded.seller.version,note});
      if(meetup.kind==='unavailable')return meetup;
      const shipping=shippingView({delivery_profile_version:loaded.seller.version,destination_state:'complete' as const,groups:[meetup.group]},input.lines);
      return {kind:'quoted' as const,shipping};
    }
    if(!loaded.options.some(option=>option.method===method))return {kind:'unavailable' as const,lines:unsupported(input.lines)};
    const planned=quotePlan(planFor({sellerShopId:loaded.profile.shop_id,profile:loaded.profile,options:loaded.options,lines:loaded.lines,merchandiseNetMinor:input.merchandise_net_minor,outlying}),method as DeliveryMethod);
    if(planned.kind==='unavailable')return {kind:'unavailable' as const,lines:unavailableFromPlan(planned)};
    const destination=method.startsWith('cvs:')?'store_required' as const:'complete' as const;
    return {kind:'quoted' as const,shipping:shippingView(frozenFromPlan(planned,loaded.versions,loaded.seller.version,destination),input.lines)};
  }
  function deliveryOptions(loaded:NonNullable<Awaited<ReturnType<typeof prepared>>>,input:ShippingQuoteInput) {
    const planned=optionResults(planFor({sellerShopId:loaded.profile.shop_id,profile:loaded.profile,options:loaded.options,lines:loaded.lines,merchandiseNetMinor:input.merchandise_net_minor,outlying:false}));
    return loaded.seller.document.delivery_options.map(option=>{
      if(option.method==='meetup') {
        const meetup=meetupQuote({lines:meetupLines(input.lines),sellerShopId:loaded.profile.shop_id,profileVersion:loaded.seller.version,note:option.note});
        const lines=meetup.kind==='unavailable'?meetup.lines:[];
        return cartOption('meetup',lines.length===0,0,1,null,null,option.note,lines);
      }
      const result=planned.get(option.method);
      if(!result||result.kind==='unavailable') {
        const lines=result?.kind==='unavailable'?unavailableFromPlan(result):unsupported(input.lines);
        return cartOption(option.method,false,null,null,option.free_over_minor,option.outlying,null,lines);
      }
      const parcels=result.groups.reduce((sum,group)=>sum+group.parcels.length,0);
      return cartOption(option.method,true,result.shipping_total_minor,parcels,option.free_over_minor,option.outlying,null,[]);
    });
  }
  return {
    async quote(q,store,input) {
      const loaded=await prepared(q,store,input);
      if(!loaded)notConfigured();
      const delivery=parseCheckoutDelivery(input.delivery);
      if(!delivery.ok)invalidDelivery(delivery.fields);
      const quoted=build(loaded,input,delivery.method,delivery.outlying);
      if(quoted.kind==='unavailable')unavailable(quoted.lines);
      return quoted.shipping;
    },
    async cart(q,store,input) {
      const loaded=await prepared(q,store,input);
      if(!loaded)return {delivery_options:[],shipping:{state:'not_configured' as const,groups:[],total_minor:null}};
      if(input.delivery!==null) {
        const delivery=parseCartDelivery(input.delivery);
        if(!delivery.ok)invalidDelivery(delivery.fields);
        const delivery_options=deliveryOptions(loaded,input);
        const quoted=build(loaded,input,delivery.method,delivery.outlying);
        const shipping=quoted.kind==='unavailable'
          ?{state:'unavailable' as const,method:delivery.method,groups:[],total_minor:null,lines:quoted.lines}
          :{state:'quoted' as const,method:delivery.method,groups:quoted.shipping.groups.map(group=>({group_ref:group.group_ref,amount_minor:group.amount_minor})),total_minor:quoted.shipping.groups.reduce((sum,group)=>sum+group.amount_minor,0)};
        const parsed=cartResult.safeParse({delivery_options,shipping});
        if(!parsed.success)throw new Error('shipping_quote_invalid');
        return parsed.data;
      }
      const delivery_options=deliveryOptions(loaded,input);
      const parsed=cartResult.safeParse({delivery_options,shipping:{state:'needs_delivery_data',groups:[],total_minor:null}});
      if(!parsed.success)throw new Error('shipping_quote_invalid');
      return parsed.data;
    },
  };
}

export {meetupQuote,type MeetupQuoteLine,type MeetupQuoteRequest} from './meetup.js';
