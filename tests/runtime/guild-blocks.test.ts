import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import CatalogBlock from '../../modules/guild-supply/CatalogBlock';
import WorksBlock from '../../modules/guild-open-source/WorksBlock';
import {GuildBlock} from '../../apps/portal-web/src/guild-blocks/runtime';
import type {GuildBlockProps} from '../../packages/guild-presentation/block';
import {BLOCK_KINDS, parseConfig as parseV1} from '../../contracts/guild-launchpad/v1/config';
import {parseConfig, convertV1, assertAvailableBlocks, publicSafeConfig} from '../../contracts/guild-launchpad/v2/config';
// @ts-expect-error Build tooling is a native ESM JavaScript module.
import {collectGuildBlocks, renderRegistry} from '../../scripts/generate-guild-blocks.mjs';

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
