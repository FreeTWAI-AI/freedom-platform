-- Additive service-cover vertical profile. Existing migrations and all default
-- legacy writers remain unchanged; no storage mode or persistence is enabled.
CREATE TABLE domain_media_storage_policy (
 purpose text PRIMARY KEY CHECK(purpose IN ('skill.submission-image','community.event-banner','community.event-video','community.event-highlight','community.social-thumbnail','member.service-cover')),
 mode text NOT NULL DEFAULT 'legacy' CHECK(mode IN ('legacy','bridge','r2_only'))
);
INSERT INTO domain_media_storage_policy(purpose) VALUES ('skill.submission-image'),('community.event-banner'),('community.event-video'),('community.event-highlight'),('community.social-thumbnail'),('member.service-cover');
CREATE FUNCTION preserve_domain_media_floor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.purpose IS DISTINCT FROM OLD.purpose OR (OLD.mode<>'legacy' AND NEW.mode='legacy') THEN
  RAISE EXCEPTION 'Media storage floor cannot rewind' USING ERRCODE='23514';
 END IF;
 IF NEW.purpose<>'member.service-cover' AND NEW.mode<>'legacy' THEN
  RAISE EXCEPTION 'Domain media adapter is not installed' USING ERRCODE='23514';
 END IF;
 IF NEW.mode='r2_only' AND EXISTS(SELECT 1 FROM member_service_covers WHERE storage_source='legacy' OR image_bytes IS NOT NULL) THEN
  RAISE EXCEPTION 'Legacy cover sources remain' USING ERRCODE='23514';
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER preserve_domain_media_floor BEFORE UPDATE OR DELETE ON domain_media_storage_policy FOR EACH ROW EXECUTE FUNCTION preserve_domain_media_floor();
ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK(purpose IN ('member.avatar','work.private-draft','member.service-cover'));
ALTER TABLE member_services ADD CONSTRAINT member_service_owner_identity UNIQUE(service_id,owner_user_id);
ALTER TABLE member_service_covers ADD COLUMN storage_source text NOT NULL DEFAULT 'legacy' CHECK(storage_source IN ('legacy','asset'));
ALTER TABLE member_service_covers ALTER COLUMN image_bytes DROP NOT NULL;
CREATE TABLE member_service_cover_asset_targets (
 service_id uuid PRIMARY KEY REFERENCES member_services(service_id) ON DELETE CASCADE,
 scope_id uuid NOT NULL,scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
 owner_principal_id uuid NOT NULL,owner_user_id uuid NOT NULL,
 asset_id uuid,linked_at_version bigint CHECK(linked_at_version>0),
 CHECK((asset_id IS NULL)=(linked_at_version IS NULL)),
 purpose text GENERATED ALWAYS AS ('member.service-cover'::text) STORED,
 asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 FOREIGN KEY(service_id,owner_user_id) REFERENCES member_services(service_id,owner_user_id),
 FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
 FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
 FOREIGN KEY(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,asset_state) REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
 UNIQUE(service_id,scope_id,owner_principal_id,owner_user_id),UNIQUE(asset_id)
);
ALTER TABLE asset_upload_intents ADD COLUMN target_service_id uuid;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_service_cover_target FOREIGN KEY(target_service_id,scope_id,owner_principal_id,target_user_id)
 REFERENCES member_service_cover_asset_targets(service_id,scope_id,owner_principal_id,owner_user_id);
ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK(
 (purpose='member.avatar' AND target_kind='member.avatar' AND target_work_id IS NULL AND target_service_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=131072)
 OR (purpose='work.private-draft' AND target_kind='work.private-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type IN ('text/plain','text/markdown') AND source_byte_size BETWEEN 1 AND 262144 AND reserved_bytes=262144)
 OR (purpose='work.private-draft' AND target_kind='work.model-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type='text/plain' AND source_byte_size BETWEEN 1 AND 16384 AND reserved_bytes=16384)
 OR (purpose='member.service-cover' AND target_kind='member.service-cover' AND target_service_id IS NOT NULL AND target_work_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 4194304 AND reserved_bytes=524288));
CREATE OR REPLACE FUNCTION preserve_upload_typed_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.target_kind,NEW.target_work_id,NEW.target_service_id) IS DISTINCT FROM ROW(OLD.target_kind,OLD.target_work_id,OLD.target_service_id) THEN
  RAISE EXCEPTION 'Upload typed target is immutable' USING ERRCODE='23514';
 END IF;RETURN NEW;END $$;
ALTER TABLE asset_objects ADD COLUMN profile_id text;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK ((purpose='member.service-cover' AND profile_id IS NOT NULL AND profile_id='member.service-cover') OR (purpose<>'member.service-cover' AND profile_id IS NULL));
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK(
 (purpose='member.avatar' AND variant='avatar' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 131072 AND transform_version='avatar.webp.v1')
 OR (purpose='work.private-draft' AND variant='draft' AND content_type IN ('text/plain','text/markdown') AND byte_size BETWEEN 1 AND 262144 AND transform_version='private-text.utf8.v1')
 OR (purpose='member.service-cover' AND variant='cover' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='member.service-cover.legacy-bytes.v1'));
ALTER TABLE asset_backup_pins DROP CONSTRAINT asset_backup_pins_byte_size_check;
ALTER TABLE asset_backup_pins ADD CONSTRAINT asset_backup_pins_byte_size_check CHECK(byte_size BETWEEN 1 AND 20971520);
CREATE FUNCTION fence_service_cover_writer() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE mode_value text;BEGIN
 SELECT mode INTO STRICT mode_value FROM domain_media_storage_policy WHERE purpose='member.service-cover' FOR SHARE;
 IF NEW.storage_source='asset' AND mode_value='legacy' THEN RAISE EXCEPTION 'Asset covers are not enabled' USING ERRCODE='23514';END IF;
 IF NEW.image_bytes IS NOT NULL AND (mode_value='r2_only' OR TG_OP='UPDATE' AND OLD.storage_source='asset' AND NEW.image_bytes IS DISTINCT FROM OLD.image_bytes) THEN
  RAISE EXCEPTION 'Legacy cover writer is fenced' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND OLD.storage_source='asset' AND NEW.storage_source<>'asset' THEN RAISE EXCEPTION 'Asset covers cannot fall back' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER fence_service_cover_writer BEFORE INSERT OR UPDATE ON member_service_covers FOR EACH ROW EXECUTE FUNCTION fence_service_cover_writer();
CREATE FUNCTION require_service_cover_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM member_service_covers c WHERE c.service_id=COALESCE(NEW.service_id,OLD.service_id) AND c.storage_source='asset' AND NOT EXISTS(
  SELECT 1 FROM member_service_cover_asset_targets t JOIN member_services s USING(service_id) WHERE t.service_id=c.service_id AND t.asset_id IS NOT NULL AND t.linked_at_version<=s.aggregate_version)) THEN
  RAISE EXCEPTION 'Asset cover requires its typed current pointer' USING ERRCODE='23514';END IF;RETURN COALESCE(NEW,OLD);END $$;
CREATE CONSTRAINT TRIGGER require_service_cover_pointer AFTER INSERT OR UPDATE ON member_service_covers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_service_cover_pointer();
CREATE FUNCTION retire_deleted_service_cover() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.asset_id IS NOT NULL THEN UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=OLD.asset_id AND state='ready';END IF;RETURN OLD;END $$;
CREATE TRIGGER retire_deleted_service_cover AFTER DELETE ON member_service_cover_asset_targets FOR EACH ROW EXECUTE FUNCTION retire_deleted_service_cover();

CREATE CONSTRAINT TRIGGER require_service_cover_target AFTER INSERT OR UPDATE OR DELETE ON member_service_cover_asset_targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_service_cover_pointer();
-- Clear the pointer first (the ready-asset FK is restrictive), then retire its old asset.
CREATE OR REPLACE FUNCTION clear_deleted_service_cover_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE old_asset uuid;BEGIN
 SELECT asset_id INTO old_asset FROM member_service_cover_asset_targets WHERE service_id=OLD.service_id FOR UPDATE;
 UPDATE member_service_cover_asset_targets SET asset_id=NULL,linked_at_version=NULL WHERE service_id=OLD.service_id;
 IF old_asset IS NOT NULL THEN UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=old_asset AND state='ready';END IF;
 RETURN OLD;END $$;
CREATE TRIGGER clear_deleted_service_cover_pointer AFTER DELETE ON member_service_covers FOR EACH ROW EXECUTE FUNCTION clear_deleted_service_cover_pointer();

ALTER TABLE member_service_covers ADD CONSTRAINT service_cover_source_shape CHECK(storage_source<>'legacy' OR image_bytes IS NOT NULL);
