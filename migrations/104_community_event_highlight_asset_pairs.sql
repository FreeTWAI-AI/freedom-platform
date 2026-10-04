-- Closed atomic event-highlight pair. No storage policy activation/backfill.
ALTER TABLE community_event_highlights ADD COLUMN storage_source text NOT NULL DEFAULT 'legacy' CHECK(storage_source IN ('legacy','asset'));
ALTER TABLE community_event_highlights ADD CONSTRAINT highlight_pair_domain_identity UNIQUE(media_id,event_id,community_id,uploader_user_id);
ALTER TABLE community_event_highlights ADD CONSTRAINT highlight_link_source CHECK(kind<>'link' OR storage_source='legacy');
ALTER TABLE community_event_highlight_images ALTER COLUMN bytes DROP NOT NULL;
ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK(purpose IN ('member.avatar','work.private-draft','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight'));
ALTER TABLE assets DROP CONSTRAINT asset_scope_purpose;
ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose CHECK((scope_kind='personal' AND community_ref IS NULL AND purpose IN ('member.avatar','work.private-draft','member.service-cover','skill.submission-image')) OR (scope_kind='community' AND community_ref IS NOT NULL AND purpose IN ('community.event-banner','community.event-video','community.social-thumbnail','community.event-highlight')));
ALTER TABLE community_events ADD CONSTRAINT highlight_pair_event_identity UNIQUE(event_id,community_id);
ALTER TABLE asset_objects ADD CONSTRAINT highlight_object_variant_identity UNIQUE(asset_id,scope_id,purpose,variant,profile_id);
CREATE TABLE community_event_highlight_asset_targets (
 media_id uuid PRIMARY KEY,event_id uuid NOT NULL,community_id uuid NOT NULL,
 scope_id uuid NOT NULL,scope_kind text GENERATED ALWAYS AS ('community'::text) STORED,
 owner_principal_id uuid NOT NULL,owner_user_id uuid NOT NULL,
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 image_asset_id uuid UNIQUE,thumb_asset_id uuid UNIQUE,published_at timestamptz,
 published_media_id uuid GENERATED ALWAYS AS (CASE WHEN image_asset_id IS NOT NULL THEN media_id END) STORED,
 purpose text GENERATED ALWAYS AS ('community.event-highlight'::text) STORED,asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 image_variant text GENERATED ALWAYS AS ('image'::text) STORED,thumb_variant text GENERATED ALWAYS AS ('thumb'::text) STORED,
 image_profile text GENERATED ALWAYS AS ('community.event-highlight'::text) STORED,thumb_profile text GENERATED ALWAYS AS ('community.event-highlight.thumbnail'::text) STORED,
 CHECK((image_asset_id IS NULL)=(thumb_asset_id IS NULL)),CHECK((image_asset_id IS NULL)=(published_at IS NULL)),CHECK(image_asset_id IS NULL OR image_asset_id<>thumb_asset_id),
 FOREIGN KEY(event_id,community_id) REFERENCES community_events(event_id,community_id),
 FOREIGN KEY(published_media_id,event_id,community_id,owner_user_id) REFERENCES community_event_highlights(media_id,event_id,community_id,uploader_user_id),
 FOREIGN KEY(scope_id,scope_kind,community_id) REFERENCES resource_scopes(scope_id,kind,community_ref),
 FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
 FOREIGN KEY(image_asset_id,scope_id,owner_principal_id,owner_user_id,purpose,asset_state) REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
 FOREIGN KEY(thumb_asset_id,scope_id,owner_principal_id,owner_user_id,purpose,asset_state) REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
 FOREIGN KEY(image_asset_id,scope_id,purpose,image_variant,image_profile) REFERENCES asset_objects(asset_id,scope_id,purpose,variant,profile_id),
 FOREIGN KEY(thumb_asset_id,scope_id,purpose,thumb_variant,thumb_profile) REFERENCES asset_objects(asset_id,scope_id,purpose,variant,profile_id),
 UNIQUE(media_id,scope_id,owner_principal_id,owner_user_id,community_id)
);
CREATE FUNCTION preserve_highlight_pair_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.media_id,NEW.event_id,NEW.community_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.source_digest) IS DISTINCT FROM ROW(OLD.media_id,OLD.event_id,OLD.community_id,OLD.scope_id,OLD.owner_principal_id,OLD.owner_user_id,OLD.source_digest) THEN RAISE EXCEPTION 'Highlight pair source cannot be rebound' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER preserve_highlight_pair_source BEFORE UPDATE ON community_event_highlight_asset_targets FOR EACH ROW EXECUTE FUNCTION preserve_highlight_pair_source();
ALTER TABLE asset_upload_intents ADD COLUMN target_highlight_media_id uuid;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_highlight_pair_target FOREIGN KEY(target_highlight_media_id,scope_id,owner_principal_id,target_user_id,target_community_id) REFERENCES community_event_highlight_asset_targets(media_id,scope_id,owner_principal_id,owner_user_id,community_id);
ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK((target_highlight_media_id IS NULL AND (
(target_submission_id IS NULL AND ((target_post_id IS NULL AND (

 (target_video_event_id IS NULL AND (

 (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='member.avatar' AND target_kind='member.avatar' AND target_work_id IS NULL AND target_service_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=131072)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='work.private-draft' AND target_kind='work.private-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type IN ('text/plain','text/markdown') AND source_byte_size BETWEEN 1 AND 262144 AND reserved_bytes=262144)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='work.private-draft' AND target_kind='work.model-result' AND target_work_id IS NOT NULL AND target_service_id IS NULL AND source_content_type='text/plain' AND source_byte_size BETWEEN 1 AND 16384 AND reserved_bytes=16384)
 OR (target_event_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND purpose='member.service-cover' AND target_kind='member.service-cover' AND target_service_id IS NOT NULL AND target_work_id IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 4194304 AND reserved_bytes=524288)
 OR (purpose='community.event-banner' AND target_kind='community.event-banner' AND target_event_id IS NOT NULL AND target_community_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NOT NULL AND source_orientation IN ('landscape','portrait') AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 524288 AND reserved_bytes=524288))) OR (purpose='community.event-video' AND target_kind='community.event-video' AND target_video_event_id IS NOT NULL AND target_event_id IS NULL AND target_community_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NULL AND source_content_type IN ('video/mp4','video/webm') AND source_byte_size BETWEEN 1 AND 20971520 AND reserved_bytes=20971520))) OR (purpose='community.social-thumbnail' AND target_kind='community.social-thumbnail' AND target_post_id IS NOT NULL AND target_community_id IS NOT NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_work_id IS NULL AND target_service_id IS NULL AND source_orientation IS NULL AND source_content_type IN ('image/png','image/jpeg','image/webp') AND source_byte_size BETWEEN 1 AND 524288 AND reserved_bytes=524288))) OR (purpose='skill.submission-image' AND target_kind='skill.submission-image' AND target_submission_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_community_id IS NULL AND source_orientation IS NULL AND source_content_type='image/webp' AND source_byte_size BETWEEN 1 AND 524288 AND reserved_bytes=524288))) OR (purpose='community.event-highlight' AND target_highlight_media_id IS NOT NULL AND target_community_id IS NOT NULL AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_submission_id IS NULL AND source_orientation IS NULL AND source_content_type='image/webp' AND ((target_kind='community.event-highlight.image' AND source_byte_size BETWEEN 1 AND 1048576 AND reserved_bytes=1048576) OR (target_kind='community.event-highlight.thumb' AND source_byte_size BETWEEN 1 AND 204800 AND reserved_bytes=204800))));
CREATE OR REPLACE FUNCTION preserve_upload_typed_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.target_kind,NEW.target_work_id,NEW.target_service_id,NEW.target_event_id,NEW.target_video_event_id,NEW.target_submission_id,NEW.target_post_id,NEW.target_highlight_media_id,NEW.target_community_id,NEW.source_orientation) IS DISTINCT FROM ROW(OLD.target_kind,OLD.target_work_id,OLD.target_service_id,OLD.target_event_id,OLD.target_video_event_id,OLD.target_submission_id,OLD.target_post_id,OLD.target_highlight_media_id,OLD.target_community_id,OLD.source_orientation) THEN RAISE EXCEPTION 'Upload typed target is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_id_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK((purpose='community.event-highlight' AND profile_id IS NOT NULL AND ((variant='image' AND profile_id='community.event-highlight') OR (variant='thumb' AND profile_id='community.event-highlight.thumbnail'))) OR (purpose IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image') AND profile_id IS NOT NULL AND profile_id=purpose) OR (purpose NOT IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight') AND profile_id IS NULL));
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK(
(


 (purpose='member.avatar' AND variant='avatar' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 131072 AND transform_version='avatar.webp.v1')
 OR (purpose='work.private-draft' AND variant='draft' AND content_type IN ('text/plain','text/markdown') AND byte_size BETWEEN 1 AND 262144 AND transform_version='private-text.utf8.v1')
 OR (purpose='member.service-cover' AND variant='cover' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='member.service-cover.legacy-bytes.v1')
 OR (purpose='community.event-banner' AND variant='banner' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='community.event-banner.legacy-bytes.v1') OR (purpose='community.event-video' AND variant='video' AND content_type IN ('video/mp4','video/webm') AND byte_size BETWEEN 1 AND 20971520 AND transform_version='community.event-video.legacy-bytes.v1') OR (purpose='community.social-thumbnail' AND variant='thumbnail' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='community.social-thumbnail.legacy-bytes.v1')) OR (purpose='skill.submission-image' AND variant='illustration' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='skill.submission-image.legacy-bytes.v1') OR (purpose='community.event-highlight' AND content_type='image/webp' AND ((variant='image' AND byte_size BETWEEN 1 AND 1048576 AND transform_version='community.event-highlight.legacy-bytes.v1') OR (variant='thumb' AND byte_size BETWEEN 1 AND 204800 AND transform_version='community.event-highlight.thumbnail.legacy-bytes.v1'))));
CREATE OR REPLACE FUNCTION preserve_domain_media_floor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.purpose IS DISTINCT FROM OLD.purpose OR (OLD.mode<>'legacy' AND NEW.mode='legacy') THEN RAISE EXCEPTION 'Media storage floor cannot rewind' USING ERRCODE='23514';END IF;
 IF NEW.purpose NOT IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight') AND NEW.mode<>'legacy' THEN RAISE EXCEPTION 'Domain media adapter is not installed' USING ERRCODE='23514';END IF;
 IF NEW.purpose='community.social-thumbnail' AND NEW.mode='r2_only' THEN RAISE EXCEPTION 'Automatic social preview writer remains legacy' USING ERRCODE='23514';END IF;
 IF NEW.mode='r2_only' AND ((NEW.purpose='community.event-highlight' AND EXISTS(SELECT 1 FROM community_event_highlights h JOIN community_event_highlight_images i USING(media_id) WHERE h.storage_source='legacy' OR i.bytes IS NOT NULL)) OR (NEW.purpose='skill.submission-image' AND EXISTS(SELECT 1 FROM skill_submissions WHERE image_bytes IS NOT NULL)) OR (NEW.purpose='community.event-banner' AND EXISTS(SELECT 1 FROM community_event_banners WHERE storage_source='legacy' OR image_bytes IS NOT NULL)) OR (NEW.purpose='member.service-cover' AND EXISTS(SELECT 1 FROM member_service_covers WHERE storage_source='legacy' OR image_bytes IS NOT NULL)) OR (NEW.purpose='community.event-video' AND EXISTS(SELECT 1 FROM community_event_videos WHERE storage_source='legacy' OR media_bytes IS NOT NULL))) THEN RAISE EXCEPTION 'Legacy media sources remain' USING ERRCODE='23514';END IF;RETURN NEW;END $$;

CREATE FUNCTION fence_highlight_source() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE mode_value text;source_value text;BEGIN
 SELECT mode INTO STRICT mode_value FROM domain_media_storage_policy WHERE purpose='community.event-highlight' FOR SHARE;
 IF TG_TABLE_NAME='community_event_highlights' THEN
  IF NEW.storage_source='asset' AND mode_value='legacy' THEN RAISE EXCEPTION 'Asset highlight pairs are not enabled' USING ERRCODE='23514';END IF;
  IF TG_OP='UPDATE' AND OLD.storage_source='asset' AND NEW.storage_source<>'asset' THEN RAISE EXCEPTION 'Asset highlights cannot fall back' USING ERRCODE='23514';END IF;
 ELSE
  SELECT storage_source INTO source_value FROM community_event_highlights WHERE media_id=NEW.media_id;
  IF source_value='legacy' AND NEW.bytes IS NULL OR mode_value='r2_only' AND NEW.bytes IS NOT NULL OR TG_OP='UPDATE' AND source_value='asset' AND NEW.bytes IS DISTINCT FROM OLD.bytes THEN RAISE EXCEPTION 'Legacy highlight writer is fenced' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER fence_highlight_metadata BEFORE INSERT OR UPDATE ON community_event_highlights FOR EACH ROW EXECUTE FUNCTION fence_highlight_source();
CREATE TRIGGER fence_highlight_image BEFORE INSERT OR UPDATE ON community_event_highlight_images FOR EACH ROW EXECUTE FUNCTION fence_highlight_source();
CREATE FUNCTION require_highlight_pair_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM community_event_highlights h WHERE h.media_id=COALESCE(NEW.media_id,OLD.media_id) AND h.storage_source='asset' AND h.state='active' AND (NOT EXISTS(SELECT 1 FROM community_event_highlight_asset_targets t WHERE t.media_id=h.media_id AND t.image_asset_id IS NOT NULL AND t.thumb_asset_id IS NOT NULL) OR (SELECT count(*) FROM community_event_highlight_images i WHERE i.media_id=h.media_id AND i.variant IN ('image','thumb'))<>2)) THEN RAISE EXCEPTION 'Both highlight variants require one atomic typed publication' USING ERRCODE='23514';END IF;RETURN COALESCE(NEW,OLD);END $$;
CREATE CONSTRAINT TRIGGER require_highlight_pair AFTER INSERT OR UPDATE ON community_event_highlights DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_highlight_pair_publication();
CREATE CONSTRAINT TRIGGER require_highlight_pair_images AFTER INSERT OR UPDATE OR DELETE ON community_event_highlight_images DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_highlight_pair_publication();
CREATE CONSTRAINT TRIGGER require_highlight_pair_target AFTER INSERT OR UPDATE OR DELETE ON community_event_highlight_asset_targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_highlight_pair_publication();
CREATE FUNCTION retire_removed_highlight_pair() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE image_asset uuid;thumb_asset uuid;BEGIN
 IF TG_TABLE_NAME='community_event_highlights' THEN IF NEW.state='active' THEN RETURN NEW;END IF;END IF;
 SELECT image_asset_id,thumb_asset_id INTO image_asset,thumb_asset FROM community_event_highlight_asset_targets WHERE media_id=COALESCE(NEW.media_id,OLD.media_id) FOR UPDATE;
 UPDATE community_event_highlight_asset_targets SET image_asset_id=NULL,thumb_asset_id=NULL,published_at=NULL WHERE media_id=COALESCE(NEW.media_id,OLD.media_id);
 UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=ANY(ARRAY[image_asset,thumb_asset]) AND state='ready';RETURN COALESCE(NEW,OLD);END $$;
CREATE TRIGGER retire_removed_highlight_pair AFTER UPDATE OF state ON community_event_highlights FOR EACH ROW EXECUTE FUNCTION retire_removed_highlight_pair();
CREATE TRIGGER retire_deleted_highlight_variant AFTER DELETE ON community_event_highlight_images FOR EACH ROW EXECUTE FUNCTION retire_removed_highlight_pair();
