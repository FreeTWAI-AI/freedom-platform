import type {BlockKind} from '../../contracts/guild-launchpad/v1/config.js';

type PurposeProfile = {
  readonly block_order: readonly BlockKind[];
  readonly preferred_applications: readonly string[];
};

export const LAUNCHPAD_PROFILES: Readonly<Partial<Record<string, PurposeProfile>>> = Object.freeze({
  guild_talent_direction: Object.freeze({
    block_order: Object.freeze(['mission', 'my_work', 'skill_books', 'announcements', 'applications', 'community_tasks', 'support'] as const),
    preferred_applications: Object.freeze(['manual-workspace']),
  }),
  guild_commerce_sales: Object.freeze({
    block_order: Object.freeze(['mission', 'applications', 'my_work', 'announcements', 'skill_books', 'community_tasks', 'support'] as const),
    preferred_applications: Object.freeze(['hosted-store', 'manual-workspace']),
  }),
  guild_commercial_production: Object.freeze({
    block_order: Object.freeze(['mission', 'my_work', 'skill_books', 'announcements', 'applications', 'community_tasks', 'support'] as const),
    preferred_applications: Object.freeze(['manual-workspace']),
  }),
});
