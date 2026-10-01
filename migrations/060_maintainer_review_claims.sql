-- Human review claims (phase 1b). A claim is a soft lock with an expiry so two
-- people do not review the same pull. It is never evidence of a review.
-- GitHub stays the source of truth. requested_reviewers is a display mirror.

ALTER TABLE maintainer_pull_requests
  ADD COLUMN requested_reviewers jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(requested_reviewers) = 'array');

CREATE TABLE maintainer_review_claims (
  claim_id uuid PRIMARY KEY,
  pull_id uuid NOT NULL REFERENCES maintainer_pull_requests (pull_id),
  reviewer_id uuid NOT NULL REFERENCES maintainer_reviewers (reviewer_id),
  claimed_by_admin uuid NOT NULL REFERENCES platform_admins (admin_id),
  assignment text NOT NULL CHECK (assignment IN ('self', 'assigned')),
  -- NULL when the reviewer claimed it. A written reason is required when someone else assigned it.
  assign_reason text,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'released', 'expired', 'completed')),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR end_reason IN (
    'admin_released', 'pull_closed', 'reviewer_inactive', 'reviewer_rank_too_low', 'review_submitted')),
  github_request_state text NOT NULL CHECK (github_request_state IN (
    'not_requested', 'pending', 'requested', 'skipped', 'failed', 'removing', 'removed')),
  github_request_error text CHECK (github_request_error IS NULL OR char_length(github_request_error) BETWEEN 1 AND 80),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  CHECK (
    (assignment = 'self' AND assign_reason IS NULL)
    OR (assignment = 'assigned' AND assign_reason IS NOT NULL AND char_length(assign_reason) BETWEEN 3 AND 1000)
  ),
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'active' AND ended_at IS NULL AND end_reason IS NULL)
    OR (state = 'expired' AND ended_at IS NOT NULL AND end_reason IS NULL)
    OR (state IN ('released', 'completed') AND ended_at IS NOT NULL AND end_reason IS NOT NULL)
  )
);

-- One live claim per pull. Ended rows stay for the detail history.
CREATE UNIQUE INDEX maintainer_claims_one_active ON maintainer_review_claims (pull_id) WHERE state = 'active';
-- The tick scans this for claims whose expiry has passed.
CREATE INDEX maintainer_claims_expiry ON maintainer_review_claims (expires_at) WHERE state = 'active';
-- Listing the claims one reviewer still holds.
CREATE INDEX maintainer_claims_reviewer_active ON maintainer_review_claims (reviewer_id) WHERE state = 'active';
