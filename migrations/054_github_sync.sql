-- Incremental GitHub issue and pull-request store.
-- Reads come from these tables. github_history_cache stays until the previous Worker is gone.
-- Objects are owned by the migrator role. Default privileges grant the runtime role.
CREATE TABLE github_sync_repositories (
  repository_key text PRIMARY KEY CHECK (repository_key ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}$'),
  repository text NOT NULL CHECK (char_length(repository) BETWEEN 3 AND 140 AND lower(repository) = repository_key),
  since timestamptz,
  etag text CHECK (etag IS NULL OR char_length(etag) BETWEEN 1 AND 200),
  etag_query text CHECK (etag_query IS NULL OR char_length(etag_query) BETWEEN 1 AND 500),
  access_status text NOT NULL DEFAULT 'pending' CHECK (access_status IN ('pending', 'ok', 'unreadable')),
  backfilled boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 80)
);
CREATE INDEX github_sync_repositories_due ON github_sync_repositories (next_sync_at, repository_key);

CREATE TABLE github_items (
  repository_key text NOT NULL REFERENCES github_sync_repositories (repository_key),
  number integer NOT NULL CHECK (number > 0 AND number <= 1000000000),
  kind text NOT NULL CHECK (kind IN ('issue', 'pr')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  author_login text CHECK (author_login IS NULL OR author_login ~ '^[A-Za-z0-9-]{1,39}(\[bot\])?$'),
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  state_reason text CHECK (state_reason IS NULL OR char_length(state_reason) BETWEEN 1 AND 100),
  merged_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_key, number)
);
CREATE INDEX github_items_repository_created ON github_items (repository_key, kind, created_at DESC, number DESC);
CREATE INDEX github_items_leaderboard ON github_items (repository_key, kind, author_login);

-- One row per credential. Anonymous and token calls have separate GitHub limits.
CREATE TABLE github_sync_backoff (
  backoff_key text PRIMARY KEY CHECK (backoff_key IN ('anonymous', 'token')),
  until_at timestamptz NOT NULL
);
