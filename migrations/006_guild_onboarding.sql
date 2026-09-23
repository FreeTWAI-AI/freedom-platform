-- Assessment inputs are private member data; recommendations are reproducible suggestions.
CREATE TABLE onboarding_assessments (
  assessment_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users, aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  assessment_version text NOT NULL, assessment_sha256 text NOT NULL CHECK(assessment_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('draft','evaluated','completed')),
  answers jsonb NOT NULL DEFAULT '{}', occupation text NOT NULL DEFAULT '', founding_interest boolean NOT NULL DEFAULT false,
  capabilities text[] NOT NULL DEFAULT '{}', equipment text[] NOT NULL DEFAULT '{}', result jsonb, published_profile jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(community_id,user_id)
);
CREATE TABLE guild_member_preferences (
  community_id uuid NOT NULL REFERENCES communities, user_id uuid NOT NULL REFERENCES users,
  primary_guild_key text NOT NULL REFERENCES positioning_guild_catalog,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(community_id,user_id)
);
CREATE TABLE member_skill_book_grants (
  grant_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities, user_id uuid NOT NULL REFERENCES users,
  guild_key text NOT NULL REFERENCES positioning_guild_catalog, book_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(), UNIQUE(community_id,user_id,guild_key,book_id)
);
-- Officers are explicitly appointed. An empty table means unassigned, never inferred from repository authors.
CREATE TABLE positioning_guild_officers (
  community_id uuid NOT NULL REFERENCES communities, guild_key text NOT NULL REFERENCES positioning_guild_catalog,
  user_id uuid NOT NULL REFERENCES users, appointed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(community_id,guild_key)
);
CREATE TABLE guild_creation_applications (
  application_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities, user_id uuid NOT NULL REFERENCES users,
  name text NOT NULL, profession text NOT NULL, reason text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','declined')),
  aggregate_version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_pending_guild_application_name_per_member ON guild_creation_applications(community_id,user_id,lower(name)) WHERE state='pending';
