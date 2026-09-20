CREATE TABLE communities (community_id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE users (
  user_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  email text UNIQUE NOT NULL, display_name text NOT NULL, password_hash text NOT NULL,
  profession_membership_ref uuid UNIQUE NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users,
  csrf_token text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE login_attempts (
  attempt_key text PRIMARY KEY, failures integer NOT NULL, window_start timestamptz NOT NULL
);
CREATE TABLE work_items (
  work_item_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  owner_ref uuid NOT NULL REFERENCES users, title text NOT NULL, objective text NOT NULL,
  acceptance_criteria text NOT NULL, gain text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','claiming_closed','accepted')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  participation_terms jsonb NOT NULL, participation_terms_revision integer NOT NULL DEFAULT 1,
  participation_terms_sha256 text NOT NULL, claim_window_expires_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
-- A scoped, self-accepted Work acceptance route; never a product QC appointment.
CREATE TABLE work_review_routes (
  work_item_id uuid NOT NULL REFERENCES work_items, reviewer_ref uuid NOT NULL REFERENCES users,
  accepted_at timestamptz NOT NULL DEFAULT now(), valid_until timestamptz NOT NULL,
  revoked_at timestamptz, PRIMARY KEY (work_item_id, reviewer_ref)
);
CREATE TABLE work_claims (
  claim_id uuid PRIMARY KEY, work_item_id uuid UNIQUE NOT NULL REFERENCES work_items,
  claimant_ref uuid NOT NULL REFERENCES users, acting_profession_membership_ref uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed','in_progress','submitted','in_review','changes_requested','accepted')),
  aggregate_version bigint NOT NULL DEFAULT 1, terms_revision integer NOT NULL,
  terms_sha256 text NOT NULL, terms_snapshot jsonb NOT NULL, feedback text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE submissions (
  submission_id uuid PRIMARY KEY, claim_id uuid NOT NULL REFERENCES work_claims,
  revision integer NOT NULL, summary text NOT NULL, artifact_ref text NOT NULL,
  sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (claim_id, revision)
);
CREATE TABLE work_decisions (
  decision_id uuid PRIMARY KEY, claim_id uuid NOT NULL REFERENCES work_claims,
  submission_id uuid NOT NULL REFERENCES submissions, reviewer_ref uuid NOT NULL REFERENCES users,
  decision text NOT NULL CHECK (decision IN ('accept','changes_requested')), feedback text NOT NULL,
  submission_sha256 text NOT NULL, official boolean NOT NULL DEFAULT false CHECK (NOT official),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (submission_id)
);
CREATE TABLE contributions (
  contribution_id uuid PRIMARY KEY, claim_id uuid UNIQUE NOT NULL REFERENCES work_claims,
  user_id uuid NOT NULL REFERENCES users, community_id uuid NOT NULL REFERENCES communities,
  work_item_id uuid NOT NULL REFERENCES work_items, decision_id uuid NOT NULL REFERENCES work_decisions,
  title text NOT NULL, summary text NOT NULL, artifact_ref text NOT NULL,
  official boolean NOT NULL DEFAULT false CHECK (NOT official), accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE showcases (
  showcase_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  owner_ref uuid NOT NULL REFERENCES users, title text NOT NULL, description text NOT NULL,
  artifact_ref text NOT NULL, visibility text NOT NULL DEFAULT 'community' CHECK (visibility='community'),
  consent_recorded_at timestamptz NOT NULL DEFAULT now(), aggregate_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE opportunities (
  opportunity_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  showcase_id uuid NOT NULL REFERENCES showcases, provider_ref uuid NOT NULL REFERENCES users,
  client_ref uuid NOT NULL REFERENCES users, need text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','proposed')),
  aggregate_version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider_ref <> client_ref)
);
CREATE TABLE engagements (
  engagement_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  opportunity_id uuid UNIQUE NOT NULL REFERENCES opportunities, provider_ref uuid NOT NULL REFERENCES users,
  client_ref uuid NOT NULL REFERENCES users, scope text NOT NULL, acceptance_criteria text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 100000000000), currency text NOT NULL CHECK (currency IN ('TWD','USD')),
  terms_sha256 text NOT NULL, state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','agreed','delivered','accepted')),
  aggregate_version bigint NOT NULL DEFAULT 1, delivery_ref text,
  agreed_at timestamptz, accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider_ref <> client_ref)
);
-- These are attributed observations, NOT provider payment facts or payable entries.
CREATE TABLE receipt_observations (
  receipt_id uuid PRIMARY KEY, engagement_id uuid UNIQUE NOT NULL REFERENCES engagements,
  reporter_ref uuid NOT NULL REFERENCES users, amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL, evidence_ref text NOT NULL, received_at timestamptz NOT NULL,
  verification_status text NOT NULL DEFAULT 'self_reported' CHECK (verification_status IN ('self_reported','counterparty_confirmed')),
  confirmed_by uuid REFERENCES users, confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_ref,evidence_ref)
);
CREATE TABLE command_receipts (
  user_id uuid NOT NULL REFERENCES users, operation text NOT NULL, idempotency_key text NOT NULL,
  request_sha256 text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation, idempotency_key)
);
CREATE TABLE transition_journal (
  transition_id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities,
  aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, aggregate_version bigint NOT NULL,
  command text NOT NULL, actor_ref uuid NOT NULL REFERENCES users, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (aggregate_type,aggregate_id,aggregate_version)
);
CREATE TABLE outbox (
  event_id uuid PRIMARY KEY, transition_id uuid UNIQUE NOT NULL REFERENCES transition_journal,
  event_type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_by_user ON sessions (user_id);
CREATE INDEX work_community ON work_items (community_id,created_at);
CREATE INDEX claim_user ON work_claims (claimant_ref);
CREATE INDEX contributions_user ON contributions (community_id,user_id);
