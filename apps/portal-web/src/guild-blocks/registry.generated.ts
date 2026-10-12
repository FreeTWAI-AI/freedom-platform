// Generated from existing freedom.module.json surfaces; do not edit.
import type {GuildBlockModule} from './runtime';

export const guildBlockLoaders: Readonly<Record<string, () => Promise<GuildBlockModule>>> = {
  "guild-block.open-source-works.v1": () => import("../../../../modules/guild-open-source/WorksBlock"),
  "guild-block.supply-catalog.v1": () => import("../../../../modules/guild-supply/CatalogBlock"),
};
