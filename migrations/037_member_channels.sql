-- Member guild/squad group text channels: one room per (community,kind,key).
-- New tables only: no backfill, no triggers, no change to existing rows.
-- A channel row never grants access. Guild catalog/active guild membership and
-- active squad membership are checked (and row-locked) by the service inside
-- the caller's transaction; kind is polymorphic, so no FK to either source.
-- The channel row is created lazily on the first valid post; empty rooms are
-- derived from memberships without writes.
CREATE TABLE member_chat_channels (
  community_id uuid NOT NULL REFERENCES communities,
  kind text NOT NULL CHECK (kind IN ('guild','squad')),
  channel_key text NOT NULL CHECK (char_length(channel_key) BETWEEN 1 AND 100 AND (
    (kind='guild' AND channel_key ~ '^(guild_[a-z_]+|guild_custom_[0-9A-Fa-f]{32})$')
    OR (kind='squad' AND channel_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))),
  -- Allocated under the channel advisory lock plus this row's lock, in the
  -- same transaction as the message insert, so sequences commit in order.
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id,kind,channel_key)
);

CREATE TABLE member_channel_messages (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL,
  kind text NOT NULL,
  channel_key text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence>0),
  sender_ref uuid NOT NULL REFERENCES users(user_id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id,kind,channel_key) REFERENCES member_chat_channels,
  -- Also serves newest-first history and unread (sequence>cursor) scans.
  CONSTRAINT member_channel_messages_sequence_unique UNIQUE (community_id,kind,channel_key,sequence)
);
CREATE INDEX member_channel_messages_sender_recent
  ON member_channel_messages (community_id,sender_ref,created_at DESC);

-- Personal read cursor. Kept after leaving; it grants nothing while the user
-- is not a current member, and resumes on rejoin. Only ever advanced (max).
CREATE TABLE member_channel_reads (
  community_id uuid NOT NULL,
  kind text NOT NULL,
  channel_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(user_id),
  last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (last_read_sequence>=0),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id,kind,channel_key,user_id),
  FOREIGN KEY (community_id,kind,channel_key) REFERENCES member_chat_channels
);
