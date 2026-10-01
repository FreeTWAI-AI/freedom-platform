-- Human review claims and repository ownership (phases 1b–1c).
-- A claim is a soft lock so two people do not review the same pull. It is never
-- evidence of a review. GitHub stays the source of truth. requested_reviewers is
-- a display mirror. expires_at NULL means the claim does not expire.
-- Who may review is maintainer_eligible_reviewers, not a stored roster.

ALTER TABLE maintainer_pull_requests
  ADD COLUMN requested_reviewers jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(requested_reviewers) = 'array');

-- NULL guild_key means no guild. open_to_guilds is only meaningful then: any
-- current guild leader may review, and the first completed leader review adopts it.
ALTER TABLE maintainer_repositories
  ADD COLUMN guild_key text REFERENCES positioning_guild_catalog (guild_key),
  ADD COLUMN scope_kind text CHECK (scope_kind IS NULL OR scope_kind IN ('module', 'skill_book')),
  ADD COLUMN open_to_guilds boolean NOT NULL DEFAULT false,
  ADD CHECK (guild_key IS NULL OR NOT open_to_guilds);

CREATE TABLE maintainer_ownership_changes (
  change_id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES maintainer_repositories (repository_id),
  guild_key text REFERENCES positioning_guild_catalog (guild_key),
  scope_kind text CHECK (scope_kind IS NULL OR scope_kind IN ('module', 'skill_book')),
  open_to_guilds boolean NOT NULL,
  source text NOT NULL CHECK (source IN ('admin', 'adopted')),
  changed_by_admin uuid REFERENCES platform_admins (admin_id),
  changed_by_user uuid REFERENCES users (user_id),
  pull_id uuid REFERENCES maintainer_pull_requests (pull_id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source = 'admin' AND changed_by_admin IS NOT NULL AND changed_by_user IS NULL)
    OR (source = 'adopted' AND changed_by_user IS NOT NULL AND changed_by_admin IS NULL
        AND pull_id IS NOT NULL AND guild_key IS NOT NULL AND NOT open_to_guilds)
  )
);
CREATE INDEX maintainer_ownership_repo ON maintainer_ownership_changes (repository_id, created_at DESC);

CREATE TABLE maintainer_review_claims (
  claim_id uuid PRIMARY KEY,
  pull_id uuid NOT NULL REFERENCES maintainer_pull_requests (pull_id),
  reviewer_user_id uuid NOT NULL REFERENCES users (user_id),
  reviewer_github_id text NOT NULL CHECK (reviewer_github_id ~ '^[0-9]+$'),
  reviewer_login text NOT NULL CHECK (reviewer_login ~ '^[A-Za-z0-9-]{1,39}(\[bot\])?$'),
  acting_as text NOT NULL CHECK (acting_as IN ('admin', 'guild_leader')),
  guild_key text REFERENCES positioning_guild_catalog (guild_key),
  claimed_by_admin uuid REFERENCES platform_admins (admin_id),
  claimed_by_user uuid REFERENCES users (user_id),
  assignment text NOT NULL CHECK (assignment IN ('self', 'assigned')),
  -- NULL when the reviewer claimed it. A written reason is required when someone else assigned it.
  assign_reason text,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  state text NOT NULL CHECK (state IN ('active', 'released', 'expired', 'completed')),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR end_reason IN (
    'self_released', 'admin_released', 'pull_closed', 'reviewer_not_eligible', 'review_submitted')),
  github_request_state text NOT NULL CHECK (github_request_state IN (
    'not_requested', 'pending', 'requested', 'skipped', 'failed', 'removing', 'removed')),
  github_request_error text CHECK (github_request_error IS NULL OR char_length(github_request_error) BETWEEN 1 AND 80),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  CHECK ((acting_as = 'admin' AND guild_key IS NULL) OR (acting_as = 'guild_leader' AND guild_key IS NOT NULL)),
  CHECK (num_nonnulls(claimed_by_admin, claimed_by_user) = 1),
  CHECK (
    (assignment = 'self' AND assign_reason IS NULL)
    OR (assignment = 'assigned' AND assign_reason IS NOT NULL AND char_length(assign_reason) BETWEEN 3 AND 1000)
  ),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (
    (state = 'active' AND ended_at IS NULL AND end_reason IS NULL)
    OR (state = 'expired' AND ended_at IS NOT NULL AND end_reason IS NULL)
    OR (state IN ('released', 'completed') AND ended_at IS NOT NULL AND end_reason IS NOT NULL)
  )
);

-- One live claim per pull. Ended rows stay for the detail history.
CREATE UNIQUE INDEX maintainer_claims_one_active ON maintainer_review_claims (pull_id) WHERE state = 'active';
-- The tick scans this for claims whose expiry has passed. A null expiry never matches.
CREATE INDEX maintainer_claims_expiry ON maintainer_review_claims (expires_at) WHERE state = 'active' AND expires_at IS NOT NULL;
-- Listing the claims one reviewer still holds.
CREATE INDEX maintainer_claims_reviewer_active ON maintainer_review_claims (reviewer_user_id) WHERE state = 'active';

-- Who may review a mirrored repository, and as whom.
-- Admins apply to every repository in their community. The member account must
-- share the admin email, be active, and have email_verified_at set: an unverified
-- member account could otherwise borrow an admin's email. GitHub is linked only
-- through OAuth (github_social_connections), never by a typed login.
-- A guild leader applies when they are the current officer, still an active member
-- of that guild, the account is active, GitHub is linked through OAuth, and the
-- repository is that guild's or is open for leaders to claim. An unowned repository
-- that is not open does not match any leader.
-- One person can appear more than once (admin, and leader of several guilds).
-- A claim picks one (user_id, acting_as, guild_key) row.
CREATE VIEW maintainer_eligible_reviewers (
  repository_id, community_id, user_id, display_name, github_user_id, github_login, acting_as, guild_key
) AS
SELECT r.repository_id, r.community_id, u.user_id, u.display_name, g.github_user_id, g.github_login,
       'admin'::text, NULL::text
FROM maintainer_repositories r
JOIN platform_admins a ON a.community_id = r.community_id AND a.active
JOIN users u ON u.community_id = a.community_id AND lower(u.email) = a.email
  AND u.active AND u.email_verified_at IS NOT NULL
JOIN github_social_connections g ON g.user_id = u.user_id AND g.community_id = u.community_id
UNION ALL
SELECT r.repository_id, r.community_id, u.user_id, u.display_name, g.github_user_id, g.github_login,
       'guild_leader'::text, o.guild_key
FROM maintainer_repositories r
JOIN positioning_guild_officers o ON o.community_id = r.community_id
  AND (o.guild_key = r.guild_key OR (r.guild_key IS NULL AND r.open_to_guilds))
JOIN positioning_profession_memberships m ON m.community_id = o.community_id
  AND m.guild_key = o.guild_key AND m.user_id = o.user_id AND m.state = 'active'
JOIN users u ON u.user_id = o.user_id AND u.community_id = o.community_id AND u.active
JOIN github_social_connections g ON g.user_id = u.user_id AND g.community_id = u.community_id;
