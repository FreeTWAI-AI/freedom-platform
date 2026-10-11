import type {LaunchpadApplication} from '../../../../../contracts/guild-launchpad/v1/module-registry';
import type {ReactNode} from 'react';
import {PageErrorBoundary} from '../../LazyPage';
import {selectGuildBlocks, GUILD_BLOCK_COMPOSITION} from './composition';
import type {GuildBlockContext as Context, GuildBlockDefinition as Definition} from '../../../../../packages/shared/guild-block-ui';
type GuildBlockContext = Context<LaunchpadApplication>;
type GuildBlockDefinition = Definition<LaunchpadApplication>;

/** One host seam; v1 core sections and their leave guards stay owned by GuildLaunchpad. */
export function GuildBlockHost({context, primary, children, composition = GUILD_BLOCK_COMPOSITION}: {
  context: GuildBlockContext; primary: ReactNode; children: ReactNode; composition?: readonly GuildBlockDefinition[];
}) {
  const selection = selectGuildBlocks(context, composition);
  const render = (block: GuildBlockDefinition) => <PageErrorBoundary
    key={`${block.id}@${block.version}:${context.guildKey}:${context.userId ?? 'visitor'}:${context.client.sessionGeneration}:${context.mode}:${context.visitor}:${context.memberTier ?? ''}`}
    fallback={<p role="alert">這個公會區塊暫時無法顯示；其他內容仍可使用。</p>}>
    <block.Component {...context}/>
  </PageErrorBoundary>;
  const customPrimary = selection.blocks.find(block => block.slot === 'primary');
  return <>
    {customPrimary ? render(customPrimary) : primary}
    {children}
    {selection.unavailable && <p role="alert">這個公會的附加區塊版本目前無法顯示。</p>}
    {selection.blocks.filter(block => block.slot === 'after_core').map(render)}
  </>;
}
