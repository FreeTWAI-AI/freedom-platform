-- Opt-in image-target AR. No camera frames, private card content or tracking
-- pixels in SQL. Images are immutable Assets under the existing write protocol.
CREATE TABLE community_ar_targets (
 target_id uuid PRIMARY KEY, community_id uuid NOT NULL, scope_id uuid NOT NULL,
 scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
 owner_principal_id uuid NOT NULL, owner_user_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('member','event','custom')), event_id uuid, scene_event_id uuid,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 60),
 aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
 content_config jsonb CHECK(content_config IS NULL OR (jsonb_typeof(content_config)='object' AND octet_length(content_config::text)<=4096)),
 asset_id uuid UNIQUE, linked_at_version bigint CHECK(linked_at_version>0),
 purpose text GENERATED ALWAYS AS ('member.ar-target'::text) STORED,
 asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','withdrawn')),
 share_token text NOT NULL UNIQUE CHECK(share_token ~ '^[A-Za-z0-9_-]{43}$'),
 parent_token text CHECK(parent_token ~ '^[A-Za-z0-9_-]{43}$'),
 target_sha256 text CHECK(target_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind IN ('member','custom') AND event_id IS NULL) OR (kind='event' AND event_id IS NOT NULL)),
 CHECK((asset_id IS NULL)=(linked_at_version IS NULL)),
 CHECK((asset_id IS NULL)=(target_sha256 IS NULL)),
 CHECK(state<>'published' OR (asset_id IS NOT NULL AND (kind IN ('event','custom') OR parent_token IS NOT NULL))),
 FOREIGN KEY(owner_user_id,community_id) REFERENCES users(user_id,community_id),
 FOREIGN KEY(event_id,community_id) REFERENCES community_events(event_id,community_id),
 FOREIGN KEY(scene_event_id,community_id) REFERENCES community_events(event_id,community_id),
 FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
 FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
 FOREIGN KEY(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,asset_state) REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
 UNIQUE(target_id,scope_id,owner_principal_id,owner_user_id)
);
CREATE INDEX ar_targets_owner ON community_ar_targets(owner_user_id,created_at DESC);
-- One public pattern identifies one destination in a community. A copied logo
-- cannot silently change which person the scanner displays.
CREATE UNIQUE INDEX ar_targets_public_pattern ON community_ar_targets(community_id,target_sha256) WHERE state='published';
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT OR UPDATE ON community_ar_targets FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();
CREATE FUNCTION preserve_ar_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AR target history is retained' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.target_id,NEW.community_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.kind,NEW.event_id,NEW.scene_event_id,NEW.share_token,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.target_id,OLD.community_id,OLD.scope_id,OLD.owner_principal_id,OLD.owner_user_id,OLD.kind,OLD.event_id,OLD.scene_event_id,OLD.share_token,OLD.created_at)
  OR (OLD.asset_id IS NOT NULL AND ROW(NEW.asset_id,NEW.linked_at_version,NEW.target_sha256,NEW.content_config) IS DISTINCT FROM ROW(OLD.asset_id,OLD.linked_at_version,OLD.target_sha256,OLD.content_config))
 THEN RAISE EXCEPTION 'AR identity and linked pattern are immutable' USING ERRCODE='23514';END IF;RETURN NEW; END $$;
CREATE TRIGGER preserve_ar_target BEFORE UPDATE OR DELETE ON community_ar_targets FOR EACH ROW EXECUTE FUNCTION preserve_ar_target();
ALTER TABLE asset_upload_intents ADD COLUMN target_ar_id uuid;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_ar_target FOREIGN KEY(target_ar_id,scope_id,owner_principal_id,target_user_id) REFERENCES community_ar_targets(target_id,scope_id,owner_principal_id,owner_user_id);
CREATE FUNCTION preserve_ar_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.target_ar_id IS DISTINCT FROM OLD.target_ar_id THEN RAISE EXCEPTION 'AR intent target is immutable' USING ERRCODE='23514';END IF;RETURN NEW; END $$;
CREATE TRIGGER preserve_ar_intent BEFORE UPDATE ON asset_upload_intents FOR EACH ROW EXECUTE FUNCTION preserve_ar_intent();
DO $$DECLARE old_shape text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='domain_media_storage_policy'::regclass AND conname='domain_media_storage_policy_purpose_check';
 ALTER TABLE domain_media_storage_policy DROP CONSTRAINT domain_media_storage_policy_purpose_check;
 EXECUTE format('ALTER TABLE domain_media_storage_policy ADD CONSTRAINT domain_media_storage_policy_purpose_check CHECK (((%s) AND purpose<>''member.ar-target'') OR purpose=''member.ar-target'')',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='assets'::regclass AND conname='assets_purpose_check';
 ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
 EXECUTE format('ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK (((%s) AND purpose<>''member.ar-target'') OR purpose=''member.ar-target'')',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='assets'::regclass AND conname='asset_scope_purpose';
 ALTER TABLE assets DROP CONSTRAINT asset_scope_purpose;
 EXECUTE format('ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose CHECK (((%s) AND purpose<>''member.ar-target'') OR (purpose=''member.ar-target'' AND scope_kind=''personal'' AND community_ref IS NULL AND tenant_ref IS NULL))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_objects'::regclass AND conname='asset_object_profile_shape';
 ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
 EXECUTE format('ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK (((%s) AND purpose<>''member.ar-target'') OR (purpose=''member.ar-target'' AND variant=''image'' AND content_type=''application/octet-stream'' AND byte_size BETWEEN 32 AND 20971520 AND transform_version=''member.ar-target.mindar-v2.v1''))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_objects'::regclass AND conname='asset_object_profile_id_shape';
 ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_id_shape;
 EXECUTE format('ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK (((%s) AND purpose<>''member.ar-target'') OR (purpose=''member.ar-target'' AND profile_id IS NOT NULL AND profile_id=purpose))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_upload_intents'::regclass AND conname='upload_profile_shape';
 ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
 EXECUTE format('ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK (((%s) AND purpose<>''member.ar-target'' AND target_ar_id IS NULL) OR (purpose=''member.ar-target'' AND target_kind=purpose AND target_ar_id IS NOT NULL AND target_comment_image_id IS NULL AND target_message_image_id IS NULL AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_submission_id IS NULL AND target_highlight_media_id IS NULL AND target_community_id IS NULL AND target_tenant_id IS NULL AND target_product_id IS NULL AND target_instance_id IS NULL AND display_name IS NULL AND source_orientation IS NULL AND source_content_type=''application/octet-stream'' AND source_byte_size BETWEEN 32 AND 20971520 AND reserved_bytes=20971520))',old_shape);
END $$;
-- Preserve the installed functions and their fixed search_path; add one closed
-- purpose to each exact admission list. Abort if a future baseline differs.
DO $$DECLARE definition text;name text; BEGIN
 FOREACH name IN ARRAY ARRAY['preserve_domain_media_floor','preserve_asset_object_write_effect'] LOOP
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname=name AND n.nspname=current_schema();
  IF strpos(definition,'''community.comment-image'',''storefront.product-photo''')=0 THEN RAISE EXCEPTION 'Unexpected asset admission baseline';END IF;
  EXECUTE replace(definition,'''community.comment-image'',''storefront.product-photo''','''community.comment-image'',''storefront.product-photo'',''member.ar-target''');
 END LOOP;
END $$;
-- No legacy AR source: legacy is OFF. An operator must explicitly approve
-- persistence revision/quota and compatible restore/reader policy to enable.
INSERT INTO domain_media_storage_policy(purpose) VALUES('member.ar-target');
