-- WORK-A is read-only for personal work. Existing rows keep every old value and
-- remain community collaboration. Null scope on that branch is an explicit
-- legacy bridge, not permission to create an unscoped personal resource.
ALTER TABLE principals ADD CONSTRAINT principal_user_identity UNIQUE(principal_id,user_ref);
ALTER TABLE resource_scopes ADD CONSTRAINT scope_person_identity UNIQUE(scope_id,kind,owner_principal_id);
ALTER TABLE resource_scopes ADD CONSTRAINT scope_community_identity UNIQUE(scope_id,kind,community_ref);

ALTER TABLE work_items
  ADD COLUMN work_mode text NOT NULL DEFAULT 'community_collaboration' CHECK(work_mode IN ('community_collaboration','personal_execution')),
  ADD COLUMN scope_id uuid,
  ADD COLUMN owner_principal_id uuid,
  ADD COLUMN scope_kind text GENERATED ALWAYS AS (CASE WHEN work_mode='personal_execution' THEN 'personal' ELSE 'community' END) STORED,
  ALTER COLUMN community_id DROP NOT NULL,
  ALTER COLUMN gain DROP NOT NULL,
  ALTER COLUMN acceptance_criteria DROP NOT NULL,
  ALTER COLUMN participation_terms DROP NOT NULL,
  ALTER COLUMN participation_terms_revision DROP NOT NULL,
  ALTER COLUMN participation_terms_sha256 DROP NOT NULL,
  ALTER COLUMN claim_window_expires_at DROP NOT NULL,
  ALTER COLUMN due_at DROP NOT NULL,
  DROP CONSTRAINT work_items_state_check,
  ADD CONSTRAINT work_mode_identity UNIQUE(work_item_id,work_mode),
  ADD CONSTRAINT work_scope_kind FOREIGN KEY(scope_id,scope_kind) REFERENCES resource_scopes(scope_id,kind),
  ADD CONSTRAINT work_person_scope FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
  ADD CONSTRAINT work_community_scope FOREIGN KEY(scope_id,scope_kind,community_id) REFERENCES resource_scopes(scope_id,kind,community_ref),
  ADD CONSTRAINT work_person_owner FOREIGN KEY(owner_principal_id,owner_ref) REFERENCES principals(principal_id,user_ref),
  ADD CONSTRAINT work_mode_shape CHECK (
    (work_mode='community_collaboration' AND community_id IS NOT NULL AND owner_principal_id IS NULL
      AND state IN ('open','claiming_closed','accepted') AND gain IS NOT NULL AND acceptance_criteria IS NOT NULL
      AND participation_terms IS NOT NULL AND participation_terms_revision IS NOT NULL
      AND participation_terms_sha256 IS NOT NULL AND claim_window_expires_at IS NOT NULL AND due_at IS NOT NULL)
    OR (work_mode='personal_execution' AND community_id IS NULL AND scope_id IS NOT NULL AND owner_principal_id IS NOT NULL
      AND state='draft' AND gain IS NULL AND acceptance_criteria IS NULL AND participation_terms IS NULL
      AND participation_terms_revision IS NULL AND participation_terms_sha256 IS NULL
      AND claim_window_expires_at IS NULL AND due_at IS NULL)
  );
CREATE INDEX personal_work_owner_page ON work_items(owner_principal_id,scope_id,created_at DESC,work_item_id DESC)
  WHERE work_mode='personal_execution';

-- Mode/ownership cannot be reclassified: old command receipts and downstream
-- community facts must never become a route to newly private data.
CREATE FUNCTION preserve_work_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Work identity cannot be deleted and rebound' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.work_item_id,NEW.work_mode,NEW.owner_ref,NEW.owner_principal_id,NEW.community_id)
    IS DISTINCT FROM ROW(OLD.work_item_id,OLD.work_mode,OLD.owner_ref,OLD.owner_principal_id,OLD.community_id)
    OR (OLD.scope_id IS NOT NULL AND NEW.scope_id IS DISTINCT FROM OLD.scope_id) THEN
    RAISE EXCEPTION 'Work mode and ownership are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_work_identity BEFORE UPDATE OR DELETE ON work_items
  FOR EACH ROW EXECUTE FUNCTION preserve_work_identity();

-- These are facts about collaboration only. A literal generated discriminator
-- plus a real FK rejects private Claim/review/Contribution/benefit construction.
ALTER TABLE work_claims ADD COLUMN work_mode text GENERATED ALWAYS AS ('community_collaboration'::text) STORED,
  ADD CONSTRAINT claim_community_work FOREIGN KEY(work_item_id,work_mode) REFERENCES work_items(work_item_id,work_mode);
ALTER TABLE work_review_routes ADD COLUMN work_mode text GENERATED ALWAYS AS ('community_collaboration'::text) STORED,
  ADD CONSTRAINT review_community_work FOREIGN KEY(work_item_id,work_mode) REFERENCES work_items(work_item_id,work_mode);
ALTER TABLE contributions ADD COLUMN work_mode text GENERATED ALWAYS AS ('community_collaboration'::text) STORED,
  ADD CONSTRAINT contribution_community_work FOREIGN KEY(work_item_id,work_mode) REFERENCES work_items(work_item_id,work_mode);
ALTER TABLE work_benefit_observations ADD COLUMN work_mode text GENERATED ALWAYS AS ('community_collaboration'::text) STORED,
  ADD CONSTRAINT benefit_community_work FOREIGN KEY(work_item_ref,work_mode) REFERENCES work_items(work_item_id,work_mode);
