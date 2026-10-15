import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
  const bundle=JSON.parse(readFileSync(new URL('../../contracts/guild-launchpad/v1/hosted-checkout.schema.json',import.meta.url),'utf8'));
  const text=JSON.stringify(bundle);for(const name of ['cart-quote-input','cart-quote','checkout-input','checkout','placement-input','placement','order','redeem-input','access-request-input','forget-input','error'])assert(text.includes(name),name);
});
