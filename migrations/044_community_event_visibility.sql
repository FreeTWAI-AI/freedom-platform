ALTER TABLE community_events ADD COLUMN visibility text NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public','guild'));
ALTER TABLE community_events ADD CONSTRAINT community_event_guild_visibility
  CHECK (visibility='public' OR (event_kind='guild_skill_exchange' AND guild_key IS NOT NULL));
