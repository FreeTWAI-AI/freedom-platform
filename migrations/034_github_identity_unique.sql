-- One GitHub stable user ID (provider subject) belongs to at most one workshop
-- member platform-wide. Login and email are mutable/untrusted and never keys.
-- Existing duplicates fail the whole migration: no owner is chosen, merged or
-- deleted automatically. The message carries counts only, never member data.
LOCK TABLE github_social_connections IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE duplicate_ids bigint; duplicate_rows bigint;
BEGIN
  SELECT count(*),coalesce(sum(linked),0) INTO duplicate_ids,duplicate_rows
    FROM (SELECT count(*) AS linked FROM github_social_connections GROUP BY github_user_id HAVING count(*)>1) duplicates;
  IF duplicate_ids>0 THEN
    RAISE EXCEPTION 'github_identity_duplicate: % GitHub user ID(s) are linked to more than one member (% connection rows)',duplicate_ids,duplicate_rows
      USING HINT='Resolve each duplicate manually with the members involved (keep one owner, disconnect the others), then rerun migrations. See docs/development/github-identity-uniqueness.md.';
  END IF;
END $$;
ALTER TABLE github_social_connections ADD CONSTRAINT github_social_connections_github_user_unique UNIQUE (github_user_id);
