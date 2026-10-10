CREATE TABLE login_email_change_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  old_email text NOT NULL,
  new_email text NOT NULL,
  requesting_session_hash text NOT NULL,
  credential_hash text NOT NULL CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at>created_at),
  CHECK (old_email<>new_email)
);
CREATE INDEX login_email_change_tokens_user ON login_email_change_tokens(user_id,created_at DESC);
