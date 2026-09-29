-- A session created before this migration has no trustworthy login timestamp.
ALTER TABLE sessions ADD COLUMN created_at timestamptz DEFAULT now();
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz DEFAULT now();
UPDATE sessions SET created_at=NULL,last_seen_at=NULL;
ALTER TABLE sessions ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE sessions ALTER COLUMN last_seen_at SET DEFAULT now();
CREATE INDEX sessions_member_presence ON sessions(user_id,last_seen_at DESC)
  WHERE revoked_at IS NULL;
