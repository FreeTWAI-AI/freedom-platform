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
