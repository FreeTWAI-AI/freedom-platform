-- New repositories start with no guild and open to guild leaders.
-- A guild-owned repository stays closed (maintainer_repositories_check).
-- Only an unowned repository that was never opened and has no ownership
-- history is opened here. An admin who already closed one, or any row that
-- already has a change, is left alone. aggregate_version moves only then.

ALTER TABLE maintainer_repositories ALTER COLUMN open_to_guilds SET DEFAULT true;

UPDATE maintainer_repositories AS r
SET open_to_guilds = true,
    aggregate_version = aggregate_version + 1,
    updated_at = now()
WHERE r.guild_key IS NULL
  AND NOT r.open_to_guilds
  AND NOT EXISTS (
    SELECT 1 FROM maintainer_ownership_changes AS c
    WHERE c.repository_id = r.repository_id
  );

-- A skill book id is set only when the repository's scope is skill_book.
-- The id matches catalog book ids. One book maps to one repository per community.
-- The appointment itself is skill_book_maintainers: named, scoped, revocable,
-- and admin-appointed. This column does not grant a guild.
ALTER TABLE maintainer_repositories
  ADD COLUMN skill_book_id text,
  ADD CONSTRAINT maintainer_repositories_skill_book_id_check
    CHECK (skill_book_id IS NULL OR skill_book_id ~ '^[a-z0-9-]{1,100}$'),
  ADD CONSTRAINT maintainer_repositories_skill_book_scope_check
    CHECK (skill_book_id IS NULL OR scope_kind = 'skill_book');

CREATE UNIQUE INDEX maintainer_repos_skill_book
  ON maintainer_repositories (community_id, skill_book_id)
  WHERE skill_book_id IS NOT NULL;

ALTER TABLE maintainer_ownership_changes
  ADD COLUMN skill_book_id text,
  ADD CONSTRAINT maintainer_ownership_changes_skill_book_id_check
    CHECK (skill_book_id IS NULL OR skill_book_id ~ '^[a-z0-9-]{1,100}$'),
  ADD CONSTRAINT maintainer_ownership_changes_skill_book_scope_check
    CHECK (skill_book_id IS NULL OR scope_kind = 'skill_book');

ALTER TABLE maintainer_review_claims
  ADD COLUMN skill_book_id text,
  ADD CONSTRAINT maintainer_review_claims_skill_book_id_check
    CHECK (skill_book_id IS NULL OR skill_book_id ~ '^[a-z0-9-]{1,100}$');

-- 062 left these checks unnamed in source; PostgreSQL named them as below.
ALTER TABLE maintainer_review_claims DROP CONSTRAINT maintainer_review_claims_acting_as_check;
ALTER TABLE maintainer_review_claims
  ADD CONSTRAINT maintainer_review_claims_acting_as_check
  CHECK (acting_as IN ('admin', 'guild_leader', 'skill_book_maintainer'));

ALTER TABLE maintainer_review_claims DROP CONSTRAINT maintainer_review_claims_check;
ALTER TABLE maintainer_review_claims
  ADD CONSTRAINT maintainer_review_claims_check
  CHECK (
    (acting_as = 'admin' AND guild_key IS NULL AND skill_book_id IS NULL)
    OR (acting_as = 'guild_leader' AND guild_key IS NOT NULL AND skill_book_id IS NULL)
    OR (acting_as = 'skill_book_maintainer' AND guild_key IS NULL AND skill_book_id IS NOT NULL)
  );

-- Who may review a mirrored repository, and as whom.
-- Admins apply to every repository in their community. The member account must
-- share the admin email, be active, and have email_verified_at set: an unverified
-- member account could otherwise borrow an admin's email. GitHub is linked only
-- through OAuth (github_social_connections), never by a typed login.
-- A guild leader applies when they are the current officer, still an active member
-- of that guild, the account is active, GitHub is linked through OAuth, and the
-- repository is that guild's or is open for leaders to claim. An unowned repository
-- that is not open does not match any leader.
-- A skill-book maintainer applies when skill_book_maintainers is active for
-- r.skill_book_id in the same community, the user is active, and GitHub is linked
-- through OAuth. The appointment is the basis: it is named, scoped to that book,
-- revocable, and admin-appointed. The skill editor's development-guild gate is
-- not part of review eligibility. guild_key is null on this branch; skill_book_id
-- is null on the admin and guild-leader branches.
-- One person can appear more than once (admin, leader of several guilds, and
-- maintainer of the repository's book). A claim picks one
-- (user_id, acting_as, guild_key, skill_book_id) row.
CREATE OR REPLACE VIEW maintainer_eligible_reviewers (
  repository_id, community_id, user_id, display_name, github_user_id, github_login, acting_as, guild_key, skill_book_id
) AS
SELECT r.repository_id, r.community_id, u.user_id, u.display_name, g.github_user_id, g.github_login,
       'admin'::text, NULL::text, NULL::text
FROM maintainer_repositories r
JOIN platform_admins a ON a.community_id = r.community_id AND a.active
JOIN users u ON u.community_id = a.community_id AND lower(u.email) = a.email
  AND u.active AND u.email_verified_at IS NOT NULL
JOIN github_social_connections g ON g.user_id = u.user_id AND g.community_id = u.community_id
UNION ALL
SELECT r.repository_id, r.community_id, u.user_id, u.display_name, g.github_user_id, g.github_login,
       'guild_leader'::text, o.guild_key, NULL::text
FROM maintainer_repositories r
JOIN positioning_guild_officers o ON o.community_id = r.community_id
  AND (o.guild_key = r.guild_key OR (r.guild_key IS NULL AND r.open_to_guilds))
JOIN positioning_profession_memberships m ON m.community_id = o.community_id
  AND m.guild_key = o.guild_key AND m.user_id = o.user_id AND m.state = 'active'
JOIN users u ON u.user_id = o.user_id AND u.community_id = o.community_id AND u.active
JOIN github_social_connections g ON g.user_id = u.user_id AND g.community_id = u.community_id
UNION ALL
SELECT r.repository_id, r.community_id, u.user_id, u.display_name, g.github_user_id, g.github_login,
       'skill_book_maintainer'::text, NULL::text, m.book_id
FROM maintainer_repositories r
JOIN skill_book_maintainers m ON m.community_id = r.community_id
  AND m.book_id = r.skill_book_id AND m.active
JOIN users u ON u.user_id = m.user_id AND u.community_id = m.community_id AND u.active
JOIN github_social_connections g ON g.user_id = u.user_id AND g.community_id = u.community_id;
