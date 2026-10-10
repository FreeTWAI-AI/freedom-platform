CREATE TABLE email_verification_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash)=64),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at>created_at)
);
CREATE INDEX email_verification_tokens_user ON email_verification_tokens(user_id,created_at DESC);
