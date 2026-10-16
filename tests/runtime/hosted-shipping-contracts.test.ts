import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import * as wire from '../../contracts/guild-launchpad/v1/hosted-shipping.js';
import {SERVICE_KEYS,DELIVERY_METHODS} from '../../modules/agent-commerce/fulfilment/rules/types.js';

test('shipping literals and fixed delivery labels match the rules in preference order',()=>{
  assert.deepEqual(wire.LogisticsServiceKeySchema.options,SERVICE_KEYS);
  assert.deepEqual(wire.LogisticsDeliveryMethodSchema.options,DELIVERY_METHODS);
  assert.deepEqual(wire.DeliveryMethodSchema.options,[...DELIVERY_METHODS,'meetup']);
  assert.deepEqual(Object.keys(wire.DELIVERY_METHOD_LABELS),[...DELIVERY_METHODS,'meetup']);
  assert.equal(wire.DELIVERY_METHOD_LABELS.meetup,'面交取貨');
});
test('shipping bundle goldens agree with strict Zod shapes and JSON Schema',()=>{
  const id=randomUUID(),time='2028-02-29T12:34:56.789Z';
  const digits=randomBytes(4).readUInt32BE().toString().padStart(10,'0');
  const location={label:'合成倉'+digits,sender_name:'合成'+['星禾','青羽','松月'][Number(digits.slice(-1))%3],mobile:'09'+digits.slice(-8),postal_code:'100',address:'合成星禾路'+digits+'號',ships:true,receives_returns:true};
  const limits={max_weight_g:10000,max_longest_side_mm:600,max_dimension_sum_mm:1500};
  const service={service_key:SERVICE_KEYS[0],ship_from_location_id:id,temperature:'ambient',handling_days:1,cutoff_time:'17:00',limits,outlying_islands:'excluded'};
  const delivery={method:'home',fee_per_parcel_minor:10000,free_over_minor:null,outlying:{kind:'excluded'}};
  const fee={service_key:SERVICE_KEYS[0],fee_per_parcel_minor:10000};
  const drop={offered:true,fees:[fee],return_location_id:id,liability:'合成責任\n條款',recipient_retention_days:7,accept_within_hours:24};
  const profile={schema:'freedom.shipping-profile/v1',working_days:[1],services:[service],delivery_options:[delivery],drop_ship:drop};
  const attributes={weight_g:100,length_mm:100,width_mm:100,height_mm:100,temperature:'ambient',cvs_allowed:true,ship_alone:false,max_per_parcel:null};
  const field={path:'services.0.ship_from_location_id',code:'not_found'};
  const view={...location,location_id:id,replaces_location_id:null,in_use:true,created_at:time,retired_at:null};
  const samples:[string,unknown][]=[['logistics-service-key',SERVICE_KEYS[0]],['delivery-method','home'],['logistics-delivery-method','home'],['meetup-delivery-option',{method:'meetup',note:'面交於店門口'}],['checkout-delivery-input',{method:'home',name:'合成買家',mobile:'0912345678',postal_code:'100',address:'合成測試路1號'}],['cart-delivery-input',{method:'home',postal_code:'100'}],['shipping-empty-input',{}],['ship-from-location-input',location],['ship-from-location',view],['ship-from-location-page',{items:[view]}],['ship-from-location-retire-input',{}],['parcel-limits',limits],['profile-service',service],['delivery-option',delivery],['drop-ship-fee',fee],['drop-ship',drop],['shipping-profile-document',profile],['shipping-profile-input',profile],['logistics-availability',{service_key:SERVICE_KEYS[0],state:'active'}],['shipping-profile-view',{version:'1',profile,saved_at:time,environment:'sandbox',logistics:SERVICE_KEYS.map(service_key=>({service_key,state:'active'}))}],['item-shipping-attributes-input',attributes],['item-shipping-attributes',{product_id:id,version:'1',attributes,updated_at:time}],['shipping-field-error-code','not_found'],['shipping-field-error',field],['shipping-error-code','shipping_input_invalid'],['shipping-error',{type:'about:blank',title:'shipping_input_invalid',status:422,code:'shipping_input_invalid',detail:'輸入資料無效。',fields:[field]}]];
  const bundle=JSON.parse(readFileSync('contracts/guild-launchpad/v1/hosted-shipping.schema.json','utf8'));
  assert.deepEqual(Object.keys(bundle.$defs).sort(),samples.map(([key])=>key).sort());
  const schemas=Object.fromEntries(Object.entries(wire).filter(([name])=>name.endsWith('Schema')));
  const cases=samples.flatMap(([name,value])=>{
    const key=name.split('-').map(part=>part[0].toUpperCase()+part.slice(1)).join('')+'Schema';
    const schema=schemas[key] as {safeParse:(value:unknown)=>{success:boolean}};
    assert(schema.safeParse(value).success,key);
    const invalid=typeof value==='object'?{...value,unexpected:true}:'invented';
    assert(!schema.safeParse(invalid).success,key);
    return [{name,value,valid:true},{name,value:invalid,valid:false},{name,value:null,valid:false}];
  });
  const result=spawnSync('python3',['-c',`import json,sys
from jsonschema import Draft202012Validator,FormatChecker
x=json.load(sys.stdin)
Draft202012Validator.check_schema(x['bundle'])
for c in x['cases']:
 assert Draft202012Validator(x['bundle']['$defs'][c['name']],format_checker=FormatChecker()).is_valid(c['value']) == c['valid'],c['name']
print(len(x['cases']))`],{input:JSON.stringify({bundle,cases}),encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(Number(result.stdout),78);
});
test('shipping contracts enforce bounds, money granularity, paths and liability code points',()=>{
  for(const code of ['invalid_command_json','origin_rejected','host_rejected','json_required','body_too_large','login_required','csrf_rejected','onboarding_required','scope_kind_unavailable','foundation_mapping_unavailable','tenant_context_unavailable'])assert.equal(wire.ShippingErrorCodeSchema.parse(code),code);
  for(const code of ['not_found','role_required','not_activated','blocked_term'])assert(wire.ShippingFieldErrorSchema.safeParse({path:'services.0.ship_from_location_id',code}).success);
  for(const path of ['services.100.x','services.-1.x','services.0.x\n','a'.repeat(81)])assert(!wire.ShippingFieldErrorSchema.safeParse({path,code:'format'}).success);
  const base={offered:false,fees:[],return_location_id:randomUUID(),liability:'😀'.repeat(1000),recipient_retention_days:1,accept_within_hours:1};
  assert(wire.DropShipSchema.safeParse(base).success);
  for(const liability of ['', ' ', 'x\ty', 'a'.repeat(1001), '😀'.repeat(1001), '\ud800'])assert(!wire.DropShipSchema.safeParse({...base,liability}).success);
  const meetup=(note:string)=>({schema:'freedom.shipping-profile/v1' as const,working_days:[1],services:[],delivery_options:[{method:'meetup' as const,note}],drop_ship:null});
  assert(wire.ShippingProfileInputSchema.safeParse(meetup('面交於店門口')).success);
  assert(wire.ShippingProfileInputSchema.safeParse(meetup('第一行\n第二行')).success);
  assert(wire.ShippingProfileInputSchema.safeParse(meetup('  面交  ')).success);
  assert.equal(wire.MeetupDeliveryOptionSchema.parse({method:'meetup',note:'  面交  '}).note,'面交');
  for(const note of ['', ' ', 'a'.repeat(201), '😀'.repeat(201), '有\t字元', '有\u0000字元', '\ud800'])assert(!wire.ShippingProfileInputSchema.safeParse(meetup(note)).success,JSON.stringify(note));
  assert(!wire.ShippingProfileInputSchema.safeParse({...meetup('面交'),delivery_options:[...Array(6)].map(()=>({method:'home',fee_per_parcel_minor:100,free_over_minor:null,outlying:{kind:'excluded'}}))}).success);
  assert(wire.CheckoutDeliveryInputSchema.safeParse({method:'cvs:FAMIC2C',name:'合成',mobile:'0912345678'}).success);
  assert(!wire.CheckoutDeliveryInputSchema.safeParse({method:'cvs:FAMIC2C',name:'合成',mobile:'0912345678',store_id:'123'}).success);
  assert(wire.CartDeliveryInputSchema.safeParse({method:'meetup'}).success);
  assert(!wire.CartDeliveryInputSchema.safeParse({method:'meetup',note:'面交'}).success);
  for(const fee of [-100,1,101,1000100])assert(!wire.DropShipFeeSchema.safeParse({service_key:SERVICE_KEYS[0],fee_per_parcel_minor:fee}).success);
});
