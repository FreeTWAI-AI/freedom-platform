ALTER TABLE media_backfill_operator_policy DROP CONSTRAINT media_backfill_operator_policy_purpose_check;
ALTER TABLE media_backfill_operator_policy ADD CONSTRAINT media_backfill_operator_policy_purpose_check CHECK(purpose IN ('member.service-cover','community.event-video','community.event-banner','community.social-thumbnail','skill.submission-image','community.event-highlight','member.avatar'));
ALTER TABLE media_backfill_jobs DROP CONSTRAINT media_backfill_jobs_purpose_check;
ALTER TABLE media_backfill_jobs ADD CONSTRAINT media_backfill_jobs_purpose_check CHECK(purpose IN ('member.service-cover','community.event-video','community.event-banner','community.social-thumbnail','skill.submission-image','community.event-highlight','member.avatar'));
ALTER TABLE media_backfill_jobs ADD COLUMN after_avatar_user_id uuid;
ALTER TABLE media_backfill_jobs DROP CONSTRAINT operator_job_limits;
ALTER TABLE media_backfill_jobs ADD CONSTRAINT operator_job_limits CHECK(
(purpose='member.service-cover' AND max_bytes BETWEEN 1 AND 8388608 AND num_nonnulls(after_event_id,after_banner_event_id,after_post_id,after_submission_id,after_highlight_media_id,after_avatar_user_id)=0) OR
(purpose='community.event-video' AND max_rows=1 AND max_bytes BETWEEN 125829120 AND 134217728 AND num_nonnulls(after_service_id,after_banner_event_id,after_post_id,after_submission_id,after_highlight_media_id,after_avatar_user_id)=0) OR
(purpose='community.event-banner' AND max_bytes BETWEEN 1 AND 8388608 AND num_nonnulls(after_service_id,after_event_id,after_post_id,after_submission_id,after_highlight_media_id,after_avatar_user_id)=0) OR
(purpose='community.social-thumbnail' AND max_bytes BETWEEN 1 AND 8388608 AND num_nonnulls(after_service_id,after_event_id,after_banner_event_id,after_submission_id,after_highlight_media_id,after_avatar_user_id)=0) OR
(purpose='skill.submission-image' AND max_bytes BETWEEN 1 AND 8388608 AND num_nonnulls(after_service_id,after_event_id,after_banner_event_id,after_post_id,after_highlight_media_id,after_avatar_user_id)=0) OR
(purpose='community.event-highlight' AND max_rows=1 AND max_bytes BETWEEN 7520256 AND 8388608 AND num_nonnulls(after_service_id,after_event_id,after_banner_event_id,after_post_id,after_submission_id,after_avatar_user_id)=0) OR
(purpose='member.avatar' AND max_bytes BETWEEN 1 AND 8388608 AND num_nonnulls(after_service_id,after_event_id,after_banner_event_id,after_post_id,after_submission_id,after_highlight_media_id)=0));
ALTER TABLE media_backfill_items ADD COLUMN avatar_user_id uuid REFERENCES member_avatars(user_id);
ALTER TABLE media_backfill_items ALTER COLUMN target_id SET EXPRESSION AS (COALESCE(service_id,event_id,banner_event_id,post_id,submission_id,highlight_media_id,avatar_user_id));
ALTER TABLE media_backfill_items ALTER COLUMN purpose SET EXPRESSION AS (CASE WHEN service_id IS NOT NULL THEN 'member.service-cover'::text WHEN event_id IS NOT NULL THEN 'community.event-video'::text WHEN banner_event_id IS NOT NULL THEN 'community.event-banner'::text WHEN post_id IS NOT NULL THEN 'community.social-thumbnail'::text WHEN submission_id IS NOT NULL THEN 'skill.submission-image'::text WHEN highlight_media_id IS NOT NULL THEN 'community.event-highlight'::text WHEN avatar_user_id IS NOT NULL THEN 'member.avatar'::text END);
ALTER TABLE media_backfill_items DROP CONSTRAINT operator_item_shape;
ALTER TABLE media_backfill_items ADD CONSTRAINT operator_item_shape CHECK(num_nonnulls(service_id,event_id,banner_event_id,post_id,submission_id,highlight_media_id,avatar_user_id)=1 AND
 ((event_id IS NOT NULL AND variant='single' AND source_size BETWEEN 1 AND 20971520 AND source_content_type IN ('video/mp4','video/webm'))
 OR (highlight_media_id IS NOT NULL AND source_content_type='image/webp' AND ((variant='image' AND source_size BETWEEN 1 AND 1048576) OR (variant='thumb' AND source_size BETWEEN 1 AND 204800)))
 OR (avatar_user_id IS NOT NULL AND variant='single' AND source_size BETWEEN 1 AND 131072 AND source_content_type='image/webp')
 OR (event_id IS NULL AND highlight_media_id IS NULL AND avatar_user_id IS NULL AND variant='single' AND source_size BETWEEN 1 AND 524288 AND source_content_type='image/webp')));
ALTER TABLE media_backfill_audit ADD COLUMN avatar_user_id uuid;
ALTER TABLE media_backfill_audit DROP CONSTRAINT operator_audit_target;
ALTER TABLE media_backfill_audit ADD CONSTRAINT operator_audit_target CHECK(num_nonnulls(service_id,event_id,banner_event_id,post_id,submission_id,highlight_media_id,avatar_user_id)<=1);
CREATE OR REPLACE FUNCTION preserve_media_backfill_item() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.service_id,NEW.event_id,NEW.banner_event_id,NEW.post_id,NEW.submission_id,NEW.highlight_media_id,NEW.avatar_user_id,NEW.variant,NEW.source_content_type,NEW.intent_id,NEW.asset_id,NEW.source_version,NEW.source_size,NEW.source_sha256,NEW.source_binding_sha256,NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id,OLD.service_id,OLD.event_id,OLD.banner_event_id,OLD.post_id,OLD.submission_id,OLD.highlight_media_id,OLD.avatar_user_id,OLD.variant,OLD.source_content_type,OLD.intent_id,OLD.asset_id,OLD.source_version,OLD.source_size,OLD.source_sha256,OLD.source_binding_sha256,OLD.created_at) OR OLD.outcome<>'pending' THEN RAISE EXCEPTION 'Backfill source identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
-- Closed byte-preserving historical avatar operator profile.
-- No ordinary upload change, consent activation, source deletion or GC.
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_id_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_id_shape CHECK((purpose='member.avatar' AND ((transform_version='avatar.webp.v1' AND profile_id IS NULL) OR (transform_version='member.avatar.legacy-bytes.v1' AND profile_id IS NOT NULL AND profile_id='member.avatar'))) OR (purpose='community.event-highlight' AND profile_id IS NOT NULL AND ((variant='image' AND profile_id='community.event-highlight') OR (variant='thumb' AND profile_id='community.event-highlight.thumbnail'))) OR (purpose IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image') AND profile_id IS NOT NULL AND profile_id=purpose) OR (purpose NOT IN ('member.avatar','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight') AND profile_id IS NULL));
ALTER TABLE asset_objects DROP CONSTRAINT asset_object_profile_shape;
ALTER TABLE asset_objects ADD CONSTRAINT asset_object_profile_shape CHECK(
(


 (purpose='member.avatar' AND variant='avatar' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 131072 AND transform_version IN ('avatar.webp.v1','member.avatar.legacy-bytes.v1'))
 OR (purpose='work.private-draft' AND variant='draft' AND content_type IN ('text/plain','text/markdown') AND byte_size BETWEEN 1 AND 262144 AND transform_version='private-text.utf8.v1')
 OR (purpose='member.service-cover' AND variant='cover' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='member.service-cover.legacy-bytes.v1')
 OR (purpose='community.event-banner' AND variant='banner' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='community.event-banner.legacy-bytes.v1') OR (purpose='community.event-video' AND variant='video' AND content_type IN ('video/mp4','video/webm') AND byte_size BETWEEN 1 AND 20971520 AND transform_version='community.event-video.legacy-bytes.v1') OR (purpose='community.social-thumbnail' AND variant='thumbnail' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='community.social-thumbnail.legacy-bytes.v1')) OR (purpose='skill.submission-image' AND variant='illustration' AND content_type='image/webp' AND byte_size BETWEEN 1 AND 524288 AND transform_version='skill.submission-image.legacy-bytes.v1') OR (purpose='community.event-highlight' AND content_type='image/webp' AND ((variant='image' AND byte_size BETWEEN 1 AND 1048576 AND transform_version='community.event-highlight.legacy-bytes.v1') OR (variant='thumb' AND byte_size BETWEEN 1 AND 204800 AND transform_version='community.event-highlight.thumbnail.legacy-bytes.v1'))));
-- Covered historical avatars deliberately have NO GC admission in this release.
-- Guard INSERT and takeover of tombstones, before the old deletion lifecycle.
CREATE FUNCTION reject_covered_avatar_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a assets%ROWTYPE;
BEGIN
 SELECT * INTO STRICT a FROM assets WHERE asset_id=NEW.asset_id FOR UPDATE;
 IF a.purpose='member.avatar' AND (a.write_effect_coverage OR EXISTS(
  SELECT 1 FROM asset_objects o WHERE o.asset_id=a.asset_id AND o.profile_id='member.avatar'))
 THEN RAISE EXCEPTION 'Operator avatar garbage collection is not installed' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER reject_covered_avatar_deletion BEFORE INSERT OR UPDATE ON asset_deletion_tombstones FOR EACH ROW EXECUTE FUNCTION reject_covered_avatar_deletion();
DO $$BEGIN EXECUTE format('ALTER FUNCTION %I.reject_covered_avatar_deletion() SET search_path=pg_catalog,%I',current_schema(),current_schema());END$$;
CREATE FUNCTION lock_media_backfill_avatar_owner(expected_plan text,expected_user uuid)
RETURNS TABLE(owner_id uuid,principal_id uuid,scope_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT u.user_id,p.principal_id,r.scope_id FROM member_avatars a
 JOIN users u ON u.user_id=a.user_id AND u.community_id=a.community_id AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
 JOIN principals p ON p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
 JOIN resource_scopes r ON r.owner_principal_id=p.principal_id AND r.kind='personal' AND r.status='active'
 WHERE a.user_id=expected_user AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='member.avatar') FOR SHARE OF u,p,r;
END;
CREATE FUNCTION lock_media_backfill_avatar_consent(expected_plan text)
RETURNS SETOF avatar_storage_policy LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT d.* FROM avatar_storage_policy d WHERE d.profile='member.avatar' AND d.mode='bridge' AND d.persistence_allowed
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='member.avatar') FOR SHARE OF d;
END;
REVOKE ALL ON FUNCTION lock_media_backfill_avatar_owner(text,uuid),lock_media_backfill_avatar_consent(text) FROM PUBLIC;
CREATE FUNCTION operator_avatar_intent_admitted(expected_intent uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT EXISTS(SELECT 1 FROM media_backfill_items m JOIN media_backfill_jobs j USING(job_id)
 JOIN asset_upload_intents i ON i.intent_id=m.intent_id AND i.asset_id=m.asset_id
 JOIN assets a ON a.asset_id=i.asset_id
 WHERE m.intent_id=expected_intent AND m.purpose='member.avatar' AND j.purpose='member.avatar' AND m.outcome='pending'
 AND a.purpose='member.avatar' AND a.write_effect_coverage AND a.state IN ('pending','ready') AND a.deletion_fence=0
 AND i.purpose='member.avatar' AND i.target_kind='member.avatar' AND i.target_user_id=m.avatar_user_id
 AND i.expected_version=m.source_version AND i.source_sha256=m.source_sha256 AND i.source_byte_size=m.source_size AND i.source_content_type='image/webp'
 AND j.policy_id IN(SELECT policy_id FROM lock_media_backfill_operator_approval(j.plan_sha256) WHERE purpose='member.avatar')
 AND NOT j.completed AND j.lease_expires_at>clock_timestamp());
END;
REVOKE ALL ON FUNCTION operator_avatar_intent_admitted(uuid) FROM PUBLIC;
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
  OR i.purpose NOT IN ('member.avatar','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight')
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
CREATE FUNCTION enforce_operator_avatar_representation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.purpose='member.avatar' AND NEW.transform_version='member.avatar.legacy-bytes.v1' THEN
 IF NOT EXISTS(
  SELECT 1 FROM asset_upload_intents i WHERE i.asset_id=NEW.asset_id AND i.state IN ('processing','stored')
  AND i.lease_expires_at>clock_timestamp() AND i.expires_at>clock_timestamp()
  AND i.representation_id=NEW.representation_id AND i.source_sha256=NEW.content_sha256 AND i.source_byte_size=NEW.byte_size
  AND i.policy_revision=NEW.policy_revision AND operator_avatar_intent_admitted(i.intent_id))
 THEN RAISE EXCEPTION 'Historical avatar representation requires approved operator authority' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER enforce_operator_avatar_representation BEFORE INSERT ON asset_objects FOR EACH ROW EXECUTE FUNCTION enforce_operator_avatar_representation();
DO $$BEGIN
 EXECUTE format('ALTER FUNCTION %I.enforce_operator_avatar_representation() SET search_path=pg_catalog,%I',current_schema(),current_schema());
 EXECUTE format('ALTER FUNCTION %I.preserve_asset_object_write_effect() SET search_path=pg_catalog,%I',current_schema(),current_schema());
END$$;
CREATE FUNCTION publish_media_backfill_avatar(expected_plan text,expected_job uuid,expected_user uuid,expected_fence bigint,expected_token uuid)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 WITH published AS (UPDATE member_avatars c SET storage_source='asset',aggregate_version=aggregate_version+1,updated_at=clock_timestamp()
 WHERE c.user_id=expected_user AND c.storage_source='legacy'
 AND EXISTS(SELECT 1 FROM media_backfill_jobs j JOIN media_backfill_items m USING(job_id)
 JOIN asset_upload_intents i ON i.intent_id=m.intent_id AND i.asset_id=m.asset_id
 JOIN assets a ON a.asset_id=m.asset_id
 JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='member.avatar' AND o.variant='avatar' AND o.profile_id='member.avatar'
 JOIN member_avatar_asset_targets t ON t.user_id=m.avatar_user_id AND t.asset_id IS NULL
 JOIN users u ON u.user_id=m.avatar_user_id AND u.community_id=c.community_id AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
 JOIN principals pr ON pr.principal_id=a.owner_principal_id AND pr.user_ref=u.user_id AND pr.kind='person' AND pr.status='active'
 JOIN resource_scopes rs ON rs.scope_id=a.scope_id AND rs.owner_principal_id=pr.principal_id AND rs.kind='personal' AND rs.status='active'
 JOIN avatar_storage_policy dp ON dp.profile=a.purpose AND dp.mode='bridge' AND dp.persistence_allowed AND dp.policy_revision=a.policy_revision
 WHERE j.policy_id IN(SELECT policy_id FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='member.avatar')
 AND j.purpose='member.avatar' AND m.purpose='member.avatar' AND j.job_id=expected_job AND j.plan_sha256=expected_plan AND j.fence=expected_fence AND j.lease_token=expected_token
 AND j.lease_expires_at>clock_timestamp() AND NOT j.completed AND m.avatar_user_id=expected_user AND m.outcome='pending'
 AND i.state='stored' AND i.lease_expires_at>clock_timestamp() AND i.expires_at>clock_timestamp()
 AND a.state='ready' AND a.deletion_fence=0 AND a.purpose='member.avatar' AND a.write_effect_coverage
 AND c.aggregate_version=m.source_version AND a.owner_user_id=c.user_id
 AND c.image_bytes IS NOT NULL AND octet_length(c.image_bytes)=m.source_size AND encode(sha256(c.image_bytes),'hex')=m.source_sha256
 AND encode(sha256(convert_to(concat_ws('|',c.user_id,c.user_id,c.community_id,'active',m.source_version,pr.principal_id,rs.scope_id,m.source_sha256,m.source_size),'UTF8')),'hex')=m.source_binding_sha256
 AND i.expected_version=m.source_version AND i.source_sha256=m.source_sha256 AND i.source_byte_size=m.source_size AND i.target_user_id=m.avatar_user_id AND i.source_content_type='image/webp'
 AND m.source_content_type='image/webp' AND o.content_type='image/webp' AND o.byte_size=m.source_size AND o.content_sha256=m.source_sha256 AND o.policy_revision=a.policy_revision AND o.representation_id=i.representation_id
 AND o.transform_version='member.avatar.legacy-bytes.v1' AND i.purpose='member.avatar' AND i.target_kind='member.avatar') RETURNING c.user_id,c.aggregate_version)
 UPDATE member_avatar_asset_targets t SET asset_id=m.asset_id,linked_at_version=p.aggregate_version FROM published p JOIN media_backfill_items m ON m.avatar_user_id=p.user_id AND m.job_id=expected_job WHERE t.user_id=p.user_id RETURNING t.user_id;
END;
REVOKE ALL ON FUNCTION publish_media_backfill_avatar(text,uuid,uuid,bigint,uuid) FROM PUBLIC;
DO $$BEGIN EXECUTE format('ALTER FUNCTION %I.publish_media_backfill_avatar(text,uuid,uuid,bigint,uuid) SET search_path=pg_catalog,%I',current_schema(),current_schema());END$$;
