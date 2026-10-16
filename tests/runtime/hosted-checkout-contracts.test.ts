import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import * as c from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
const input={publication_revision:'1',lines:[{sku:'P0001',quantity:1}]};
test('strict checkout requests reject promotions, duplicate SKU, invalid counts and authority selectors',()=>{
  assert(c.CartQuoteInputSchema.safeParse(input).success);
  for(const extra of [{promotion_code:'X'},{tenant_id:randomUUID()},{instance_id:randomUUID()}])assert(!c.CartQuoteInputSchema.safeParse({...input,...extra}).success);
  for(const quantity of [0,100,1.5])assert(!c.CartQuoteInputSchema.safeParse({...input,lines:[{sku:'P0001',quantity}]}).success);
  assert(!c.CartQuoteInputSchema.safeParse({...input,lines:[...input.lines,...input.lines]}).success);
  assert(c.CartQuoteInputSchema.safeParse({...input,lines:[{...input.lines[0],unit_price_minor:1}]}).success);
  assert(!c.PlaceOrderInputSchema.safeParse({terms_sha256:'a'.repeat(64),client_order_id:randomUUID(),buyer_principal_id:randomUUID()}).success);
});
test('closed errors and the generated hosted checkout bundle cover each JSON request and response',()=>{
  assert(!c.CheckoutErrorCodeSchema.safeParse('invented').success);
  assert(c.CheckoutErrorCodeSchema.safeParse('invalid_json').success);
  const bundle=JSON.parse(readFileSync(new URL('../../contracts/guild-launchpad/v1/hosted-checkout.schema.json',import.meta.url),'utf8'));
  const id=randomUUID(),time='2028-02-29T12:34:56.789Z',hash='a'.repeat(64),item={sku:'P0001',title:'合成商品',quantity:1,unit_price_minor:100,line_total_minor:100};
  const terms={publication_revision:'1',currency:'TWD',items:[item],merchandise_total_minor:100,discount_total_minor:0,discounts:[],shipping:{groups:[{group_ref:'group',amount_minor:0}]},shipping_total_minor:0,tax_state:'not_assessed',total_minor:100,consents:[],payment_methods:['immediate_card']};
  const order={order_ref:id,display_number:'280229-ABCDEF',store:{slug:'synthetic-shop',name:'合成商店'},created_at:time,pay_by:time,reservation_expired:false,lifecycle_state:'cancelled',cancel_reason:'paid_cancelled',currency:'TWD',lines:[{...item,options:[]}],merchandise_total_minor:100,discount_total_minor:0,shipping_total_minor:0,total_minor:100,payment_state:'confirmed',latest_payment_attempt:null,can_resume_payment:false,contact:{name:'測試買家甲😀',email:'buyer@example.test',phone:'0900000000'},delivery:{},invoice:null,redacted:false};
  const samples:[string,unknown][]=[
    ['cart-quote-input',input],['cart-quote',{publication_revision:'1',currency:'TWD',lines:[{...item,options:[],state:'ok'}],merchandise_total_minor:100,discounts:[],shipping:{state:'quoted',groups:[{group_ref:'group',amount_minor:0}],total_minor:0},total_minor:100}],
    ['checkout-input',{...input,contact:order.contact,delivery:{}}],['checkout',{checkout_ref:id,terms,terms_sha256:hash,expires_at:time}],
    ['placement-input',{terms_sha256:hash,client_order_id:id}],['placement',{order,payment:null}],['order',order],['redeem-input',{token:'synthetic'}],
    ['payment-handoff-input',{}],['payment-handoff',{handoff_url:'/pay/ecpay/'+'A'.repeat(43),attempt_ref:id,expires_at:time}],
    ['access-request-input',{email:'buyer@example.test',display_number:'280229-ABCDEF'}],['forget-input',{}],['error',{type:'about:blank',title:'internal_error',status:500,code:'internal_error',detail:'結帳服務暫時無法使用。'}],
  ];
  assert.deepEqual(Object.keys(bundle.$defs).sort(),samples.map(([name])=>name).sort());
  const cases=samples.flatMap(([name,value])=>[{name,value,valid:true},{name,value:{...(value as object),secret:'forbidden'},valid:false},{name,value:null,valid:false}]);
  const result=spawnSync('python3',['-c',`import json,sys
from jsonschema import Draft202012Validator,FormatChecker
x=json.load(sys.stdin)
Draft202012Validator.check_schema(x['bundle'])
for c in x['cases']:
 s=x['bundle']['$defs'][c['name']]
 Draft202012Validator.check_schema(s)
 assert Draft202012Validator(s,format_checker=FormatChecker()).is_valid(c['value']) == c['valid'],c
print(len(x['cases']))`],{input:JSON.stringify({bundle,cases}),encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(Number(result.stdout),39);
});
test('checkout timestamps require ASCII UTC milliseconds and reject trailing content',()=>{
  const timestamp=c.CheckoutResponseSchema.shape.expires_at;
  assert(timestamp.safeParse('2028-02-29T12:34:56.789Z').success);
  for(const value of ['2027-02-29T12:34:56.789Z','2028-02-29T12:34:56.789Z\n','２０２８-02-29T12:34:56.789Z','2028-02-29T12:34:56.789+00:00'])assert(!timestamp.safeParse(value).success,value);
});
test('payment DTOs and JSON Schema share closed states, bearer URLs and strict buyer allowlists',()=>{
  const id=randomUUID(),time='2028-02-29T12:34:56.789Z',handoff={handoff_url:'/pay/ecpay/'+'A'.repeat(43),attempt_ref:id,expires_at:time};
  const order={order_ref:id,display_number:'280229-ABCDEF',store:{slug:'synthetic-shop',name:'合成商店'},created_at:time,pay_by:time,reservation_expired:false,lifecycle_state:'open',cancel_reason:null,currency:'TWD',lines:[{sku:'P0001',title:'合成商品',quantity:5,unit_price_minor:100,line_total_minor:500,options:[]}],merchandise_total_minor:500,discount_total_minor:0,shipping_total_minor:0,total_minor:500,payment_state:'unpaid',latest_payment_attempt:null,can_resume_payment:false,contact:{name:'合成買家',email:'synthetic@example.test',phone:'0000000000'},delivery:{},invoice:null,redacted:false};
  const bundle=JSON.parse(readFileSync(new URL('../../contracts/guild-launchpad/v1/hosted-checkout.schema.json',import.meta.url),'utf8'));
  const cases:{name:string;value:unknown;valid:boolean}[]=[];
  const add=(name:string,value:unknown,valid:boolean,schema:{safeParse:(value:unknown)=>{success:boolean}})=>{assert.equal(schema.safeParse(value).success,valid,name);cases.push({name,value,valid});};
  for(const payment_state of ['unpaid','pending','simulated','confirmed','overpaid'])for(const state of [null,'ready','awaiting_result','paid','failed','expired'])add('order',{...order,payment_state,latest_payment_attempt:state===null?null:{attempt_ref:id,state,created_at:time}},true,c.PublicOrderSchema);
  for(const extra of [{payment_state:'refunded'},{latest_payment_attempt:{attempt_ref:id,state:'issued',created_at:time}},{latest_payment_attempt:{attempt_ref:id,state:'ready',created_at:time,account_id:id}},{can_resume_payment:'true'},{trade_no:'SYNTHETIC'},{exceptions:[]}])add('order',{...order,...extra},false,c.PublicOrderSchema);
  add('placement',{order,payment:handoff},true,c.PlaceOrderResponseSchema);add('placement',{order,payment:null},true,c.PlaceOrderResponseSchema);
  for(const value of [handoff,{...handoff,handoff_url:'https://foreign.test'+handoff.handoff_url},{...handoff,handoff_url:handoff.handoff_url+'\n'},{...handoff,handoff_url:handoff.handoff_url+'?x=1'},{...handoff,handoff_url:'/pay/ecpay/'+'A'.repeat(42)},{...handoff,account_ref:'forbidden'},{...handoff,expires_at:'2028-02-29T12:34:56Z'}])add('payment-handoff',value,value===handoff,c.PaymentHandoffResponseSchema);
  for(const code of ['payment_profile_unavailable','payment_handoff_unavailable','checkout_order_closed','checkout_hold_expired','payment_already_applied','payment_attempts_exhausted','payment_result_pending']){assert(c.CheckoutErrorCodeSchema.safeParse(code).success);add('error',{type:'about:blank',title:code,status:409,code,detail:'合成錯誤'},true,c.CheckoutErrorSchema);}
  const result=spawnSync('python3',['-c',`import json,sys
from jsonschema import Draft202012Validator,FormatChecker
x=json.load(sys.stdin)
for c in x['cases']:
 assert Draft202012Validator(x['bundle']['$defs'][c['name']],format_checker=FormatChecker()).is_valid(c['value']) == c['valid'],c['name']
print(len(x['cases']))`],{input:JSON.stringify({bundle,cases}),encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(Number(result.stdout),52);
});
