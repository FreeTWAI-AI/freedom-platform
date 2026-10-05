import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConnectedStorefront } from '../../client-connections/storefront-workspace.mjs';
import { loadSupplierWorkspace } from '../../client-connections/supplier-workspace.mjs';

const token = 'fw_read_' + 'A'.repeat(43);
function fixture(overrides = {}) {
  const seen = [], data = {
    '/connection': { kind: 'storefront', scope: 'storefront:read', store_id: 'store-1', read_only: true },
    '/retail/catalog': { items: [{ product_id: 'product-1' }], read_only: true },
    '/retail/stores': { items: [{ store_id: 'store-1' }], read_only: true },
    '/retail/listings': { items: [{ listing_id: 'listing-1', store_id: 'store-1' }], read_only: true },
    ...overrides,
  };
  return { seen, options: { token, origin: 'http://127.0.0.1', fetcher: async (url, init) => {
    const path = new URL(url).pathname.replace('/client-api/v1', ''); seen.push(path);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer ' + token); assert.equal(init.headers.Cookie, undefined);
    const payload = data[path]; return payload instanceof Response ? payload : Response.json(payload);
  } } };
}

test('scoped storefront adapter calls shared transport and returns only the approved private workspace', async () => {
  const { options, seen } = fixture();
  const workspace = await loadConnectedStorefront(options);
  assert.equal(workspace.store_id, 'store-1'); assert.equal(workspace.listings.length, 1);
  assert.deepEqual(workspace.capabilities, { checkout: false, payments: false, public_publication: false, service_offers: false });
  assert.deepEqual(seen, ['/connection', '/retail/catalog', '/retail/stores', '/retail/listings']);
  assert(!JSON.stringify(workspace).includes(token));
});

test('shared supplier workspace preserves sequential scope checks and read-only result', async () => {
  const calls = [], connection = { kind: 'supplier', scope: 'supplier:read', read_only: true };
  const client = { read: async resource => {
    calls.push(resource); return resource === 'connection' ? connection : { items: [{ resource }], read_only: true };
  } };
  assert.deepEqual(await loadSupplierWorkspace(client), {
    connection, products: [{ resource: 'products' }], requests: [{ resource: 'requests' }], read_only: true,
  });
  assert.deepEqual(calls, ['connection', 'products', 'requests']);
  calls.length = 0;
  connection.kind = 'storefront';
  await assert.rejects(loadSupplierWorkspace(client), /supplier read connection/);
  assert.deepEqual(calls, ['connection']);
});

test('shared supplier workspace propagates revocation and refuses malformed lists', async () => {
  await assert.rejects(loadSupplierWorkspace({ read: async () => { throw Object.assign(new Error('revoked'), { status: 401 }); } }), { status: 401 });
  await assert.rejects(loadSupplierWorkspace({ read: async resource => resource === 'connection'
    ? { kind: 'supplier', scope: 'supplier:read', read_only: true } : {} }), /Incompatible supplier list/);
});

test('rejects a supplier connection before requesting any storefront data', async () => {
  const { options, seen } = fixture({ '/connection': { kind: 'supplier', scope: 'supplier:read', store_id: null, read_only: true } });
  await assert.rejects(loadConnectedStorefront(options), /storefront:read/);
  assert.deepEqual(seen, ['/connection']);
});

test('revocation or mixed-store results fail without a partial workspace or automatic retry', async () => {
  const revoked = fixture({ '/connection': Response.json({ code: 'client_token_invalid' }, { status: 401 }) });
  await assert.rejects(loadConnectedStorefront(revoked.options), { status: 401 });
  assert.equal(revoked.seen.length, 1);
  for (const response of [
    { '/retail/stores': { items: [{ store_id: 'other' }], read_only: true } },
    { '/retail/listings': { items: [{ store_id: 'other' }], read_only: true } },
    { '/retail/listings': Response.json({ code: 'client_token_invalid' }, { status: 401 }) },
  ]) await assert.rejects(loadConnectedStorefront(fixture(response).options));
});
