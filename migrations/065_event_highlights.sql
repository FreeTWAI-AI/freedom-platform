-- Public recap items for events that have already ended.
-- Metadata lives here. Image bytes live in community_event_highlight_images.
-- Objects are owned by the migrator role. Default privileges grant the runtime role.

CREATE TABLE community_event_highlights (
  media_id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES community_events(event_id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities,
  uploader_user_id uuid NOT NULL REFERENCES users,
  kind text NOT NULL CHECK (kind IN ('link','photo','poster')),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
  url text,
  platform text,
  orientation text,
  byte_size integer,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES users,
  CHECK (
    (kind = 'link' AND url IS NOT NULL AND char_length(url) BETWEEN 1 AND 2048 AND url LIKE 'https://%'
      AND platform IN ('youtube','facebook','instagram','threads','tiktok','x','vimeo','google_drive','google_photos','other')
      AND orientation IS NULL AND byte_size IS NULL)
    OR (kind IN ('photo','poster') AND url IS NULL AND platform IS NULL
      AND orientation IN ('landscape','portrait') AND byte_size BETWEEN 1 AND 1048576)
  ),
  CHECK (
    (state = 'active' AND removed_at IS NULL AND removed_by_user_id IS NULL)
    OR (state = 'removed' AND removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX community_event_highlights_active_link
  ON community_event_highlights (event_id, url) WHERE kind = 'link' AND state = 'active';
CREATE INDEX community_event_highlights_event
  ON community_event_highlights (event_id, state, kind, created_at);

CREATE TABLE community_event_highlight_images (
  media_id uuid NOT NULL REFERENCES community_event_highlights(media_id) ON DELETE CASCADE,
  variant text NOT NULL CHECK (variant IN ('image','thumb')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 1048576),
  PRIMARY KEY (media_id, variant)
);
