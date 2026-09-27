-- Member-submitted events require a current platform admin or host guild master review.
-- RSVP is interest/attendance intent, never a contribution.
CREATE TABLE community_events (
  event_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  organizer_ref uuid NOT NULL REFERENCES users,
  guild_key text REFERENCES positioning_guild_catalog,
  title text NOT NULL,
  description text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('online','in_person','hybrid')),
  location text NOT NULL,
  capacity integer CHECK (capacity BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','published','rejected','cancelled')),
  reviewer_user_ref uuid REFERENCES users,
  reviewer_admin_ref uuid REFERENCES platform_admins,
  review_reason text,
  reviewed_at timestamptz,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK ((reviewed_at IS NULL AND reviewer_user_ref IS NULL AND reviewer_admin_ref IS NULL)
    OR (reviewed_at IS NOT NULL AND num_nonnulls(reviewer_user_ref,reviewer_admin_ref)=1))
);
CREATE INDEX community_events_upcoming ON community_events (community_id, starts_at, event_id);
CREATE INDEX community_events_review_queue ON community_events (community_id,guild_key,created_at) WHERE state='pending';

-- The system bulletin is a durable projection of accepted commands, not chat text.
CREATE TABLE community_event_bulletins (
  bulletin_id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES community_events,
  community_id uuid NOT NULL REFERENCES communities,
  kind text NOT NULL CHECK (kind IN ('submitted','approved','rejected')),
  actor_name text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,kind)
);
CREATE INDEX community_event_bulletins_recent ON community_event_bulletins (community_id,created_at DESC,bulletin_id DESC);

ALTER TABLE member_notifications DROP CONSTRAINT member_notifications_kind_check;
ALTER TABLE member_notifications ADD CONSTRAINT member_notifications_kind_check CHECK (kind IN (
  'friend_request','friend_accepted','friend_declined','squad_invitation',
  'guild_application_approved','guild_application_rejected',
  'guild_expert_appointed','guild_expert_revoked',
  'guild_master_appointed','guild_master_revoked',
  'event_submitted','event_review_needed','event_approved','event_rejected'));
ALTER TABLE member_notifications DROP CONSTRAINT member_notifications_action_tab_check;
ALTER TABLE member_notifications ADD CONSTRAINT member_notifications_action_tab_check
  CHECK (action_tab IN ('members','squads','guilds','guild-workspace','messages','events'));

CREATE TABLE community_event_rsvps (
  rsvp_id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES community_events,
  user_id uuid NOT NULL REFERENCES users,
  state text NOT NULL CHECK (state IN ('going','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  UNIQUE (event_id,user_id)
);
CREATE INDEX community_event_rsvps_count ON community_event_rsvps (event_id) WHERE state='going';
