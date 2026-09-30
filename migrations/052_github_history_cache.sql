-- Shared GitHub issue and pull-request page cache. One row per repository, kind and page.
-- A failed refresh keeps the previous snapshot and only moves retry_after forward.
CREATE TABLE github_history_cache (
  cache_key text PRIMARY KEY,
  snapshot jsonb,
  checked_at timestamptz,
  retry_after timestamptz NOT NULL DEFAULT now(),
  last_error text
);
