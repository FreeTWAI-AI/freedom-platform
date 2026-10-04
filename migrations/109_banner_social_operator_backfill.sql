-- Closed original banner/social byte-preserving extension of the SAME host.
-- No consent activation, role creation, source purge or synthetic member actor.
ALTER TABLE media_backfill_operator_policy DROP CONSTRAINT media_backfill_operator_policy_purpose_check;
ALTER TABLE media_backfill_operator_policy ADD CONSTRAINT media_backfill_operator_policy_purpose_check CHECK(purpose IN ('member.service-cover','community.event-video','community.event-banner','community.social-thumbnail'));
ALTER TABLE media_backfill_jobs DROP CONSTRAINT media_backfill_jobs_purpose_check,DROP CONSTRAINT operator_job_limits;
ALTER TABLE media_backfill_jobs ADD COLUMN after_banner_event_id uuid,ADD COLUMN after_post_id uuid;
ALTER TABLE media_backfill_jobs ADD CONSTRAINT media_backfill_jobs_purpose_check CHECK(purpose IN ('member.service-cover','community.event-video','community.event-banner','community.social-thumbnail'));
ALTER TABLE media_backfill_jobs ADD CONSTRAINT operator_job_limits CHECK(
 (purpose='member.service-cover' AND max_bytes BETWEEN 1 AND 8388608 AND after_event_id IS NULL AND after_banner_event_id IS NULL AND after_post_id IS NULL)
 OR (purpose='community.event-video' AND max_rows=1 AND max_bytes BETWEEN 125829120 AND 134217728 AND after_service_id IS NULL AND after_banner_event_id IS NULL AND after_post_id IS NULL)
 OR (purpose='community.event-banner' AND max_bytes BETWEEN 1 AND 8388608 AND after_service_id IS NULL AND after_event_id IS NULL AND after_post_id IS NULL)
 OR (purpose='community.social-thumbnail' AND max_bytes BETWEEN 1 AND 8388608 AND after_service_id IS NULL AND after_event_id IS NULL AND after_banner_event_id IS NULL));
ALTER TABLE media_backfill_items ADD COLUMN banner_event_id uuid REFERENCES community_events,ADD COLUMN post_id uuid REFERENCES community_social_posts;
ALTER TABLE media_backfill_items ALTER COLUMN target_id SET EXPRESSION AS (COALESCE(service_id,event_id,banner_event_id,post_id));
ALTER TABLE media_backfill_items ALTER COLUMN purpose SET EXPRESSION AS (CASE WHEN service_id IS NOT NULL THEN 'member.service-cover'::text WHEN event_id IS NOT NULL THEN 'community.event-video'::text WHEN banner_event_id IS NOT NULL THEN 'community.event-banner'::text ELSE 'community.social-thumbnail'::text END);
ALTER TABLE media_backfill_items DROP CONSTRAINT operator_item_shape;
ALTER TABLE media_backfill_items ADD CONSTRAINT operator_item_shape CHECK(num_nonnulls(service_id,event_id,banner_event_id,post_id)=1 AND
 ((event_id IS NOT NULL AND source_size BETWEEN 1 AND 20971520 AND source_content_type IN ('video/mp4','video/webm')) OR (event_id IS NULL AND source_size BETWEEN 1 AND 524288 AND source_content_type='image/webp')));
ALTER TABLE media_backfill_audit ADD COLUMN banner_event_id uuid,ADD COLUMN post_id uuid;
ALTER TABLE media_backfill_audit DROP CONSTRAINT operator_audit_target;
ALTER TABLE media_backfill_audit ADD CONSTRAINT operator_audit_target CHECK(num_nonnulls(service_id,event_id,banner_event_id,post_id)<=1);
CREATE OR REPLACE FUNCTION preserve_media_backfill_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.service_id,NEW.event_id,NEW.banner_event_id,NEW.post_id,NEW.source_content_type,NEW.intent_id,NEW.asset_id,NEW.source_version,NEW.source_size,NEW.source_sha256,NEW.source_binding_sha256,NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id,OLD.service_id,OLD.event_id,OLD.banner_event_id,OLD.post_id,OLD.source_content_type,OLD.intent_id,OLD.asset_id,OLD.source_version,OLD.source_size,OLD.source_sha256,OLD.source_binding_sha256,OLD.created_at) OR OLD.outcome<>'pending' THEN RAISE EXCEPTION 'Backfill source identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE FUNCTION lock_media_backfill_banner_organizer(expected_plan text,expected_event uuid)
RETURNS TABLE(owner_id uuid,principal_id uuid,scope_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT u.user_id,p.principal_id,r.scope_id FROM community_events e
 JOIN users u ON u.user_id=e.organizer_ref AND u.community_id=e.community_id AND u.active
 JOIN principals p ON p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
 JOIN resource_scopes r ON r.community_ref=e.community_id AND r.kind='community' AND r.status='active'
 WHERE e.event_id=expected_event AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.event-banner')
 FOR SHARE OF u,p,r;
END;
CREATE FUNCTION lock_media_backfill_banner_consent(expected_plan text)
RETURNS SETOF domain_media_storage_policy LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT d.* FROM domain_media_storage_policy d WHERE d.purpose='community.event-banner' AND d.mode='bridge' AND d.persistence_allowed
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.event-banner') FOR SHARE OF d;
END;
REVOKE ALL ON FUNCTION lock_media_backfill_banner_organizer(text,uuid),lock_media_backfill_banner_consent(text) FROM PUBLIC;
CREATE FUNCTION publish_media_backfill_banner(expected_plan text, expected_job uuid, expected_event uuid, expected_fence bigint, expected_token uuid)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 UPDATE community_event_banners c SET storage_source='asset',updated_at=clock_timestamp()
 WHERE c.event_id=expected_event AND c.storage_source='legacy'
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan))
 AND EXISTS(SELECT 1 FROM media_backfill_jobs j
 JOIN media_backfill_items m ON m.job_id=j.job_id
 JOIN asset_upload_intents i ON i.intent_id=m.intent_id AND i.asset_id=m.asset_id
 JOIN assets a ON a.asset_id=m.asset_id
 JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='community.event-banner' AND o.variant='banner' AND o.profile_id='community.event-banner'
 JOIN community_event_banner_asset_targets t ON t.event_id=m.banner_event_id AND t.asset_id=a.asset_id
 JOIN community_events s ON s.event_id=m.banner_event_id
 JOIN users u ON u.user_id=s.organizer_ref AND u.community_id=s.community_id AND u.active
 JOIN principals pr ON pr.principal_id=a.owner_principal_id AND pr.user_ref=u.user_id AND pr.kind='person' AND pr.status='active'
 JOIN resource_scopes rs ON rs.scope_id=a.scope_id AND rs.community_ref=s.community_id AND rs.kind='community' AND rs.status='active'
 JOIN domain_media_storage_policy dp ON dp.purpose=a.purpose AND dp.mode='bridge' AND dp.persistence_allowed AND dp.policy_revision=a.policy_revision
 WHERE j.policy_id IN(SELECT policy_id FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.event-banner')
 AND j.purpose='community.event-banner' AND m.purpose='community.event-banner' AND j.job_id=expected_job AND j.plan_sha256=expected_plan AND j.fence=expected_fence AND j.lease_token=expected_token
 AND j.lease_expires_at>clock_timestamp() AND NOT j.completed AND m.banner_event_id=expected_event AND m.outcome='pending'
 AND i.state='stored' AND i.lease_expires_at>clock_timestamp() AND i.expires_at>clock_timestamp()
 AND a.state='ready' AND a.deletion_fence=0 AND a.purpose='community.event-banner'
 AND s.aggregate_version=m.source_version+1 AND t.linked_at_version=s.aggregate_version
 AND s.organizer_ref=a.owner_user_id AND s.state IN ('pending','published','rejected','cancelled')
 AND c.image_bytes IS NOT NULL AND octet_length(c.image_bytes)=m.source_size
 AND encode(sha256(c.image_bytes),'hex')=m.source_sha256
 AND encode(sha256(convert_to(concat_ws('|',s.event_id,s.organizer_ref,s.community_id,s.state,m.source_version,pr.principal_id,rs.scope_id,m.source_sha256,m.source_size,c.orientation),'UTF8')),'hex')=m.source_binding_sha256
 AND i.source_orientation=c.orientation
 AND i.expected_version=m.source_version AND i.source_sha256=m.source_sha256
 AND i.source_byte_size=m.source_size AND i.target_event_id=m.banner_event_id AND i.target_community_id=s.community_id AND i.source_content_type='image/webp'
 AND m.source_content_type='image/webp' AND o.content_type='image/webp' AND o.byte_size=m.source_size AND o.content_sha256=m.source_sha256 AND o.policy_revision=a.policy_revision AND o.representation_id=i.representation_id
 AND o.transform_version='community.event-banner.legacy-bytes.v1'
 AND i.purpose='community.event-banner' AND i.target_kind='community.event-banner')
 RETURNING c.event_id;
END;
REVOKE ALL ON FUNCTION publish_media_backfill_banner(text,uuid,uuid,bigint,uuid) FROM PUBLIC;
-- Existing attachment triggers use unqualified names. Pin their invocation to
-- the trusted migration schema, never the caller's search_path or public.
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.publish_media_backfill_banner(text,uuid,uuid,bigint,uuid) SET search_path = pg_catalog,%I',current_schema(),current_schema());
END $$;

CREATE FUNCTION lock_media_backfill_social_author(expected_plan text,expected_post uuid)
RETURNS TABLE(owner_id uuid,principal_id uuid,scope_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT u.user_id,p.principal_id,r.scope_id FROM community_social_posts e
 JOIN users u ON u.user_id=e.author_user_id AND u.community_id=e.community_id AND u.active
 JOIN principals p ON p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
 JOIN resource_scopes r ON r.community_ref=e.community_id AND r.kind='community' AND r.status='active'
 WHERE e.post_id=expected_post AND e.state='active' AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.social-thumbnail')
 FOR SHARE OF u,p,r;
END;
CREATE FUNCTION lock_media_backfill_social_consent(expected_plan text)
RETURNS SETOF domain_media_storage_policy LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT d.* FROM domain_media_storage_policy d WHERE d.purpose='community.social-thumbnail' AND d.mode='bridge' AND d.persistence_allowed
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.social-thumbnail') FOR SHARE OF d;
END;
REVOKE ALL ON FUNCTION lock_media_backfill_social_author(text,uuid),lock_media_backfill_social_consent(text) FROM PUBLIC;
CREATE FUNCTION publish_media_backfill_social(expected_plan text, expected_job uuid, expected_post uuid, expected_fence bigint, expected_token uuid)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 UPDATE community_social_post_thumbnails c SET storage_source='asset',updated_at=clock_timestamp()
 WHERE c.post_id=expected_post AND c.storage_source='legacy'
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan))
 AND EXISTS(SELECT 1 FROM media_backfill_jobs j
 JOIN media_backfill_items m ON m.job_id=j.job_id
 JOIN asset_upload_intents i ON i.intent_id=m.intent_id AND i.asset_id=m.asset_id
 JOIN assets a ON a.asset_id=m.asset_id
 JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='community.social-thumbnail' AND o.variant='thumbnail' AND o.profile_id='community.social-thumbnail'
 JOIN community_social_thumbnail_asset_targets t ON t.post_id=m.post_id AND t.asset_id=a.asset_id
 JOIN community_social_posts s ON s.post_id=m.post_id
 JOIN users u ON u.user_id=s.author_user_id AND u.community_id=s.community_id AND u.active
 JOIN principals pr ON pr.principal_id=a.owner_principal_id AND pr.user_ref=u.user_id AND pr.kind='person' AND pr.status='active'
 JOIN resource_scopes rs ON rs.scope_id=a.scope_id AND rs.community_ref=s.community_id AND rs.kind='community' AND rs.status='active'
 JOIN domain_media_storage_policy dp ON dp.purpose=a.purpose AND dp.mode='bridge' AND dp.persistence_allowed AND dp.policy_revision=a.policy_revision
 WHERE j.policy_id IN(SELECT policy_id FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.social-thumbnail')
 AND j.purpose='community.social-thumbnail' AND m.purpose='community.social-thumbnail' AND j.job_id=expected_job AND j.plan_sha256=expected_plan AND j.fence=expected_fence AND j.lease_token=expected_token
 AND j.lease_expires_at>clock_timestamp() AND NOT j.completed AND m.post_id=expected_post AND m.outcome='pending'
 AND i.state='stored' AND i.lease_expires_at>clock_timestamp() AND i.expires_at>clock_timestamp()
 AND a.state='ready' AND a.deletion_fence=0 AND a.purpose='community.social-thumbnail'
 AND s.media_version=m.source_version+1 AND t.linked_at_version=s.media_version
 AND s.author_user_id=a.owner_user_id AND s.state='active'
 AND c.image_bytes IS NOT NULL AND octet_length(c.image_bytes)=m.source_size
 AND encode(sha256(c.image_bytes),'hex')=m.source_sha256
 AND encode(sha256(convert_to(concat_ws('|',s.post_id,s.author_user_id,s.community_id,s.state,m.source_version,pr.principal_id,rs.scope_id,m.source_sha256,m.source_size,c.source,encode(convert_to(s.url,'UTF8'),'hex'),encode(convert_to(s.platform,'UTF8'),'hex'),encode(convert_to(s.title,'UTF8'),'hex'),COALESCE(encode(convert_to(s.note,'UTF8'),'hex'),'~')),'UTF8')),'hex')=m.source_binding_sha256
 AND i.expected_version=m.source_version AND i.source_sha256=m.source_sha256
 AND i.source_byte_size=m.source_size AND i.target_post_id=m.post_id AND i.target_community_id=s.community_id AND i.source_content_type='image/webp'
 AND m.source_content_type='image/webp' AND o.content_type='image/webp' AND o.byte_size=m.source_size AND o.content_sha256=m.source_sha256 AND o.policy_revision=a.policy_revision AND o.representation_id=i.representation_id
 AND o.transform_version='community.social-thumbnail.legacy-bytes.v1'
 AND i.purpose='community.social-thumbnail' AND i.target_kind='community.social-thumbnail')
 RETURNING c.post_id;
END;
REVOKE ALL ON FUNCTION publish_media_backfill_social(text,uuid,uuid,bigint,uuid) FROM PUBLIC;
-- Existing attachment triggers use unqualified names. Pin their invocation to
-- the trusted migration schema, never the caller's search_path or public.
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.publish_media_backfill_social(text,uuid,uuid,bigint,uuid) SET search_path = pg_catalog,%I',current_schema(),current_schema());
END $$;
