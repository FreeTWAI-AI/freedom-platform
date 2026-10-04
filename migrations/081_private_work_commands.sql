-- Closed human-only private Work commands. No route, Result or AI activation.
-- Preserve the 077 community branch verbatim; only personal state is extended.
ALTER TABLE work_items DROP CONSTRAINT work_mode_shape;
ALTER TABLE work_items ADD CONSTRAINT work_mode_shape CHECK (
    (work_mode='community_collaboration' AND community_id IS NOT NULL AND owner_principal_id IS NULL
      AND state IN ('open','claiming_closed','accepted') AND gain IS NOT NULL AND acceptance_criteria IS NOT NULL
      AND participation_terms IS NOT NULL AND participation_terms_revision IS NOT NULL
      AND participation_terms_sha256 IS NOT NULL AND claim_window_expires_at IS NOT NULL AND due_at IS NOT NULL)
    OR (work_mode='personal_execution' AND community_id IS NULL AND scope_id IS NOT NULL AND owner_principal_id IS NOT NULL
      AND state IN ('draft','archived') AND gain IS NULL AND acceptance_criteria IS NULL AND participation_terms IS NULL
      AND participation_terms_revision IS NULL AND participation_terms_sha256 IS NULL
      AND claim_window_expires_at IS NULL AND due_at IS NULL)
  );

-- Archive is a retained, terminal state, not deletion/erasure. Existing identity
-- protection and community-only downstream FKs from 077 remain authoritative.
CREATE FUNCTION preserve_private_work_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_mode='personal_execution' THEN
    IF TG_OP='INSERT' AND NEW.state<>'draft' THEN
      RAISE EXCEPTION 'Private Work must start draft' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND OLD.state='archived' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Archived private Work is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_private_work_archive BEFORE INSERT OR UPDATE ON work_items
  FOR EACH ROW EXECUTE FUNCTION preserve_private_work_archive();
