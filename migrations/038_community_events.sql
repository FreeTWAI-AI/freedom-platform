-- Member-published events. RSVP is interest/attendance intent, never a contribution.
CREATE TABLE community_events (
  event_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  organizer_ref uuid NOT NULL REFERENCES users,
  title text NOT NULL,
  description text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('online','in_person','hybrid')),
  location text NOT NULL,
  capacity integer CHECK (capacity BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'published' CHECK (state IN ('published','cancelled')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX community_events_upcoming ON community_events (community_id, starts_at, event_id);

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
