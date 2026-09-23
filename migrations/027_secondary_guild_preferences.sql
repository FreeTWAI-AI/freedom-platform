-- A display preference, never a guild office or an authorization grant.
-- NULL supports read-only legacy imports; {} means no secondary choices.
ALTER TABLE guild_member_preferences ADD COLUMN secondary_guild_keys text[];
ALTER TABLE guild_member_preferences ADD CONSTRAINT secondary_guild_preferences_valid CHECK (
  secondary_guild_keys IS NULL OR (
    cardinality(secondary_guild_keys) <= 2
    AND array_position(secondary_guild_keys,NULL) IS NULL
    AND NOT primary_guild_key = ANY(secondary_guild_keys)
    AND (cardinality(secondary_guild_keys) < 2 OR secondary_guild_keys[1] <> secondary_guild_keys[2])
  )
);

-- Freeze the choices visible at upgrade, including [] for no active secondaries.
-- All future join paths (including administrator appointments) preserve them.
UPDATE guild_member_preferences p SET secondary_guild_keys=ARRAY(
  SELECT m.guild_key FROM positioning_profession_memberships m
  WHERE m.community_id=p.community_id AND m.user_id=p.user_id
    AND m.state='active' AND m.guild_key<>p.primary_guild_key
  ORDER BY m.guild_key LIMIT 2
) WHERE p.secondary_guild_keys IS NULL;
