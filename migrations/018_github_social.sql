-- GitHub is an optional member connection, never a workshop login or role grant.
CREATE TABLE github_social_connections (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities,
  github_user_id text NOT NULL CHECK (github_user_id ~ '^[0-9]+$'),
  github_login text NOT NULL,
  encrypted_tokens text NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE github_social_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities,
  session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  encrypted_verifier text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_social_oauth_user ON github_social_oauth_states(user_id);
CREATE INDEX github_social_oauth_expiry ON github_social_oauth_states(expires_at);
CREATE TABLE github_social_rate_limits (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  operation text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, operation)
);
-- Only public, catalog-allowlisted upstream repositories are cached here.
CREATE TABLE github_repository_metrics (
  repository_key text PRIMARY KEY,
  snapshot jsonb,
  checked_at timestamptz,
  retry_after timestamptz NOT NULL DEFAULT now(),
  last_error text
);
