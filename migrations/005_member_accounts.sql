ALTER TABLE users ADD COLUMN onboarding_required boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN onboarding_completed_at timestamptz;
-- Login identity is not provider ownership, and starts unverified.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
CREATE TABLE member_accounts (
  user_id uuid PRIMARY KEY REFERENCES users, community_id uuid NOT NULL REFERENCES communities,
  contacts jsonb NOT NULL DEFAULT '{"discord":{"value":"","visibility":"private"},"github":{"value":"","visibility":"private"},"line":{"value":"","visibility":"private"},"email":{"value":"","visibility":"private"}}',
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0)
);
CREATE TABLE auth_rate_limits (
  bucket text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE member_friendships (
  community_id uuid NOT NULL REFERENCES communities, low_ref uuid NOT NULL REFERENCES users,
  high_ref uuid NOT NULL REFERENCES users, requester_ref uuid NOT NULL REFERENCES users,
  state text NOT NULL CHECK(state IN ('pending','accepted','removed')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(community_id,low_ref,high_ref),
  CHECK(low_ref<high_ref), CHECK(requester_ref=low_ref OR requester_ref=high_ref)
);
CREATE TABLE member_squads (
  squad_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), kind text NOT NULL CHECK(kind IN ('project','mutual_help')),
  purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 800), owner_ref uuid NOT NULL REFERENCES users,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE member_squad_memberships (
  squad_id uuid NOT NULL REFERENCES member_squads, user_id uuid NOT NULL REFERENCES users,
  state text NOT NULL CHECK(state IN ('pending','active','left')), aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(squad_id,user_id)
);
CREATE INDEX member_squad_members_by_user ON member_squad_memberships(user_id,state);
CREATE INDEX member_squads_by_community ON member_squads(community_id,created_at);
