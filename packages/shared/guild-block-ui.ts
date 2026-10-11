import type {ComponentType} from 'react';

/** Minimal structural reader implemented by the existing portal client; no new transport. */
export type UiReadClient = {
  readonly sessionGeneration: number;
  get<T>(path: string, options?: {signal?: AbortSignal}): Promise<T>;
};

/** Reviewed, bundled UI only. These props and surface references grant no authority. */
export type GuildBlockContext<TApplication> = {
  client: UiReadClient;
  guildKey: string;
  userId?: string;
  memberTier?: string;
  visitor: boolean;
  mode: 'member' | 'public';
  primary?: TApplication;
  showPrimary: boolean;
  onCreate: () => void;
  navigate: (path: string) => boolean;
};
export type GuildBlockDefinition<TApplication> = {
  id: string;
  version: 1;
  guildKeys: readonly string[];
  slot: 'primary' | 'after_core';
  surfaceIds: readonly string[];
  Component: ComponentType<GuildBlockContext<TApplication>>;
  primaryApplicationKey?: string;
  storePath?: (tenantId: string, instanceId: string) => string;
};
