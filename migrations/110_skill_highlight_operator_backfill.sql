-- Skill owner-read and atomic original highlight-pair operator extension.
-- SAME jobs/common intents/Assets; no member grant, session or pair catalog.
ALTER TABLE media_backfill_operator_policy DROP CONSTRAINT media_backfill_operator_policy_purpose_check;
ALTER TABLE media_backfill_operator_policy ADD CONSTRAINT media_backfill_operator_policy_purpose_check CHECK(purpose IN ('member.service-cover','community.event-video','community.event-banner','community.social-thumbnail','skill.submission-image','community.event-highlight'));
ALTER TABLE media_backfill_jobs DROP CONSTRAINT media_backfill_jobs_purpose_check,DROP CONSTRAINT operator_job_limits;
ALTER TABLE media_backfill_jobs ADD COLUMN after_submission_id uuid,ADD COLUMN after_highlight_media_id uuid;
ALTER TABLE media_backfill_jobs ADD CONSTRAINT media_backfill_jobs_purpose_check CHECK(purpose IN ('member.service-cover','community.event-video','community.event-banner','community.social-thumbnail','skill.submission-image','community.event-highlight'));
ALTER TABLE media_backfill_jobs ADD CONSTRAINT operator_job_limits CHECK(
 (purpose='community.event-video' AND max_rows=1 AND max_bytes BETWEEN 125829120 AND 134217728 AND num_nonnulls(after_service_id,after_banner_event_id,after_post_id,after_submission_id,after_highlight_media_id)=0)
 OR (purpose='community.event-highlight' AND max_rows=1 AND max_bytes BETWEEN 7520256 AND 8388608 AND num_nonnulls(after_service_id,after_event_id,after_banner_event_id,after_post_id,after_submission_id)=0)
 OR (max_bytes BETWEEN 1 AND 8388608 AND (
  (purpose='member.service-cover' AND num_nonnulls(after_event_id,after_banner_event_id,after_post_id,after_submission_id,after_highlight_media_id)=0)
  OR (purpose='community.event-banner' AND num_nonnulls(after_service_id,after_event_id,after_post_id,after_submission_id,after_highlight_media_id)=0)
  OR (purpose='community.social-thumbnail' AND num_nonnulls(after_service_id,after_event_id,after_banner_event_id,after_submission_id,after_highlight_media_id)=0)
  OR (purpose='skill.submission-image' AND num_nonnulls(after_service_id,after_event_id,after_banner_event_id,after_post_id,after_highlight_media_id)=0))));
ALTER TABLE media_backfill_items DROP CONSTRAINT media_backfill_items_pkey;
ALTER TABLE media_backfill_items ADD COLUMN submission_id uuid REFERENCES skill_submissions,ADD COLUMN highlight_media_id uuid REFERENCES community_event_highlights,ADD COLUMN variant text NOT NULL DEFAULT 'single';
ALTER TABLE media_backfill_items ALTER COLUMN target_id SET EXPRESSION AS (COALESCE(service_id,event_id,banner_event_id,post_id,submission_id,highlight_media_id));
ALTER TABLE media_backfill_items ALTER COLUMN purpose SET EXPRESSION AS (CASE WHEN service_id IS NOT NULL THEN 'member.service-cover'::text WHEN event_id IS NOT NULL THEN 'community.event-video'::text WHEN banner_event_id IS NOT NULL THEN 'community.event-banner'::text WHEN post_id IS NOT NULL THEN 'community.social-thumbnail'::text WHEN submission_id IS NOT NULL THEN 'skill.submission-image'::text ELSE 'community.event-highlight'::text END);
ALTER TABLE media_backfill_items ADD PRIMARY KEY(job_id,target_id,variant);
ALTER TABLE media_backfill_items DROP CONSTRAINT operator_item_shape;
ALTER TABLE media_backfill_items ADD CONSTRAINT operator_item_shape CHECK(num_nonnulls(service_id,event_id,banner_event_id,post_id,submission_id,highlight_media_id)=1 AND
 ((event_id IS NOT NULL AND variant='single' AND source_size BETWEEN 1 AND 20971520 AND source_content_type IN ('video/mp4','video/webm'))
 OR (highlight_media_id IS NOT NULL AND source_content_type='image/webp' AND ((variant='image' AND source_size BETWEEN 1 AND 1048576) OR (variant='thumb' AND source_size BETWEEN 1 AND 204800)))
 OR (event_id IS NULL AND highlight_media_id IS NULL AND variant='single' AND source_size BETWEEN 1 AND 524288 AND source_content_type='image/webp')));
ALTER TABLE media_backfill_audit ADD COLUMN submission_id uuid,ADD COLUMN highlight_media_id uuid;
ALTER TABLE media_backfill_audit DROP CONSTRAINT operator_audit_target;
ALTER TABLE media_backfill_audit ADD CONSTRAINT operator_audit_target CHECK(num_nonnulls(service_id,event_id,banner_event_id,post_id,submission_id,highlight_media_id)<=1);
CREATE OR REPLACE FUNCTION preserve_media_backfill_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.service_id,NEW.event_id,NEW.banner_event_id,NEW.post_id,NEW.submission_id,NEW.highlight_media_id,NEW.variant,NEW.source_content_type,NEW.intent_id,NEW.asset_id,NEW.source_version,NEW.source_size,NEW.source_sha256,NEW.source_binding_sha256,NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id,OLD.service_id,OLD.event_id,OLD.banner_event_id,OLD.post_id,OLD.submission_id,OLD.highlight_media_id,OLD.variant,OLD.source_content_type,OLD.intent_id,OLD.asset_id,OLD.source_version,OLD.source_size,OLD.source_sha256,OLD.source_binding_sha256,OLD.created_at) OR OLD.outcome<>'pending' THEN RAISE EXCEPTION 'Backfill source identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE FUNCTION lock_media_backfill_skill_owner(expected_plan text,expected_submission uuid)
RETURNS TABLE(owner_id uuid,principal_id uuid,scope_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT u.user_id,p.principal_id,r.scope_id FROM skill_submissions s
 JOIN users u ON u.user_id=s.owner_ref AND u.community_id=s.community_id AND u.active
 JOIN principals p ON p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
 JOIN resource_scopes r ON r.owner_principal_id=p.principal_id AND r.kind='personal' AND r.status='active'
 WHERE s.submission_id=expected_submission AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='skill.submission-image') FOR SHARE OF u,p,r;
END;
CREATE FUNCTION lock_media_backfill_skill_consent(expected_plan text)
RETURNS SETOF domain_media_storage_policy LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT d.* FROM domain_media_storage_policy d WHERE d.purpose='skill.submission-image' AND d.mode='bridge' AND d.persistence_allowed
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='skill.submission-image') FOR SHARE OF d;
END;
REVOKE ALL ON FUNCTION lock_media_backfill_skill_owner(text,uuid),lock_media_backfill_skill_consent(text) FROM PUBLIC;
CREATE FUNCTION publish_media_backfill_skill(expected_plan text, expected_job uuid, expected_submission uuid, expected_fence bigint, expected_token uuid)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 WITH published AS (UPDATE skill_submissions c SET storage_source='asset',aggregate_version=aggregate_version+1,updated_at=clock_timestamp()
 WHERE c.submission_id=expected_submission AND c.storage_source='legacy'
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan))
 AND EXISTS(SELECT 1 FROM media_backfill_jobs j
 JOIN media_backfill_items m ON m.job_id=j.job_id
 JOIN asset_upload_intents i ON i.intent_id=m.intent_id AND i.asset_id=m.asset_id
 JOIN assets a ON a.asset_id=m.asset_id
 JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='skill.submission-image' AND o.variant='illustration' AND o.profile_id='skill.submission-image'
 JOIN skill_submission_image_asset_targets t ON t.submission_id=m.submission_id AND t.asset_id IS NULL
 JOIN skill_submissions s ON s.submission_id=m.submission_id
 JOIN users u ON u.user_id=s.owner_ref AND u.community_id=s.community_id AND u.active
 JOIN principals pr ON pr.principal_id=a.owner_principal_id AND pr.user_ref=u.user_id AND pr.kind='person' AND pr.status='active'
 JOIN resource_scopes rs ON rs.scope_id=a.scope_id AND rs.owner_principal_id=pr.principal_id AND rs.kind='personal' AND rs.status='active'
 JOIN domain_media_storage_policy dp ON dp.purpose=a.purpose AND dp.mode='bridge' AND dp.persistence_allowed AND dp.policy_revision=a.policy_revision
 WHERE j.policy_id IN(SELECT policy_id FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='skill.submission-image')
 AND j.purpose='skill.submission-image' AND m.purpose='skill.submission-image' AND j.job_id=expected_job AND j.plan_sha256=expected_plan AND j.fence=expected_fence AND j.lease_token=expected_token
 AND j.lease_expires_at>clock_timestamp() AND NOT j.completed AND m.submission_id=expected_submission AND m.outcome='pending'
 AND i.state='stored' AND i.lease_expires_at>clock_timestamp() AND i.expires_at>clock_timestamp()
 AND a.state='ready' AND a.deletion_fence=0 AND a.purpose='skill.submission-image'
 AND s.aggregate_version=m.source_version
 AND s.owner_ref=a.owner_user_id AND s.status IN ('awaiting_upload','ready_for_review','published','revoked')
 AND c.image_bytes IS NOT NULL AND octet_length(c.image_bytes)=m.source_size
 AND encode(sha256(c.image_bytes),'hex')=m.source_sha256
 AND encode(sha256(convert_to(concat_ws('|',s.submission_id,s.owner_ref,s.community_id,s.status,m.source_version,pr.principal_id,rs.scope_id,m.source_sha256,m.source_size,s.consent_to_share::text,COALESCE(s.project_id::text,'~'),COALESCE(s.project_version_id::text,'~'),COALESCE(s.payload_sha256,'~'),COALESCE(encode(sha256(convert_to(s.payload::text,'UTF8')),'hex'),'~'),COALESCE(extract(epoch FROM s.published_at)::text,'~'),COALESCE(extract(epoch FROM s.revoked_at)::text,'~')),'UTF8')),'hex')=m.source_binding_sha256
 AND i.expected_version=m.source_version AND i.source_sha256=m.source_sha256
 AND i.source_byte_size=m.source_size AND i.target_submission_id=m.submission_id AND i.target_community_id IS NULL AND i.source_content_type='image/webp'
 AND m.source_content_type='image/webp' AND o.content_type='image/webp' AND o.byte_size=m.source_size AND o.content_sha256=m.source_sha256 AND o.policy_revision=a.policy_revision AND o.representation_id=i.representation_id
 AND o.transform_version='skill.submission-image.legacy-bytes.v1'
 AND i.purpose='skill.submission-image' AND i.target_kind='skill.submission-image')
 RETURNING c.submission_id,c.aggregate_version)
 UPDATE skill_submission_image_asset_targets t SET asset_id=m.asset_id,linked_at_version=p.aggregate_version FROM published p JOIN media_backfill_items m ON m.submission_id=p.submission_id AND m.job_id=expected_job WHERE t.submission_id=p.submission_id RETURNING t.submission_id;
END;
REVOKE ALL ON FUNCTION publish_media_backfill_skill(text,uuid,uuid,bigint,uuid) FROM PUBLIC;
-- Existing attachment triggers use unqualified names. Pin their invocation to
-- the trusted migration schema, never the caller's search_path or public.
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.publish_media_backfill_skill(text,uuid,uuid,bigint,uuid) SET search_path = pg_catalog,%I',current_schema(),current_schema());
END $$;
CREATE FUNCTION lock_media_backfill_highlight_uploader(expected_plan text,expected_media uuid)
RETURNS TABLE(owner_id uuid,principal_id uuid,scope_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT u.user_id,p.principal_id,r.scope_id FROM community_event_highlights h
 JOIN community_events e ON e.event_id=h.event_id AND e.community_id=h.community_id
 JOIN users u ON u.user_id=h.uploader_user_id AND u.community_id=h.community_id AND u.active
 JOIN users organizer ON organizer.user_id=e.organizer_ref AND organizer.community_id=e.community_id AND organizer.active
 JOIN principals p ON p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
 JOIN resource_scopes r ON r.community_ref=h.community_id AND r.kind='community' AND r.status='active'
 WHERE h.media_id=expected_media AND h.state='active' AND h.kind IN ('photo','poster') AND e.state='published' AND e.ends_at<=clock_timestamp()
 AND NOT is_verification_test_email(u.email) AND NOT is_verification_test_email(organizer.email)
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.event-highlight') FOR SHARE OF u,organizer,p,r;
END;
CREATE FUNCTION lock_media_backfill_highlight_consent(expected_plan text)
RETURNS SETOF domain_media_storage_policy LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT d.* FROM domain_media_storage_policy d WHERE d.purpose='community.event-highlight' AND d.mode='bridge' AND d.persistence_allowed
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.event-highlight') FOR SHARE OF d;
END;
REVOKE ALL ON FUNCTION lock_media_backfill_highlight_uploader(text,uuid),lock_media_backfill_highlight_consent(text) FROM PUBLIC;
CREATE FUNCTION publish_media_backfill_highlight(expected_plan text,expected_job uuid,expected_media uuid,expected_fence bigint,expected_token uuid)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 UPDATE community_event_highlights h SET storage_source='asset'
 WHERE h.media_id=expected_media AND h.storage_source='legacy' AND h.state='active' AND h.kind IN ('photo','poster')
 AND EXISTS(SELECT 1 FROM media_backfill_jobs j
 JOIN media_backfill_items m ON m.job_id=j.job_id AND m.variant='image'
 JOIN media_backfill_items mt ON mt.job_id=j.job_id AND mt.target_id=m.target_id AND mt.variant='thumb'
 JOIN asset_upload_intents i ON i.intent_id=m.intent_id AND i.asset_id=m.asset_id
 JOIN asset_upload_intents it ON it.intent_id=mt.intent_id AND it.asset_id=mt.asset_id
 JOIN assets a ON a.asset_id=m.asset_id JOIN assets at ON at.asset_id=mt.asset_id
 JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='community.event-highlight' AND o.variant='image' AND o.profile_id='community.event-highlight'
 JOIN asset_objects ot ON ot.asset_id=at.asset_id AND ot.purpose='community.event-highlight' AND ot.variant='thumb' AND ot.profile_id='community.event-highlight.thumbnail'
 JOIN community_event_highlight_asset_targets t ON t.media_id=m.highlight_media_id AND t.image_asset_id=a.asset_id AND t.thumb_asset_id=at.asset_id
 JOIN community_event_highlight_images b ON b.media_id=h.media_id AND b.variant='image'
 JOIN community_event_highlight_images bt ON bt.media_id=h.media_id AND bt.variant='thumb'
 JOIN community_events e ON e.event_id=h.event_id AND e.community_id=h.community_id
 JOIN users u ON u.user_id=h.uploader_user_id AND u.community_id=h.community_id AND u.active
 JOIN users organizer ON organizer.user_id=e.organizer_ref AND organizer.community_id=e.community_id AND organizer.active
 JOIN principals pr ON pr.principal_id=a.owner_principal_id AND pr.principal_id=at.owner_principal_id AND pr.user_ref=u.user_id AND pr.kind='person' AND pr.status='active'
 JOIN resource_scopes rs ON rs.scope_id=a.scope_id AND rs.scope_id=at.scope_id AND rs.community_ref=h.community_id AND rs.kind='community' AND rs.status='active'
 JOIN domain_media_storage_policy dp ON dp.purpose=a.purpose AND dp.mode='bridge' AND dp.persistence_allowed AND dp.policy_revision=a.policy_revision AND dp.policy_revision=at.policy_revision
 WHERE j.policy_id IN(SELECT policy_id FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.event-highlight')
 AND j.purpose='community.event-highlight' AND m.purpose='community.event-highlight' AND mt.purpose='community.event-highlight'
 AND j.job_id=expected_job AND j.plan_sha256=expected_plan AND j.fence=expected_fence AND j.lease_token=expected_token AND j.lease_expires_at>clock_timestamp() AND NOT j.completed
 AND m.highlight_media_id=expected_media AND mt.highlight_media_id=expected_media AND m.outcome='pending' AND mt.outcome='pending'
 AND i.state='stored' AND it.state='stored' AND i.lease_expires_at>clock_timestamp() AND it.lease_expires_at>clock_timestamp() AND i.expires_at>clock_timestamp() AND it.expires_at>clock_timestamp()
 AND a.state='ready' AND at.state='ready' AND a.deletion_fence=0 AND at.deletion_fence=0 AND a.purpose='community.event-highlight' AND at.purpose=a.purpose
 AND e.aggregate_version=m.source_version+1 AND mt.source_version=m.source_version AND e.state='published' AND e.ends_at<=clock_timestamp()
 AND NOT is_verification_test_email(u.email) AND NOT is_verification_test_email(organizer.email)
 AND a.owner_user_id=h.uploader_user_id AND at.owner_user_id=h.uploader_user_id AND t.event_id=h.event_id AND t.community_id=h.community_id
 AND t.source_digest=m.source_binding_sha256 AND mt.source_binding_sha256=m.source_binding_sha256
 AND b.bytes IS NOT NULL AND bt.bytes IS NOT NULL AND octet_length(b.bytes)=m.source_size AND octet_length(bt.bytes)=mt.source_size
 AND encode(sha256(b.bytes),'hex')=m.source_sha256 AND encode(sha256(bt.bytes),'hex')=mt.source_sha256 AND h.byte_size=m.source_size
 AND encode(sha256(convert_to(concat_ws('|',h.media_id,h.uploader_user_id,h.community_id,h.state,m.source_version,pr.principal_id,rs.scope_id,m.source_sha256,m.source_size,mt.source_sha256,mt.source_size,h.event_id,e.state,e.organizer_ref,extract(epoch FROM e.ends_at)::text,h.kind,h.orientation,COALESCE(encode(convert_to(h.title,'UTF8'),'hex'),'~'),h.byte_size),'UTF8')),'hex')=m.source_binding_sha256
 AND i.expected_version=m.source_version AND it.expected_version=m.source_version AND i.source_sha256=m.source_sha256 AND it.source_sha256=mt.source_sha256
 AND i.source_byte_size=m.source_size AND it.source_byte_size=mt.source_size AND i.target_highlight_media_id=m.highlight_media_id AND it.target_highlight_media_id=m.highlight_media_id
 AND i.target_community_id=h.community_id AND it.target_community_id=h.community_id AND i.source_content_type='image/webp' AND it.source_content_type='image/webp'
 AND o.content_type='image/webp' AND ot.content_type='image/webp' AND o.byte_size=m.source_size AND ot.byte_size=mt.source_size AND o.content_sha256=m.source_sha256 AND ot.content_sha256=mt.source_sha256
 AND o.policy_revision=a.policy_revision AND ot.policy_revision=at.policy_revision AND o.representation_id=i.representation_id AND ot.representation_id=it.representation_id
 AND o.transform_version='community.event-highlight.legacy-bytes.v1' AND ot.transform_version='community.event-highlight.thumbnail.legacy-bytes.v1'
 AND i.purpose='community.event-highlight' AND it.purpose=i.purpose AND i.target_kind='community.event-highlight.image' AND it.target_kind='community.event-highlight.thumb')
 RETURNING h.media_id;
END;
REVOKE ALL ON FUNCTION publish_media_backfill_highlight(text,uuid,uuid,bigint,uuid) FROM PUBLIC;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.publish_media_backfill_highlight(text,uuid,uuid,bigint,uuid) SET search_path = pg_catalog,%I',current_schema(),current_schema());
END $$;
-- Original image/parent tables have no harmless UPDATE column for row locking.
-- Do not grant byte/identity mutation merely to obtain source lock permission.
CREATE FUNCTION lock_media_backfill_highlight_bytes(expected_plan text,expected_media uuid)
RETURNS TABLE(target_id uuid,owner_user_id uuid,community_id uuid,state text,kind text,orientation text,title text,byte_size integer,storage_source text,event_id uuid,variant text,bytes bytea)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT h.media_id,h.uploader_user_id,h.community_id,h.state,h.kind,h.orientation,h.title,h.byte_size,h.storage_source,h.event_id,i.variant,
 CASE WHEN i.variant='image' AND octet_length(i.bytes) BETWEEN 1 AND 1048576 OR i.variant='thumb' AND octet_length(i.bytes) BETWEEN 1 AND 204800 THEN i.bytes END
 FROM community_event_highlights h JOIN community_event_highlight_images i ON i.media_id=h.media_id
 WHERE h.media_id=expected_media AND h.state='active' AND h.kind IN ('photo','poster')
 AND EXISTS(SELECT 1 FROM lock_media_backfill_highlight_uploader(expected_plan,expected_media))
 ORDER BY i.variant LIMIT 3 FOR UPDATE OF h,i;
END;
REVOKE ALL ON FUNCTION lock_media_backfill_highlight_bytes(text,uuid) FROM PUBLIC;

-- Bridge retains historical skill bytes; r2_only remains blocked until explicit purge/floor.
CREATE OR REPLACE FUNCTION fence_skill_image_writer() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE mode_value text;BEGIN
 SELECT mode INTO STRICT mode_value FROM domain_media_storage_policy WHERE purpose='skill.submission-image' FOR SHARE;
 IF NEW.storage_source='asset' AND (mode_value='legacy' OR (mode_value='r2_only' AND NEW.image_bytes IS NOT NULL)) THEN RAISE EXCEPTION 'Asset skill image is not enabled or contains legacy bytes' USING ERRCODE='23514';END IF;
 IF NEW.image_bytes IS NOT NULL AND mode_value='r2_only' THEN RAISE EXCEPTION 'Legacy skill writer is fenced' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND OLD.storage_source='asset' AND (NEW.storage_source<>'asset' OR NEW.image_bytes IS DISTINCT FROM OLD.image_bytes) THEN RAISE EXCEPTION 'Asset skill images cannot fall back' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
