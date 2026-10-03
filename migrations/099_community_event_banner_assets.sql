-- Finite community-owned event-banner branch. Existing private/avatar/cover
-- ownership FKs remain binding; no policy or storage mode is enabled.
ALTER TABLE users ADD CONSTRAINT banner_user_community_identity UNIQUE(user_id,community_id);
ALTER TABLE assets DROP CONSTRAINT assets_scope_id_scope_kind_owner_principal_id_fkey;
ALTER TABLE assets ALTER COLUMN scope_kind DROP EXPRESSION;
ALTER TABLE assets ALTER COLUMN scope_kind SET DEFAULT 'personal';
ALTER TABLE assets ALTER COLUMN scope_kind SET NOT NULL;
ALTER TABLE assets ADD COLUMN community_ref uuid;
ALTER TABLE assets ADD COLUMN personal_owner_principal_id uuid GENERATED ALWAYS AS (CASE WHEN scope_kind='personal' THEN owner_principal_id END) STORED;
ALTER TABLE assets ADD CONSTRAINT asset_scope_kind FOREIGN KEY(scope_id,scope_kind) REFERENCES resource_scopes(scope_id,kind);
ALTER TABLE assets ADD CONSTRAINT asset_personal_scope_owner FOREIGN KEY(scope_id,scope_kind,personal_owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id);
ALTER TABLE assets ADD CONSTRAINT asset_community_scope_owner FOREIGN KEY(scope_id,scope_kind,community_ref) REFERENCES resource_scopes(scope_id,kind,community_ref);
ALTER TABLE assets ADD CONSTRAINT asset_creator_community FOREIGN KEY(owner_user_id,community_ref) REFERENCES users(user_id,community_id);
ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose CHECK((scope_kind='personal' AND community_ref IS NULL AND purpose IN ('member.avatar','work.private-draft','member.service-cover')) OR (scope_kind='community' AND community_ref IS NOT NULL AND purpose='community.event-banner'));
ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK(purpose IN ('member.avatar','work.private-draft','member.service-cover','community.event-banner'));
CREATE FUNCTION preserve_asset_scope_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.scope_kind,NEW.community_ref) IS DISTINCT FROM ROW(OLD.scope_kind,OLD.community_ref) THEN RAISE EXCEPTION 'Asset scope identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER preserve_asset_scope_identity BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION preserve_asset_scope_identity();
ALTER TABLE community_events ADD CONSTRAINT event_banner_domain_identity UNIQUE(event_id,community_id,organizer_ref);
ALTER TABLE community_event_banners ADD COLUMN storage_source text NOT NULL DEFAULT 'legacy' CHECK(storage_source IN ('legacy','asset'));
ALTER TABLE community_event_banners ALTER COLUMN image_bytes DROP NOT NULL;
ALTER TABLE community_event_banners ADD CONSTRAINT banner_source_shape CHECK(storage_source='asset' OR image_bytes IS NOT NULL);
CREATE TABLE community_event_banner_asset_targets (
 event_id uuid PRIMARY KEY REFERENCES community_events(event_id) ON DELETE CASCADE,
 community_id uuid NOT NULL,scope_id uuid NOT NULL,scope_kind text GENERATED ALWAYS AS ('community'::text) STORED,
 owner_principal_id uuid NOT NULL,owner_user_id uuid NOT NULL,
 asset_id uuid,linked_at_version bigint CHECK(linked_at_version>0),
 CHECK((asset_id IS NULL)=(linked_at_version IS NULL)),
 purpose text GENERATED ALWAYS AS ('community.event-banner'::text) STORED,asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 FOREIGN KEY(event_id,community_id,owner_user_id) REFERENCES community_events(event_id,community_id,organizer_ref),
 FOREIGN KEY(scope_id,scope_kind,community_id) REFERENCES resource_scopes(scope_id,kind,community_ref),
 FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
 FOREIGN KEY(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,asset_state) REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
 UNIQUE(event_id,scope_id,owner_principal_id,owner_user_id,community_id),UNIQUE(asset_id)
);
ALTER TABLE asset_upload_intents ADD COLUMN target_event_id uuid;
ALTER TABLE asset_upload_intents ADD COLUMN target_community_id uuid;
ALTER TABLE asset_upload_intents ADD COLUMN source_orientation text;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_banner_target FOREIGN KEY(target_event_id,scope_id,owner_principal_id,target_user_id,target_community_id) REFERENCES community_event_banner_asset_targets(event_id,scope_id,owner_principal_id,owner_user_id,community_id);
ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK(

 (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='member.avatar' AND target_kind='member.avatar' AND target_work_id IS NULL AND target_service_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=131072)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='work.private-draft' AND target_kind='work.private-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type IN ('text/plain','text/markdown') AND source_byte_size BETWEEN 1 AND 262144 AND reserved_bytes=262144)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='work.private-draft' AND target_kind='work.model-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type='text/plain' AND source_byte_size BETWEEN 1 AND 16384 AND reserved_bytes=16384)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='member.service-cover' AND target_kind='member.service-cover' AND target_service_id IS NOT NULL AND target_work_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 4194304 AND reserved_bytes=524288)
 OR (purpose='community.event-banner' AND target_kind='community.event-banner' AND target_event_id IS NOT NULL AND target_community_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NOT NULL AND source_orientation IN ('landscape','portrait') AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 524288 AND reserved_bytes=524288));
CREATE OR REPLACE FUNCTION preserve_upload_typed_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.target_kind,NEW.target_work_id,NEW.target_service_id,NEW.target_event_id,NEW.target_community_id,NEW.source_orientation) IS DISTINCT FROM ROW(OLD.target_kind,OLD.target_work_id,OLD.target_service_id,OLD.target_event_id,OLD.target_community_id,OLD.source_orientation) THEN RAISE EXCEPTION 'Upload typed target is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_id_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK((purpose IN ('member.service-cover','community.event-banner') AND profile_id IS NOT NULL AND profile_id=purpose) OR (purpose NOT IN ('member.service-cover','community.event-banner') AND profile_id IS NULL));
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK(

 (purpose='member.avatar' AND variant='avatar' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 131072 AND transform_version='avatar.webp.v1')
 OR (purpose='work.private-draft' AND variant='draft' AND content_type IN ('text/plain','text/markdown') AND byte_size BETWEEN 1 AND 262144 AND transform_version='private-text.utf8.v1')
 OR (purpose='member.service-cover' AND variant='cover' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='member.service-cover.legacy-bytes.v1')
 OR (purpose='community.event-banner' AND variant='banner' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='community.event-banner.legacy-bytes.v1'));
CREATE OR REPLACE FUNCTION preserve_domain_media_floor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.purpose IS DISTINCT FROM OLD.purpose OR (OLD.mode<>'legacy' AND NEW.mode='legacy') THEN RAISE EXCEPTION 'Media storage floor cannot rewind' USING ERRCODE='23514';END IF;
 IF NEW.purpose NOT IN ('member.service-cover','community.event-banner') AND NEW.mode<>'legacy' THEN RAISE EXCEPTION 'Domain media adapter is not installed' USING ERRCODE='23514';END IF;
 IF NEW.mode='r2_only' AND ((NEW.purpose='member.service-cover' AND EXISTS(SELECT 1 FROM member_service_covers WHERE storage_source='legacy' OR image_bytes IS NOT NULL)) OR (NEW.purpose='community.event-banner' AND EXISTS(SELECT 1 FROM community_event_banners WHERE storage_source='legacy' OR image_bytes IS NOT NULL))) THEN RAISE EXCEPTION 'Legacy media sources remain' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE FUNCTION fence_event_banner_writer() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE mode_value text;BEGIN
 SELECT mode INTO STRICT mode_value FROM domain_media_storage_policy WHERE purpose='community.event-banner' FOR SHARE;
 IF NEW.storage_source='asset' AND mode_value='legacy' THEN RAISE EXCEPTION 'Asset banners are not enabled' USING ERRCODE='23514';END IF;
 IF NEW.image_bytes IS NOT NULL AND (mode_value='r2_only' OR TG_OP='UPDATE' AND OLD.storage_source='asset' AND NEW.image_bytes IS DISTINCT FROM OLD.image_bytes) THEN RAISE EXCEPTION 'Legacy banner writer is fenced' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND OLD.storage_source='asset' AND NEW.storage_source<>'asset' THEN RAISE EXCEPTION 'Asset banners cannot fall back' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER fence_event_banner_writer BEFORE INSERT OR UPDATE ON community_event_banners FOR EACH ROW EXECUTE FUNCTION fence_event_banner_writer();
CREATE FUNCTION require_event_banner_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM community_event_banners b WHERE b.event_id=COALESCE(NEW.event_id,OLD.event_id) AND b.storage_source='asset' AND NOT EXISTS(SELECT 1 FROM community_event_banner_asset_targets t JOIN community_events e USING(event_id) WHERE t.event_id=b.event_id AND t.asset_id IS NOT NULL AND t.linked_at_version<=e.aggregate_version)) THEN RAISE EXCEPTION 'Asset banner requires its typed current pointer' USING ERRCODE='23514';END IF;RETURN COALESCE(NEW,OLD);END $$;
CREATE CONSTRAINT TRIGGER require_event_banner_pointer AFTER INSERT OR UPDATE ON community_event_banners DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_event_banner_pointer();
CREATE CONSTRAINT TRIGGER require_event_banner_target AFTER INSERT OR UPDATE OR DELETE ON community_event_banner_asset_targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_event_banner_pointer();
CREATE FUNCTION retire_deleted_event_banner_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.asset_id IS NOT NULL THEN UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=OLD.asset_id AND state='ready';END IF;RETURN OLD;END $$;
CREATE TRIGGER retire_deleted_event_banner_target AFTER DELETE ON community_event_banner_asset_targets FOR EACH ROW EXECUTE FUNCTION retire_deleted_event_banner_target();
CREATE FUNCTION clear_deleted_event_banner_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE old_asset uuid;BEGIN
 SELECT asset_id INTO old_asset FROM community_event_banner_asset_targets WHERE event_id=OLD.event_id FOR UPDATE;
 UPDATE community_event_banner_asset_targets SET asset_id=NULL,linked_at_version=NULL WHERE event_id=OLD.event_id;
 IF old_asset IS NOT NULL THEN UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=old_asset AND state='ready';END IF;RETURN OLD;END $$;
CREATE TRIGGER clear_deleted_event_banner_pointer AFTER DELETE ON community_event_banners FOR EACH ROW EXECUTE FUNCTION clear_deleted_event_banner_pointer();
