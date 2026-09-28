-- Event formats and participation details are independent of the review route.
-- Existing events remain valid and retain their original location text.
ALTER TABLE community_events
  ADD COLUMN event_kind text NOT NULL DEFAULT 'other'
    CHECK (event_kind IN ('reading_group','meetup','guild_skill_exchange','other')),
  ADD COLUMN topic text,
  ADD COLUMN online_url text;
ALTER TABLE community_events
  ADD CONSTRAINT community_events_reading_topic CHECK (event_kind <> 'reading_group' OR nullif(trim(topic),'') IS NOT NULL),
  ADD CONSTRAINT community_events_hybrid_url CHECK (mode <> 'hybrid' OR online_url IS NOT NULL) NOT VALID;
