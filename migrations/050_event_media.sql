ALTER TABLE community_event_banners ADD COLUMN orientation text NOT NULL DEFAULT 'landscape'
  CHECK (orientation IN ('landscape','portrait'));
CREATE TABLE community_event_videos (
  event_id uuid PRIMARY KEY REFERENCES community_events(event_id) ON DELETE CASCADE,
  media_bytes bytea NOT NULL CHECK (octet_length(media_bytes) BETWEEN 1 AND 20971520),
  mime_type text NOT NULL CHECK (mime_type IN ('video/mp4','video/webm')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
