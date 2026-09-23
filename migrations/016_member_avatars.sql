-- Store only a small, server-decoded WebP. Removing a photo keeps its revision
-- so a stale editor cannot restore it without a new version check.
CREATE TABLE member_avatars (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities,
  image_bytes bytea,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (image_bytes IS NULL OR octet_length(image_bytes) BETWEEN 1 AND 131072)
);
CREATE INDEX member_avatars_by_community ON member_avatars(community_id);
