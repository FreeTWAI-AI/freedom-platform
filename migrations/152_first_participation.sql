CREATE TABLE member_first_participation (
  user_id uuid PRIMARY KEY REFERENCES users(user_id),
  community_id uuid NOT NULL REFERENCES communities(community_id),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  choice text CHECK (choice IN ('work','introduction')),
  state text NOT NULL DEFAULT 'offered' CHECK (state IN ('offered','chosen','skipped','dismissed')),
  guild_key text REFERENCES positioning_guild_catalog(guild_key),
  started_at timestamptz,
  reception_requested boolean NOT NULL DEFAULT false,
  reception_stopped boolean NOT NULL DEFAULT false,
  claimant_ref uuid REFERENCES users(user_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((choice IS NULL AND started_at IS NULL) OR (choice IS NOT NULL AND started_at IS NOT NULL)),
  CHECK (claimant_ref IS NULL OR (reception_requested AND claimant_ref <> user_id)),
  CHECK (NOT reception_requested OR NOT reception_stopped)
);
CREATE INDEX member_first_participation_reception ON member_first_participation(community_id,updated_at,user_id) WHERE reception_requested;
