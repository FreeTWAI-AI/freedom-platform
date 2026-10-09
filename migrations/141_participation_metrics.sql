-- Search outcome signals for participation metrics. The query text, filters and result
-- titles are never stored: only a per-page operation, its result count and one opened kind.
CREATE TABLE community_search_operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities,
  user_id uuid NOT NULL REFERENCES users,
  searched_at timestamptz NOT NULL DEFAULT now(),
  first_page boolean NOT NULL,
  result_count integer NOT NULL CHECK (result_count BETWEEN 0 AND 100),
  opened_at timestamptz,
  opened_kind text CHECK (opened_kind IN ('post','work','skill_book','event')),
  CHECK ((opened_at IS NULL) = (opened_kind IS NULL)),
  CHECK (opened_at IS NULL OR result_count > 0)
);
CREATE INDEX community_search_operations_window ON community_search_operations(community_id, searched_at);
