-- Local AI handoffs (phase 2a).
-- A row records who asked for a task file and the file we handed back.
-- The platform does not run an agent, does not hold a token for one, and does
-- not write to GitHub for a handoff. The person runs the file in their own
-- terminal. Rows are append-only: code never updates or deletes them.

CREATE TABLE maintainer_handoffs (
  handoff_id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES maintainer_repositories (repository_id),
  pull_id uuid REFERENCES maintainer_pull_requests (pull_id),
  issue_number integer,
  kind text NOT NULL CHECK (kind IN ('fix', 'merge', 'issue')),
  cli text NOT NULL CHECK (cli IN ('claude', 'codex', 'grok')),
  head_sha text,
  user_id uuid NOT NULL REFERENCES users (user_id),
  github_user_id text NOT NULL CHECK (github_user_id ~ '^[0-9]+$'),
  github_login text NOT NULL CHECK (github_login ~ '^[A-Za-z0-9-]{1,39}$'),
  acting_as text NOT NULL CHECK (acting_as IN ('admin', 'guild_leader', 'skill_book_maintainer')),
  guild_key text REFERENCES positioning_guild_catalog (guild_key),
  skill_book_id text CHECK (skill_book_id IS NULL OR skill_book_id ~ '^[a-z0-9-]{1,100}$'),
  requested_by_admin uuid REFERENCES platform_admins (admin_id),
  task_markdown text NOT NULL CHECK (char_length(task_markdown) BETWEEN 1 AND 24000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  CHECK (issue_number IS NULL OR (issue_number BETWEEN 1 AND 1000000000)),
  CHECK (
    (acting_as = 'admin' AND guild_key IS NULL AND skill_book_id IS NULL)
    OR (acting_as = 'guild_leader' AND guild_key IS NOT NULL AND skill_book_id IS NULL)
    OR (acting_as = 'skill_book_maintainer' AND guild_key IS NULL AND skill_book_id IS NOT NULL)
  ),
  CHECK (requested_by_admin IS NULL OR acting_as = 'admin'),
  CHECK (
    (kind IN ('fix', 'merge') AND pull_id IS NOT NULL AND head_sha ~ '^[0-9a-f]{40}$' AND issue_number IS NULL)
    OR (kind = 'issue' AND pull_id IS NULL AND head_sha IS NULL AND issue_number BETWEEN 1 AND 1000000000)
  )
);

-- Recent handoffs of one pull, newest first. Issue rows have no pull.
CREATE INDEX maintainer_handoffs_pull_recent
  ON maintainer_handoffs (pull_id, created_at DESC)
  WHERE pull_id IS NOT NULL;
