import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import CatalogBlock, {SupplySummaryView} from '../../modules/guild-supply/CatalogBlock';
import WorksBlock from '../../modules/guild-open-source/WorksBlock';
import {GuildBlock} from '../../apps/portal-web/src/guild-blocks/runtime';
import type {GuildBlockProps} from '../../packages/guild-presentation/block';
import {canReplaceLaunchpadLayout} from '../../modules/guild-workspace/launchpad-layout-guards';
import {BLOCK_KINDS, parseConfig as parseV1} from '../../contracts/guild-launchpad/v1/config';
import {parseConfig, convertV1, assertAvailableBlocks, publicSafeConfig} from '../../contracts/guild-launchpad/v2/config';
// @ts-expect-error Build tooling is a native ESM JavaScript module.
import {collectGuildBlocks, renderRegistry} from '../../scripts/generate-guild-blocks.mjs';
// @ts-expect-error Build tooling is a native ESM JavaScript module.
import {guildPresentationImportsProven} from '../../packages/contribution-tools/guild-presentation-profile.mjs';

const descriptor = {module_id: 'sample-guild', owned_paths: ['modules/sample/**'], public_exports: ['modules/sample/Block.tsx'], surfaces: [{surface_id: 'guild-block.sample.v1', kind: 'page', entry: 'modules/sample/Block.tsx', auth_profile: 'member-session', operations: ['sample.read']}]};
test('reviewed module surfaces produce deterministic bundled imports without a second application manifest', () => {
  assert.deepEqual(collectGuildBlocks([descriptor]), [{id: 'guild-block.sample.v1', entry: 'modules/sample/Block.tsx', module_id: 'sample-guild'}]);
  assert.match(renderRegistry(collectGuildBlocks([descriptor])), /import\("\.\.\/\.\.\/\.\.\/\.\.\/modules\/sample\/Block"\)/);
});
test('descriptor collection rejects duplicate, unowned, unpublished, remote and wrong-authority entries', () => {
  assert.throws(() => collectGuildBlocks([descriptor, descriptor]), /Duplicate/);
  for (const change of [{entry: 'https://example.com/block.tsx'}, {entry: 'modules/sample/../../private.tsx'}, {auth_profile: 'public-anonymous-read'}, {kind: 'http'}, {operations: []}]) {
    assert.throws(() => collectGuildBlocks([{...descriptor, surfaces: [{...descriptor.surfaces[0], ...change}]}]), /Invalid/);
  }
  assert.throws(() => collectGuildBlocks([{...descriptor, public_exports: []}]), /Invalid/);
  assert.throws(() => collectGuildBlocks([{...descriptor, owned_paths: []}]), /Invalid/);
});
test('visitors render both working examples without performing private reads or exposing member actions', () => {
  const props: GuildBlockProps = {viewer: 'visitor', client: {sessionGeneration: 0, get: async () => {throw new Error('Private request forbidden');}}, navigate: () => {throw new Error('Unexpected navigation');}};
  for (const block of [CatalogBlock, WorksBlock]) {
    const html = renderToStaticMarkup(createElement(block, props));
    assert.match(html, /登入後/); assert.doesNotMatch(html, /<button/);
  }
});
test('unknown versions and prototype keys stay inert', () => {
  const props: GuildBlockProps = {viewer: 'member', client: {sessionGeneration: 0, get: async () => {throw new Error('Private request forbidden');}}, navigate: () => {}};
  for (const id of ['guild-block.missing.v9','__proto__','constructor']) {
    const html = renderToStaticMarkup(createElement(GuildBlock, {...props, id, loaders: {}}));
    assert.match(html, /版本目前無法使用/); assert.doesNotMatch(html, /<button/);
  }
});

const v1 = () => parseV1({schema_version: 'guild-launchpad.config/v1', guild_key: 'guild_ai_vibe', mission_override: null,
  blocks: BLOCK_KINDS.map((kind, order) => ({id: kind, kind, order, enabled: true, title: null})), application_refs: [],
  starter: {title_label: '', objective_hint: '', note_hint: ''}, support: {kind: 'platform_help', public_url: null}, extensions: {}}, 'guild_ai_vibe');
const extension = {id: 'works', kind: 'extension' as const, extension_id: 'guild-block.open-source-works.v1', order: 7, enabled: true, title: '我的作品', settings: {}};
test('v1 stays immutable/strict while explicit v2 conversion allows reviewed composition', () => {
  const original = v1(), previous = JSON.stringify(original), converted = convertV1(original);
  converted.blocks.push(extension);
  assert.equal(JSON.stringify(original), previous);
  assert.throws(() => parseV1({...original, blocks: converted.blocks}, original.guild_key));
  assert.equal(parseConfig({...converted, blocks: [extension]}, original.guild_key).blocks.length, 1);
  assert.equal(parseConfig(original, original.guild_key).schema_version, 'guild-launchpad.config/v1');
  assertAvailableBlocks(converted, new Set([extension.extension_id]));
});
test('v2 rejects arbitrary settings, URLs, fields, duplicate IDs/orders and guild substitution', () => {
  const body = {...convertV1(v1()), blocks: [extension]};
  for (const invalid of [
    {...body, blocks: [{...extension, settings: {script: 'alert(1)'}}]},
    {...body, blocks: [{...extension, extension_id: 'https://example.com/block.js'}]},
    {...body, blocks: [extension, {...extension, order: 8}]},
    {...body, blocks: [extension, {...extension, id: 'second'}]},
    {...body, admin: true}, {...body, support: {kind: 'guild_public_contact', public_url: 'javascript:alert(1)'}},
    {...body, blocks: [{...extension, title: 'hidden\ncontrol'}]},
  ]) assert.throws(() => parseConfig(invalid, body.guild_key));
  assert.throws(() => parseConfig(body, 'guild_security'));
});
test('unknown stored versions can render inert but cannot be published; public projection has no extension payload', () => {
  const body = {...convertV1(v1()), blocks: [{...extension, extension_id: 'guild-block.future.v9'}]};
  const loaded = parseConfig(body, body.guild_key);
  assert.throws(() => assertAvailableBlocks(loaded, new Set([extension.extension_id])));
  assert.equal('extensions' in publicSafeConfig(loaded), false);
  assert.deepEqual(publicSafeConfig(loaded).blocks, body.blocks);
});


test('layout edits and late adoption preserve mounted work and launch flows when leave is rejected', () => {
  const current = convertV1(v1());
  for (const kind of ['my_work', 'applications'] as const) {
    for (const change of ['disable', 'remove', 'replace-id'] as const) {
      const next = structuredClone(current);
      next.blocks = change === 'remove' ? next.blocks.filter(block => block.kind !== kind)
        : next.blocks.map(block => block.kind !== kind ? block : {...block, ...(change === 'disable' ? {enabled: false} : {id: 'replacement'})});
      let calls = 0;
      assert.equal(canReplaceLaunchpadLayout(current, next, {[kind]: () => {calls++; return false;}}), false, `${kind}/${change}`);
      assert.equal(calls, 1);
      assert.equal(canReplaceLaunchpadLayout(current, next, {[kind]: () => true}), true);
      assert.equal(canReplaceLaunchpadLayout(current, next, {}), true);
    }
  }
  assert.equal(canReplaceLaunchpadLayout(current, structuredClone(current), {my_work: () => {throw new Error('unchanged section');}}), true);
  assert.equal(canReplaceLaunchpadLayout(null, current, {my_work: () => {throw new Error('initial load');}}), true);
  const legacy = v1();
  legacy.blocks = legacy.blocks.map(block => block.kind === 'my_work' ? {...block, enabled: false} : block);
  assert.equal(canReplaceLaunchpadLayout(v1(), legacy, {my_work: () => {throw new Error('v1 work remains visible');}}), true);
  assert.equal(canReplaceLaunchpadLayout(legacy, {...legacy, schema_version: 'guild-launchpad.config/v2'}, {my_work: () => false}), false);
});

test('SupplySummaryView renders expected markup for each state in SSR', () => {
  const name = '山間茶作 · 示範供貨';
  const tenantId = '70000000-0000-4000-8000-000000000001';
  const instanceId = '70000000-0000-4000-8000-000000000002';
  const retry = () => {};

  // loading
  const loadingHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {kind: 'loading'}, name, tenantId, instanceId, retry,
  }));
  assert.equal(loadingHtml, '<p class="field-hint">正在讀取待辦…</p>');
  assert.equal(loadingHtml.includes('<button'), false);

  // ready with zeros -> 目前沒有待辦。
  const readyZeroHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {
      kind: 'ready',
      data: {
        profile: 'freedom.supplier-console.summary/v1',
        tenant_id: tenantId,
        instance_id: instanceId,
        as_of: '2026-10-15T00:00:00.000Z',
        todos: {state: 'ready', pending_requests: 0, outdated_offers: 0, out_of_stock_products: 0},
      },
    },
    name, tenantId, instanceId, retry,
  }));
  assert.equal(readyZeroHtml, '<p class="field-hint">目前沒有待辦。</p>');

  // ready otherwise
  const readyHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {
      kind: 'ready',
      data: {
        profile: 'freedom.supplier-console.summary/v1',
        tenant_id: tenantId,
        instance_id: instanceId,
        as_of: '2026-10-15T00:00:00.000Z',
        todos: {state: 'ready', pending_requests: 3, outdated_offers: 2, out_of_stock_products: 1},
      },
    },
    name, tenantId, instanceId, retry,
  }));
  assert.equal(readyHtml, '<p class="field-hint">待辦：待確認售價申請 3、供貨版本需重新公開 2、缺貨商品 1</p>');

  // unavailable: store_write_required -> 需要商品編輯權限才能查看待辦。 (no number rendered)
  const writeRequiredHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {
      kind: 'ready',
      data: {
        profile: 'freedom.supplier-console.summary/v1',
        tenant_id: tenantId,
        instance_id: instanceId,
        as_of: '2026-10-15T00:00:00.000Z',
        todos: {state: 'unavailable', reason: 'store_write_required'},
      },
    },
    name, tenantId, instanceId, retry,
  }));
  assert.equal(writeRequiredHtml, '<p class="field-hint">需要商品編輯權限才能查看待辦。</p>');
  assert.equal(/\d/.test(writeRequiredHtml), false);

  // read error -> 暫時無法讀取待辦。 + ghost button 重新讀取待辦 with catalog name (no number rendered)
  const errorHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {kind: 'error'}, name, tenantId, instanceId, retry,
  }));
  assert.match(errorHtml, /暫時無法讀取待辦。/);
  assert.match(errorHtml, /<button[^>]*class="btn btn-ghost btn-small"[^>]*>重新讀取待辦<span class="sr-only">：山間茶作 · 示範供貨<\/span><\/button>/);
  assert.equal(/\d/.test(errorHtml), false);

  // mismatched tenant_id renders error text + button with name (no number rendered)
  const mismatchedTenantHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {
      kind: 'ready',
      data: {
        profile: 'freedom.supplier-console.summary/v1',
        tenant_id: '70000000-0000-4000-8000-999999999999',
        instance_id: instanceId,
        as_of: '2026-10-15T00:00:00.000Z',
        todos: {state: 'ready', pending_requests: 5, outdated_offers: 2, out_of_stock_products: 1},
      },
    },
    name, tenantId, instanceId, retry,
  }));
  assert.match(mismatchedTenantHtml, /暫時無法讀取待辦。/);
  assert.match(mismatchedTenantHtml, /重新讀取待辦/);
  assert.match(mismatchedTenantHtml, new RegExp(name));
  assert.equal(/\d/.test(mismatchedTenantHtml), false);

  // mismatched instance_id renders error text + button with name (no number rendered)
  const mismatchedInstanceHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {
      kind: 'ready',
      data: {
        profile: 'freedom.supplier-console.summary/v1',
        tenant_id: tenantId,
        instance_id: '70000000-0000-4000-8000-999999999999',
        as_of: '2026-10-15T00:00:00.000Z',
        todos: {state: 'ready', pending_requests: 5, outdated_offers: 2, out_of_stock_products: 1},
      },
    },
    name, tenantId, instanceId, retry,
  }));
  assert.match(mismatchedInstanceHtml, /暫時無法讀取待辦。/);
  assert.match(mismatchedInstanceHtml, /重新讀取待辦/);
  assert.match(mismatchedInstanceHtml, new RegExp(name));
  assert.equal(/\d/.test(mismatchedInstanceHtml), false);

  // denied -> empty markup
  const deniedHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {kind: 'denied'}, name, tenantId, instanceId, retry,
  }));
  assert.equal(deniedHtml, '');

  // unavailable -> empty markup
  const unavailableHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {kind: 'unavailable'}, name, tenantId, instanceId, retry,
  }));
  assert.equal(unavailableHtml, '');

  // visitor -> empty markup
  const visitorHtml = renderToStaticMarkup(createElement(SupplySummaryView, {
    state: {kind: 'visitor'}, name, tenantId, instanceId, retry,
  }));
  assert.equal(visitorHtml, '');
});

test('CatalogBlock source passes guildPresentationImportsProven', () => {
  const path = 'modules/guild-supply/CatalogBlock.tsx';
  const source = readFileSync(new URL('../../modules/guild-supply/CatalogBlock.tsx', import.meta.url), 'utf8');
  assert.equal(guildPresentationImportsProven(path, source), true);
});
