-- Extend the existing membership-checked chat service to one world room per community.
ALTER TABLE member_chat_channels DROP CONSTRAINT member_chat_channels_kind_check;
ALTER TABLE member_chat_channels ADD CONSTRAINT member_chat_channels_kind_check CHECK (kind IN ('guild','squad','world'));
DO $$ DECLARE old_name text; BEGIN
  SELECT conname INTO old_name FROM pg_constraint
  WHERE conrelid='member_chat_channels'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%channel_key%' LIMIT 1;
  IF old_name IS NULL THEN RAISE EXCEPTION 'member_chat_channels key constraint missing'; END IF;
  EXECUTE format('ALTER TABLE member_chat_channels DROP CONSTRAINT %I',old_name);
END $$;
ALTER TABLE member_chat_channels ADD CONSTRAINT member_chat_channels_channel_key_check CHECK (char_length(channel_key) BETWEEN 1 AND 100 AND (
  (kind='guild' AND channel_key ~ '^(guild_[a-z_]+|guild_custom_[0-9A-Fa-f]{32})$') OR
  (kind='squad' AND channel_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR
  (kind='world' AND channel_key='world')));

-- A bounded diagnostic trail. Never store request bodies, raw errors, stacks or credentials.
CREATE TABLE member_client_errors (
  error_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users(user_id),
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
  error_code text NOT NULL CHECK (char_length(error_code) BETWEEN 1 AND 80),
  http_status integer CHECK (http_status BETWEEN 0 AND 599),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX member_client_errors_recent ON member_client_errors (community_id,created_at DESC);
