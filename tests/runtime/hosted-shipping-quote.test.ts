import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {after,before,describe,test} from 'node:test';
import {z} from 'zod';
import {CartQuoteResponseSchema,CheckoutErrorSchema,isCheckoutText} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {CheckoutDeliveryProblem,validateShippingQuote,type ShippingQuoteLine} from '../../modules/agent-commerce/checkout/terms.js';
import {lockStore} from '../../modules/agent-commerce/checkout/authority.js';
import {parseCartDelivery,parseCheckoutDelivery} from '../../modules/agent-commerce/fulfilment/quote/delivery-input.js';
import {createShippingQuotePort} from '../../modules/agent-commerce/fulfilment/quote/index.js';
import {meetupQuote,type MeetupQuoteLine} from '../../modules/agent-commerce/fulfilment/quote/meetup.js';
import {FulfilmentRuleError} from '../../modules/agent-commerce/fulfilment/rules/errors.js';
import {SERVICE_KEYS} from '../../modules/agent-commerce/fulfilment/rules/types.js';
import {syntheticShippingQuote} from '../../scripts/synthetic-shipping-quote.js';
import {shippingSettingsHarness,type ShippingSettingsHarness} from './module-registry-harness.js';

const SHOP_A='11111111-1111-4111-8111-111111111111';
const SHOP_B='22222222-2222-4222-8222-222222222222';
const FOREIGN='33333333-3333-4333-8333-333333333333';
const ITEM='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Line=ShippingQuoteLine;
type Frozen=ReturnType<typeof syntheticShippingQuote>;
const line=(sku:string,shop:string,own:boolean,price=100,quantity=1):Line=>({sku,item_id:ITEM,quantity,unit_price_minor:price,supplier_shop_id:shop,own});
const input=(lines:Line[])=>({lines,merchandise_net_minor:lines.reduce((sum,entry)=>sum+entry.unit_price_minor*entry.quantity,0)});
function agreementId(shop:string){
  const hex=createHash('sha256').update(`freedom.synthetic-shipping/agreement\n${shop}`).digest('hex').slice(0,32).split('');
  hex[12]='4';hex[16]='8';const raw=hex.join('');
  return `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
}
function invalidQuote(run:()=>unknown){
  assert.throws(run,(error:unknown)=>error instanceof Error&&error.message==='shipping_quote_invalid'&&!(error instanceof CheckoutDeliveryProblem));
}
function problem(fields:readonly {path:string;code:string}[]){
  return {type:'about:blank',title:'delivery_invalid',status:422,code:'delivery_invalid',detail:'配送資料有誤，請檢查標示的欄位。',fields};
}
const cartPortResult=z.object({delivery_options:CartQuoteResponseSchema.shape.delivery_options,shipping:CartQuoteResponseSchema.shape.shipping}).strict();
const homeBody={method:'home',name:'王小明',mobile:'0912345678',postal_code:'100',address:'合成測試路1號'};
const meetupBody={method:'meetup',name:'面交人',mobile:'0900000000'};

describe('shipping quote fixtures and delivery fields',()=>{
  test('synthetic groups own and supplied lines, and rejects supplied meetup',()=>{
    const lines=[line('B1',SHOP_B,true),line('A1',SHOP_A,true,200,2),line('A2',SHOP_A,false)];
    const first=syntheticShippingQuote(input(lines),{fee_per_parcel_minor:50,outlying_surcharge_per_parcel_minor:0});
    const second=syntheticShippingQuote(input([...lines].reverse()),{fee_per_parcel_minor:50});
    assert.deepEqual(second,first);
    assert.deepEqual(first.groups.map(group=>[group.group_ref,group.supplier_shop_id,group.fulfilment_mode,group.agreement]),[
      ['g1',SHOP_A,'drop_ship',{agreement_id:agreementId(SHOP_A),version:'1'}],
      ['g2',SHOP_A,'self',null],
      ['g3',SHOP_B,'self',null],
    ]);
    assert.deepEqual(first.groups[0].parcels[0].lines.map(entry=>entry.sku),['A2']);
    assert.notEqual(first.groups[0].fulfilment_mode,'self');
    const meetup=syntheticShippingQuote(input([line('P0001',SHOP_A,true)]),{method_ref:'meetup',fee_per_parcel_minor:50,outlying_surcharge_per_parcel_minor:50,destination_state:'store_required',meetup_note:'面交於店門口'});
    assert.equal(meetup.groups.length,1);
    assert.equal(meetup.destination_state,'complete');
    assert.equal(meetup.groups[0].fulfilment_mode,'self');
    assert.equal(meetup.groups[0].agreement,null);
    assert.equal(meetup.groups[0].fee_per_parcel_minor,0);
    assert.equal(meetup.groups[0].outlying_surcharge_per_parcel_minor,0);
    assert.equal(meetup.groups[0].amount_minor,0);
    assert.equal(meetup.groups[0].meetup?.note,'面交於店門口');
    assert.equal(meetup.groups[0].logistics,null);
    invalidQuote(()=>syntheticShippingQuote(input([line('P0002',SHOP_A,false)]),{method_ref:'meetup'}));
    invalidQuote(()=>syntheticShippingQuote(input([line('P0001',SHOP_A,true),line('P0002',SHOP_B,false)]),{method_ref:'meetup'}));
  });

  test('meetupQuote rejects drop-ship and not-agreed lines without building a group',()=>{
    const base=(fulfilment:MeetupQuoteLine['fulfilment'],sku='P0001'):MeetupQuoteLine=>({sku,quantity:1,unit_price_minor:100,supplier_shop_id:SHOP_A,fulfilment});
    const dropped=meetupQuote({lines:[base({kind:'self'},'B'),base({kind:'drop_ship'},'A')],sellerShopId:SHOP_A,profileVersion:'1',note:'面交'});
    assert.equal(dropped.kind,'unavailable');
    if(dropped.kind==='unavailable')assert.deepEqual(dropped.lines,[{sku:'A',reason:'method_unsupported'}]);
    const agreed=meetupQuote({lines:[base({kind:'not_agreed'})],sellerShopId:SHOP_A,profileVersion:'1',note:'面交'});
    assert.equal(agreed.kind,'unavailable');
    if(agreed.kind==='unavailable')assert.deepEqual(agreed.lines,[{sku:'P0001',reason:'fulfilment_not_agreed'}]);
    invalidQuote(()=>meetupQuote({lines:[],sellerShopId:SHOP_A,profileVersion:'1',note:'面交'}));
  });

  test('validateShippingQuote rejects each broken invariant',()=>{
    const sameLines=[line('P0002',SHOP_A,true),line('P0001',SHOP_A,true,200,2)];
    const same=syntheticShippingQuote(input(sameLines),{fee_per_parcel_minor:100});
    const twoLines=[line('B',SHOP_B,true),line('A',SHOP_A,true)];
    const two=syntheticShippingQuote(input(twoLines),{fee_per_parcel_minor:100});
    const supplied=syntheticShippingQuote(input([line('S',SHOP_B,false)]),{fee_per_parcel_minor:100});
    const meetup=syntheticShippingQuote(input([line('P0001',SHOP_A,true)]),{method_ref:'meetup'});
    const breakQuote=(quote:Frozen,lines:Line[],mutate:(copy:Frozen,copiedLines:Line[])=>void)=>invalidQuote(()=>{
      const copy=structuredClone(quote),copiedLines=structuredClone(lines);mutate(copy,copiedLines);validateShippingQuote(copy,copiedLines);
    });
    breakQuote(same,sameLines,(copy)=>{copy.groups[0].group_ref='g2';});
    breakQuote(same,sameLines,(copy)=>{copy.groups[0].parcels[0].parcel_ref='g1-p2';});
    breakQuote(two,twoLines,(copy)=>{copy.groups[1].method_ref='cvs:UNIMARTC2C';});
    breakQuote(meetup,[line('P0001',SHOP_A,true)],(copy)=>{copy.groups[0].logistics=structuredClone(same.groups[0].logistics);});
    breakQuote(meetup,[line('P0001',SHOP_A,true)],(copy)=>{copy.groups[0].fee_per_parcel_minor=100;copy.groups[0].amount_minor=100;});
    breakQuote(meetup,[line('P0001',SHOP_A,true)],(copy)=>{copy.groups[0].parcels.push(structuredClone(copy.groups[0].parcels[0]));copy.groups[0].parcels[1].parcel_ref='g1-p2';});
    breakQuote(meetup,[line('P0001',SHOP_A,true)],(copy)=>{copy.groups[0].attribute_versions=[{sku:'P0001',version:'1'}];});
    breakQuote(supplied,[line('S',SHOP_B,false)],(copy)=>{copy.groups[0].agreement=null;});
    breakQuote(same,sameLines,(copy)=>{copy.groups[0].agreement=supplied.groups[0].agreement;});
    breakQuote(same,sameLines.map(entry=>({...entry,own:false})),(copy)=>void copy);
    breakQuote(same,sameLines,(copy)=>{copy.groups[0].parcels[0].lines.splice(0,1);copy.groups[0].parcels[0].declared_value_minor=400;copy.groups[0].attribute_versions.splice(0,1);});
    breakQuote(same,sameLines,(copy)=>{copy.groups[0].parcels[0].lines.push({sku:'NOPE',quantity:1});});
    breakQuote(same,sameLines,(copy)=>{const part=copy.groups[0].parcels[0].lines.find(entry=>entry.sku==='P0001')!;part.quantity=1;copy.groups[0].parcels[0].declared_value_minor=300;});
    breakQuote(same,sameLines,(copy)=>{copy.groups[0].supplier_shop_id=SHOP_B;});
    breakQuote(same,sameLines,(copy)=>{const versions=copy.groups[0].attribute_versions;versions.reverse();});
    breakQuote(same,sameLines,(copy)=>{copy.groups[0].attribute_versions=[{sku:'P0002',version:'1'},{sku:'P0002',version:'1'}];});
    breakQuote(same,sameLines,(copy)=>{copy.groups[0].parcels[0].declared_value_minor+=1;});
    breakQuote(same,sameLines,(copy)=>{copy.groups[0].amount_minor+=1;});
    breakQuote(same,sameLines,(copy)=>{copy.destination_state='store_required';});
    const split=structuredClone(same);
    const [first,second]=split.groups[0].parcels[0].lines;
    split.groups[0].parcels=[{parcel_ref:'g1-p1',lines:[first],weight_g:100,declared_value_minor:first.sku==='P0001'?400:100},{parcel_ref:'g1-p2',lines:[second],weight_g:100,declared_value_minor:second.sku==='P0001'?400:100}];
    split.groups[0].amount_minor=200;
    assert.equal(validateShippingQuote(split,sameLines).groups[0].parcels.length,2);
    invalidQuote(()=>{const swapped=structuredClone(split);swapped.groups[0].parcels[0].parcel_ref='g1-p2';swapped.groups[0].parcels[1].parcel_ref='g1-p1';validateShippingQuote(swapped,sameLines);});
  });

  test('astral meetup names pass and unsafe delivery keys stay schema-valid',()=>{
    assert.equal(isCheckoutText('𠮷野'),true);
    assert.equal(isCheckoutText('\uD800'),false);
    assert.deepEqual(parseCheckoutDelivery({method:'meetup',name:'𠮷野',mobile:'0900000000'}),{ok:true,method:'meetup',outlying:false});
    assert.equal(parseCheckoutDelivery({method:'meetup',name:'𠮷'.repeat(20),mobile:'0900000000'}).ok,true);
    assert.deepEqual(parseCheckoutDelivery({method:'meetup',name:'𠮷'.repeat(21),mobile:'0900000000'}),{ok:false,fields:[{path:'delivery.name',code:'too_long'}]});
    assert.equal(parseCheckoutDelivery({method:'meetup',name:'面'.repeat(40),mobile:'0900000000'}).ok,true);
    assert.deepEqual(parseCheckoutDelivery({method:'meetup',name:'面'.repeat(41),mobile:'0900000000'}),{ok:false,fields:[{path:'delivery.name',code:'too_long'}]});
    for(const name of ['面\u007F交','面\n交','面\u0085交','\uD800']){
      const parsed=parseCheckoutDelivery({method:'meetup',name,mobile:'0900000000'});
      assert.deepEqual(parsed,{ok:false,fields:[{path:'delivery.name',code:'format'}]},JSON.stringify(name));
    }
    assert.deepEqual(parseCheckoutDelivery({method:'meetup',name:'   ',mobile:'0900000000'}),{ok:false,fields:[{path:'delivery.name',code:'required'}]});
    const echo=parseCheckoutDelivery({...homeBody,name:'Echo'});
    assert.equal(echo.ok,false);
    if(!echo.ok){assert.equal(echo.fields.find(field=>field.path==='delivery.name')?.code,'blocked_term');assert.equal(JSON.stringify(echo).includes('Echo'),false);}
    const meetupEcho=parseCheckoutDelivery({...meetupBody,name:'Echo'});
    assert.deepEqual(meetupEcho,{ok:true,method:'meetup',outlying:false});
    const cases:Record<string,unknown>[]=[
      {method:'home',姓名:'sentinel-unicode'},
      {method:'home',['a'.repeat(200)]:'sentinel-long'},
      {method:'home','store-id':'sentinel-punct'},
      {method:'home','':'sentinel-empty'},
      {method:'cvs:UNIMARTC2C',store_id:'sentinel-store'},
      {method:'home',['a'.repeat(71)]:'sentinel-edge'},
      {method:'home',['a'.repeat(72)]:'sentinel-over'},
    ];
    for(const raw of cases){
      for(const parsed of [parseCartDelivery(raw),parseCheckoutDelivery(raw.method==='home'?{...homeBody,...raw}:raw.method==='cvs:UNIMARTC2C'?{...meetupBody,method:raw.method,...raw}:raw)]){
        assert.equal(parsed.ok,false);
        if(parsed.ok)continue;
        const json=JSON.stringify(parsed);
        assert.equal(CheckoutErrorSchema.safeParse(problem(parsed.fields)).success,true,json);
        for(const value of Object.values(raw))if(typeof value==='string'&&value.startsWith('sentinel'))assert.equal(json.includes(value),false,json);
        const unsafe=Object.keys(raw).find(key=>key!=='method'&&key!=='store_id'&&key.length!==71);
        if(unsafe)assert.equal(json.includes(unsafe),false,json);
      }
    }
    const representable=parseCartDelivery({method:'home',store_id:'sentinel-store'});
    assert.equal(representable.ok,false);
    if(!representable.ok)assert.deepEqual(representable.fields,[{path:'delivery.store_id',code:'format'}]);
    const edge=parseCartDelivery({method:'cvs:UNIMARTC2C',['a'.repeat(71)]:'x'});
    assert.equal(edge.ok,false);
    if(!edge.ok)assert.equal(edge.fields[0].path,`delivery.${'a'.repeat(71)}`);
    const keys=Array.from({length:20},(_,index)=>`field_${index}`);
    const capped=parseCartDelivery({method:'cvs:UNIMARTC2C',...Object.fromEntries(keys.map(key=>[key,'v'])),姓名:'secret-cap'});
    assert.equal(capped.ok,false);
    if(!capped.ok){
      assert.equal(capped.fields.length,20);
      assert.equal(capped.fields.some(field=>field.path==='delivery'),true);
      assert.equal(capped.fields.some(field=>field.path==='delivery.field_19'),false);
      assert.equal(JSON.stringify(capped).includes('姓名')||JSON.stringify(capped).includes('secret-cap'),false);
      assert.equal(CheckoutErrorSchema.safeParse(problem(capped.fields)).success,true);
    }
    assert.deepEqual(parseCheckoutDelivery({method:'drone',name:1}),{ok:false,fields:[{path:'delivery.method',code:'format'}]});
  });
});

describe('sql-local shipping quote port',()=>{
  let h:ShippingSettingsHarness;
  let store:Awaited<ReturnType<ShippingSettingsHarness['f']['x']['store']>>;
  let bare:Awaited<ReturnType<ShippingSettingsHarness['f']['x']['store']>>;
  let products:{sku:string;product_id:string}[];
  let logisticsAccountId:string;
  const port=createShippingQuotePort({environment:'sandbox'});
  const home={method:'home' as const,name:'王小明',mobile:'0912345678',postal_code:'100',address:'合成測試路1號'};
  before(async()=>{
    h=await shippingSettingsHarness('fp_ship_quote');
    await h.reset();
    store=await h.f.x.store(50);
    await h.f.setup(store);
    const extra=[await h.request(store,'POST','/products',{title:'合成商品乙',price_minor:100,stock:50}),await h.request(store,'POST','/products',{title:'合成商品丙',price_minor:100,stock:50})];
    for(const created of extra)assert.equal(created.status,201,JSON.stringify(created.data));
    const current=h.expect(await h.request(store,'GET',''));
    h.expect(await h.request(store,'POST','/publish',{},current.version));
    products=[store.product,extra[0].data,extra[1].data].map(product=>({sku:product.sku as string,product_id:product.product_id as string}));
    const locationId=h.expect(await h.request(store,'POST','/ship-from-locations',h.locationInput()),201).location_id as string;
    const service=(key:typeof SERVICE_KEYS[number],outlying:'allowed'|'excluded')=>({service_key:key,ship_from_location_id:locationId,temperature:'ambient' as const,handling_days:1,cutoff_time:'17:00',limits:{max_weight_g:1000,max_longest_side_mm:1000,max_dimension_sum_mm:3000},outlying_islands:outlying});
    logisticsAccountId=(await h.provider(store,[SERVICE_KEYS[0],SERVICE_KEYS[1],SERVICE_KEYS[2],SERVICE_KEYS[3]],true)).account_id as string;
    const option=(method:'home'|'cvs:UNIMARTC2C'|'cvs:FAMIC2C')=>({method,fee_per_parcel_minor:10000,free_over_minor:null,outlying:method==='home'?{kind:'surcharge' as const,surcharge_per_parcel_minor:2000}:{kind:'excluded' as const}});
    const document={...h.document(),services:[service(SERVICE_KEYS[0],'allowed'),service(SERVICE_KEYS[1],'excluded'),service(SERVICE_KEYS[2],'excluded'),service(SERVICE_KEYS[3],'excluded')],delivery_options:[option('home'),option('cvs:UNIMARTC2C'),option('cvs:FAMIC2C'),{method:'meetup' as const,note:'面交於店門口'}]};
    h.expect(await h.request(store,'PUT','/shipping-profile',document),201);
    for(const product of products.slice(0,2))h.expect(await h.request(store,'PUT',`/products/${product.product_id}/shipping-attributes`,h.attributes()),201);
    bare=await h.f.x.store(10);
    await h.f.setup(bare);
    h.f.install({commercePorts:{shipping:port}});
  });
  after(async()=>{await h?.stop();});
  async function quoted(target:typeof store,delivery:Record<string,unknown>,entries:Line[]){
    return h.f.x.tx(async q=>{
      const context=await lockStore(q,{storefront_shop_id:target.storefront_shop_id},[...new Set(entries.map(entry=>entry.sku))]);
      return port.quote(q,context.profile,{lines:entries,merchandise_net_minor:entries.reduce((sum,entry)=>sum+entry.unit_price_minor*entry.quantity,0),delivery}) as Promise<Frozen>;
    });
  }
  function own(product:{sku:string;product_id:string},price=100,quantity=1):Line{
    return {sku:product.sku,item_id:product.product_id,quantity,unit_price_minor:price,supplier_shop_id:store.supply_shop_id,own:true};
  }
  async function putAttributes(productId:string,body:Omit<ReturnType<ShippingSettingsHarness['attributes']>,'temperature'>&{temperature:'ambient'|'chilled'|'frozen'}){
    const current=h.expect(await h.request(store,'GET',`/products/${productId}/shipping-attributes`));
    h.expect(await h.request(store,'PUT',`/products/${productId}/shipping-attributes`,body,current.version??undefined));
  }
  async function putProfile(mutate:(document:Record<string,unknown>)=>void){
    const current=h.expect(await h.request(store,'GET','/shipping-profile'));
    const document=structuredClone(current.profile) as Record<string,unknown>;
    mutate(document);
    h.expect(await h.request(store,'PUT','/shipping-profile',document,current.version));
    return current;
  }

  test('unconfigured quotes ignore delivery and configured quotes freeze the plan',async()=>{
    const garbage={method:'nope',姓名:'不該出現'};
    await assert.rejects(quoted(bare,garbage,[own(products[0])]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.status===409&&error.code==='shipping_not_configured');
    const cart=await h.f.x.tx(async q=>{
      const context=await lockStore(q,{storefront_shop_id:bare.storefront_shop_id},[products[0].sku]);
      return port.cart!(q,context.profile,{lines:[own(products[0])],merchandise_net_minor:100,delivery:garbage});
    });
    assert.deepEqual(cart,{delivery_options:[],shipping:{state:'not_configured',groups:[],total_minor:null}});
    assert.equal(JSON.stringify(cart).includes('姓名'),false);
    const empty=structuredClone(h.document());
    h.expect(await h.request(bare,'PUT','/shipping-profile',empty),201);
    await assert.rejects(quoted(bare,home,[own(products[0])]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.code==='shipping_not_configured');
    const saved=await quoted(store,home,[own(products[0],100,5)]);
    assert.equal(saved.destination_state,'complete');
    assert.equal(saved.delivery_profile_version,'1');
    assert.equal(saved.groups.length,1);
    const group=saved.groups[0];
    assert.equal(group.group_ref,'g1');
    assert.equal(group.supplier_shop_id,store.supply_shop_id);
    assert.equal(group.fulfilment_mode,'self');
    assert.equal(group.agreement,null);
    assert.equal(group.profile_version,'1');
    assert.equal(group.method_ref,'home');
    assert.equal(group.logistics?.service_key,'ecpay.logistics.home.tcat');
    assert.equal(group.parcels.length,1);
    assert.equal(group.parcels[0].parcel_ref,'g1-p1');
    assert.equal(group.fee_per_parcel_minor,10000);
    assert.equal(group.outlying_surcharge_per_parcel_minor,0);
    assert.equal(group.amount_minor,10000);
    assert.deepEqual(group.attribute_versions,[{sku:products[0].sku,version:'1'}]);
    const reversed=await quoted(store,home,[own(products[1]),own(products[0])]);
    const forward=await quoted(store,home,[own(products[0]),own(products[1])]);
    assert.deepEqual(reversed,forward);
    assert.deepEqual(forward.groups[0].parcels[0].lines.map(entry=>entry.sku),[products[0].sku,products[1].sku]);
    const island=await quoted(store,{...home,postal_code:'880'},[own(products[0])]);
    assert.equal(island.groups[0].outlying_surcharge_per_parcel_minor,2000);
    assert.equal(island.groups[0].amount_minor,12000);
    const options=cartPortResult.parse(await h.f.x.tx(async q=>{
      const context=await lockStore(q,{storefront_shop_id:store.storefront_shop_id},[products[0].sku]);
      return port.cart!(q,context.profile,{lines:[own(products[0])],merchandise_net_minor:100,delivery:{method:'home',postal_code:'880'}});
    }));
    assert.deepEqual(options.delivery_options.map(option=>option.method),['home','cvs:UNIMARTC2C','cvs:FAMIC2C','meetup']);
    assert.equal(options.delivery_options[0].shipping_total_minor,10000);
    assert.equal(options.delivery_options[0].outlying?.kind,'surcharge');
    assert.equal(options.delivery_options[3].note,'面交於店門口');
    assert.equal(options.delivery_options[3].free_over_minor,null);
    assert.equal(options.delivery_options[3].outlying,null);
    assert.equal(options.delivery_options[3].shipping_total_minor,0);
    assert.equal(options.shipping.state,'quoted');
    if(options.shipping.state==='quoted')assert.equal(options.shipping.total_minor,12000);
    const meetup=await quoted(store,meetupBody,[own(products[2])]);
    assert.equal(meetup.groups[0].method_ref,'meetup');
    assert.equal(meetup.groups[0].amount_minor,0);
    assert.equal(meetup.groups[0].logistics,null);
    assert.deepEqual(meetup.groups[0].attribute_versions,[]);
    assert.equal(meetup.groups[0].meetup?.note,'面交於店門口');
    assert.equal(meetup.destination_state,'complete');
  });

  test('availability, free shipping, CVS and supplied lines',async()=>{
    const product=products[0];
    const missing=await assert.rejects(quoted(store,home,[own(products[2])]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.code==='shipping_unavailable'&&error.lines?.[0].reason==='shipping_attributes_missing');
    assert.equal(missing,undefined);
    const supplied:Line={...own(product),own:false,supplier_shop_id:FOREIGN};
    for(const delivery of [home,meetupBody]){
      await assert.rejects(quoted(store,delivery,[supplied]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.code==='shipping_unavailable'&&error.lines?.[0].reason==='fulfilment_not_agreed');
    }
    await assert.rejects(quoted(store,{method:'cvs:HILIFEC2C',name:'王小明',mobile:'0912345678'},[supplied]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.lines?.[0].reason==='method_unsupported');
    await assert.rejects(quoted(store,meetupBody,[{...own(product),supplier_shop_id:FOREIGN}]),(error:unknown)=>error instanceof Error&&error.message==='shipping_quote_invalid'&&!(error instanceof CheckoutDeliveryProblem));
    await assert.rejects(h.f.x.tx(async q=>{
      const context=await lockStore(q,{storefront_shop_id:store.storefront_shop_id},[product.sku]);
      return port.quote(q,context.profile,{lines:[own(product)],merchandise_net_minor:1.5,delivery:home});
    }),(error:unknown)=>error instanceof FulfilmentRuleError);
    const original=await putProfile(document=>{
      const options=document.delivery_options as {method:string;free_over_minor:number|null}[];
      options[0].free_over_minor=500;
    });
    try {
      const free=await quoted(store,home,[own(product,100,5)]);
      assert.equal(free.groups[0].fee_per_parcel_minor,0);
      assert.equal(free.groups[0].amount_minor,0);
      const surcharge=await quoted(store,{...home,postal_code:'880'},[own(product,100,5)]);
      assert.equal(surcharge.groups[0].fee_per_parcel_minor,0);
      assert.equal(surcharge.groups[0].outlying_surcharge_per_parcel_minor,2000);
      assert.equal(surcharge.groups[0].amount_minor,2000);
    } finally {
      h.expect(await h.request(store,'PUT','/shipping-profile',original.profile,h.expect(await h.request(store,'GET','/shipping-profile')).version));
    }
    const excluded=await putProfile(document=>{
      (document.delivery_options as {method:string;outlying:{kind:string}}[])[0].outlying={kind:'excluded'};
    });
    try {
      await assert.rejects(quoted(store,{...home,postal_code:'880'},[own(product)]), (error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.lines?.[0].reason==='outlying_unsupported');
    } finally {
      h.expect(await h.request(store,'PUT','/shipping-profile',excluded.profile,h.expect(await h.request(store,'GET','/shipping-profile')).version));
    }
    const path=`/products/${product.product_id}/shipping-attributes`;
    const base=h.attributes();
    await putAttributes(product.product_id,{...base,temperature:'chilled'});
    try {await assert.rejects(quoted(store,home,[own(product)]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.lines?.[0].reason==='temperature_unsupported');}
    finally {await putAttributes(product.product_id,base);}
    await putAttributes(product.product_id,{...base,weight_g:5000});
    try {await assert.rejects(quoted(store,home,[own(product)]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.lines?.[0].reason==='too_large');}
    finally {await putAttributes(product.product_id,base);}
    await putAttributes(product.product_id,{...base,cvs_allowed:false});
    try {
      await assert.rejects(quoted(store,{method:'cvs:UNIMARTC2C',name:'王小明',mobile:'0912345678'},[own(product)]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.lines?.[0].reason==='method_unsupported');
      assert.equal((await quoted(store,home,[own(product)])).groups[0].method_ref,'home');
    } finally {await putAttributes(product.product_id,base);}
    await assert.rejects(quoted(store,{method:'cvs:UNIMARTC2C',name:'王小明',mobile:'0912345678'},[own(product,2_000_001)]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.lines?.[0].reason==='cvs_value_limit');
    const capped=await quoted(store,{method:'cvs:UNIMARTC2C',name:'王小明',mobile:'0912345678'},[own(product,2_000_000)]);
    assert.equal(capped.destination_state,'store_required');
    assert.equal(capped.groups[0].method_ref,'cvs:UNIMARTC2C');
    assert.equal(capped.groups[0].logistics?.service_key,'ecpay.logistics.cvs.unimartc2c');
    const fami=await quoted(store,{method:'cvs:FAMIC2C',name:'王小明',mobile:'0912345678'},[own(product)]);
    assert.equal(fami.groups[0].method_ref,'cvs:FAMIC2C');
    assert.equal(fami.groups[0].logistics?.service_key,'ecpay.logistics.cvs.famic2c');
    assert.equal(fami.groups.length,1);
    const accounts=h.expect(await h.request(store,'GET','/provider-accounts')).items as {account_id:string;version:string}[];
    let account=accounts.find(entry=>entry.account_id===logisticsAccountId)!;
    assert.ok(account);
    account=h.expect(await h.request(store,'POST',`/provider-accounts/${account.account_id}/logistics-services/${SERVICE_KEYS[0]}/suspend`,{fresh_auth_verification_id:await h.fresh(store)},account.version));
    try {assert.equal((await quoted(store,home,[own(product)])).groups[0].logistics?.service_key,'ecpay.logistics.home.post');}
    finally {account=h.expect(await h.request(store,'POST',`/provider-accounts/${account.account_id}/logistics-services/${SERVICE_KEYS[0]}/resume`,{fresh_auth_verification_id:await h.fresh(store)},account.version));}
    account=h.expect(await h.request(store,'POST',`/provider-accounts/${account.account_id}/services/logistics/suspend`,{fresh_auth_verification_id:await h.fresh(store)},account.version));
    try {await assert.rejects(quoted(store,home,[own(product)]),(error:unknown)=>error instanceof CheckoutDeliveryProblem&&error.lines?.[0].reason==='method_unsupported');}
    finally {await h.request(store,'POST',`/provider-accounts/${account.account_id}/services/logistics/resume`,{fresh_auth_verification_id:await h.fresh(store)},account.version);}
    const badCart=await h.f.x.tx(async q=>{
      const context=await lockStore(q,{storefront_shop_id:store.storefront_shop_id},[product.sku]);
      return port.cart!(q,context.profile,{lines:[own(product)],merchandise_net_minor:100,delivery:{method:'home',姓名:'不該出現'}}).then(()=>null,(error:unknown)=>error);
    });
    assert.equal(badCart instanceof CheckoutDeliveryProblem&&badCart.code==='delivery_invalid'&&badCart.fields?.[0].path==='delivery',true);
    if(badCart instanceof CheckoutDeliveryProblem){
      assert.equal(CheckoutErrorSchema.safeParse(problem(badCart.fields??[])).success,true);
      assert.equal(JSON.stringify(badCart.fields).includes('姓名'),false);
      assert.equal(JSON.stringify(badCart.fields).includes('不該出現'),false);
    }
  });
});
