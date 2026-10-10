-- #398: senders retract their own direct and channel messages. The row stays
-- for ordering, read cursors and audit; readers hide body, sticker, image and
-- quotes once retracted_at is set.
ALTER TABLE member_direct_messages ADD COLUMN retracted_at timestamptz;
ALTER TABLE member_channel_messages ADD COLUMN retracted_at timestamptz;

-- Body-free activity checks only scan committed tombstones of this pair/room.
CREATE INDEX member_direct_messages_pair_retracted
 ON member_direct_messages(community_id,least(sender_ref,recipient_ref),greatest(sender_ref,recipient_ref)) WHERE retracted_at IS NOT NULL;
CREATE INDEX member_channel_messages_room_retracted
 ON member_channel_messages(community_id,kind,channel_key,sender_ref) WHERE retracted_at IS NOT NULL;
