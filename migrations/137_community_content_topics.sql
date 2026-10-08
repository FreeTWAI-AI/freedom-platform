-- Optional topic tags for community search. Publication does not require a tag,
-- and search reads the current source rows rather than a second permission copy.
CREATE TABLE community_content_topic_sets (
  set_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(community_id),
  content_kind text NOT NULL CHECK (content_kind IN ('post','work','skill_book','event')),
  content_id text NOT NULL CHECK (char_length(content_id) BETWEEN 1 AND 100),
  topics text[] NOT NULL CHECK (
    cardinality(topics) BETWEEN 0 AND 3
    AND topics <@ ARRAY['intro','showcase','help','tools','gathering']::text[]
  ),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  updated_by uuid NOT NULL REFERENCES users(user_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_kind, content_id)
);
