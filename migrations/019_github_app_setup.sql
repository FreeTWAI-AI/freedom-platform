-- The manifest callback stores only the OAuth client credentials needed for
-- member-directed starring. App private keys and webhook secrets are discarded.
CREATE TABLE github_social_apps (
  community_id uuid PRIMARY KEY REFERENCES communities,
  app_id bigint UNIQUE NOT NULL CHECK (app_id > 0 AND app_id <= 9007199254740991),
  app_slug text NOT NULL,
  html_url text NOT NULL,
  client_id text UNIQUE NOT NULL,
  client_secret_encrypted text NOT NULL,
  configured_by uuid NOT NULL REFERENCES platform_admins,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_app_setup_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  community_id uuid NOT NULL REFERENCES communities,
  admin_id uuid NOT NULL REFERENCES platform_admins,
  origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  code_hash text CHECK (code_hash IS NULL OR code_hash ~ '^[a-f0-9]{64}$'),
  completed_app_id bigint REFERENCES github_social_apps(app_id),
  CHECK (expires_at > created_at),
  CHECK ((consumed_at IS NULL AND code_hash IS NULL AND completed_app_id IS NULL)
    OR (consumed_at IS NOT NULL AND code_hash IS NOT NULL AND completed_app_id IS NOT NULL))
);
CREATE INDEX github_app_setup_states_expiry ON github_app_setup_states(expires_at);
