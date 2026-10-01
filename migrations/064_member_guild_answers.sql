-- Private guild-entry answers. Only the member who wrote them can read them.
-- Cleanup deletes these rows with the member; there is no ON DELETE CASCADE.
-- Objects are owned by the migrator role. Default privileges grant the runtime role.
CREATE TABLE member_guild_answers (
  community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users,
  guild_key text NOT NULL REFERENCES positioning_guild_catalog,
  question_set_version text NOT NULL,
  question_set_sha256 text NOT NULL CHECK (question_set_sha256 ~ '^[a-f0-9]{64}$'),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id, guild_key)
);
