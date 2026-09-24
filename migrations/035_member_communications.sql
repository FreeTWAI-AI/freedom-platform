-- In-app member notifications and one-to-one direct messages.
-- New tables only: no backfill, no triggers, no change to existing rows.
-- users has no (community_id,user_id) key, so same-community routing is
-- enforced by the service layer inside the caller's transaction.
CREATE TABLE member_notifications (
  notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities,
  recipient_ref uuid NOT NULL REFERENCES users(user_id),
  kind text NOT NULL CHECK (kind IN (
    'friend_request','friend_accepted','friend_declined','squad_invitation',
    'guild_application_approved','guild_application_rejected',
    'guild_expert_appointed','guild_expert_revoked',
    'guild_master_appointed','guild_master_revoked')),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 200),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160 AND title=btrim(title)),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000 AND body=btrim(body)),
  action_tab text CHECK (action_tab IN ('members','squads','guilds','guild-workspace','messages')),
  action_resource_id text CHECK (char_length(action_resource_id) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CHECK (action_tab IS NOT NULL OR action_resource_id IS NULL),
  CONSTRAINT member_notifications_source_unique UNIQUE (community_id,recipient_ref,source_key)
);
CREATE INDEX member_notifications_recipient_recent
  ON member_notifications (community_id,recipient_ref,created_at DESC,notification_id DESC);
CREATE INDEX member_notifications_recipient_unread
  ON member_notifications (community_id,recipient_ref) WHERE read_at IS NULL;

CREATE TABLE member_direct_messages (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities,
  sender_ref uuid NOT NULL REFERENCES users(user_id),
  recipient_ref uuid NOT NULL REFERENCES users(user_id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CHECK (sender_ref<>recipient_ref)
);
CREATE INDEX member_direct_messages_recipient_unread
  ON member_direct_messages (community_id,recipient_ref,sender_ref) WHERE read_at IS NULL;
-- Unordered pair history: (least,greatest) identifies one conversation.
CREATE INDEX member_direct_messages_pair_history
  ON member_direct_messages (community_id,least(sender_ref,recipient_ref),greatest(sender_ref,recipient_ref),created_at DESC,message_id DESC);
CREATE INDEX member_direct_messages_sender_recent
  ON member_direct_messages (community_id,sender_ref,created_at DESC);
CREATE INDEX member_direct_messages_recipient_recent
  ON member_direct_messages (community_id,recipient_ref,created_at DESC);
