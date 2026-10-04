-- Additive chat content; existing text and permission/read-cursor rules remain.
ALTER TABLE member_channel_messages
  ADD COLUMN sticker_id text CHECK (sticker_id IN ('workshop-v1-hello','workshop-v1-thanks','workshop-v1-cheer','workshop-v1-together')),
  ADD COLUMN reply_to_message_id uuid,
  ADD CONSTRAINT member_channel_message_reply_not_self CHECK (reply_to_message_id<>message_id),
  ADD CONSTRAINT member_channel_message_reply_scope_unique UNIQUE (community_id,kind,channel_key,message_id),
  ADD CONSTRAINT member_channel_message_reply_scope FOREIGN KEY (community_id,kind,channel_key,reply_to_message_id)
    REFERENCES member_channel_messages(community_id,kind,channel_key,message_id);

ALTER TABLE member_direct_messages
  ADD COLUMN sticker_id text CHECK (sticker_id IN ('workshop-v1-hello','workshop-v1-thanks','workshop-v1-cheer','workshop-v1-together')),
  ADD COLUMN reply_to_message_id uuid,
  ADD COLUMN conversation_low uuid GENERATED ALWAYS AS (least(sender_ref,recipient_ref)) STORED,
  ADD COLUMN conversation_high uuid GENERATED ALWAYS AS (greatest(sender_ref,recipient_ref)) STORED,
  ADD CONSTRAINT member_direct_message_reply_not_self CHECK (reply_to_message_id<>message_id),
  ADD CONSTRAINT member_direct_message_reply_scope_unique UNIQUE (community_id,conversation_low,conversation_high,message_id),
  ADD CONSTRAINT member_direct_message_reply_scope FOREIGN KEY (community_id,conversation_low,conversation_high,reply_to_message_id)
    REFERENCES member_direct_messages(community_id,conversation_low,conversation_high,message_id);
