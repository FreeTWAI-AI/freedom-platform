-- Social manual-thumbnail vertical. Automatic link previews remain legacy;
-- R2-only activation is deliberately refused until that writer is migrated.
ALTER TABLE community_social_posts ADD COLUMN media_version bigint NOT NULL DEFAULT 1 CHECK(media_version>0);
ALTER TABLE community_social_posts ADD CONSTRAINT social_media_domain_identity UNIQUE(post_id,community_id,author_user_id);
ALTER TABLE community_social_post_thumbnails ADD COLUMN storage_source text NOT NULL DEFAULT 'legacy' CHECK(storage_source IN ('legacy','asset'));
ALTER TABLE community_social_post_thumbnails ALTER COLUMN image_bytes DROP NOT NULL;
ALTER TABLE community_social_post_thumbnails ADD CONSTRAINT social_source_shape CHECK(storage_source='asset' OR image_bytes IS NOT NULL);
ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK(purpose IN ('member.avatar','work.private-draft','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail'));
ALTER TABLE assets DROP CONSTRAINT asset_scope_purpose;
ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose CHECK((scope_kind='personal' AND community_ref IS NULL AND purpose IN ('member.avatar','work.private-draft','member.service-cover')) OR (scope_kind='community' AND community_ref IS NOT NULL AND purpose IN ('community.event-banner','community.event-video','community.social-thumbnail')));
CREATE TABLE community_social_thumbnail_asset_targets (
 post_id uuid PRIMARY KEY REFERENCES community_social_posts(post_id) ON DELETE CASCADE,
 community_id uuid NOT NULL,scope_id uuid NOT NULL,scope_kind text GENERATED ALWAYS AS ('community'::text) STORED,
 owner_principal_id uuid NOT NULL,owner_user_id uuid NOT NULL,
 asset_id uuid,linked_at_version bigint CHECK(linked_at_version>0),CHECK((asset_id IS NULL)=(linked_at_version IS NULL)),
 purpose text GENERATED ALWAYS AS ('community.social-thumbnail'::text) STORED,asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 FOREIGN KEY(post_id,community_id,owner_user_id) REFERENCES community_social_posts(post_id,community_id,author_user_id),
 FOREIGN KEY(scope_id,scope_kind,community_id) REFERENCES resource_scopes(scope_id,kind,community_ref),
 FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
 FOREIGN KEY(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,asset_state) REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
 UNIQUE(post_id,scope_id,owner_principal_id,owner_user_id,community_id),UNIQUE(asset_id)
);
ALTER TABLE asset_upload_intents ADD COLUMN target_post_id uuid;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_social_target FOREIGN KEY(target_post_id,scope_id,owner_principal_id,target_user_id,target_community_id) REFERENCES community_social_thumbnail_asset_targets(post_id,scope_id,owner_principal_id,owner_user_id,community_id);
ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK((target_post_id IS NULL AND (

 (target_video_event_id IS NULL AND (

 (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='member.avatar' AND target_kind='member.avatar' AND target_work_id IS NULL AND target_service_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=131072)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='work.private-draft' AND target_kind='work.private-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type IN ('text/plain','text/markdown') AND source_byte_size BETWEEN 1 AND 262144 AND reserved_bytes=262144)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='work.private-draft' AND target_kind='work.model-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type='text/plain' AND source_byte_size BETWEEN 1 AND 16384 AND reserved_bytes=16384)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='member.service-cover' AND target_kind='member.service-cover' AND target_service_id IS NOT NULL AND target_work_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 4194304 AND reserved_bytes=524288)
 OR (purpose='community.event-banner' AND target_kind='community.event-banner' AND target_event_id IS NOT NULL AND target_community_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NOT NULL AND source_orientation IN ('landscape','portrait') AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 524288 AND reserved_bytes=524288))) OR (purpose='community.event-video' AND target_kind='community.event-video' AND target_video_event_id IS NOT NULL AND target_event_id IS NULL AND target_community_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NULL AND source_content_type IN ('video/mp4','video/webm') AND source_byte_size BETWEEN 1 AND 20971520 AND reserved_bytes=20971520))) OR (purpose='community.social-thumbnail' AND target_kind='community.social-thumbnail' AND target_post_id IS NOT NULL AND target_community_id IS NOT NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 524288 AND reserved_bytes=524288));
CREATE OR REPLACE FUNCTION preserve_upload_typed_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.target_kind,NEW.target_work_id,NEW.target_service_id,NEW.target_event_id,NEW.target_video_event_id,NEW.target_post_id,NEW.target_community_id,NEW.source_orientation) IS DISTINCT FROM ROW(OLD.target_kind,OLD.target_work_id,OLD.target_service_id,OLD.target_event_id,OLD.target_video_event_id,OLD.target_post_id,OLD.target_community_id,OLD.source_orientation) THEN RAISE EXCEPTION 'Upload typed target is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_id_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK((purpose IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail') AND profile_id IS NOT NULL AND profile_id=purpose) OR (purpose NOT IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail') AND profile_id IS NULL));
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK(


 (purpose='member.avatar' AND variant='avatar' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 131072 AND transform_version='avatar.webp.v1')
 OR (purpose='work.private-draft' AND variant='draft' AND content_type IN ('text/plain','text/markdown') AND byte_size BETWEEN 1 AND 262144 AND transform_version='private-text.utf8.v1')
 OR (purpose='member.service-cover' AND variant='cover' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='member.service-cover.legacy-bytes.v1')
 OR (purpose='community.event-banner' AND variant='banner' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='community.event-banner.legacy-bytes.v1') OR (purpose='community.event-video' AND variant='video' AND content_type IN ('video/mp4','video/webm') AND byte_size BETWEEN 1 AND 20971520 AND transform_version='community.event-video.legacy-bytes.v1') OR (purpose='community.social-thumbnail' AND variant='thumbnail' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='community.social-thumbnail.legacy-bytes.v1'));
CREATE OR REPLACE FUNCTION preserve_domain_media_floor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.purpose IS DISTINCT FROM OLD.purpose OR (OLD.mode<>'legacy' AND NEW.mode='legacy') THEN RAISE EXCEPTION 'Media storage floor cannot rewind' USING ERRCODE='23514';END IF;
 IF NEW.purpose NOT IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail') AND NEW.mode<>'legacy' THEN RAISE EXCEPTION 'Domain media adapter is not installed' USING ERRCODE='23514';END IF;
 IF NEW.purpose='community.social-thumbnail' AND NEW.mode='r2_only' THEN RAISE EXCEPTION 'Automatic social preview writer remains legacy' USING ERRCODE='23514';END IF;
 IF NEW.mode='r2_only' AND ((NEW.purpose='community.event-banner' AND EXISTS(SELECT 1 FROM community_event_banners WHERE storage_source='legacy' OR image_bytes IS NOT NULL)) OR (NEW.purpose='member.service-cover' AND EXISTS(SELECT 1 FROM member_service_covers WHERE storage_source='legacy' OR image_bytes IS NOT NULL)) OR (NEW.purpose='community.event-video' AND EXISTS(SELECT 1 FROM community_event_videos WHERE storage_source='legacy' OR media_bytes IS NOT NULL))) THEN RAISE EXCEPTION 'Legacy media sources remain' USING ERRCODE='23514';END IF;RETURN NEW;END $$;

CREATE FUNCTION fence_social_thumbnail_writer() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE mode_value text;BEGIN
 SELECT mode INTO STRICT mode_value FROM domain_media_storage_policy WHERE purpose='community.social-thumbnail' FOR SHARE;
 IF NEW.storage_source='asset' AND mode_value='legacy' THEN RAISE EXCEPTION 'Asset thumbnails are not enabled' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND OLD.storage_source='asset' AND (NEW.storage_source<>'asset' OR NEW.image_bytes IS DISTINCT FROM OLD.image_bytes) THEN RAISE EXCEPTION 'Legacy thumbnail writer is fenced' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER fence_social_thumbnail_writer BEFORE INSERT OR UPDATE ON community_social_post_thumbnails FOR EACH ROW EXECUTE FUNCTION fence_social_thumbnail_writer();
CREATE FUNCTION require_social_thumbnail_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM community_social_post_thumbnails b WHERE b.post_id=COALESCE(NEW.post_id,OLD.post_id) AND b.storage_source='asset' AND EXISTS(SELECT 1 FROM community_social_posts p WHERE p.post_id=b.post_id AND p.state='active') AND NOT EXISTS(SELECT 1 FROM community_social_thumbnail_asset_targets t JOIN community_social_posts p USING(post_id) WHERE t.post_id=b.post_id AND t.asset_id IS NOT NULL AND t.linked_at_version<=p.media_version)) THEN RAISE EXCEPTION 'Asset thumbnail requires its typed current pointer' USING ERRCODE='23514';END IF;RETURN COALESCE(NEW,OLD);END $$;
CREATE CONSTRAINT TRIGGER require_social_thumbnail_pointer AFTER INSERT OR UPDATE ON community_social_post_thumbnails DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_social_thumbnail_pointer();
CREATE CONSTRAINT TRIGGER require_social_thumbnail_target AFTER INSERT OR UPDATE OR DELETE ON community_social_thumbnail_asset_targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_social_thumbnail_pointer();
CREATE FUNCTION social_legacy_media_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.storage_source='legacy' THEN UPDATE community_social_posts SET media_version=media_version+1 WHERE post_id=COALESCE(NEW.post_id,OLD.post_id);END IF;RETURN COALESCE(NEW,OLD);END $$;
CREATE TRIGGER social_legacy_media_clock AFTER INSERT OR UPDATE OR DELETE ON community_social_post_thumbnails FOR EACH ROW EXECUTE FUNCTION social_legacy_media_clock();
CREATE FUNCTION social_visibility_media_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.state,NEW.community_id,NEW.author_user_id) IS DISTINCT FROM ROW(OLD.state,OLD.community_id,OLD.author_user_id) THEN NEW.media_version=OLD.media_version+1;ELSIF NEW.media_version NOT IN (OLD.media_version,OLD.media_version+1) THEN RAISE EXCEPTION 'Social media version cannot rewind or jump' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER social_visibility_media_clock BEFORE UPDATE ON community_social_posts FOR EACH ROW EXECUTE FUNCTION social_visibility_media_clock();
CREATE FUNCTION retire_hidden_social_thumbnail() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE old_asset uuid;BEGIN
 IF TG_TABLE_NAME='community_social_posts' THEN IF NEW.state='active' THEN RETURN NEW;END IF;END IF;
 SELECT asset_id INTO old_asset FROM community_social_thumbnail_asset_targets WHERE post_id=COALESCE(NEW.post_id,OLD.post_id) FOR UPDATE;
 UPDATE community_social_thumbnail_asset_targets SET asset_id=NULL,linked_at_version=NULL WHERE post_id=COALESCE(NEW.post_id,OLD.post_id);
 IF old_asset IS NOT NULL THEN UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=old_asset AND state='ready';END IF;
 -- Hidden/deleted rows keep historical bytes; the immutable asset is retired.
 RETURN COALESCE(NEW,OLD);END $$;
CREATE TRIGGER retire_hidden_social_thumbnail AFTER UPDATE OF state ON community_social_posts FOR EACH ROW EXECUTE FUNCTION retire_hidden_social_thumbnail();
CREATE TRIGGER retire_deleted_social_thumbnail AFTER DELETE ON community_social_post_thumbnails FOR EACH ROW EXECUTE FUNCTION retire_hidden_social_thumbnail();

CREATE CONSTRAINT TRIGGER require_active_social_thumbnail_pointer AFTER UPDATE OF state ON community_social_posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_social_thumbnail_pointer();
