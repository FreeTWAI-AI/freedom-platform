-- Owner-designated appointments stay pending until the nominated person proves
-- both their Access identity and the matching signed-in platform membership.
-- Real addresses and nominee mappings are provisioned privately, not in source.
CREATE TABLE guild_leadership_nominations (
  community_id uuid NOT NULL REFERENCES communities,
  guild_key text NOT NULL REFERENCES positioning_guild_catalog,
  admin_id uuid NOT NULL REFERENCES platform_admins,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','bound','revoked')),
  bound_user_id uuid REFERENCES users,
  nominated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  PRIMARY KEY(community_id,guild_key),
  CHECK((state='bound')=(bound_user_id IS NOT NULL AND activated_at IS NOT NULL))
);
