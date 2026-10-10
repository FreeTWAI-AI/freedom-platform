-- #418. Additive member wall data; reads are unique members, never public identities.
ALTER TABLE community_social_posts ADD COLUMN topic text NOT NULL DEFAULT 'mood' CHECK(topic IN ('mood','event','work')),
 ADD COLUMN location_name text CHECK(char_length(location_name) BETWEEN 1 AND 120),
 ADD COLUMN tags text[] NOT NULL DEFAULT '{}', ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]';
CREATE INDEX social_posts_tags ON community_social_posts USING gin(tags) WHERE state='active';
ALTER TABLE community_social_comments ADD COLUMN sticker_id text,
 ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]',
 ADD CONSTRAINT social_comment_identity UNIQUE(comment_id,post_id,community_id,author_user_id);
CREATE TABLE community_social_reads (
 post_id uuid NOT NULL, community_id uuid NOT NULL, user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(post_id,user_id),
 FOREIGN KEY(post_id,community_id) REFERENCES community_social_posts(post_id,community_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,community_id) REFERENCES users(user_id,community_id)
);
CREATE TABLE community_social_comment_likes (
 comment_id uuid NOT NULL REFERENCES community_social_comments ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(comment_id,user_id)
);

-- Comment pictures use immutable personal Assets bound to a visible community
-- post and then one comment. No bytea fallback, public URL or new storage service.
CREATE TABLE community_comment_image_asset_targets (
 image_id uuid PRIMARY KEY, post_id uuid NOT NULL, community_id uuid NOT NULL,
 scope_id uuid NOT NULL, scope_kind text GENERATED ALWAYS AS ('personal'::text) STORED,
 owner_principal_id uuid NOT NULL,owner_user_id uuid NOT NULL,
 asset_id uuid UNIQUE,linked_at_version bigint CHECK(linked_at_version>0),CHECK((asset_id IS NULL)=(linked_at_version IS NULL)),
 comment_id uuid UNIQUE,CHECK(comment_id IS NULL OR asset_id IS NOT NULL),
 purpose text GENERATED ALWAYS AS ('community.comment-image'::text) STORED,asset_state text GENERATED ALWAYS AS ('ready'::text) STORED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(post_id,community_id) REFERENCES community_social_posts(post_id,community_id),
 FOREIGN KEY(owner_user_id,community_id) REFERENCES users(user_id,community_id),
 FOREIGN KEY(comment_id,post_id,community_id,owner_user_id) REFERENCES community_social_comments(comment_id,post_id,community_id,author_user_id),
 FOREIGN KEY(scope_id,scope_kind,owner_principal_id) REFERENCES resource_scopes(scope_id,kind,owner_principal_id),
 FOREIGN KEY(owner_principal_id,owner_user_id) REFERENCES principals(principal_id,user_ref),
 FOREIGN KEY(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,asset_state) REFERENCES assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,state),
 UNIQUE(image_id,scope_id,owner_principal_id,owner_user_id)
);
CREATE TRIGGER reject_fenced_asset_reference BEFORE INSERT OR UPDATE ON community_comment_image_asset_targets FOR EACH ROW EXECUTE FUNCTION reject_fenced_asset_reference();
CREATE FUNCTION preserve_comment_image_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.asset_id IS NOT NULL THEN RAISE EXCEPTION 'Linked comment image targets are permanent' USING ERRCODE='23514';END IF;RETURN OLD;
 END IF;
 IF ROW(NEW.image_id,NEW.post_id,NEW.community_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.image_id,OLD.post_id,OLD.community_id,OLD.scope_id,OLD.owner_principal_id,OLD.owner_user_id,OLD.created_at)
 OR (OLD.asset_id IS NOT NULL AND ROW(NEW.asset_id,NEW.linked_at_version) IS DISTINCT FROM ROW(OLD.asset_id,OLD.linked_at_version))
 OR (OLD.comment_id IS NOT NULL AND NEW.comment_id IS DISTINCT FROM OLD.comment_id)
 THEN RAISE EXCEPTION 'Comment image target is immutable once linked' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER preserve_comment_image_target BEFORE UPDATE OR DELETE ON community_comment_image_asset_targets FOR EACH ROW EXECUTE FUNCTION preserve_comment_image_target();
ALTER TABLE asset_upload_intents ADD COLUMN target_comment_image_id uuid;
ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_comment_image_target FOREIGN KEY(target_comment_image_id,scope_id,owner_principal_id,target_user_id)
 REFERENCES community_comment_image_asset_targets(image_id,scope_id,owner_principal_id,owner_user_id);
CREATE FUNCTION preserve_comment_image_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.target_comment_image_id IS DISTINCT FROM OLD.target_comment_image_id THEN RAISE EXCEPTION 'Comment image intent target is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER preserve_comment_image_intent BEFORE UPDATE ON asset_upload_intents FOR EACH ROW EXECUTE FUNCTION preserve_comment_image_intent();

-- Preserve every existing closed profile verbatim, adding exactly one branch.
DO $$DECLARE old_shape text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='domain_media_storage_policy'::regclass AND conname='domain_media_storage_policy_purpose_check';
 ALTER TABLE domain_media_storage_policy DROP CONSTRAINT domain_media_storage_policy_purpose_check;
 EXECUTE format('ALTER TABLE domain_media_storage_policy ADD CONSTRAINT domain_media_storage_policy_purpose_check CHECK (((%s) AND purpose<>''community.comment-image'') OR (purpose=''community.comment-image''))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='assets'::regclass AND conname='assets_purpose_check';
 ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
 EXECUTE format('ALTER TABLE assets ADD CONSTRAINT assets_purpose_check CHECK (((%s) AND purpose<>''community.comment-image'') OR (purpose=''community.comment-image''))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='assets'::regclass AND conname='asset_scope_purpose';
 ALTER TABLE assets DROP CONSTRAINT asset_scope_purpose;
 EXECUTE format('ALTER TABLE assets ADD CONSTRAINT asset_scope_purpose CHECK (((%s) AND purpose<>''community.comment-image'') OR (purpose=''community.comment-image'' AND scope_kind=''personal'' AND community_ref IS NULL AND tenant_ref IS NULL))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_objects'::regclass AND conname='asset_object_profile_shape';
 ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
 EXECUTE format('ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK (((%s) AND purpose<>''community.comment-image'') OR (purpose=''community.comment-image'' AND variant=''image'' AND content_type=''image/webp'' AND byte_size BETWEEN 1 AND 1048576 AND transform_version=''community.comment-image.webp.v1''))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_objects'::regclass AND conname='asset_object_profile_id_shape';
 ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_id_shape;
 EXECUTE format('ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK (((%s) AND purpose<>''community.comment-image'') OR (purpose=''community.comment-image'' AND profile_id IS NOT NULL AND profile_id=purpose))',old_shape);
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_shape FROM pg_constraint WHERE conrelid='asset_upload_intents'::regclass AND conname='upload_profile_shape';
 ALTER TABLE asset_upload_intents DROP CONSTRAINT upload_profile_shape;
 EXECUTE format('ALTER TABLE asset_upload_intents ADD CONSTRAINT upload_profile_shape CHECK (((%s) AND purpose<>''community.comment-image'' AND target_comment_image_id IS NULL) OR (purpose=''community.comment-image'' AND target_kind=purpose AND target_comment_image_id IS NOT NULL AND target_message_image_id IS NULL AND target_work_id IS NULL AND target_service_id IS NULL AND target_event_id IS NULL AND target_video_event_id IS NULL AND target_post_id IS NULL AND target_submission_id IS NULL AND target_highlight_media_id IS NULL AND target_community_id IS NULL AND target_tenant_id IS NULL AND target_product_id IS NULL AND target_instance_id IS NULL AND display_name IS NULL AND source_orientation IS NULL AND source_content_type IN (''image/png'',''image/jpeg'',''image/webp'') AND source_byte_size BETWEEN 1 AND 2097152 AND reserved_bytes=1048576))',old_shape);
END $$;
INSERT INTO domain_media_storage_policy(purpose) VALUES ('community.comment-image');
CREATE OR REPLACE FUNCTION preserve_domain_media_floor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.purpose IS DISTINCT FROM OLD.purpose OR (OLD.mode<>'legacy' AND NEW.mode='legacy') THEN RAISE EXCEPTION 'Media storage floor cannot rewind' USING ERRCODE='23514';END IF;
 IF NEW.purpose NOT IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight','member.message-image','community.comment-image','storefront.product-photo') AND NEW.mode<>'legacy' THEN RAISE EXCEPTION 'Domain media adapter is not installed' USING ERRCODE='23514';END IF;
 IF NEW.mode='r2_only' AND ((NEW.purpose='community.social-thumbnail' AND EXISTS(SELECT 1 FROM community_social_post_thumbnails WHERE storage_source='legacy' OR image_bytes IS NOT NULL))
  OR (NEW.purpose='community.event-highlight' AND EXISTS(SELECT 1 FROM community_event_highlights h JOIN community_event_highlight_images i USING(media_id) WHERE h.storage_source='legacy' OR i.bytes IS NOT NULL))
  OR (NEW.purpose='skill.submission-image' AND EXISTS(SELECT 1 FROM skill_submissions WHERE image_bytes IS NOT NULL))
  OR (NEW.purpose='community.event-banner' AND EXISTS(SELECT 1 FROM community_event_banners WHERE storage_source='legacy' OR image_bytes IS NOT NULL))
  OR (NEW.purpose='member.service-cover' AND EXISTS(SELECT 1 FROM member_service_covers WHERE storage_source='legacy' OR image_bytes IS NOT NULL))
  OR (NEW.purpose='community.event-video' AND EXISTS(SELECT 1 FROM community_event_videos WHERE storage_source='legacy' OR media_bytes IS NOT NULL))) THEN RAISE EXCEPTION 'Legacy media sources remain' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
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
  OR i.purpose NOT IN ('member.avatar','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight','member.message-image','community.comment-image','storefront.product-photo')
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
DO $$BEGIN EXECUTE format('ALTER FUNCTION %I.preserve_asset_object_write_effect() SET search_path=pg_catalog,%I',current_schema(),current_schema()); END $$;
