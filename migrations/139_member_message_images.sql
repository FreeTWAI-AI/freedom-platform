-- Direct-message image attachments (#230). Additive only: no backfill, no flag and
-- no persistence is enabled here. The new purpose's storage policy row starts as
-- mode='legacy' (OFF); the operator enables it by setting a non-legacy mode
-- (r2_only recommended) with a policy revision, retained byte limit and
-- persistence_allowed=true.
--
-- Message images have NO legacy byte source, so 'bridge' and 'r2_only' are the
-- same ON state: both only require the other policy fields below.
-- Their Assets are intentionally NOT supported by the retired-domain GC
-- (lock_asset_deletion_domain / check_asset_deletion_claim reject the purpose);
-- retention and cleanup are documented in modules/assets/message-image.md.

-- 1. Closed purpose lists.
ALTER TABLE domain_media_storage_policy DROP CONSTRAINT domain_media_storage_policy_purpose_check;
ALTER TABLE domain_media_storage_policy ADD CONSTRAINT domain_media_storage_policy_purpose_check
 CHECK (purpose IN ('skill.submission-image','community.event-banner','community.event-video','community.event-highlight','community.social-thumbnail','member.service-cover','member.message-image'));
INSERT INTO domain_media_storage_policy(purpose) VALUES ('member.message-image');
CREATE OR REPLACE FUNCTION preserve_domain_media_floor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.purpose IS DISTINCT FROM OLD.purpose OR (OLD.mode<>'legacy' AND NEW.mode='legacy') THEN RAISE EXCEPTION 'Media storage floor cannot rewind' USING ERRCODE='23514';END IF;
 IF NEW.purpose NOT IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight','member.message-image') AND NEW.mode<>'legacy' THEN RAISE EXCEPTION 'Domain media adapter is not installed' USING ERRCODE='23514';END IF;
 IF NEW.mode='r2_only' AND ((NEW.purpose='community.social-thumbnail' AND EXISTS(SELECT 1 FROM community_social_post_thumbnails WHERE storage_source='legacy' OR image_bytes IS NOT NULL))
  OR (NEW.purpose='community.event-highlight' AND EXISTS(SELECT 1 FROM community_event_highlights h JOIN community_event_highlight_images i USING(media_id) WHERE h.storage_source='legacy' OR i.bytes IS NOT NULL))
  OR (NEW.purpose='skill.submission-image' AND EXISTS(SELECT 1 FROM skill_submissions WHERE image_bytes IS NOT NULL))
  OR (NEW.purpose='community.event-banner' AND EXISTS(SELECT 1 FROM community_event_banners WHERE storage_source='legacy' OR image_bytes IS NOT NULL))
  OR (NEW.purpose='member.service-cover' AND EXISTS(SELECT 1 FROM member_service_covers WHERE storage_source='legacy' OR image_bytes IS NOT NULL))
  OR (NEW.purpose='community.event-video' AND EXISTS(SELECT 1 FROM community_event_videos WHERE storage_source='legacy' OR media_bytes IS NOT NULL))) THEN RAISE EXCEPTION 'Legacy media sources remain' USING ERRCODE='23514';END IF;RETURN NEW;END $$;

ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK(purpose IN ('member.avatar','work.private-draft','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight','work.tenant-result','member.message-image'));
ALTER TABLE assets DROP CONSTRAINT asset_scope_purpose;
ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose CHECK ((((scope_kind = 'personal'::text) AND (community_ref IS NULL) AND (tenant_ref IS NULL) AND (purpose = ANY (ARRAY['member.avatar'::text, 'work.private-draft'::text, 'member.service-cover'::text, 'skill.submission-image'::text, 'member.message-image'::text])))
 OR ((scope_kind = 'community'::text) AND (community_ref IS NOT NULL) AND (tenant_ref IS NULL) AND (purpose = ANY (ARRAY['community.event-banner'::text, 'community.event-video'::text, 'community.social-thumbnail'::text, 'community.event-highlight'::text])))
 OR ((scope_kind = 'tenant'::text) AND (tenant_ref IS NOT NULL) AND (community_ref IS NULL) AND (purpose = 'work.tenant-result'::text))));

-- 2. Typed sender-owned target. The attachment exists BEFORE its message: the
-- sender uploads to a draft target bound to one recipient; sending the message
-- later sets message_id. The sidecar references the message (like every other
-- typed target references its domain row), so member_direct_messages itself
-- gains no foreign key into the Asset graph.
ALTER TABLE member_direct_messages ADD CONSTRAINT direct_message_image_identity UNIQUE(message_id,community_id,sender_ref,recipient_ref);
CREATE TABLE member_message_image_asset_targets (
 image_id uuid PRIMARY KEY,
 community_id uuid NOT NULL REFERENCES communities,
 scope_id uuid NOT NULL,scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
 owner_principal_id uuid NOT NULL,owner_user_id uuid NOT NULL,recipient_user_id uuid NOT NULL,
 asset_id uuid,linked_at_version bigint CHECK(linked_at_version>0),CHECK((asset_id IS NULL)=(linked_at_version IS NULL)),
 message_id uuid UNIQUE,CHECK(message_id IS NULL OR asset_id IS NOT NULL),
 purpose text GENERATED ALWAYS AS ('member.message-image'::text) STORED,asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(owner_user_id<>recipient_user_id),
 FOREIGN KEY(owner_user_id,community_id) REFERENCES users(user_id,community_id),
 FOREIGN KEY(recipient_user_id,community_id) REFERENCES users(user_id,community_id),
 FOREIGN KEY(message_id,community_id,owner_user_id,recipient_user_id) REFERENCES member_direct_messages(message_id,community_id,sender_ref,recipient_ref),
 FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
 FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
 FOREIGN KEY(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,asset_state) REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
 UNIQUE(image_id,scope_id,owner_principal_id,owner_user_id),
 UNIQUE(asset_id)
);
CREATE INDEX member_message_image_targets_owner ON member_message_image_asset_targets(owner_user_id,created_at DESC);
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT OR UPDATE ON member_message_image_asset_targets FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();
-- A target links one Asset once and attaches to one message once; neither changes afterwards.
CREATE FUNCTION preserve_message_image_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.asset_id IS NOT NULL THEN RAISE EXCEPTION 'Linked message image targets are permanent' USING ERRCODE='23514';END IF;RETURN OLD;
 END IF;
 IF ROW(NEW.image_id,NEW.community_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.recipient_user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.image_id,OLD.community_id,OLD.scope_id,OLD.owner_principal_id,OLD.owner_user_id,OLD.recipient_user_id,OLD.created_at)
  OR (OLD.asset_id IS NOT NULL AND ROW(NEW.asset_id,NEW.linked_at_version) IS DISTINCT FROM ROW(OLD.asset_id,OLD.linked_at_version))
  OR (OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id) THEN
  RAISE EXCEPTION 'Message image target is immutable once linked' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER preserve_message_image_target BEFORE UPDATE OR DELETE ON member_message_image_asset_targets FOR EACH ROW EXECUTE FUNCTION preserve_message_image_target();

-- 4. Upload intents: new typed target column, closed shapes and immutability.
ALTER TABLE asset_upload_intents ADD COLUMN target_message_image_id uuid;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_message_image_target FOREIGN KEY(target_message_image_id,scope_id,owner_principal_id,target_user_id)
 REFERENCES member_message_image_asset_targets(image_id,scope_id,owner_principal_id,owner_user_id);
ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
-- Every pre-existing shape is kept byte-for-byte and must NOT carry the new target.
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK ((
((((target_highlight_media_id IS NULL) AND (((target_submission_id IS NULL) AND (((target_post_id IS NULL) AND (((target_video_event_id IS NULL) AND (((target_event_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'member.avatar'::text) AND (target_kind = 'member.avatar'::text) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 2097152)) AND (reserved_bytes = 131072))
 OR ((target_event_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'work.private-draft'::text) AND (target_kind = 'work.private-result'::text) AND (target_work_id IS NOT NULL) AND (target_service_id IS NULL) AND (source_content_type = ANY (ARRAY['text/plain'::text, 'text/markdown'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 262144)) AND (reserved_bytes = 262144))
 OR ((target_event_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'work.private-draft'::text) AND (target_kind = 'work.model-result'::text) AND (target_work_id IS NOT NULL) AND (target_service_id IS NULL) AND (source_content_type = 'text/plain'::text) AND ((source_byte_size >= 1) AND (source_byte_size <= 16384)) AND (reserved_bytes = 16384))
 OR ((target_event_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'member.service-cover'::text) AND (target_kind = 'member.service-cover'::text) AND (target_service_id IS NOT NULL) AND (target_work_id IS NULL) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 4194304)) AND (reserved_bytes = 524288))
 OR ((purpose = 'community.event-banner'::text) AND (target_kind = 'community.event-banner'::text) AND (target_event_id IS NOT NULL) AND (target_community_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (source_orientation IS NOT NULL) AND (source_orientation = ANY (ARRAY['landscape'::text, 'portrait'::text])) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 524288)) AND (reserved_bytes = 524288))))
 OR ((purpose = 'community.event-video'::text) AND (target_kind = 'community.event-video'::text) AND (target_video_event_id IS NOT NULL) AND (target_event_id IS NULL) AND (target_community_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (source_orientation IS NULL) AND (source_content_type = ANY (ARRAY['video/mp4'::text, 'video/webm'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 20971520)) AND (reserved_bytes = 20971520))))
 OR ((purpose = 'community.social-thumbnail'::text) AND (target_kind = 'community.social-thumbnail'::text) AND (target_post_id IS NOT NULL) AND (target_community_id IS NOT NULL) AND (target_event_id IS NULL) AND (target_video_event_id IS NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (source_orientation IS NULL) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 524288)) AND (reserved_bytes = 524288))))
 OR ((purpose = 'skill.submission-image'::text) AND (target_kind = 'skill.submission-image'::text) AND (target_submission_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (target_event_id IS NULL) AND (target_video_event_id IS NULL) AND (target_post_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (source_content_type = 'image/webp'::text) AND ((source_byte_size >= 1) AND (source_byte_size <= 524288)) AND (reserved_bytes = 524288))))
 OR ((purpose = 'community.event-highlight'::text) AND (target_highlight_media_id IS NOT NULL) AND (target_community_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (target_event_id IS NULL) AND (target_video_event_id IS NULL) AND (target_post_id IS NULL) AND (target_submission_id IS NULL) AND (source_orientation IS NULL) AND (source_content_type = 'image/webp'::text) AND (((target_kind = 'community.event-highlight.image'::text) AND ((source_byte_size >= 1) AND (source_byte_size <= 1048576)) AND (reserved_bytes = 1048576))
 OR ((target_kind = 'community.event-highlight.thumb'::text) AND ((source_byte_size >= 1) AND (source_byte_size <= 204800)) AND (reserved_bytes = 204800))))
 OR ((target_highlight_media_id IS NULL) AND (target_submission_id IS NULL) AND (target_post_id IS NULL) AND (target_video_event_id IS NULL) AND (target_event_id IS NULL) AND (target_service_id IS NULL) AND (target_community_id IS NULL) AND (source_orientation IS NULL) AND (purpose = 'work.tenant-result'::text) AND (target_kind = 'work.tenant-result'::text) AND (target_work_id IS NOT NULL) AND (target_tenant_id IS NOT NULL) AND (display_name IS NOT NULL) AND (source_content_type = ANY (ARRAY['text/plain'::text, 'text/markdown'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 262144)) AND (reserved_bytes = 262144)))) AND target_message_image_id IS NULL)
 OR ((purpose = 'member.message-image'::text) AND (target_kind = 'member.message-image'::text) AND (target_message_image_id IS NOT NULL) AND (target_work_id IS NULL) AND (target_service_id IS NULL) AND (target_event_id IS NULL) AND (target_video_event_id IS NULL) AND (target_post_id IS NULL) AND (target_submission_id IS NULL) AND (target_highlight_media_id IS NULL) AND (target_community_id IS NULL) AND (target_tenant_id IS NULL) AND (display_name IS NULL) AND (source_orientation IS NULL) AND (source_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])) AND ((source_byte_size >= 1) AND (source_byte_size <= 2097152)) AND (reserved_bytes = 1048576)));
CREATE OR REPLACE FUNCTION preserve_upload_typed_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.target_kind, NEW.target_work_id, NEW.target_service_id, NEW.target_event_id, NEW.target_video_event_id, NEW.target_submission_id, NEW.target_post_id, NEW.target_highlight_media_id, NEW.target_message_image_id, NEW.target_community_id, NEW.source_orientation, NEW.display_name, NEW.target_tenant_id)
  IS DISTINCT FROM ROW(OLD.target_kind, OLD.target_work_id, OLD.target_service_id, OLD.target_event_id, OLD.target_video_event_id, OLD.target_submission_id, OLD.target_post_id, OLD.target_highlight_media_id, OLD.target_message_image_id, OLD.target_community_id, OLD.source_orientation, OLD.display_name, OLD.target_tenant_id) THEN
  RAISE EXCEPTION 'Upload typed target is immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;

-- 5. Stored object shapes.
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_id_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK ((((purpose = 'member.avatar'::text) AND (((transform_version = 'avatar.webp.v1'::text) AND (profile_id IS NULL))
 OR ((transform_version = 'member.avatar.legacy-bytes.v1'::text) AND (profile_id IS NOT NULL) AND (profile_id = 'member.avatar'::text))))
 OR ((purpose = 'community.event-highlight'::text) AND (profile_id IS NOT NULL) AND (((variant = 'image'::text) AND (profile_id = 'community.event-highlight'::text))
 OR ((variant = 'thumb'::text) AND (profile_id = 'community.event-highlight.thumbnail'::text))))
 OR ((purpose = ANY (ARRAY['member.service-cover'::text, 'community.event-banner'::text, 'community.event-video'::text, 'community.social-thumbnail'::text, 'skill.submission-image'::text, 'member.message-image'::text])) AND (profile_id IS NOT NULL) AND (profile_id = purpose))
 OR ((purpose <> ALL (ARRAY['member.avatar'::text, 'member.service-cover'::text, 'community.event-banner'::text, 'community.event-video'::text, 'community.social-thumbnail'::text, 'skill.submission-image'::text, 'community.event-highlight'::text, 'member.message-image'::text])) AND (profile_id IS NULL))));
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK ((
((((purpose = 'member.avatar'::text) AND (variant = 'avatar'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 131072)) AND (transform_version = ANY (ARRAY['avatar.webp.v1'::text, 'member.avatar.legacy-bytes.v1'::text])))
 OR ((purpose = 'work.private-draft'::text) AND (variant = 'draft'::text) AND (content_type = ANY (ARRAY['text/plain'::text, 'text/markdown'::text])) AND ((byte_size >= 1) AND (byte_size <= 262144)) AND (transform_version = 'private-text.utf8.v1'::text))
 OR ((purpose = 'member.service-cover'::text) AND (variant = 'cover'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 524288)) AND (transform_version = 'member.service-cover.legacy-bytes.v1'::text))
 OR ((purpose = 'community.event-banner'::text) AND (variant = 'banner'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 524288)) AND (transform_version = 'community.event-banner.legacy-bytes.v1'::text))
 OR ((purpose = 'community.event-video'::text) AND (variant = 'video'::text) AND (content_type = ANY (ARRAY['video/mp4'::text, 'video/webm'::text])) AND ((byte_size >= 1) AND (byte_size <= 20971520)) AND (transform_version = 'community.event-video.legacy-bytes.v1'::text))
 OR ((purpose = 'community.social-thumbnail'::text) AND (variant = 'thumbnail'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 524288)) AND (transform_version = 'community.social-thumbnail.legacy-bytes.v1'::text))
 OR ((purpose = 'skill.submission-image'::text) AND (variant = 'illustration'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 524288)) AND (transform_version = 'skill.submission-image.legacy-bytes.v1'::text))
 OR ((purpose = 'community.event-highlight'::text) AND (content_type = 'image/webp'::text) AND (((variant = 'image'::text) AND ((byte_size >= 1) AND (byte_size <= 1048576)) AND (transform_version = 'community.event-highlight.legacy-bytes.v1'::text))
 OR ((variant = 'thumb'::text) AND ((byte_size >= 1) AND (byte_size <= 204800)) AND (transform_version = 'community.event-highlight.thumbnail.legacy-bytes.v1'::text))))
 OR ((purpose = 'work.tenant-result'::text) AND (variant = 'draft'::text) AND (content_type = ANY (ARRAY['text/plain'::text, 'text/markdown'::text])) AND ((byte_size >= 1) AND (byte_size <= 262144)) AND (transform_version = 'private-text.utf8.v1'::text)))))
 OR ((purpose = 'member.message-image'::text) AND (variant = 'image'::text) AND (content_type = 'image/webp'::text) AND ((byte_size >= 1) AND (byte_size <= 1048576)) AND (transform_version = 'member.message-image.webp.v1'::text)));

-- 6. Immutable PUT-effect evidence is admitted for the new purpose. Only the
-- purpose list changes from migration 111.
CREATE OR REPLACE FUNCTION preserve_asset_object_write_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i asset_upload_intents%ROWTYPE;a assets%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Write effect history is permanent' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.effect_id,NEW.intent_id,NEW.asset_id,NEW.intent_fence,NEW.settlement_nonce,NEW.begun_at) IS DISTINCT FROM ROW(OLD.effect_id,OLD.intent_id,OLD.asset_id,OLD.intent_fence,OLD.settlement_nonce,OLD.begun_at)
   OR OLD.state<>'started' OR NEW.state NOT IN ('fulfilled','unknown','not_started') OR NEW.finished_at IS NULL THEN RAISE EXCEPTION 'Invalid write effect transition' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 SELECT * INTO STRICT i FROM asset_upload_intents WHERE intent_id=NEW.intent_id AND asset_id=NEW.asset_id FOR UPDATE;
 SELECT * INTO STRICT a FROM assets WHERE asset_id=NEW.asset_id FOR UPDATE;
 IF NEW.state<>'started' OR NEW.finished_at IS NOT NULL OR i.fence<>NEW.intent_fence
  OR i.purpose NOT IN ('member.avatar','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight','member.message-image')
  OR i.state NOT IN ('processing','stored') OR i.expires_at<=clock_timestamp() OR i.lease_expires_at<=clock_timestamp()
  OR a.state<>'pending' OR a.deletion_fence<>0 THEN RAISE EXCEPTION 'Write effect admission is invalid' USING ERRCODE='23514';END IF;
 -- Separate PL/pgSQL statements keep the privileged avatar port out of the
 -- SQL expression planned for ordinary domain admission. SQL expression
 -- planning checks function privileges even when its AND branch is false.
 IF i.purpose='member.avatar' THEN
  IF NOT a.write_effect_coverage OR NOT operator_avatar_intent_admitted(i.intent_id) THEN
   RAISE EXCEPTION 'Avatar effect requires an approved operator intent' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END$$;
DO $$BEGIN
 EXECUTE format('ALTER FUNCTION %I.preserve_asset_object_write_effect() SET search_path=pg_catalog,%I',current_schema(),current_schema());
END$$;
