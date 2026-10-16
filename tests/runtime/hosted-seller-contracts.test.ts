import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import * as c from '../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import {createTenantListCursorCodec} from '../../packages/shared/tenant-list-cursor.js';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {applyConfirmedPayment} from '../../modules/agent-commerce/checkout/payments.js';
import {openException} from '../../modules/agent-commerce/checkout/exceptions.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
const time='2028-02-29T12:34:56.789Z',id=randomUUID();
const customer={name_masked:'合○○',contact_redacted:false};
const summary={order_ref:id,display_number:'280229-ABCDEF',environment:'sandbox',created_at:time,pay_by:time,lifecycle_state:'open',cancel_reason:null,currency:'TWD',total_minor:500,quantity_total:5,customer,payment_method:'immediate_card',payment_state:'refunded',inventory_state:'released',open_exception_count:0,version:'1'};
const line={sku:'P0001',title:'合成商品',quantity:5,unit_price_minor:100,line_total_minor:500,inventory:{held:0,allocated:0,shipped:0,released:5}};
const attempt={attempt_ref:id,sequence:1,state:'issued',amount_minor:500,currency:'TWD',merchant_trade_no:'F1234567890123456789',trade_no:null,payment_type:null,payment_date:null,charge_fee_minor:null,created_at:time,handed_off_at:null,paid_at:null,confirmed_at:null,failed_at:null,superseded_at:null,expired_at:null};
const application={application_ref:id,attempt_ref:id,offline_payment_ref:null,amount_minor:600,currency:'TWD',outcome:'amount_mismatch',created_at:time,refunded_minor:600,refundable_minor:0};
const refund={refund_ref:id,application_ref:id,attempt_ref:id,amount_minor:600,currency:'TWD',refunded_on:'2028-02-29',provider_reference:'REF_1',basis:'unapplied_payment',mode:'manual_record',state:'recorded',recorded_without_provider:true,recorded_by:id,created_at:time};
const exception={case_ref:id,kind:'amount_mismatch',status:'resolved',responsible_party:'retailer',order:{order_ref:id,display_number:summary.display_number},subject:{kind:'payment_attempt',ref:id},next_action:'refund_payment',due_at:time,opened_at:time,updated_at:time,resolution:{code:'refunded',note:'店家已登記全額退款。',resolved_by:id},payment_facts:{merchant_trade_no:attempt.merchant_trade_no,trade_no:null,expected_amount_minor:500,paid_amount_minor:600,currency:'TWD',payment_date:null,payment_type:null},allowed_actions:[],resolution_codes:[],version:'2'};
const order={...summary,lines:[line],merchandise_total_minor:500,discount_total_minor:0,shipping_total_minor:0,payment_grace_until:null,meetup_handover:null,latest_payment_attempt:null,payment_detail:{attempts:[attempt],applications:[application],offline_payments:[],refunds:[refund]},exceptions:[exception],actions:{cancel:false,query_payment:false,record_refund:false,view_contact:true,view_finance:true,confirm_offline_payment:false,complete_meetup:false,record_meetup_handover:false}};
const samples:[string,{safeParse:(value:unknown)=>{success:boolean}},unknown][]=[
  ['payment-state',c.SellerPaymentStateSchema,'refunded'],['inventory-state',c.SellerInventoryStateSchema,'released'],['customer',c.SellerCustomerSchema,customer],['order-summary',c.SellerCheckoutOrderSummarySchema,summary],['order-page',c.SellerCheckoutOrderPageSchema,{items:[summary],next_cursor:null}],['order-line',c.SellerOrderLineSchema,line],['payment-attempt',c.SellerPaymentAttemptSchema,attempt],['payment-application',c.SellerPaymentApplicationSchema,application],['refund',c.SellerRefundSchema,refund],['exception-case',c.ExceptionCaseViewSchema,exception],['exception-case-page',c.ExceptionCasePageSchema,{items:[exception],next_cursor:null}],['order',c.SellerCheckoutOrderSchema,order],['order-contact',c.SellerOrderContactSchema,{order_ref:id,contact_redacted:false,contact:{name:'合成買家-'+id,email:'synthetic-'+id+'@example.test',phone:'000'+id.replaceAll('-','').slice(0,7)},delivery:{method:'synthetic'},invoice:null}],['empty-input',c.SellerCheckoutEmptyInputSchema,{}],['resolve-with-evidence-input',c.ResolveWithEvidenceInputSchema,{code:'refunded',provider_date:'2028-02-29',provider_reference:'REF_1'}],['retry-allocation-input',c.RetryAllocationInputSchema,{}],['manual-refund-input',c.ManualRefundInputSchema,{application_ref:id,amount_minor:100,refunded_on:'2028-02-29'}],['refund-list',c.SellerRefundListSchema,{items:[refund]}],['order-query',c.SellerCheckoutOrderQuerySchema,{lifecycle:'open',needs_action:'true',display_number:'280229-ABCDEF',payment_method:'bank_transfer',awaiting_offline_payment:'true',limit:'20'}],['offline-payment-confirm-input',c.OfflinePaymentConfirmInputSchema,{amount_minor:500,received_on:'2028-02-29',reference:'SYNTHETIC'}],['meetup-completion-input',c.MeetupCompletionInputSchema,{amount_minor:500,completed_on:'2028-02-29'}],['meetup-handover-input',c.MeetupHandoverInputSchema,{completed_on:'2028-02-29'}],['error-code',c.SellerCheckoutErrorCodeSchema,'refund_date_invalid'],
];
test('seller JSON Schema goldens cover every strict request and safe response',()=>{
  const bundle=JSON.parse(readFileSync(new URL('../../contracts/guild-launchpad/v1/hosted-seller-checkout.schema.json',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(bundle.$defs).sort(),samples.map(([name])=>name).sort());
  const cases=samples.flatMap(([name,schema,value])=>{
    assert(schema.safeParse(value).success,name);const bad=typeof value==='object'?{...(value as object),secret:'forbidden'}:'invented';assert(!schema.safeParse(bad).success,name);return [{name,value,valid:true},{name,value:bad,valid:false},{name,value:null,valid:false}];
  });
  const result=spawnSync('python3',['-c',`import json,sys
from jsonschema import Draft202012Validator,FormatChecker
x=json.load(sys.stdin)
Draft202012Validator.check_schema(x['bundle'])
for c in x['cases']:
 assert Draft202012Validator(x['bundle']['$defs'][c['name']],format_checker=FormatChecker()).is_valid(c['value']) == c['valid'],c
print(len(x['cases']))`],{input:JSON.stringify({bundle,cases}),encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(Number(result.stdout),69);
});
test('seller contracts reject nested private fields, invalid dates, references and redaction shapes',()=>{
  for(const secret of ['gwsr','hash_key','hash_iv','body','sealed','dedupe_key'])assert(!c.SellerPaymentAttemptSchema.safeParse({...attempt,[secret]:'private'}).success);
  for(const extra of [{contact:{name:'private'}},{delivery:{}},{invoice:{}},{email:'private@example.test'},{executor_tenant_id:id}])assert(!c.SellerCheckoutOrderSchema.safeParse({...order,...extra}).success);
  assert(!c.SellerCheckoutOrderSchema.safeParse({...order,payment_detail:{...order.payment_detail,attempts:[{...attempt,gwsr:'123'}]}}).success);
  for(const value of ['2027-02-29','2028-02-30','0000-01-01','2028-02-29\n'])assert(!c.ManualRefundInputSchema.safeParse({application_ref:id,amount_minor:100,refunded_on:value}).success);
  for(const value of ['', 'personal reference','x'.repeat(65),'REF\n'])assert(!c.SellerProviderReferenceSchema.safeParse(value).success);
  assert(c.SellerCustomerSchema.safeParse({name_masked:null,contact_redacted:true}).success);assert(!c.SellerCustomerSchema.safeParse({name_masked:'合○○',contact_redacted:true}).success);assert(!c.SellerCustomerSchema.safeParse({name_masked:null,contact_redacted:false}).success);
  assert(c.SellerOrderContactSchema.safeParse({order_ref:id,contact_redacted:true,contact:null,delivery:null,invoice:null}).success);assert(!c.SellerOrderContactSchema.safeParse({order_ref:id,contact_redacted:true,contact:null,delivery:{private:'removed'},invoice:null}).success);
  assert(c.ResolveWithEvidenceInputSchema.safeParse({code:'confirmed'}).success);assert(!c.ResolveWithEvidenceInputSchema.safeParse({code:'confirmed',provider_reference:'unneeded'}).success);
});
test('seller route responses parse through their generated strict contracts',async()=>{
  const f=await hostedPaymentHarness('fp_seller_contracts',{randomContact:true});
  try{
    await f.reset();f.install({tenantListCursors:createTenantListCursorCodec(randomBytes(32).toString('base64url'),{environment:'local',origin:f.origin})});
    const p=await f.placed(),root=p.s.root+'/checkout-orders/'+p.order.order_ref;
    const call=(method:string,path:string,body?:unknown,headers:Record<string,string>={})=>f.x.h.call(method,path,p.s.owner,body,headers,f.app);
    const get=async(path:string)=>{const r=await call('GET',path);assert.equal(r.status,200,JSON.stringify(r.data));return r;};
    c.SellerCheckoutOrderPageSchema.parse((await get(p.s.root+'/checkout-orders')).data);c.SellerCheckoutOrderSchema.parse((await get(root)).data);c.SellerOrderContactSchema.parse((await get(root+'/contact')).data);
    const app=await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:600,currency:'TWD',simulated:false}));
    const e=await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);return openException(q,{tenantId:p.s.tenantId,instanceId:p.s.instanceId,orderId:p.order.order_ref,kind:'amount_mismatch',subjectKind:'payment_attempt',subjectId:p.payment.attempt_ref});});
    c.ExceptionCasePageSchema.parse((await get(p.s.root+'/exception-cases?view=retailer')).data);c.ExceptionCaseViewSchema.parse((await get(p.s.root+'/exception-cases/'+e.case_id)).data);
    const refunded_on=(await f.x.h.pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') d")).rows[0].d;
    const r=await call('POST',root+'/refunds',{application_ref:app.application_id,amount_minor:600,refunded_on},{'Idempotency-Key':randomUUID()});assert.equal(r.status,201,JSON.stringify(r.data));c.SellerRefundSchema.parse(r.data);c.SellerRefundListSchema.parse((await get(root+'/refunds')).data);c.SellerCheckoutOrderSchema.parse((await get(root)).data);
    const query=await call('POST',root+'/payment-queries',{});assert.equal(query.status,200);c.SellerCheckoutOrderSchema.parse(query.data);
  }finally{await f.stop();}
});
