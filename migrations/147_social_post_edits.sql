-- #399: authors edit their own social posts and comments. edit_revision is the
-- If-Match version; edited_at drives the 「已編輯」 marker. Likes, comments and
-- thumbnails stay attached to the same row.
ALTER TABLE community_social_posts ADD COLUMN edited_at timestamptz;
ALTER TABLE community_social_posts ADD COLUMN edit_revision integer NOT NULL DEFAULT 1 CHECK (edit_revision>0);
ALTER TABLE community_social_comments ADD COLUMN edited_at timestamptz;
ALTER TABLE community_social_comments ADD COLUMN edit_revision integer NOT NULL DEFAULT 1 CHECK (edit_revision>0);
