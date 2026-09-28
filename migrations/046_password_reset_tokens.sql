CREATE TABLE password_reset_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash)=64),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at>created_at)
);
CREATE INDEX password_reset_tokens_user ON password_reset_tokens(user_id,created_at DESC);
