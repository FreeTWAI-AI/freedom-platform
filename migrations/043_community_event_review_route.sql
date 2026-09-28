-- Keep the organizer's guild separate from the guild responsible for review.
ALTER TABLE community_events ADD COLUMN review_guild_key text REFERENCES positioning_guild_catalog;
-- Preserve the assigned reviewer for existing pending and published events.
UPDATE community_events SET review_guild_key=guild_key;
