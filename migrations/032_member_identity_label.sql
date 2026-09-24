-- Optional, self-selected member-card label. Never infer or backfill it.
ALTER TABLE member_accounts ADD COLUMN identity_label text
  CHECK (identity_label IN ('male','female','alien','ai'));
