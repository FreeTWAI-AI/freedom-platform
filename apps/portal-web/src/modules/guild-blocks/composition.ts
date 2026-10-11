import type {LaunchpadApplication} from '../../../../../contracts/guild-launchpad/v1/module-registry';
import {SupplierBlock, supplierStorePath} from './SupplierBlock';
import {UpcomingEventsBlock} from './UpcomingEventsBlock';
import type {GuildBlockContext as Context, GuildBlockDefinition as Definition} from '../../../../../packages/shared/guild-block-ui';
type GuildBlockContext = Context<LaunchpadApplication>;
type GuildBlockDefinition = Definition<LaunchpadApplication>;

/** Build-time composition, separate from stored guild-launchpad.config/v1.
 * Add reviewed imports here, never URLs, fetched scripts, capability grants or user configuration.
 * Ownership/dependencies remain in the existing freedom.module.json descriptors.
 */
export const GUILD_BLOCK_COMPOSITION: readonly GuildBlockDefinition[] = [
  {id: 'supplier-overview', version: 1, guildKeys: ['guild_product_quality_supply'], slot: 'primary',
    primaryApplicationKey: 'hosted-store', surfaceIds: ['commerce.hosted-store-api', 'commerce.hosted-store-page'],
    Component: SupplierBlock, storePath: supplierStorePath},
  {id: 'upcoming-events', version: 1, guildKeys: ['guild_event_space'], slot: 'after_core',
    surfaceIds: ['community.community-events.member-api', 'community.events-page'], Component: UpcomingEventsBlock},
];

export function selectGuildBlocks(context: GuildBlockContext, composition = GUILD_BLOCK_COMPOSITION) {
  const selected = composition.filter(block => block.guildKeys.includes(context.guildKey));
  const ids = new Set<string>();
  // A malformed/unsupported build entry cannot hide the existing core or choose an arbitrary renderer.
  for (const block of selected) {
    if (block.version !== 1 || !block.id || ids.has(block.id)
      || !['primary', 'after_core'].includes(block.slot) || typeof block.Component !== 'function') return {blocks: [], unavailable: true};
    ids.add(block.id);
  }
  if (selected.filter(block => block.slot === 'primary').length > 1) return {blocks: [], unavailable: true};
  return {blocks: selected.filter(block => block.slot !== 'primary'
    || (!context.visitor && context.mode === 'member' && Boolean(context.userId) && context.showPrimary && block.primaryApplicationKey === context.primary?.application_key)), unavailable: false};
}

export function guildStorePath(guildKey: string, tenantId: string, instanceId: string) {
  const entry = GUILD_BLOCK_COMPOSITION.find(block => block.version === 1 && block.guildKeys.includes(guildKey) && block.storePath);
  return entry?.storePath?.(tenantId, instanceId) ?? `#stores/${tenantId}/${instanceId}`;
}
