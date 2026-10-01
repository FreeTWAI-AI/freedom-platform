-- Observe-only mirror for the repository maintainer (phase 1a).
-- GitHub stays the source of truth. These tables store the facts the queue
-- needs, never a webhook payload, token, or private key.
-- GitHub numeric ids are text, same rule as repo author claims.
-- Objects are owned by the migrator role. Default privileges grant the runtime role.

CREATE TABLE maintainer_repositories (
  repository_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  github_repository_id text NOT NULL CHECK (github_repository_id ~ '^[0-9]+$'),
  installation_id text NOT NULL CHECK (installation_id ~ '^[0-9]+$'),
  full_name text NOT NULL CHECK (full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  default_branch text NOT NULL CHECK (char_length(default_branch) BETWEEN 1 AND 255 AND default_branch !~ '[[:space:]]'),
  installation_state text NOT NULL CHECK (installation_state IN ('active', 'removed')),
  mode text NOT NULL DEFAULT 'observe' CHECK (mode IN ('off', 'observe', 'ai_review', 'merge_dry_run', 'merge')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  -- Sweep schedule and the row lease. A claim sets this a few minutes ahead.
  next_sweep_at timestamptz NOT NULL DEFAULT now(),
  last_swept_at timestamptz,
  rate_limited_until timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 80),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (github_repository_id)
);
CREATE INDEX maintainer_repos_community ON maintainer_repositories (community_id, full_name);
CREATE INDEX maintainer_repos_due ON maintainer_repositories (next_sweep_at, repository_id)
  WHERE installation_state = 'active' AND mode <> 'off';

-- One row. next_installation_sync_at is both the schedule and the lease.
CREATE TABLE maintainer_worker_state (
  singleton boolean PRIMARY KEY CHECK (singleton),
  next_installation_sync_at timestamptz NOT NULL DEFAULT now(),
  last_installation_sync_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 80)
);
INSERT INTO maintainer_worker_state (singleton) VALUES (true);

-- Delivery id is GitHub's GUID. The body is hashed and discarded.
CREATE TABLE maintainer_webhook_deliveries (
  delivery_id text PRIMARY KEY CHECK (delivery_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  github_event text NOT NULL CHECK (github_event ~ '^[a-z_]{1,64}$'),
  action text CHECK (action IS NULL OR action ~ '^[a-z_]{1,80}$'),
  installation_id text CHECK (installation_id IS NULL OR installation_id ~ '^[0-9]+$'),
  github_repository_id text CHECK (github_repository_id IS NULL OR github_repository_id ~ '^[0-9]+$'),
  target_number integer CHECK (target_number IS NULL OR (target_number > 0 AND target_number <= 1000000000)),
  head_sha text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  outcome text NOT NULL CHECK (outcome IN ('queued', 'ignored')),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintainer_deliveries_received ON maintainer_webhook_deliveries (received_at);

-- kind stays a pattern so later phases can enqueue new work without an ALTER.
-- This phase only inserts reconcile_pull.
CREATE TABLE maintainer_jobs (
  job_id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES maintainer_repositories (repository_id),
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{3,40}$'),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 200),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (attempts >= 0 AND attempts <= max_attempts)
);
-- A newer queued job blocks requeue of an older one. Running rows are not in the index.
CREATE UNIQUE INDEX maintainer_jobs_queued_dedupe ON maintainer_jobs (dedupe_key) WHERE state = 'queued';
CREATE INDEX maintainer_jobs_claim ON maintainer_jobs (run_after, created_at) WHERE state IN ('queued', 'running');
CREATE INDEX maintainer_jobs_finished ON maintainer_jobs (finished_at) WHERE state IN ('done', 'failed', 'cancelled');

CREATE TABLE maintainer_pull_requests (
  pull_id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES maintainer_repositories (repository_id),
  number integer NOT NULL CHECK (number > 0 AND number <= 1000000000),
  github_pull_id text NOT NULL CHECK (github_pull_id ~ '^[0-9]+$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  html_url text NOT NULL CHECK (html_url ~ '^https://github\.com/' AND char_length(html_url) <= 500),
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  merged_at timestamptz,
  closed_at timestamptz,
  is_draft boolean NOT NULL,
  author_github_id text NOT NULL CHECK (author_github_id ~ '^[0-9]+$'),
  author_login text NOT NULL CHECK (author_login ~ '^[A-Za-z0-9-]{1,39}(\[bot\])?$'),
  author_type text NOT NULL CHECK (char_length(author_type) BETWEEN 1 AND 40),
  author_association text NOT NULL CHECK (char_length(author_association) BETWEEN 1 AND 40),
  is_fork boolean NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  head_repository_id text CHECK (head_repository_id IS NULL OR head_repository_id ~ '^[0-9]+$'),
  base_ref text NOT NULL CHECK (char_length(base_ref) BETWEEN 1 AND 255),
  base_sha text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  mergeable boolean,
  mergeable_state text CHECK (mergeable_state IS NULL OR char_length(mergeable_state) BETWEEN 1 AND 40),
  labels text[] NOT NULL DEFAULT '{}',
  additions integer NOT NULL CHECK (additions >= 0 AND additions <= 100000000),
  deletions integer NOT NULL CHECK (deletions >= 0 AND deletions <= 100000000),
  changed_files integer NOT NULL CHECK (changed_files >= 0 AND changed_files <= 100000000),
  github_created_at timestamptz NOT NULL,
  github_updated_at timestamptz NOT NULL,
  first_ready_at timestamptz,
  head_observed_at timestamptz NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('low', 'medium', 'high')),
  risk_reasons jsonb NOT NULL CHECK (jsonb_typeof(risk_reasons) = 'array'),
  queue_state text NOT NULL CHECK (queue_state IN (
    'draft', 'waiting_ci', 'ci_not_run', 'needs_author', 'awaiting_review', 'in_review',
    'needs_owner', 'ready', 'paused', 'merged', 'closed')),
  queue_reasons jsonb NOT NULL CHECK (jsonb_typeof(queue_reasons) = 'array'),
  sla_due_at timestamptz,
  recheck_at timestamptz,
  paused boolean NOT NULL DEFAULT false,
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 40),
  synced_at timestamptz NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  UNIQUE (repository_id, number)
);
CREATE INDEX maintainer_pulls_queue ON maintainer_pull_requests (queue_state, github_updated_at DESC);
CREATE INDEX maintainer_pulls_sla ON maintainer_pull_requests (sla_due_at, github_updated_at DESC)
  WHERE queue_state = 'awaiting_review';
CREATE INDEX maintainer_pulls_recheck ON maintainer_pull_requests (recheck_at)
  WHERE state = 'open' AND recheck_at IS NOT NULL;
CREATE INDEX maintainer_pulls_head ON maintainer_pull_requests (repository_id, head_sha);

-- Current head only. Reconcile deletes and inserts these three.
CREATE TABLE maintainer_pull_files (
  pull_id uuid NOT NULL REFERENCES maintainer_pull_requests (pull_id) ON DELETE CASCADE,
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1024),
  previous_path text CHECK (previous_path IS NULL OR char_length(previous_path) BETWEEN 1 AND 1024),
  status text NOT NULL CHECK (char_length(status) BETWEEN 1 AND 40),
  additions integer NOT NULL CHECK (additions >= 0 AND additions <= 100000000),
  deletions integer NOT NULL CHECK (deletions >= 0 AND deletions <= 100000000),
  PRIMARY KEY (pull_id, path)
);

CREATE TABLE maintainer_checks (
  pull_id uuid NOT NULL REFERENCES maintainer_pull_requests (pull_id) ON DELETE CASCADE,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  source text NOT NULL CHECK (source IN ('check_run', 'status')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- Check-run app id. Empty string for commit statuses, which have no app.
  app_key text NOT NULL DEFAULT '' CHECK (app_key = '' OR app_key ~ '^[0-9]+$'),
  app_slug text CHECK (app_slug IS NULL OR char_length(app_slug) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (char_length(status) BETWEEN 1 AND 40),
  conclusion text CHECK (conclusion IS NULL OR char_length(conclusion) BETWEEN 1 AND 40),
  check_suite_id text CHECK (check_suite_id IS NULL OR check_suite_id ~ '^[0-9]+$'),
  completed_at timestamptz,
  PRIMARY KEY (pull_id, source, app_key, name)
);

CREATE TABLE maintainer_reviews (
  pull_id uuid NOT NULL REFERENCES maintainer_pull_requests (pull_id) ON DELETE CASCADE,
  github_review_id text NOT NULL CHECK (github_review_id ~ '^[0-9]+$'),
  reviewer_github_id text NOT NULL CHECK (reviewer_github_id ~ '^[0-9]+$'),
  reviewer_login text NOT NULL CHECK (reviewer_login ~ '^[A-Za-z0-9-]{1,39}(\[bot\])?$'),
  reviewer_type text NOT NULL CHECK (char_length(reviewer_type) BETWEEN 1 AND 40),
  reviewer_association text CHECK (reviewer_association IS NULL OR char_length(reviewer_association) BETWEEN 1 AND 40),
  state text NOT NULL CHECK (char_length(state) BETWEEN 1 AND 40),
  commit_id text CHECK (commit_id IS NULL OR commit_id ~ '^[0-9a-f]{40}$'),
  submitted_at timestamptz NOT NULL,
  PRIMARY KEY (pull_id, github_review_id)
);

CREATE TABLE maintainer_reviewers (
  reviewer_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  github_user_id text NOT NULL CHECK (github_user_id ~ '^[0-9]+$'),
  github_login text NOT NULL CHECK (github_login ~ '^[A-Za-z0-9-]{1,39}(\[bot\])?$'),
  -- Member whose verified GitHub connection was copied. Login is display only.
  user_id uuid NOT NULL REFERENCES users,
  max_risk text NOT NULL CHECK (max_risk IN ('low', 'medium', 'high')),
  active boolean NOT NULL DEFAULT true,
  appointed_by uuid NOT NULL REFERENCES platform_admins,
  appointed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  UNIQUE (community_id, github_user_id)
);
CREATE INDEX maintainer_reviewers_community ON maintainer_reviewers (community_id, active, github_login);
