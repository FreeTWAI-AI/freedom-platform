-- Closed human Result schema, sharing the existing Asset lifecycle. No route,
-- execution identity, Grant, automatic GC or private-text policy is enabled.
ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK(purpose IN ('member.avatar','work.private-draft'));
ALTER TABLE assets ADD CONSTRAINT asset_profile_identity UNIQUE(asset_id,scope_id,representation_id,policy_revision,purpose);

ALTER TABLE asset_objects
  ADD COLUMN purpose text NOT NULL DEFAULT 'member.avatar',
  DROP CONSTRAINT asset_objects_variant_check,
  DROP CONSTRAINT asset_objects_content_type_check,
  DROP CONSTRAINT asset_objects_byte_size_check,
  DROP CONSTRAINT asset_objects_transform_version_check,
  ADD CONSTRAINT asset_object_profile FOREIGN KEY(asset_id,scope_id,representation_id,policy_revision,purpose)
    REFERENCES assets(asset_id,scope_id,representation_id,policy_revision,purpose),
  ADD CONSTRAINT asset_object_profile_shape CHECK(
    (purpose='member.avatar' AND variant='avatar' AND content_type='image/webp'
      AND byte_size BETWEEN 1 AND 131072 AND transform_version='avatar.webp.v1')
    OR (purpose='work.private-draft' AND variant='draft' AND content_type IN ('text/plain','text/markdown')
      AND byte_size BETWEEN 1 AND 262144 AND transform_version='private-text.utf8.v1')
  );

ALTER TABLE work_items ADD CONSTRAINT work_person_target_identity
  UNIQUE(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref);
-- Only the avatar target FK is replaced; the exact owner/Asset identity FK,
-- old lease/state guards and all old avatar defaults remain unchanged.
DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid='asset_upload_intents'::regclass AND confrelid='member_avatar_asset_targets'::regclass AND contype='f';
  EXECUTE format('ALTER TABLE asset_upload_intents DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE asset_upload_intents
  ADD COLUMN target_kind text NOT NULL DEFAULT 'member.avatar',
  ADD COLUMN target_work_id uuid,
  ADD COLUMN avatar_target_user_id uuid GENERATED ALWAYS AS
    (CASE WHEN target_kind='member.avatar' THEN target_user_id ELSE NULL END) STORED,
  ADD COLUMN work_mode text GENERATED ALWAYS AS
    (CASE WHEN target_kind='work.private-result' THEN 'personal_execution'::text ELSE NULL END) STORED,
  DROP CONSTRAINT asset_upload_intents_purpose_check,
  DROP CONSTRAINT asset_upload_intents_source_content_type_check,
  DROP CONSTRAINT asset_upload_intents_source_byte_size_check,
  DROP CONSTRAINT asset_upload_intents_reserved_bytes_check,
  ADD CONSTRAINT upload_avatar_target FOREIGN KEY(avatar_target_user_id,scope_id,owner_principal_id)
    REFERENCES member_avatar_asset_targets(user_id,scope_id,owner_principal_id),
  ADD CONSTRAINT upload_private_work_target FOREIGN KEY(target_work_id,work_mode,scope_id,owner_principal_id,target_user_id)
    REFERENCES work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref),
  ADD CONSTRAINT upload_profile_shape CHECK(
    (purpose='member.avatar' AND target_kind='member.avatar' AND target_work_id IS NULL
      AND source_content_type IN ('image/png','image/jpeg','image/webp')
      AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=131072)
    OR (purpose='work.private-draft' AND target_kind='work.private-result' AND target_work_id IS NOT NULL
      AND source_content_type IN ('text/plain','text/markdown')
      AND source_byte_size BETWEEN 1 AND 262144 AND reserved_bytes=262144)
  );
CREATE FUNCTION preserve_upload_typed_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.target_kind,NEW.target_work_id) IS DISTINCT FROM ROW(OLD.target_kind,OLD.target_work_id) THEN
    RAISE EXCEPTION 'Upload typed target is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_upload_typed_target BEFORE UPDATE ON asset_upload_intents
  FOR EACH ROW EXECUTE FUNCTION preserve_upload_typed_target();

-- The existing full object-metadata FK makes a pin's size exactly the verified
-- object's size. That object now has a purpose-specific cap; avatars therefore
-- remain <=128KiB, while only private text can use the 256KiB bound. No second
-- caller-controlled purpose or generic enlarged avatar profile is introduced.
ALTER TABLE asset_backup_pins DROP CONSTRAINT asset_backup_pins_byte_size_check;
ALTER TABLE asset_backup_pins ADD CONSTRAINT asset_backup_pins_byte_size_check CHECK(byte_size BETWEEN 1 AND 262144);

CREATE TABLE private_work_results (
  result_id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE REFERENCES asset_upload_intents(intent_id),
  work_item_id uuid NOT NULL,
  work_mode text GENERATED ALWAYS AS ('personal_execution'::text) STORED,
  scope_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  asset_id uuid NOT NULL UNIQUE,
  representation_id uuid NOT NULL,
  policy_revision text NOT NULL,
  purpose text GENERATED ALWAYS AS ('work.private-draft'::text) STORED,
  provenance text GENERATED ALWAYS AS ('human'::text) STORED,
  revision bigint NOT NULL CHECK(revision>0),
  work_version bigint NOT NULL CHECK(work_version>1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(work_item_id,work_mode,scope_id,owner_principal_id,owner_user_id)
    REFERENCES work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref),
  FOREIGN KEY(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,policy_revision,representation_id)
    REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,policy_revision,representation_id),
  UNIQUE(work_item_id,revision),
  UNIQUE(work_item_id,work_version),
  UNIQUE(result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version)
);
CREATE TABLE private_work_result_targets (
  work_item_id uuid PRIMARY KEY,
  work_mode text GENERATED ALWAYS AS ('personal_execution'::text) STORED,
  scope_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  result_id uuid,
  asset_id uuid,
  -- Historical attach snapshot, not an independently incremented version.
  linked_at_work_version bigint,
  purpose text GENERATED ALWAYS AS ('work.private-draft'::text) STORED,
  asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
  FOREIGN KEY(work_item_id,work_mode,scope_id,owner_principal_id,owner_user_id)
    REFERENCES work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref),
  FOREIGN KEY(result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,linked_at_work_version)
    REFERENCES private_work_results(result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version),
  FOREIGN KEY(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,asset_state)
    REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
  CHECK((result_id IS NULL AND asset_id IS NULL AND linked_at_work_version IS NULL)
    OR (result_id IS NOT NULL AND asset_id IS NOT NULL AND linked_at_work_version IS NOT NULL))
);

CREATE FUNCTION preserve_private_result_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target work_items%ROWTYPE; latest private_work_results%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Result target identity is retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.work_item_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id)
    IS DISTINCT FROM ROW(OLD.work_item_id,OLD.scope_id,OLD.owner_principal_id,OLD.owner_user_id) THEN
    RAISE EXCEPTION 'Result target cannot be rebound' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT target FROM work_items WHERE work_item_id=NEW.work_item_id FOR UPDATE;
  IF target.work_mode<>'personal_execution' OR target.state<>'draft' THEN
    RAISE EXCEPTION 'Result target must be active private Work' USING ERRCODE='23514';
  END IF;
  SELECT * INTO latest FROM private_work_results WHERE work_item_id=NEW.work_item_id ORDER BY revision DESC LIMIT 1;
  IF NEW.result_id IS DISTINCT FROM latest.result_id THEN
    RAISE EXCEPTION 'Result pointer must reference latest immutable revision' USING ERRCODE='23514';
  END IF;
  IF NEW.asset_id IS NOT NULL THEN
    PERFORM 1 FROM assets WHERE asset_id=NEW.asset_id AND deletion_fence=0 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Result asset is permanently fenced' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_private_result_target BEFORE INSERT OR UPDATE OR DELETE ON private_work_result_targets
  FOR EACH ROW EXECUTE FUNCTION preserve_private_result_target();

-- INSERT is the sole Result append/CAS primitive. Callers supply ONLY result_id
-- and intent_id; all ownership/provenance/version fields come from real rows.
-- App adapter must not separately increment Work. The same transaction must
-- finish the intent, write metadata-only facts and receipt, or roll everything
-- back. No authentication is implied by a SQL row: current session, eligibility,
-- policy and quota belong to the closed future scoped member adapter.
CREATE FUNCTION append_private_work_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent asset_upload_intents%ROWTYPE; target work_items%ROWTYPE; artifact assets%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Result history is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.work_item_id IS NOT NULL OR NEW.scope_id IS NOT NULL OR NEW.owner_principal_id IS NOT NULL OR NEW.owner_user_id IS NOT NULL
    OR NEW.asset_id IS NOT NULL OR NEW.representation_id IS NOT NULL OR NEW.policy_revision IS NOT NULL
    OR NEW.revision IS NOT NULL OR NEW.work_version IS NOT NULL THEN
    RAISE EXCEPTION 'Result identity and versions are derived from the upload intent' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT intent FROM asset_upload_intents WHERE intent_id=NEW.intent_id;
  IF intent.purpose<>'work.private-draft' OR intent.target_kind<>'work.private-result' THEN
    RAISE EXCEPTION 'Result requires a private text intent' USING ERRCODE='23514';
  END IF;
  -- The initial routing read is safe because intent target identity is immutable.
  SELECT * INTO STRICT target FROM work_items WHERE work_item_id=intent.target_work_id FOR UPDATE;
  IF target.work_mode<>'personal_execution' OR target.state<>'draft' THEN
    RAISE EXCEPTION 'Result requires active private Work' USING ERRCODE='23514';
  END IF;
  -- Work serializes first creation as well; don't create a placeholder in this
  -- BEFORE trigger because ON CONFLICT may subsequently suppress the Result.
  PERFORM 1 FROM private_work_result_targets WHERE work_item_id=target.work_item_id FOR UPDATE;
  SELECT * INTO STRICT intent FROM asset_upload_intents WHERE intent_id=NEW.intent_id FOR UPDATE;
  SELECT * INTO STRICT artifact FROM assets WHERE asset_id=intent.asset_id FOR UPDATE;
  IF intent.state<>'stored' OR intent.expires_at<=clock_timestamp() OR intent.lease_expires_at<=clock_timestamp()
    OR artifact.state<>'ready' OR artifact.deletion_fence<>0 THEN
    RAISE EXCEPTION 'Result requires a live stored intent and ready unfenced asset' USING ERRCODE='23514';
  END IF;
  IF intent.expected_version<>target.aggregate_version THEN
    RAISE EXCEPTION 'Private Work version changed' USING ERRCODE='P0412';
  END IF;
  NEW.work_item_id:=target.work_item_id; NEW.scope_id:=intent.scope_id;
  NEW.owner_principal_id:=intent.owner_principal_id; NEW.owner_user_id:=intent.target_user_id;
  NEW.asset_id:=intent.asset_id; NEW.representation_id:=intent.representation_id; NEW.policy_revision:=intent.policy_revision;
  NEW.work_version:=target.aggregate_version+1;
  SELECT COALESCE(max(revision),0)+1 INTO NEW.revision FROM private_work_results WHERE work_item_id=target.work_item_id;
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER append_private_work_result BEFORE INSERT OR UPDATE OR DELETE ON private_work_results
  FOR EACH ROW EXECUTE FUNCTION append_private_work_result();
CREATE FUNCTION publish_private_work_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Unique-index insertion can wait after the BEFORE trigger (even when the
  -- competing transaction eventually rolls back). Recheck the actual clock
  -- here, still holding Work/intent/Asset locks, before consuming a Work CAS.
  IF NOT EXISTS(SELECT 1 FROM asset_upload_intents i JOIN assets a ON a.asset_id=i.asset_id
    WHERE i.intent_id=NEW.intent_id AND i.state='stored' AND i.expires_at>clock_timestamp()
      AND i.lease_expires_at>clock_timestamp() AND a.state='ready' AND a.deletion_fence=0) THEN
    RAISE EXCEPTION 'Result lease expired before actual insertion' USING ERRCODE='23514';
  END IF;
  -- Mutation occurs only for a successfully inserted Result, never for a row
  -- suppressed by INSERT ... ON CONFLICT DO NOTHING after its BEFORE trigger.
  UPDATE work_items SET aggregate_version=NEW.work_version
    WHERE work_item_id=NEW.work_item_id AND aggregate_version=NEW.work_version-1 AND state='draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'Private Work version changed' USING ERRCODE='P0412'; END IF;
  INSERT INTO private_work_result_targets(work_item_id,scope_id,owner_principal_id,owner_user_id,result_id,asset_id,linked_at_work_version)
    VALUES(NEW.work_item_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.result_id,NEW.asset_id,NEW.work_version)
    ON CONFLICT(work_item_id) DO UPDATE SET result_id=EXCLUDED.result_id,asset_id=EXCLUDED.asset_id,linked_at_work_version=EXCLUDED.linked_at_work_version;
  RETURN NULL;
END;
$$;
CREATE TRIGGER publish_private_work_result AFTER INSERT ON private_work_results
  FOR EACH ROW EXECUTE FUNCTION publish_private_work_result();
CREATE FUNCTION require_private_result_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM asset_upload_intents WHERE intent_id=NEW.intent_id AND state='finalized') THEN
    RAISE EXCEPTION 'Result and intent finalization must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_private_result_finalization AFTER INSERT ON private_work_results
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_private_result_finalization();
CREATE FUNCTION require_finalized_private_intent_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private_work_results WHERE intent_id=NEW.intent_id) THEN
    RAISE EXCEPTION 'Private intent finalization requires its immutable Result' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_finalized_private_intent_result AFTER INSERT OR UPDATE ON asset_upload_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.purpose='work.private-draft' AND NEW.state='finalized')
  EXECUTE FUNCTION require_finalized_private_intent_result();
