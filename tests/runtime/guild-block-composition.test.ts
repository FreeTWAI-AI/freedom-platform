import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PortalClient} from '../../apps/portal-web/src/api.js';
import {BLOCK_KINDS, parseConfig} from '../../contracts/guild-launchpad/v1/config.js';
import {defaultConfigFor} from '../../modules/guild-workspace/launchpad-config.js';
import {GuildBlockHost} from '../../apps/portal-web/src/modules/guild-blocks/GuildBlockHost.js';
import {GUILD_BLOCK_COMPOSITION, guildStorePath, selectGuildBlocks} from '../../apps/portal-web/src/modules/guild-blocks/composition.js';
import {UpcomingEventsContent, upcomingEvents, loadUpcomingEvents} from '../../apps/portal-web/src/modules/guild-blocks/UpcomingEventsBlock.js';
import type {GuildBlockContext as Context, GuildBlockDefinition as Definition} from '../../packages/shared/guild-block-ui.js';
import type {LaunchpadApplication} from '../../contracts/guild-launchpad/v1/module-registry.js';
type GuildBlockContext = Context<LaunchpadApplication>;
type GuildBlockDefinition = Definition<LaunchpadApplication>;

const context = (patch: Partial<GuildBlockContext> = {}): GuildBlockContext => ({
  client: new PortalClient(), guildKey: 'guild_product_quality_supply', userId: 'synthetic', memberTier: 'full',
  visitor: false, mode: 'member', showPrimary: true, onCreate() {}, navigate: () => false,
  primary: {application_key: 'hosted-store', release_ref: 'hosted-store@1.0.0', display_name: '商店',
    eligibility: {can_launch: false, tenant_action: 'create', reason_codes: ['tenant_manage_required'], required_guild_tier: 'full', policy_revision: '1'}}, ...patch,
});
const renderHost = (value: GuildBlockContext, composition = GUILD_BLOCK_COMPOSITION) => renderToStaticMarkup(createElement(GuildBlockHost,
  {context: value, composition, primary: createElement('p', null, 'Original primary'), children: createElement('p', null, 'Original seven blocks')}));

test('v1 remains exactly seven strict blocks and an empty extensions object, including custom guilds', () => {
  const key = 'guild_custom_0123456789abcdef0123456789abcdef';
  const config = defaultConfigFor({guild_key: key, name: '自訂公會', purpose: '原本使命'});
  assert.deepEqual(parseConfig(config, key), config);
  assert.deepEqual(config.blocks.map(block => block.kind), BLOCK_KINDS);
  assert.throws(() => parseConfig({...config, extensions: {'upcoming-events': {version: 1}}}, key));
  assert.throws(() => parseConfig({...config, blocks: [...config.blocks, {id: 'future', kind: 'upcoming-events', enabled: true, title: null, order: 10}]}, key));
  assert.throws(() => parseConfig({...config, schema_version: 'guild-launchpad.config/v2'}, key));
  assert.deepEqual(selectGuildBlocks(context({guildKey: key})), {blocks: [], unavailable: false});
});

test('supplier composition honors the existing chosen primary and disabled applications visibility', () => {
  assert.equal(selectGuildBlocks(context()).blocks[0]?.id, 'supplier-overview');
  assert.equal(selectGuildBlocks(context({showPrimary: false})).blocks.length, 0);
  assert.equal(selectGuildBlocks(context({primary: undefined})).blocks.length, 0);
  assert.equal(selectGuildBlocks(context({primary: {...context().primary!, application_key: 'manual-workspace'}})).blocks.length, 0);
  assert.equal(guildStorePath('guild_product_quality_supply', 'tenant', 'instance'), '#stores/tenant/instance/supply');
  assert.equal(guildStorePath('guild_commerce_sales', 'tenant', 'instance'), '#stores/tenant/instance');
});

test('supplier loading and intern states retain the existing action and never imply write permission', () => {
  assert.match(renderHost(context()), /正在確認你的供貨資料/);
  assert.match(renderHost(context({memberTier: 'intern'})), /實習成員/);
  assert.doesNotMatch(renderHost(context({memberTier: 'intern'})), /正在確認你的供貨資料/);
  const visitor = renderHost(context({visitor: true, mode: 'public', userId: undefined, showPrimary: false}));
  assert.match(visitor, /Original seven blocks/);
  assert.doesNotMatch(visitor, /商品與供貨/);
});

test('unknown composition versions and duplicate primary registrations preserve original core', () => {
  const invalid = {...GUILD_BLOCK_COMPOSITION[0], version: 2} as unknown as GuildBlockDefinition;
  for (const entries of [[invalid], [GUILD_BLOCK_COMPOSITION[0], {...GUILD_BLOCK_COMPOSITION[0], id: 'duplicate-primary'}]]) {
    const html = renderHost(context(), entries);
    assert.match(html, /Original primary/); assert.match(html, /Original seven blocks/);
    assert.match(html, /附加區塊版本目前無法顯示/); assert.doesNotMatch(html, /正在確認你的供貨資料/);
  }
});

test('third reviewed build-time component renders without changing App or GuildLaunchpad', () => {
  const third: GuildBlockDefinition = {id: 'synthetic-third', version: 1, guildKeys: ['guild_test'], slot: 'after_core',
    surfaceIds: ['community.events-page'], Component: () => createElement('p', null, 'Third synthetic block')};
  const html = renderHost(context({guildKey: 'guild_test'}), [...GUILD_BLOCK_COMPOSITION, third]);
  assert.match(html, /Third synthetic block/); assert.match(html, /Original seven blocks/);
  for (const path of ['apps/portal-web/src/App.tsx', 'apps/portal-web/src/modules/GuildLaunchpad.tsx']) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /synthetic-third|SupplierBlock|UpcomingEventsBlock/);
  }
  assert.doesNotMatch(readFileSync('apps/portal-web/src/modules/GuildLaunchpad.tsx', 'utf8'), /guild_product_quality_supply|supplyPrimary/);
});

test('composition surface references exist in the original ownership descriptors', () => {
  const surfaces = ['modules/agent-commerce/freedom.module.json', 'modules/community/freedom.module.json']
    .flatMap(path => (JSON.parse(readFileSync(path, 'utf8')).surfaces as {surface_id: string}[]).map(surface => surface.surface_id));
  for (const block of GUILD_BLOCK_COMPOSITION) for (const id of block.surfaceIds) assert.ok(surfaces.includes(id), id);
});

const event = (last: string, patch = {}) => ({event_id: `00000000-0000-4000-8000-00000000000${last}`, title: `合成活動 ${last}`, starts_at: `2099-10-${last.padStart(2,'0')}T10:00:00Z`, state: 'published', ...patch});
test('events only show the first three future published authorized results, with a deterministic order', () => {
  const items = [event('4'), event('2'), event('1'), event('3'), event('5', {state: 'pending'}), event('6', {state: 'cancelled'}), event('7', {starts_at: '2020-10-01T10:00:00Z'})];
  assert.deepEqual(upcomingEvents({items}, Date.parse('2026-10-11T00:00:00Z')).map(item => item.title), ['合成活動 1','合成活動 2','合成活動 3']);
  assert.equal(items[0].title, '合成活動 4');
  assert.throws(() => upcomingEvents({items: [event('1', {event_id: 'https://untrusted.example'})]}));
  assert.throws(() => upcomingEvents({items: [event('1', {starts_at: 'invalid'})]}));
});

test('event loading, empty, error and visitor states are explicit; detail links use the original event domain', () => {
  const render = (state: Parameters<typeof UpcomingEventsContent>[0]['state']) => renderToStaticMarkup(createElement(UpcomingEventsContent, {state, retry() {}, navigate: () => false}));
  assert.match(render({status: 'loading'}), /正在讀取近期活動/);
  assert.match(render({status: 'error'}), /role="alert".*暫時無法讀取近期活動/);
  assert.match(render({status: 'error'}), /重試/);
  assert.match(render({status: 'ready', items: []}), /目前沒有可顯示的近期活動/);
  assert.match(render({status: 'ready', items: upcomingEvents({items: [event('1')]})}), /href="#events\/00000000-0000-4000-8000-000000000001"/);
  const visitor = renderHost(context({guildKey: 'guild_event_space', visitor: true, mode: 'public', userId: undefined, showPrimary: false}));
  assert.match(visitor, /登入並加入公會後/); assert.doesNotMatch(visitor, /正在讀取近期活動|href="#events/);
});


test('event reads discard completion after abort or session replacement, and recover through a fresh read', async () => {
  for (const invalidate of ['abort', 'session'] as const) {
    let resolve: (raw: unknown) => void = () => undefined;
    class DeferredClient extends PortalClient {
      override get<T>(): Promise<T> {return new Promise<T>(done => {resolve = raw => done(raw as T);});}
    }
    const client = new DeferredClient(); const controller = new AbortController();
    const states: string[] = [];
    const pending = loadUpcomingEvents(client, controller.signal, state => states.push(state.status));
    if (invalidate === 'abort') controller.abort(); else client.csrfToken = 'synthetic-session-replacement';
    resolve({items: [event('1')]}); await pending;
    assert.deepEqual(states, ['loading']);
  }
  class RecoveringClient extends PortalClient {
    calls = 0;
    override async get<T>(path: string): Promise<T> {assert.equal(path, '/events'); if (++this.calls === 1) throw Error('Synthetic error'); return {items: []} as T;}
  }
  const client = new RecoveringClient(); const states: string[] = [];
  await loadUpcomingEvents(client, new AbortController().signal, state => states.push(state.status));
  await loadUpcomingEvents(client, new AbortController().signal, state => states.push(state.status));
  assert.deepEqual(states, ['loading', 'error', 'loading', 'ready']);
});

test('event links always delegate navigation to the host, so a rejecting leave guard keeps the current page', () => {
  const paths: string[] = []; let prevented = 0;
  const element = UpcomingEventsContent({state: {status: 'ready', items: upcomingEvents({items: [event('1')]})}, retry() {}, navigate: path => {paths.push(path);return false;}});
  function visit(node: unknown) {
    if (Array.isArray(node)) {node.forEach(visit); return;}
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const value = node as {type?: unknown; props: {children?: unknown; onClick?: (event: {preventDefault: () => void}) => void}};
    if (value.type === 'a') value.props.onClick?.({preventDefault: () => prevented++});
    visit(value.props.children);
  }
  visit(element);
  assert.deepEqual(paths, ['#events/00000000-0000-4000-8000-000000000001', '#events']);
  assert.equal(prevented, 2);
});


test('the public UI interface is neutral and domain blocks have no shell import dependency', () => {
  const contract = 'packages/shared/guild-block-ui.ts';
  const shared = JSON.parse(readFileSync('packages/shared/freedom.module.json', 'utf8'));
  assert.ok(shared.owned_paths.includes(contract)); assert.ok(shared.public_exports.includes(contract));
  assert.deepEqual(shared.dependencies, []);
  assert.doesNotMatch(readFileSync(contract, 'utf8'), /from ['"].*(?:apps|modules|contracts)|import (?!type)/);
  for (const file of ['SupplierBlock.tsx', 'UpcomingEventsBlock.tsx']) {
    const source = readFileSync(`apps/portal-web/src/modules/guild-blocks/${file}`, 'utf8');
    assert.doesNotMatch(source, /from ['"].*(?:GuildBlockHost|composition|GuildLaunchpad|\.\/types)/);
    assert.match(source, /import type .*packages\/shared\/guild-block-ui/);
  }
  const supplier = JSON.parse(readFileSync('modules/agent-commerce/hosted/freedom.module.json', 'utf8'));
  assert.ok(supplier.dependencies.includes('shared')); assert.ok(supplier.dependencies.includes('module-registry'));
  assert.ok(!supplier.dependencies.includes('guild-workspace'));
  const community = JSON.parse(readFileSync('modules/community/freedom.module.json', 'utf8'));
  assert.ok(community.dependencies.includes('shared')); assert.ok(!community.dependencies.includes('guild-workspace'));
});
