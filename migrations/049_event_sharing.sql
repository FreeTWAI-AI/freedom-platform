-- Existing member-visible events do not become public merely by upgrading.
ALTER TABLE community_events DROP CONSTRAINT community_events_visibility_check;
ALTER TABLE community_events DROP CONSTRAINT community_event_guild_visibility;
UPDATE community_events SET visibility='workshop' WHERE visibility='public';
ALTER TABLE community_events ALTER COLUMN visibility SET DEFAULT 'workshop';
ALTER TABLE community_events ADD CONSTRAINT community_events_visibility_check
  CHECK (visibility IN ('guild','workshop','referral','open'));
ALTER TABLE community_events ADD CONSTRAINT community_event_guild_visibility
  CHECK (visibility<>'guild' OR (event_kind='guild_skill_exchange' AND guild_key IS NOT NULL));

CREATE TABLE community_event_share_codes (
  event_id uuid NOT NULL REFERENCES community_events(event_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id),
  code text NOT NULL UNIQUE CHECK (length(code) BETWEEN 16 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id,user_id)
);
ALTER TABLE community_event_rsvps ADD COLUMN referred_by_user_id uuid REFERENCES users(user_id);
CREATE INDEX community_event_rsvps_referral ON community_event_rsvps(event_id,referred_by_user_id)
  WHERE state='going' AND referred_by_user_id IS NOT NULL;

CREATE TABLE community_event_guest_rsvps (
  event_id uuid NOT NULL REFERENCES community_events(event_id) ON DELETE CASCADE,
  email text NOT NULL,
  name text NOT NULL,
  referred_by_user_id uuid REFERENCES users(user_id),
  email_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id,email)
);
CREATE INDEX community_event_guest_referral ON community_event_guest_rsvps(event_id,referred_by_user_id)
  WHERE email_sent_at IS NOT NULL AND referred_by_user_id IS NOT NULL;
