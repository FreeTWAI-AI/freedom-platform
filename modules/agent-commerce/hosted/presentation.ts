import type { Pool } from 'pg';
import {
  STOREFRONT_PRESENTATION_PROFILE, StoreAppearanceInputSchema, StoreAppearanceSchema,
} from '../../../contracts/guild-launchpad/v1/storefront-presentation.js';
import { checkVersion } from '../../../packages/db/index.js';
import type { Actor } from '../../identity-membership/service.js';
import { profile, ready, storeCommand, storeFact, storeRead, type Profile } from './store.js';

function appearance(p: Profile) {
  return StoreAppearanceSchema.parse({ profile: STOREFRONT_PRESENTATION_PROFILE,
    template_id: p.template_id, published_template_id: p.published_template_id, version: p.version });
}
export async function readStoreAppearance(pool: Pool, actor: Actor, tenantId: string, instanceId: string) {
  return storeRead(pool, actor, tenantId, instanceId, 'store:read', async q => {
    const p = await profile(q, tenantId, instanceId); ready(p); return appearance(p);
  });
}
export async function updateStoreAppearance(pool: Pool, actor: Actor, tenantId: string, instanceId: string,
  raw: unknown, key: string, expected: string) {
  const input = StoreAppearanceInputSchema.parse(raw);
  return storeCommand(pool, actor, tenantId, instanceId, 'store:manage', 'storefront.appearance.update', input, key, expected, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p); checkVersion(p.version, expected);
    if (p.template_id === input.template_id) return appearance(p);
    await q.query(`UPDATE commerce_storefront_profiles SET template_id=$3,version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND instance_id=$2`, [tenantId, instanceId, input.template_id]);
    await storeFact(q, context, instanceId, String(BigInt(p.version) + 1n), 'storefront.appearance.update');
    return appearance({ ...p, template_id: input.template_id, version: String(BigInt(p.version) + 1n) });
  });
}
