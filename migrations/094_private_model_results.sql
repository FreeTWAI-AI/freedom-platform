-- Add typed, private model Results while retaining the original human table,
-- ownership, Asset lifecycle and sole Work CAS. No provider credential or text
-- is stored in execution receipts. Neither export nor persistence is seeded.
ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_private_work_target;
ALTER TABLE asset_upload_intents DROP COLUMN work_mode;
ALTER TABLE asset_upload_intents ADD COLUMN work_mode text GENERATED ALWAYS AS
 (CASE WHEN target_kind IN ('work.private-result','work.model-result') THEN 'personal_execution'::text ELSE NULL END) STORED;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_private_work_target
 FOREIGN KEY(target_work_id,work_mode,scope_id,owner_principal_id,target_user_id)
 REFERENCES work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref);
ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK(
 (purpose='member.avatar' AND target_kind='member.avatar' AND target_work_id IS NULL
  AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=131072)
 OR (purpose='work.private-draft' AND target_kind='work.private-result' AND target_work_id IS NOT NULL
  AND source_content_type IN ('text/plain','text/markdown') AND source_byte_size BETWEEN 1 AND 262144 AND reserved_bytes=262144)
 OR (purpose='work.private-draft' AND target_kind='work.model-result' AND target_work_id IS NOT NULL
  AND source_content_type='text/plain' AND source_byte_size BETWEEN 1 AND 16384 AND reserved_bytes=16384));

ALTER TABLE model_text_steps ADD CONSTRAINT model_step_result_owner_identity
 UNIQUE(step_id,attempt_id,work_item_id,owner_user_id,owner_principal_id,scope_id);
CREATE TABLE private_model_work_results (
 result_id uuid PRIMARY KEY,
 intent_id uuid NOT NULL UNIQUE REFERENCES asset_upload_intents(intent_id),
 step_id uuid NOT NULL UNIQUE REFERENCES model_text_steps(step_id),
 work_item_id uuid NOT NULL,
 work_mode text GENERATED ALWAYS AS ('personal_execution'::text) STORED,
 scope_id uuid NOT NULL, owner_principal_id uuid NOT NULL, owner_user_id uuid NOT NULL,
 asset_id uuid NOT NULL UNIQUE, representation_id uuid NOT NULL, policy_revision text NOT NULL,
 purpose text GENERATED ALWAYS AS ('work.private-draft'::text) STORED,
 provenance text GENERATED ALWAYS AS ('model'::text) STORED,
 revision bigint NOT NULL CHECK(revision>0), work_version bigint NOT NULL CHECK(work_version>1),
 attempt_id uuid NOT NULL, dispatch_intent_id uuid NOT NULL,
 model_binding jsonb NOT NULL CHECK(jsonb_typeof(model_binding)='object'),
 observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object' AND NOT observation ?| ARRAY['text','prompt','secret','credential','stderr']),
 evidence_origin text NOT NULL CHECK(evidence_origin IN ('synthetic_local_fixture','provider_https')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(work_item_id,work_mode,scope_id,owner_principal_id,owner_user_id)
  REFERENCES work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref),
 FOREIGN KEY(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,policy_revision,representation_id)
  REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,policy_revision,representation_id),
 FOREIGN KEY(step_id,attempt_id,work_item_id,owner_user_id,owner_principal_id,scope_id)
  REFERENCES model_text_steps(step_id,attempt_id,work_item_id,owner_user_id,owner_principal_id,scope_id),
 UNIQUE(work_item_id,revision), UNIQUE(work_item_id,work_version), UNIQUE(result_id,step_id),
 UNIQUE(result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version)
);
-- A common immutable identity index provides one global revision sequence and
-- current pointer. Disjoint generated FKs preserve actual human/model origin.
CREATE TABLE private_work_result_index (
 result_id uuid PRIMARY KEY, provenance text NOT NULL CHECK(provenance IN ('human','model')),
 work_item_id uuid NOT NULL, scope_id uuid NOT NULL, owner_principal_id uuid NOT NULL, owner_user_id uuid NOT NULL,
 asset_id uuid NOT NULL UNIQUE, work_version bigint NOT NULL CHECK(work_version>1), revision bigint NOT NULL CHECK(revision>0),
 human_result_id uuid GENERATED ALWAYS AS (CASE WHEN provenance='human' THEN result_id ELSE NULL END) STORED,
 model_result_id uuid GENERATED ALWAYS AS (CASE WHEN provenance='model' THEN result_id ELSE NULL END) STORED,
 FOREIGN KEY(human_result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version)
  REFERENCES private_work_results(result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version),
 FOREIGN KEY(model_result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version)
  REFERENCES private_model_work_results(result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version),
 UNIQUE(work_item_id,revision), UNIQUE(work_item_id,work_version),
 UNIQUE(result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version)
);
INSERT INTO private_work_result_index(result_id,provenance,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version,revision)
 SELECT result_id,'human',work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version,revision FROM private_work_results;
CREATE FUNCTION preserve_private_result_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Result identity history is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM private_work_result_catalog WHERE result_id=NEW.result_id AND provenance=NEW.provenance AND revision=NEW.revision) THEN
  RAISE EXCEPTION 'Result index requires actual typed revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE VIEW private_work_result_catalog AS
 SELECT result_id,intent_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,representation_id,policy_revision,
  revision,work_version,created_at,provenance,NULL::text evidence_origin,NULL::uuid step_id,NULL::uuid attempt_id,
  NULL::uuid dispatch_intent_id,NULL::jsonb model_binding,NULL::jsonb observation FROM private_work_results
 UNION ALL
 SELECT result_id,intent_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,representation_id,policy_revision,
  revision,work_version,created_at,provenance,evidence_origin,step_id,attempt_id,dispatch_intent_id,model_binding,observation FROM private_model_work_results;
CREATE TRIGGER preserve_private_result_index BEFORE INSERT OR UPDATE OR DELETE ON private_work_result_index
 FOR EACH ROW EXECUTE FUNCTION preserve_private_result_index();
DO $$ DECLARE name text; BEGIN
 SELECT conname INTO STRICT name FROM pg_constraint WHERE conrelid='private_work_result_targets'::regclass
  AND confrelid='private_work_results'::regclass AND contype='f';
 EXECUTE format('ALTER TABLE private_work_result_targets DROP CONSTRAINT %I',name);
END; $$;
ALTER TABLE private_work_result_targets ADD CONSTRAINT private_current_result_identity
 FOREIGN KEY(result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,linked_at_work_version)
 REFERENCES private_work_result_index(result_id,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version);

CREATE OR REPLACE FUNCTION preserve_private_result_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target work_items%ROWTYPE; latest private_work_result_index%ROWTYPE;
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
  SELECT * INTO latest FROM private_work_result_index WHERE work_item_id=NEW.work_item_id ORDER BY revision DESC LIMIT 1;
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
CREATE OR REPLACE FUNCTION append_private_work_result() RETURNS trigger LANGUAGE plpgsql AS $$
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
  SELECT COALESCE(max(revision),0)+1 INTO NEW.revision FROM private_work_result_index WHERE work_item_id=target.work_item_id;
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION publish_private_work_result() RETURNS trigger LANGUAGE plpgsql AS $$
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
  INSERT INTO private_work_result_index(result_id,provenance,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version,revision)
    VALUES(NEW.result_id,NEW.provenance,NEW.work_item_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.asset_id,NEW.work_version,NEW.revision);
  INSERT INTO private_work_result_targets(work_item_id,scope_id,owner_principal_id,owner_user_id,result_id,asset_id,linked_at_work_version)
    VALUES(NEW.work_item_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.result_id,NEW.asset_id,NEW.work_version)
    ON CONFLICT(work_item_id) DO UPDATE SET result_id=EXCLUDED.result_id,asset_id=EXCLUDED.asset_id,linked_at_work_version=EXCLUDED.linked_at_work_version;
  RETURN NULL;
END;
$$;
CREATE FUNCTION append_private_model_work_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s model_text_steps%ROWTYPE; i asset_upload_intents%ROWTYPE; w work_items%ROWTYPE; a assets%ROWTYPE; o asset_objects%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Model Result history immutable' USING ERRCODE='23514'; END IF;
 IF jsonb_strip_nulls(to_jsonb(NEW)-ARRAY['result_id','intent_id','step_id','created_at','work_mode','purpose','provenance'])<>'{}'::jsonb THEN
  RAISE EXCEPTION 'Model Result fields are derived from actual Step and Asset' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT s FROM model_text_steps WHERE step_id=NEW.step_id;
 PERFORM check_model_text_step_current(TG_TABLE_SCHEMA,to_jsonb(s));
 SELECT * INTO STRICT w FROM work_items WHERE work_item_id=s.work_item_id FOR UPDATE;
 SELECT * INTO STRICT s FROM model_text_steps WHERE step_id=NEW.step_id FOR UPDATE;
 IF s.state IS DISTINCT FROM 'awaiting_result' OR s.observation IS NULL THEN
  RAISE EXCEPTION 'Actual observed Step required' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM private_work_result_targets WHERE work_item_id=w.work_item_id FOR UPDATE;
 SELECT * INTO STRICT i FROM asset_upload_intents WHERE intent_id=NEW.intent_id FOR UPDATE;
 SELECT * INTO STRICT a FROM assets WHERE asset_id=i.asset_id FOR UPDATE;
 SELECT * INTO STRICT o FROM asset_objects WHERE asset_id=a.asset_id;
 IF i.target_kind IS DISTINCT FROM 'work.model-result' OR i.purpose IS DISTINCT FROM 'work.private-draft'
  OR ROW(i.target_work_id,i.scope_id,i.owner_principal_id,i.target_user_id) IS DISTINCT FROM ROW(s.work_item_id,s.scope_id,s.owner_principal_id,s.owner_user_id)
  OR i.state IS DISTINCT FROM 'stored' OR i.expires_at<=clock_timestamp() OR i.lease_expires_at IS NULL OR i.lease_expires_at<=clock_timestamp()
  OR i.expected_version IS DISTINCT FROM w.aggregate_version OR a.state IS DISTINCT FROM 'ready' OR a.deletion_fence<>0
  OR o.content_type IS DISTINCT FROM 'text/plain' OR o.content_sha256 IS DISTINCT FROM s.observation->>'outputSha256'
  OR o.byte_size IS DISTINCT FROM (s.observation->>'outputByteSize')::integer
  OR i.source_sha256 IS DISTINCT FROM o.content_sha256 OR i.source_byte_size IS DISTINCT FROM o.byte_size THEN
  RAISE EXCEPTION 'Exact live private model Asset required' USING ERRCODE='23514'; END IF;
 NEW.work_item_id:=w.work_item_id; NEW.scope_id:=s.scope_id; NEW.owner_principal_id:=s.owner_principal_id; NEW.owner_user_id:=s.owner_user_id;
 NEW.asset_id:=i.asset_id; NEW.representation_id:=i.representation_id; NEW.policy_revision:=i.policy_revision;
 NEW.work_version:=w.aggregate_version+1;
 SELECT COALESCE(max(revision),0)+1 INTO NEW.revision FROM private_work_result_index WHERE work_item_id=w.work_item_id;
 NEW.attempt_id:=s.attempt_id; NEW.dispatch_intent_id:=s.intent_id; NEW.model_binding:=s.binding;
 NEW.observation:=s.observation; NEW.evidence_origin:=s.evidence_origin; NEW.created_at:=clock_timestamp();
 RETURN NEW;
END; $$;
CREATE TRIGGER append_private_model_work_result BEFORE INSERT OR UPDATE OR DELETE ON private_model_work_results
 FOR EACH ROW EXECUTE FUNCTION append_private_model_work_result();
CREATE FUNCTION publish_private_model_work_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s model_text_steps%ROWTYPE;
BEGIN
 SELECT * INTO STRICT s FROM model_text_steps WHERE step_id=NEW.step_id;
 PERFORM check_model_text_step_current(TG_TABLE_SCHEMA,to_jsonb(s));
 IF NOT EXISTS(SELECT 1 FROM asset_upload_intents i JOIN assets a ON a.asset_id=i.asset_id
  WHERE i.intent_id=NEW.intent_id AND i.state='stored' AND i.expires_at>clock_timestamp() AND i.lease_expires_at>clock_timestamp()
   AND a.state='ready' AND a.deletion_fence=0) THEN
  RAISE EXCEPTION 'Model Result lease expired during insert' USING ERRCODE='23514'; END IF;
 UPDATE work_items SET aggregate_version=NEW.work_version
  WHERE work_item_id=NEW.work_item_id AND aggregate_version=NEW.work_version-1 AND state='draft';
 IF NOT FOUND THEN RAISE EXCEPTION 'Private Work version changed' USING ERRCODE='P0412'; END IF;
 INSERT INTO private_work_result_index(result_id,provenance,work_item_id,scope_id,owner_principal_id,owner_user_id,asset_id,work_version,revision)
  VALUES(NEW.result_id,NEW.provenance,NEW.work_item_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.asset_id,NEW.work_version,NEW.revision);
 INSERT INTO private_work_result_targets(work_item_id,scope_id,owner_principal_id,owner_user_id,result_id,asset_id,linked_at_work_version)
  VALUES(NEW.work_item_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.result_id,NEW.asset_id,NEW.work_version)
  ON CONFLICT(work_item_id) DO UPDATE SET result_id=EXCLUDED.result_id,asset_id=EXCLUDED.asset_id,linked_at_work_version=EXCLUDED.linked_at_work_version;
 RETURN NULL;
END; $$;
CREATE TRIGGER publish_private_model_work_result AFTER INSERT ON private_model_work_results
 FOR EACH ROW EXECUTE FUNCTION publish_private_model_work_result();
CREATE CONSTRAINT TRIGGER require_private_model_result_finalization AFTER INSERT ON private_model_work_results
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_private_result_finalization();
CREATE OR REPLACE FUNCTION require_finalized_private_intent_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.target_kind='work.private-result' AND NOT EXISTS(SELECT 1 FROM private_work_results WHERE intent_id=NEW.intent_id))
  OR (NEW.target_kind='work.model-result' AND NOT EXISTS(SELECT 1 FROM private_model_work_results WHERE intent_id=NEW.intent_id))
  OR NEW.target_kind NOT IN ('work.private-result','work.model-result') THEN
  RAISE EXCEPTION 'Private intent finalization requires its typed immutable Result' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
ALTER TABLE model_text_steps ADD COLUMN result_id uuid;
ALTER TABLE model_text_steps ADD CONSTRAINT model_step_result_identity FOREIGN KEY(result_id,step_id)
 REFERENCES private_model_work_results(result_id,step_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE model_text_steps ADD CONSTRAINT model_step_result_shape CHECK((state='succeeded' AND result_id IS NOT NULL) OR (state<>'succeeded' AND result_id IS NULL));
CREATE FUNCTION require_private_model_step_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM model_text_steps WHERE step_id=NEW.step_id AND state='succeeded' AND result_id=NEW.result_id) THEN
  RAISE EXCEPTION 'Model Result and Step completion commit together' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER require_private_model_step_result AFTER INSERT ON private_model_work_results
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_private_model_step_result();
-- Last receipt/index waits must not publish after authority expires. This
-- terminal check allows only this Result's sole Work CAS and Run completion.
CREATE FUNCTION check_private_model_result_commit_current(target_schema text,id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE result record; s record; g record; r record; w record; runtime record; connection record; family record; m record; approval record; export_policy record; persistence record;
BEGIN
 EXECUTE format('SELECT * FROM %I.private_model_work_results WHERE result_id=$1',target_schema) INTO result USING id;
 IF result.result_id IS NULL THEN RAISE EXCEPTION 'Actual model Result required' USING ERRCODE='23514'; END IF;
 EXECUTE format('SELECT * FROM %I.model_text_steps WHERE step_id=$1',target_schema) INTO s USING result.step_id;
 EXECUTE format('SELECT * FROM %I.execution_grants WHERE grant_id=$1',target_schema) INTO g USING (s.binding->>'grantId')::uuid;
 EXECUTE format('SELECT * FROM %I.runtime_registrations WHERE runtime_device_id=$1',target_schema) INTO runtime USING g.runtime_device_id;
 EXECUTE format('SELECT * FROM %I.agent_connections WHERE connection_id=$1',target_schema) INTO connection USING g.connection_id;
 EXECUTE format('SELECT * FROM %I.bootstrap_refresh_families WHERE family_id=$1',target_schema) INTO family USING g.family_id;
 EXECUTE format('SELECT * FROM %I.execution_runs WHERE run_id=$1',target_schema) INTO r USING s.run_id;
 EXECUTE format('SELECT * FROM %I.work_items WHERE work_item_id=$1',target_schema) INTO w USING s.work_item_id;
 EXECUTE format('SELECT * FROM %I.model_connections WHERE model_connection_id=$1',target_schema) INTO m USING g.model_connection_id;
 EXECUTE format('SELECT * FROM %I.model_export_approvals WHERE approval_id=$1',target_schema) INTO approval USING s.approval_id;
 EXECUTE format('SELECT * FROM %I.model_inference_export_policy WHERE policy_id=$1',target_schema) INTO export_policy USING approval.policy_id;
 EXECUTE format('SELECT * FROM %I.private_work_persistence_policy WHERE scope_id=$1 AND purpose=''work.private-draft''',target_schema) INTO persistence USING s.scope_id;
 IF s.state IS DISTINCT FROM 'succeeded' OR s.result_id IS DISTINCT FROM result.result_id OR s.observation IS DISTINCT FROM result.observation
  OR s.lease_expires_at<=clock_timestamp() OR (s.verified_binding->>'expiresAt')::timestamptz<=clock_timestamp()
  OR g.state IS DISTINCT FROM 'active' OR g.aggregate_version IS DISTINCT FROM (s.binding->>'grantVersion')::bigint OR g.expires_at<=clock_timestamp()
  OR runtime.state IS DISTINCT FROM 'enrolled' OR runtime.aggregate_version IS DISTINCT FROM g.runtime_version
  OR connection.state IS DISTINCT FROM 'active' OR connection.aggregate_version IS DISTINCT FROM g.connection_version OR connection.expires_at<=clock_timestamp()
  OR family.state IS DISTINCT FROM 'active' OR family.expires_at<=clock_timestamp()
  OR m.state IS DISTINCT FROM 'unverified' OR m.aggregate_version IS DISTINCT FROM g.model_version OR m.selection IS DISTINCT FROM s.binding->'selection'
  OR approval.state IS DISTINCT FROM 'active' OR approval.aggregate_version IS DISTINCT FROM (s.binding->>'approvalVersion')::bigint OR approval.expires_at<=clock_timestamp()
  OR export_policy.export_allowed IS DISTINCT FROM true OR export_policy.revision IS DISTINCT FROM approval.export_policy_revision
  OR persistence.persistence_allowed IS DISTINCT FROM true OR persistence.retained_byte_limit IS NULL OR persistence.retained_byte_limit<262144
  OR 'private-work.v'||persistence.revision::text IS DISTINCT FROM approval.persistence_policy_revision
  OR w.state IS DISTINCT FROM 'draft' OR w.aggregate_version IS DISTINCT FROM result.work_version
  OR encode(sha256(model_step_context_bytes(to_jsonb(w))),'hex') IS DISTINCT FROM s.context_sha256
  OR r.state IS DISTINCT FROM 'succeeded' OR r.current_attempt_id IS DISTINCT FROM s.attempt_id
  OR r.aggregate_version::numeric IS DISTINCT FROM s.activated_run_version::numeric+1
  OR r.task_lease_epoch IS DISTINCT FROM s.task_lease_epoch OR r.control_epoch IS DISTINCT FROM s.control_epoch THEN
  RAISE EXCEPTION 'Model Result authority expired before commit decision' USING ERRCODE='23514'; END IF;
END; $$;
CREATE OR REPLACE FUNCTION require_private_model_step_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM check_private_model_result_commit_current(TG_TABLE_SCHEMA,NEW.result_id);
 RETURN NULL;
END; $$;
