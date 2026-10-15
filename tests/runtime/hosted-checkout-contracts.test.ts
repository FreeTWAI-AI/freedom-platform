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
  const order={order_ref:id,display_number:'280229-ABCDEF',store:{slug:'synthetic-shop',name:'合成商店'},created_at:time,pay_by:time,reservation_expired:false,lifecycle_state:'cancelled',cancel_reason:'paid_cancelled',currency:'TWD',lines:[{...item,options:[]}],merchandise_total_minor:100,discount_total_minor:0,shipping_total_minor:0,total_minor:100,payment_state:'confirmed',contact:{name:'測試買家甲😀',email:'buyer@example.test',phone:'0900000000'},delivery:{},invoice:null,redacted:false};
  const samples:[string,unknown][]=[
    ['cart-quote-input',input],['cart-quote',{publication_revision:'1',currency:'TWD',lines:[{...item,options:[],state:'ok'}],merchandise_total_minor:100,discounts:[],shipping:{state:'quoted',groups:[{group_ref:'group',amount_minor:0}],total_minor:0},total_minor:100}],
    ['checkout-input',{...input,contact:order.contact,delivery:{}}],['checkout',{checkout_ref:id,terms,terms_sha256:hash,expires_at:time}],
    ['placement-input',{terms_sha256:hash,client_order_id:id}],['placement',{order,payment:null}],['order',order],['redeem-input',{token:'synthetic'}],
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
  assert.equal(result.status,0,result.stderr);assert.equal(Number(result.stdout),33);
});
test('checkout timestamps require ASCII UTC milliseconds and reject trailing content',()=>{
  const timestamp=c.CheckoutResponseSchema.shape.expires_at;
  assert(timestamp.safeParse('2028-02-29T12:34:56.789Z').success);
  for(const value of ['2027-02-29T12:34:56.789Z','2028-02-29T12:34:56.789Z\n','２０２８-02-29T12:34:56.789Z','2028-02-29T12:34:56.789+00:00'])assert(!timestamp.safeParse(value).success,value);
});
