import type {ComponentProps} from 'react';
import {GuildsPanel as Directory} from '../modules/PositioningPanels';
import {guildBlockLoaders} from './registry.generated';

export function GuildsPanel(props: Omit<ComponentProps<typeof Directory>, 'blockLoaders'>) {
  return <Directory {...props} blockLoaders={guildBlockLoaders}/>;
}
