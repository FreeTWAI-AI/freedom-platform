CREATE TABLE community_event_banners (
  event_id uuid PRIMARY KEY REFERENCES community_events(event_id) ON DELETE CASCADE,
  image_bytes bytea NOT NULL CHECK (octet_length(image_bytes) BETWEEN 1 AND 524288),
  updated_at timestamptz NOT NULL DEFAULT now()
);
