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
    const response = await app.request('/me/stores?' + query);
    assert.equal(response.status, 422, query);
  }
  assert.equal(connections, 0);
});
