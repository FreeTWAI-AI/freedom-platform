-- Page activity, public events and co-creation fields for the GitHub sync cron.
-- Page views read these rows. They do not call GitHub.
-- Feed state is its own table so an events ETag cannot reset an issue cursor.
-- This migration also clears issue cursors: rows synced before these columns
-- must be read again. Page activity can look empty until that pass finishes.
-- Objects are owned by the migrator role. Default privileges grant the runtime role.
-- PostgreSQL CHECK cannot subquery, so list rules live in immutable functions.
CREATE FUNCTION github_sync_text_list_ok(items text[], max_items integer, max_len integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT items IS NOT NULL
    AND cardinality(items) <= max_items
    AND NOT EXISTS (
      SELECT 1 FROM unnest(items) AS item(value)
      WHERE value IS NULL OR char_length(value) < 1 OR char_length(value) > max_len
    );
$$;

CREATE FUNCTION github_sync_login_list_ok(items text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT items IS NOT NULL
    AND cardinality(items) <= 100
    AND NOT EXISTS (
      SELECT 1 FROM unnest(items) AS item(value)
      WHERE value IS NULL OR value !~ '^[A-Za-z0-9-]{1,39}(\[bot\])?$'
    );
$$;

ALTER TABLE github_items
  ADD COLUMN labels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN assignees text[] NOT NULL DEFAULT '{}',
  ADD COLUMN page_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN body_excerpt text,
  ADD CONSTRAINT github_items_labels_ok CHECK (github_sync_text_list_ok(labels, 100, 100)),
  ADD CONSTRAINT github_items_assignees_ok CHECK (github_sync_login_list_ok(assignees)),
  ADD CONSTRAINT github_items_page_ids_ok CHECK (github_sync_text_list_ok(page_ids, 100, 80)),
  ADD CONSTRAINT github_items_body_excerpt_ok CHECK (
    body_excerpt IS NULL OR (kind = 'issue' AND state = 'open' AND char_length(body_excerpt) BETWEEN 1 AND 12000)
  );
CREATE INDEX github_items_page_ids ON github_items USING gin (page_ids);

-- One row per named feed. freedom_platform_events is the public events cursor.
CREATE TABLE github_feed_state (
  feed_name text PRIMARY KEY CHECK (feed_name ~ '^[a-z0-9_]{1,80}$'),
  etag text CHECK (etag IS NULL OR char_length(etag) BETWEEN 1 AND 200),
  checked_at timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 80)
);

CREATE TABLE github_repository_events (
  event_id text PRIMARY KEY CHECK (char_length(event_id) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('issue_opened', 'issue_closed', 'pr_opened', 'pr_merged', 'pr_closed', 'pr_approved', 'design_claimed', 'release_published')),
  number integer CHECK (number IS NULL OR (number > 0 AND number <= 1000000000)),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 1000),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL
);
CREATE INDEX github_repository_events_recent ON github_repository_events (created_at DESC, event_id DESC);

UPDATE github_sync_repositories
SET since = NULL, etag = NULL, etag_query = NULL, backfilled = false, next_sync_at = now();
