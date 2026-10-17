import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,describe,test} from 'node:test';
import {CartQuoteResponseSchema,CheckoutErrorSchema,CheckoutResponseSchema} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {hashJSON} from '../../modules/agent-commerce/checkout/terms.js';
import {createShippingQuotePort} from '../../modules/agent-commerce/fulfilment/quote/index.js';
import {SERVICE_KEYS} from '../../modules/agent-commerce/fulfilment/rules/types.js';
import {shippingSettingsHarness,type ShippingSettingsHarness} from './module-registry-harness.js';

describe('hosted shipping quote over HTTP',()=>{
  let h:ShippingSettingsHarness;
  let store:Awaited<ReturnType<ShippingSettingsHarness['f']['x']['store']>>;
  let revision:string;
  let skus:{main:string;second:string;bare:string};
  let productId:string;
  let logisticsAccountId:string;
  let octet=1;
  const home={method:'home',name:'王小明',mobile:'0912345678',postal_code:'100',address:'合成測試路1號'};
  before(async()=>{
    h=await shippingSettingsHarness('fp_ship_quote_http');
    await h.reset();
    store=await h.f.x.store(50);
    await h.f.setup(store);
    const second=h.expect(await h.request(store,'POST','/products',{title:'合成商品乙',price_minor:100,stock:50}),201);
    const bare=h.expect(await h.request(store,'POST','/products',{title:'合成商品丙',price_minor:100,stock:50}),201);
    const current=h.expect(await h.request(store,'GET',''));
    h.expect(await h.request(store,'POST','/publish',{},current.version));
    revision=h.expect(await h.request(store,'GET','')).publication.current_revision as string;
    assert.equal(typeof revision,'string');
    skus={main:store.product.sku,second:second.sku,bare:bare.sku};
    productId=store.product.product_id;
    const locationId=h.expect(await h.request(store,'POST','/ship-from-locations',h.locationInput()),201).location_id as string;
    const service=(key:typeof SERVICE_KEYS[number],outlying:'allowed'|'excluded')=>({service_key:key,ship_from_location_id:locationId,temperature:'ambient' as const,handling_days:1,cutoff_time:'17:00',limits:{max_weight_g:1000,max_longest_side_mm:1000,max_dimension_sum_mm:3000},outlying_islands:outlying});
    logisticsAccountId=(await h.provider(store,[SERVICE_KEYS[0],SERVICE_KEYS[1],SERVICE_KEYS[2],SERVICE_KEYS[3]],true)).account_id as string;
    const option=(method:'home'|'cvs:UNIMARTC2C'|'cvs:FAMIC2C')=>({method,fee_per_parcel_minor:10000,free_over_minor:null,outlying:method==='home'?{kind:'surcharge' as const,surcharge_per_parcel_minor:2000}:{kind:'excluded' as const}});
    h.expect(await h.request(store,'PUT','/shipping-profile',{...h.document(),services:[service(SERVICE_KEYS[0],'allowed'),service(SERVICE_KEYS[1],'excluded'),service(SERVICE_KEYS[2],'excluded'),service(SERVICE_KEYS[3],'excluded')],delivery_options:[option('home'),option('cvs:UNIMARTC2C'),option('cvs:FAMIC2C'),{method:'meetup',note:'面交於店門口'}]}),201);
    h.expect(await h.request(store,'PUT',`/products/${productId}/shipping-attributes`,h.attributes()),201);
    h.expect(await h.request(store,'PUT',`/products/${second.product_id}/shipping-attributes`,h.attributes()),201);
    h.f.install({commercePorts:{shipping:createShippingQuotePort({environment:'sandbox'})}});
  });
  after(async()=>{await h?.stop();});
  function network(){const value=`198.51.100.${octet}`;octet=octet===250?1:octet+1;return value;}
  async function post(suffix:string,body:unknown,cookie?:string){
    return h.f.http('POST',h.f.root(store)+suffix,body,cookie,{'Idempotency-Key':randomUUID(),'CF-Connecting-IP':network()});
  }
  function checkoutBody(delivery:unknown,sku=skus.main,quantity=5,email=`buyer-${randomUUID()}@example.test`){
    return {publication_revision:revision,lines:[{sku,quantity}],contact:{name:'測試買家甲',email,phone:'0900000000'},delivery,invoice:null,consents:[]};
  }
  function hidden(response:unknown,...secrets:string[]){
    const json=JSON.stringify(response);
    for(const secret of secrets)assert.equal(json.includes(secret),false,secret);
  }

  test('unsafe and invalid delivery fields are 422 and do not echo caller data',async()=>{
    const cases:{delivery:Record<string,unknown>;fields:{path:string;code:string}[];secrets:string[]}[]=[
      {delivery:{...home,name:undefined},fields:[{path:'delivery.name',code:'required'}],secrets:[]},
      {delivery:{...home,name:15},fields:[{path:'delivery.name',code:'format'}],secrets:[]},
      {delivery:{...home,name:'王'},fields:[{path:'delivery.name',code:'too_short'}],secrets:[]},
      {delivery:{...home,name:'王'.repeat(6)},fields:[{path:'delivery.name',code:'too_long'}],secrets:[]},
      {delivery:{...home,name:'Echo'},fields:[{path:'delivery.name',code:'blocked_term'}],secrets:['Echo']},
      {delivery:{...home,mobile:undefined},fields:[{path:'delivery.mobile',code:'required'}],secrets:[]},
      {delivery:{...home,mobile:'091234567'},fields:[{path:'delivery.mobile',code:'format'}],secrets:['091234567']},
      {delivery:{...home,postal_code:undefined},fields:[{path:'delivery.postal_code',code:'required'}],secrets:[]},
      {delivery:{...home,postal_code:'12'},fields:[{path:'delivery.postal_code',code:'format'}],secrets:[]},
      {delivery:{...home,postal_code:'999'},fields:[{path:'delivery.postal_code',code:'unknown_postal_code'}],secrets:['999']},
      {delivery:{...home,postal_code:'12345678901'},fields:[{path:'delivery.postal_code',code:'too_long'}],secrets:['12345678901']},
      {delivery:{...home,address:undefined},fields:[{path:'delivery.address',code:'required'}],secrets:[]},
      {delivery:{...home,address:'短地址'},fields:[{path:'delivery.address',code:'too_short'}],secrets:['短地址']},
      {delivery:{...home,address:'合成測試<>路1號'},fields:[{path:'delivery.address',code:'format'}],secrets:['合成測試<>路1號']},
      {delivery:{...home,address:'echo street'},fields:[{path:'delivery.address',code:'blocked_term'}],secrets:['echo street']},
      {delivery:{...home,address:'路'.repeat(61)},fields:[{path:'delivery.address',code:'too_long'}],secrets:['路'.repeat(61)]},
      {delivery:{...home,bonus:'sentinel-bonus'},fields:[{path:'delivery.bonus',code:'format'}],secrets:['sentinel-bonus']},
      {delivery:{method:'drone',name:15},fields:[{path:'delivery.method',code:'format'}],secrets:[]},
      {delivery:{method:'cvs:UNIMARTC2C',name:'王小明',mobile:'0912345678',store_id:'STORE12345'},fields:[{path:'delivery.store_id',code:'format'}],secrets:['STORE12345']},
      {delivery:{method:'meetup',name:'面\n交',mobile:'0900000000'},fields:[{path:'delivery.name',code:'format'}],secrets:[]},
      {delivery:{method:'meetup',name:'面'.repeat(41),mobile:'0900000000'},fields:[{path:'delivery.name',code:'too_long'}],secrets:[]},
      {delivery:{method:'meetup',name:'面\u007F交',mobile:'0900000000'},fields:[{path:'delivery.name',code:'format'}],secrets:[]},
      {delivery:{...home,姓名:'sentinel-unicode'},fields:[{path:'delivery',code:'format'}],secrets:['姓名','sentinel-unicode']},
      {delivery:{...home,['k'.repeat(200)]:'sentinel-long-key'},fields:[{path:'delivery',code:'format'}],secrets:['k'.repeat(200),'sentinel-long-key']},
      {delivery:{...home,'store-id':'sentinel-punct'},fields:[{path:'delivery',code:'format'}],secrets:['store-id','sentinel-punct']},
      {delivery:{...home,store_id:'sentinel-representable'},fields:[{path:'delivery.store_id',code:'format'}],secrets:['sentinel-representable']},
    ];
    for(const item of cases){
      const delivery=Object.fromEntries(Object.entries(item.delivery).filter(([,value])=>value!==undefined));
      const response=await post('/checkouts',checkoutBody(delivery));
      assert.equal(response.status,422,JSON.stringify(response.data));
      assert.equal(response.data.code,'delivery_invalid');
      assert.equal(response.data.detail,'配送資料有誤，請檢查標示的欄位。');
      assert.deepEqual(response.data.fields,item.fields);
      assert.equal(CheckoutErrorSchema.safeParse(response.data).success,true,JSON.stringify(response.data));
      hidden(response.data,...item.secrets);
      assert.equal(response.response.headers.get('Cache-Control'),'no-store');
    }
    const both=await post('/checkouts',checkoutBody({method:'home',mobile:'0912345678',postal_code:'12',address:'合成測試路1號'}));
    assert.equal(both.status,422,JSON.stringify(both.data));
    assert.deepEqual(both.data.fields,[{path:'delivery.name',code:'required'},{path:'delivery.postal_code',code:'format'}]);
    const lone=await post('/checkouts',checkoutBody({...home,name:'\uD800'}));
    assert.equal(lone.status,422,JSON.stringify(lone.data));
    assert.equal(lone.data.code,'validation_failed');
    assert.notEqual(lone.status,500);
    hidden(lone.data,'\uD800');
    const astral=await post('/checkouts',checkoutBody({method:'meetup',name:'𠮷野',mobile:'0900000000'}));
    assert.equal(astral.status,201,JSON.stringify(astral.data));
    CheckoutResponseSchema.parse(astral.data);
    assert.equal(astral.data.terms.shipping.groups[0].method,'meetup');
    assert.equal(astral.data.terms.shipping.groups[0].meetup_note,'面交於店門口');
    const unavailable=await post('/checkouts',checkoutBody(home,skus.bare));
    assert.equal(unavailable.status,422,JSON.stringify(unavailable.data));
    assert.equal(unavailable.data.code,'shipping_unavailable');
    assert.deepEqual(unavailable.data.lines,[{sku:skus.bare,reason:'shipping_attributes_missing'}]);
    const cart=await post('/cart-quotes',{publication_revision:revision,lines:[{sku:skus.main,quantity:5}]});
    assert.equal(cart.status,200,JSON.stringify(cart.data));
    CartQuoteResponseSchema.parse(cart.data);
    assert.equal(cart.data.shipping.state,'needs_delivery_data');
    assert.equal(cart.response.headers.get('Cache-Control'),'no-store');
    const quoted=await post('/cart-quotes',{publication_revision:revision,lines:[{sku:skus.main,quantity:5}],delivery:{method:'home',postal_code:'100'}});
    assert.equal(quoted.status,200,JSON.stringify(quoted.data));
    CartQuoteResponseSchema.parse(quoted.data);
    assert.equal(quoted.data.shipping.state,'quoted');
    assert.equal(quoted.data.shipping.method,'home');
    assert.equal(quoted.data.shipping.total_minor,10000);
    assert.equal(quoted.data.delivery_options[0].shipping_total_minor,10000);
    const outlying=await post('/cart-quotes',{publication_revision:revision,lines:[{sku:skus.main,quantity:5}],delivery:{method:'home',postal_code:'880'}});
    assert.equal(outlying.data.shipping.total_minor,12000);
    assert.equal(outlying.data.delivery_options[0].shipping_total_minor,10000);
    const badCart=await post('/cart-quotes',{publication_revision:revision,lines:[{sku:skus.main,quantity:1}],delivery:{method:'home',姓名:'不該出現'}});
    assert.equal(badCart.status,422,JSON.stringify(badCart.data));
    assert.equal(badCart.data.code,'delivery_invalid');
    assert.equal(CheckoutErrorSchema.safeParse(badCart.data).success,true);
    hidden(badCart.data,'姓名','不該出現');
  });

  test('placement freezes shipping, blocks CVS, and reports terms changes',async()=>{
    const homeEmail='buyer-home-quote@example.test';
    const created=await post('/checkouts',checkoutBody(home,skus.main,5,homeEmail));
    assert.equal(created.status,201,JSON.stringify(created.data));
    CheckoutResponseSchema.parse(created.data);
    assert.equal(created.response.headers.get('Cache-Control'),'no-store');
    assert.deepEqual(created.data.terms.payment_methods,['immediate_card']);
    const group=created.data.terms.shipping.groups[0];
    assert.deepEqual(Object.keys(created.data.terms.shipping).sort(),['destination_state','groups']);
    assert.deepEqual(Object.keys(group).sort(),['amount_minor','fee_per_parcel_minor','group_ref','handling_days','items','meetup_note','method','outlying_surcharge_per_parcel_minor','parcel_count']);
    assert.equal(group.method,'home');
    assert.equal(group.amount_minor,10000);
    assert.equal(created.data.terms.shipping.destination_state,'complete');
    hidden(created.data,store.supply_shop_id,'agreement','service_key','ship_from','profile_version','logistics');
    const row=(await h.f.x.h.pool.query('SELECT terms,terms_sha256 FROM commerce_checkouts WHERE checkout_id=$1',[created.data.checkout_ref])).rows[0];
    assert.equal(row.terms_sha256,created.data.terms_sha256);
    assert.equal(created.data.terms_sha256,hashJSON(row.terms));
    assert.equal(row.terms.shipping.groups[0].supplier_shop_id,store.supply_shop_id);
    assert.equal(row.terms.shipping.groups[0].logistics.service_key,'ecpay.logistics.home.tcat');
    assert.equal(row.terms.payment_methods[0],'immediate_card');
    const cookie=created.response.headers.get('Set-Cookie')!.split(';')[0];
    const intent={terms_sha256:created.data.terms_sha256,client_order_id:randomUUID()};
    const placed=await h.f.http('POST',h.f.root(store)+`/checkouts/${created.data.checkout_ref}/orders`,intent,cookie,{'CF-Connecting-IP':network()});
    assert.equal(placed.status,201,JSON.stringify(placed.data));
    const replay=await h.f.http('POST',h.f.root(store)+`/checkouts/${created.data.checkout_ref}/orders`,intent,cookie,{'CF-Connecting-IP':network()});
    assert.equal(replay.status,200,JSON.stringify(replay.data));
    assert.equal(replay.data.order.order_ref,placed.data.order.order_ref);
    assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_checkout_orders WHERE checkout_id=$1',[created.data.checkout_ref])).rows[0].n,1);
    const meetup=await post('/checkouts',checkoutBody({method:'meetup',name:'面交人',mobile:'0912345678'},skus.main,5,'buyer-meetup-quote@example.test'));
    assert.equal(meetup.status,201,JSON.stringify(meetup.data));
    assert.equal(meetup.data.terms.total_minor,500);
    const meetupCookie=meetup.response.headers.get('Set-Cookie')!.split(';')[0];
    const meetupOrder=await h.f.http('POST',h.f.root(store)+`/checkouts/${meetup.data.checkout_ref}/orders`,{terms_sha256:meetup.data.terms_sha256,client_order_id:randomUUID()},meetupCookie,{'CF-Connecting-IP':network()});
    assert.equal(meetupOrder.status,201,JSON.stringify(meetupOrder.data));
    const cvs=await post('/checkouts',checkoutBody({method:'cvs:UNIMARTC2C',name:'王小明',mobile:'0912345678'},skus.main,5,'buyer-cvs-quote@example.test'));
    assert.equal(cvs.status,201,JSON.stringify(cvs.data));
    assert.equal(cvs.data.terms.shipping.destination_state,'store_required');
    const cvsCookie=cvs.response.headers.get('Set-Cookie')!.split(';')[0];
    const cvsPlace=await h.f.http('POST',h.f.root(store)+`/checkouts/${cvs.data.checkout_ref}/orders`,{terms_sha256:cvs.data.terms_sha256,client_order_id:randomUUID()},cvsCookie,{'CF-Connecting-IP':network()});
    assert.equal(cvsPlace.status,409,JSON.stringify(cvsPlace.data));
    assert.equal(cvsPlace.data.code,'delivery_store_required');
    for(const sql of [
      'SELECT count(*)::int n FROM commerce_checkout_orders WHERE checkout_id=$1',
      'SELECT count(*)::int n FROM commerce_inventory_reservations r WHERE r.order_id IN (SELECT order_id FROM commerce_checkout_orders WHERE checkout_id=$1)',
      'SELECT count(*)::int n FROM commerce_payment_attempts a WHERE a.order_id IN (SELECT order_id FROM commerce_checkout_orders WHERE checkout_id=$1)',
    ])assert.equal((await h.f.x.h.pool.query(sql,[cvs.data.checkout_ref])).rows[0].n,0,sql);
    async function freeze(delivery:unknown,email:string){
      const response=await post('/checkouts',checkoutBody(delivery,skus.main,5,email));
      assert.equal(response.status,201,JSON.stringify(response.data));
      return response;
    }
    async function rejectChanged(response:Awaited<ReturnType<typeof post>>){
      const browser=response.response.headers.get('Set-Cookie')!.split(';')[0];
      const denied=await h.f.http('POST',h.f.root(store)+`/checkouts/${response.data.checkout_ref}/orders`,{terms_sha256:response.data.terms_sha256,client_order_id:randomUUID()},browser,{'CF-Connecting-IP':network()});
      assert.equal(denied.status,409,JSON.stringify(denied.data));
      assert.equal(denied.data.code,'terms_changed');
      assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_checkout_orders WHERE checkout_id=$1',[response.data.checkout_ref])).rows[0].n,0);
    }
    const sameProfile=h.expect(await h.request(store,'GET','/shipping-profile'));
    const frozenProfile=await freeze(home,'buyer-profile-quote@example.test');
    h.expect(await h.request(store,'PUT','/shipping-profile',sameProfile.profile,sameProfile.version));
    await rejectChanged(frozenProfile);
    const feeProfile=h.expect(await h.request(store,'GET','/shipping-profile'));
    const frozenFee=await freeze(home,'buyer-fee-quote@example.test');
    const feeDocument=structuredClone(feeProfile.profile);
    feeDocument.delivery_options[0].fee_per_parcel_minor=20000;
    h.expect(await h.request(store,'PUT','/shipping-profile',feeDocument,feeProfile.version));
    await rejectChanged(frozenFee);
    const attributePath=`/products/${productId}/shipping-attributes`;
    const attribute=h.expect(await h.request(store,'GET',attributePath));
    const frozenAttribute=await freeze(home,'buyer-attribute-quote@example.test');
    h.expect(await h.request(store,'PUT',attributePath,{...attribute.attributes,weight_g:200},attribute.version));
    await rejectChanged(frozenAttribute);
    const frozenService=await freeze(home,'buyer-service-quote@example.test');
    const accounts=h.expect(await h.request(store,'GET','/provider-accounts')).items as {account_id:string;version:string}[];
    const account=accounts.find(entry=>entry.account_id===logisticsAccountId)!;
    const suspended=h.expect(await h.request(store,'POST',`/provider-accounts/${account.account_id}/logistics-services/${SERVICE_KEYS[0]}/suspend`,{fresh_auth_verification_id:await h.fresh(store)},account.version));
    try {await rejectChanged(frozenService);}
    finally {await h.request(store,'POST',`/provider-accounts/${account.account_id}/logistics-services/${SERVICE_KEYS[0]}/resume`,{fresh_auth_verification_id:await h.fresh(store)},suspended.version);}
  });
});

test('production Node ports quote, place and complete cash meetup without an ECPay account or journal',async()=>{
  const {nodeRuntime}=await import('../../apps/platform-api/src/app.js');
  const {createPlatformApp}=await import('../../apps/platform-api/src/platform-app.js');
  const h=await shippingSettingsHarness('fp_ship_offline_join');
  try{
    await h.reset();
    const store=await h.store(),adminCsrf=randomUUID();
    const adminEmail=(await h.f.x.h.pool.query('SELECT email FROM platform_admins LIMIT 1')).rows[0].email as string;
    // No commercePorts override: this exercises both production port factories.
    const runtime=nodeRuntime('local',h.f.origin,{
      guildLaunchpadEnabled:true,commerceCredentialKeyring:null,
      commerceSettings:{checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:['offline.cash_on_meetup.v1']},
      adminVerifier:async()=>({email:adminEmail,subject:'synthetic-offline-admin',csrfToken:adminCsrf}),
    });
    assert.equal(runtime.commercePayments,undefined);
    assert.equal(runtime.commerceJournal,undefined);
    assert.equal(runtime.commerceCredentialKeyring,null);
    const app=createPlatformApp(h.f.x.runtime,h.f.origin,'local',runtime);
    const seller=(method:string,path:string,body?:unknown,version?:string,key=randomUUID())=>h.f.x.h.call(method,store.root+path,store.owner,body,
      {'Idempotency-Key':key,...(version===undefined?{}:{'If-Match':`"${version}"`})},app);
    h.expect(await seller('PUT','/shipping-profile',{...h.document(),delivery_options:[{method:'meetup',note:'店門口面交'}]}),201);
    h.expect(await seller('PUT','/offline-payment-settings',{
      schema:'freedom.offline-payment-settings/v1',bank_transfer:null,cash_on_meetup:{deadline_days:7},fresh_auth_verification_id:await h.fresh(store),
    }),201);
    const admitted=await app.request(h.f.origin+'/admin/api/commerce/store-admissions',{
      method:'POST',headers:{Origin:h.f.origin,'Content-Type':'application/json','X-Admin-CSRF':adminCsrf,'Idempotency-Key':randomUUID()},
      body:JSON.stringify({tenant_id:store.tenantId,instance_id:store.instanceId,reason:'合成面交整合驗證'}),
    });
    assert.equal(admitted.status,201,await admitted.text());
    const root='/public/stores/'+store.slug;
    const cart=h.expect(await h.f.x.h.call('POST',root+'/cart-quotes',store.owner,{
      publication_revision:'1',lines:[{sku:store.product.sku,quantity:2}],delivery:{method:'meetup'},
    },{},app));
    assert.deepEqual(cart.payment_options,[{method:'cash_on_meetup',available:true,reason:null}]);
    assert.equal(cart.shipping.method,'meetup');
    assert.equal(cart.shipping.total_minor,0);
    const frozen=await h.f.x.h.call('POST',root+'/checkouts',store.owner,{
      ...h.f.x.input(store.product.sku,2),delivery:{method:'meetup',name:'面交買家',mobile:'0900000000'},
    },{'Idempotency-Key':randomUUID()},app);
    const checkout=h.expect(frozen,201);
    assert.deepEqual(checkout.terms.payment_methods,['cash_on_meetup']);
    assert.deepEqual(checkout.terms.offline_payment,{settings_version:'1',bank_transfer_deadline_days:null,meetup_deadline_days:7});
    assert.equal(checkout.terms.shipping.destination_state,'complete');
    assert.equal(checkout.terms.shipping.groups[0].method,'meetup');
    assert.equal(checkout.terms.shipping.groups[0].meetup_note,'店門口面交');
    const device=frozen.response.headers.get('set-cookie')!.split(';')[0];
    const buyer={...store.owner,cookie:store.owner.cookie+'; '+device};
    const placed=h.expect(await h.f.x.h.call('POST',root+`/checkouts/${checkout.checkout_ref}/orders`,buyer,{
      terms_sha256:checkout.terms_sha256,client_order_id:randomUUID(),payment_method:'cash_on_meetup',
    },{},app),201);
    assert.equal(placed.payment,null);
    assert.equal(placed.order.payment_method,'cash_on_meetup');
    assert.equal(placed.order.payment_state,'unpaid');
    const orderId=placed.order.order_ref as string;
    const retained=(await h.f.x.h.pool.query(`SELECT co.terms,extract(epoch FROM o.expires_at-o.created_at)::int AS seconds
      FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id) WHERE co.order_id=$1`,[orderId])).rows[0];
    assert.equal(retained.seconds,7*24*60*60);
    assert.equal(retained.terms.shipping.groups[0].method_ref,'meetup');
    assert.equal(retained.terms.shipping.groups[0].fulfilment_mode,'self');
    const detail=h.expect(await seller('GET',`/checkout-orders/${orderId}`));
    assert.equal(detail.actions.complete_meetup,true);
    const completedOn=(await h.f.x.h.pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS date")).rows[0].date as string;
    const key=randomUUID(),body={amount_minor:placed.order.total_minor,completed_on:completedOn};
    const completed=h.expect(await seller('POST',`/checkout-orders/${orderId}/meetup-completion`,body,detail.version,key));
    assert.equal(completed.payment_state,'confirmed');
    assert.equal(completed.inventory_state,'shipped');
    assert.equal(completed.actions.complete_meetup,false);
    assert.equal(completed.meetup_handover.completed_on,completedOn);
    const replay=h.expect(await seller('POST',`/checkout-orders/${orderId}/meetup-completion`,body,detail.version,key));
    assert.equal(replay.meetup_handover.handover_ref,completed.meetup_handover.handover_ref);
    for(const table of ['commerce_offline_payments','commerce_checkout_payment_applications','commerce_meetup_handovers']){
      assert.equal((await h.f.x.h.pool.query(`SELECT count(*)::int n FROM ${table} WHERE order_id=$1`,[orderId])).rows[0].n,1,table);
    }
    assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts WHERE order_id=$1',[orderId])).rows[0].n,0);
    assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_provider_accounts')).rows[0].n,0);
    assert.equal((await h.f.x.h.pool.query('SELECT count(*)::int n FROM commerce_item_shipping_attributes')).rows[0].n,0);
    assert.deepEqual((await h.f.x.h.pool.query('SELECT quantity,shipped_quantity,released_quantity FROM commerce_inventory_allocations WHERE order_id=$1',[orderId])).rows,
      [{quantity:2,shipped_quantity:2,released_quantity:0}]);
    const publicOrder=h.expect(await h.f.x.h.call('GET',root+`/orders/${orderId}`,buyer,undefined,{},app));
    assert.equal(publicOrder.payment_state,'confirmed');
    assert.equal(publicOrder.can_resume_payment,false);
  }finally{await h.stop();}
});
