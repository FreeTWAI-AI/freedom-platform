-- #398: senders retract their own direct and channel messages. The row stays
-- for ordering, read cursors and audit; readers hide body, sticker, image and
-- quotes once retracted_at is set.
ALTER TABLE member_direct_messages ADD COLUMN retracted_at timestamptz;
ALTER TABLE member_channel_messages ADD COLUMN retracted_at timestamptz;
