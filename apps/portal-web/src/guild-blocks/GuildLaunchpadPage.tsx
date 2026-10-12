import type {ComponentProps} from 'react';
import {GuildLaunchpad as Shell, PublicGuildLaunchpad as PublicShell} from '../modules/GuildLaunchpad';
import {guildBlockLoaders} from './registry.generated';

/** Application composition injects reviewed code; the shared shell has no guild imports. */
export function GuildLaunchpad(props: Omit<ComponentProps<typeof Shell>, 'blockLoaders'>) {
  return <Shell {...props} blockLoaders={guildBlockLoaders}/>;
}
export function PublicGuildLaunchpad(props: Omit<ComponentProps<typeof PublicShell>, 'blockLoaders'>) {
  return <PublicShell {...props} blockLoaders={guildBlockLoaders}/>;
}
