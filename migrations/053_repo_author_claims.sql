-- Original-author claims follow the provider repository id, never a URL.
-- Catalog attribution stays on the skill book and is not stored or overwritten here.
CREATE TABLE canonical_repositories (
  repo_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider = 'github'),
  provider_repo_id text NOT NULL CHECK (provider_repo_id ~ '^[0-9]+$'),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 3 AND 140),
  current_url text NOT NULL CHECK (current_url ~ '^https://github\.com/'),
  source_repo_id text CHECK (source_repo_id IS NULL OR source_repo_id ~ '^[0-9]+$'),
  source_full_name text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_repo_id)
);

-- One observation per catalog book. A later id at the same URL does not move claims.
CREATE TABLE catalog_repo_observations (
  book_id text PRIMARY KEY CHECK (book_id ~ '^[a-z0-9-]{1,100}$'),
  provider text NOT NULL CHECK (provider = 'github'),
  provider_repo_id text NOT NULL CHECK (provider_repo_id ~ '^[0-9]+$'),
  requested_full_name text NOT NULL,
  full_name text NOT NULL,
  current_url text NOT NULL CHECK (current_url ~ '^https://github\.com/'),
  source_repo_id text CHECK (source_repo_id IS NULL OR source_repo_id ~ '^[0-9]+$'),
  previous_provider_repo_id text CHECK (previous_provider_repo_id IS NULL OR previous_provider_repo_id ~ '^[0-9]+$'),
  needs_recheck boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repo_credit_claims (
  claim_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  repo_id uuid NOT NULL REFERENCES canonical_repositories(repo_id),
  user_id uuid NOT NULL REFERENCES users,
  github_user_id text NOT NULL CHECK (github_user_id ~ '^[0-9]+$'),
  github_login text NOT NULL CHECK (char_length(github_login) BETWEEN 1 AND 100),
  role text NOT NULL CHECK (role IN ('original_author', 'co_original_author', 'maintainer')),
  state text NOT NULL CHECK (state IN ('pending', 'verified', 'rejected', 'withdrawn', 'disputed', 'revoked')),
  evidence_url text CHECK (evidence_url IS NULL OR char_length(evidence_url) BETWEEN 1 AND 2000),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 10 AND 1000),
  appeal_text text CHECK (appeal_text IS NULL OR char_length(appeal_text) BETWEEN 10 AND 1000),
  appeal_count integer NOT NULL DEFAULT 0 CHECK (appeal_count BETWEEN 0 AND 1),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES platform_admins,
  reviewed_at timestamptz,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 1000),
  source_snapshot jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX repo_credit_claims_one_active_role
  ON repo_credit_claims (repo_id, user_id, role)
  WHERE state IN ('pending', 'verified', 'disputed');
CREATE INDEX repo_credit_claims_repo_state ON repo_credit_claims (repo_id, state);
CREATE INDEX repo_credit_claims_member ON repo_credit_claims (community_id, user_id, submitted_at DESC);

CREATE TABLE repo_credit_claim_events (
  event_id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES repo_credit_claims(claim_id),
  community_id uuid NOT NULL REFERENCES communities,
  actor_user_id uuid REFERENCES users,
  actor_admin_id uuid REFERENCES platform_admins,
  action text NOT NULL CHECK (action IN ('submit', 'withdraw', 'verify', 'reject', 'dispute', 'revoke', 'appeal')),
  previous_state text CHECK (previous_state IS NULL OR previous_state IN ('pending', 'verified', 'rejected', 'withdrawn', 'disputed', 'revoked')),
  new_state text NOT NULL CHECK (new_state IN ('pending', 'verified', 'rejected', 'withdrawn', 'disputed', 'revoked')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(actor_user_id, actor_admin_id) = 1)
);
CREATE INDEX repo_credit_claim_events_claim ON repo_credit_claim_events (claim_id, created_at);

CREATE TABLE catalog_repo_identity_events (
  event_id uuid PRIMARY KEY,
  book_id text NOT NULL,
  provider text NOT NULL CHECK (provider = 'github'),
  previous_provider_repo_id text,
  provider_repo_id text NOT NULL CHECK (provider_repo_id ~ '^[0-9]+$'),
  full_name text NOT NULL,
  actor_user_id uuid REFERENCES users,
  actor_admin_id uuid REFERENCES platform_admins,
  action text NOT NULL CHECK (action IN ('identity_changed', 'acknowledged')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(actor_user_id, actor_admin_id) = 1)
);

CREATE FUNCTION forbid_repo_credit_claim_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'repo credit claims are retained'; END; $$;
CREATE TRIGGER repo_credit_claims_no_delete BEFORE DELETE ON repo_credit_claims
  FOR EACH ROW EXECUTE FUNCTION forbid_repo_credit_claim_delete();

CREATE FUNCTION protect_repo_credit_claim_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.claim_id IS DISTINCT FROM OLD.claim_id
    OR NEW.community_id IS DISTINCT FROM OLD.community_id
    OR NEW.repo_id IS DISTINCT FROM OLD.repo_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.github_user_id IS DISTINCT FROM OLD.github_user_id
    OR NEW.github_login IS DISTINCT FROM OLD.github_login
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.evidence_url IS DISTINCT FROM OLD.evidence_url
    OR NEW.statement IS DISTINCT FROM OLD.statement
    OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
  THEN RAISE EXCEPTION 'claim identity and statement are immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER repo_credit_claims_identity BEFORE UPDATE ON repo_credit_claims
  FOR EACH ROW EXECUTE FUNCTION protect_repo_credit_claim_identity();

CREATE FUNCTION forbid_repo_credit_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'repo credit audit events are append-only'; END; $$;
CREATE TRIGGER repo_credit_claim_events_append_only BEFORE UPDATE OR DELETE ON repo_credit_claim_events
  FOR EACH ROW EXECUTE FUNCTION forbid_repo_credit_event_change();
CREATE TRIGGER catalog_repo_identity_events_append_only BEFORE UPDATE OR DELETE ON catalog_repo_identity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_repo_credit_event_change();
