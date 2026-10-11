import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ZodError} from 'zod';
import type {Pool} from 'pg';
import {MyStoresSchema} from '../../contracts/guild-launchpad/v1/storefront.js';
import {MyStoresQuerySchema, MyStoresPageSchema, MyStoresLegacyProjectionSchema} from '../../contracts/guild-launchpad/v1/storefront-pagination.js';
import {createHostedStoreRoutes} from '../../apps/platform-api/src/routes/hosted-store.js';
import {Problem} from '../../packages/shared/problem.js';

test('default projection preserves the exact immutable old schema, including empty continuation pages', () => {
  for (const next_cursor of [null, 'opaque-continuation']) {
    const page = MyStoresPageSchema.parse({items: [], next_cursor});
    const legacy = MyStoresLegacyProjectionSchema.parse(page);
    assert.deepEqual(legacy, {items: [], truncated: next_cursor !== null});
    assert.deepEqual(MyStoresSchema.parse(legacy), legacy);
    assert.equal(MyStoresSchema.safeParse(page).success, false);
    assert.equal(MyStoresPageSchema.safeParse(legacy).success, false);
  }
});

test('cursor pages require explicit opt-in while the empty legacy query stays valid', () => {
  assert.deepEqual(MyStoresQuerySchema.parse({}), {});
  assert.deepEqual(MyStoresQuerySchema.parse({pagination: 'cursor'}), {pagination: 'cursor'});
  assert.deepEqual(MyStoresQuerySchema.parse({pagination: 'cursor', cursor: 'opaque'}), {pagination: 'cursor', cursor: 'opaque'});
  for (const query of [{cursor: 'opaque'}, {pagination: ''}, {pagination: 'other'},
    {pagination: 'cursor', cursor: ''}, {pagination: 'cursor', cursor: 'x'.repeat(2049)}, {unknown: '1'}]) {
    assert.equal(MyStoresQuerySchema.safeParse(query).success, false);
  }
});

test('actual store route rejects unknown, repeated and non-opt-in queries before database access', async () => {
  let connections = 0;
  const app = createHostedStoreRoutes({connect() {connections++; throw new Error('must not connect');}} as unknown as Pool);
  app.onError((error, c) => c.json({error: 'rejected'}, error instanceof ZodError || error instanceof Problem && error.status === 422 ? 422 : 500));
  for (const query of ['cursor=opaque', 'pagination=other', 'pagination=cursor&pagination=cursor',
    'pagination=cursor&cursor=a&cursor=b', 'pagination=cursor&cursor=', 'unknown=1', 'pagination=cursor&unknown=1']) {
    for (const endpoint of ['/me/stores', '/me/supply-catalogs']) {
      const response = await app.request(endpoint + '?' + query);
      assert.equal(response.status, 422, endpoint + '?' + query);
    }
  }
  assert.equal(connections, 0);
});

// Additive supplier DTOs never accept retail activation or a retail price.
import {SupplyCatalogSetupInputSchema, SupplyProductInputSchema, SupplyProductUpdateInputSchema, SupplyProductViewSchema, SupplyCatalogReceiptSchema, SupplyProductReceiptSchema}
  from '../../contracts/guild-launchpad/v1/hosted-supply-catalog.js';

test('supply-only setup has no required or accepted retail activation fields',()=>{
 const input={name:'Supply catalog',currency:'TWD'};
 assert.deepEqual(SupplyCatalogSetupInputSchema.parse(input),input);
 for(const extra of [{slug:'private-cost'},{template_id:'classic'},{retail_enabled:true},{published:true}])
  assert.equal(SupplyCatalogSetupInputSchema.safeParse({...input,...extra}).success,false);
});
test('supply product DTOs separate private cost from retail price',()=>{
 const input={title:'Supply product',cost_minor:500,stock:10};
 assert.deepEqual(SupplyProductInputSchema.parse(input),input);
 assert.equal(SupplyProductInputSchema.safeParse({...input,price_minor:500}).success,false);
 assert.equal(SupplyProductUpdateInputSchema.safeParse({}).success,false);
 assert.equal(SupplyProductUpdateInputSchema.safeParse({cost_minor:-1}).success,false);
 assert.equal(SupplyProductUpdateInputSchema.safeParse({stock:5}).success,true);
 const product={...input,product_id:'11111111-1111-4111-8111-111111111111',sku:'P0001',description:'',currency:'TWD',version:'1'};
 assert.equal(SupplyProductViewSchema.safeParse(product).success,true);
 assert.equal(SupplyProductViewSchema.safeParse({...product,price_minor:500}).success,false);
});

test('supplier command receipts retain stable IDs/version and reject private projections',()=>{
 const id='11111111-1111-4111-8111-111111111111';
 assert.deepEqual(SupplyCatalogReceiptSchema.parse({instance_id:id,version:'1',created:true}),{instance_id:id,version:'1',created:true});
 assert.deepEqual(SupplyProductReceiptSchema.parse({product_id:id,version:'2'}),{product_id:id,version:'2'});
 for(const extra of [{name:'private name'},{description:'private text'},{cost_minor:500},{catalog:{name:'private'}},{url:'https://example.test'}]) {
  assert.equal(SupplyCatalogReceiptSchema.safeParse({instance_id:id,version:'1',created:true,...extra}).success,false);
  assert.equal(SupplyProductReceiptSchema.safeParse({product_id:id,version:'2',...extra}).success,false);
 }
});
