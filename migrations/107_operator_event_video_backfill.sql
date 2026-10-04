-- Finite exact-byte video extension to the existing approved operator host.
ALTER TABLE media_backfill_operator_policy DROP CONSTRAINT media_backfill_operator_policy_purpose_check;
ALTER TABLE media_backfill_operator_policy ADD CONSTRAINT media_backfill_operator_policy_purpose_check CHECK(purpose IN ('member.service-cover','community.event-video'));
ALTER TABLE media_backfill_operator_policy ADD CONSTRAINT operator_policy_purpose_identity UNIQUE(policy_id,purpose);
ALTER TABLE media_backfill_jobs DROP CONSTRAINT media_backfill_jobs_max_bytes_check;
ALTER TABLE media_backfill_jobs ADD COLUMN purpose text NOT NULL DEFAULT 'member.service-cover' CHECK(purpose IN ('member.service-cover','community.event-video')),ADD COLUMN after_event_id uuid;
ALTER TABLE media_backfill_jobs ADD CONSTRAINT operator_job_purpose FOREIGN KEY(policy_id,purpose) REFERENCES media_backfill_operator_policy(policy_id,purpose);
ALTER TABLE media_backfill_jobs ADD CONSTRAINT operator_job_limits CHECK((purpose='member.service-cover' AND max_bytes BETWEEN 1 AND 8388608 AND after_event_id IS NULL) OR (purpose='community.event-video' AND max_rows=1 AND max_bytes BETWEEN 125829120 AND 134217728 AND after_service_id IS NULL));
ALTER TABLE media_backfill_jobs ADD CONSTRAINT operator_job_identity UNIQUE(job_id,purpose);
ALTER TABLE media_backfill_items DROP CONSTRAINT media_backfill_items_pkey,DROP CONSTRAINT media_backfill_items_source_size_check;
ALTER TABLE media_backfill_items ALTER COLUMN service_id DROP NOT NULL;
ALTER TABLE media_backfill_items ADD COLUMN event_id uuid REFERENCES community_events,ADD COLUMN source_content_type text NOT NULL DEFAULT 'image/webp';
ALTER TABLE media_backfill_items ADD COLUMN target_id uuid GENERATED ALWAYS AS (COALESCE(service_id,event_id)) STORED,ADD COLUMN purpose text GENERATED ALWAYS AS (CASE WHEN event_id IS NULL THEN 'member.service-cover'::text ELSE 'community.event-video'::text END) STORED;
ALTER TABLE media_backfill_items ADD PRIMARY KEY(job_id,target_id),ADD CONSTRAINT operator_item_purpose FOREIGN KEY(job_id,purpose) REFERENCES media_backfill_jobs(job_id,purpose),ADD CONSTRAINT operator_item_shape CHECK((service_id IS NOT NULL AND event_id IS NULL AND source_size BETWEEN 1 AND 524288 AND source_content_type='image/webp') OR (service_id IS NULL AND event_id IS NOT NULL AND source_size BETWEEN 1 AND 20971520 AND source_content_type IN ('video/mp4','video/webm')));
ALTER TABLE media_backfill_audit ADD COLUMN event_id uuid;
ALTER TABLE media_backfill_audit DROP CONSTRAINT media_backfill_audit_event_check;
ALTER TABLE media_backfill_audit ADD CONSTRAINT media_backfill_audit_event_check CHECK(event IN ('claimed','prepared','stored','linked','stale','complete','object_outcome_unknown','blocked_source'));
ALTER TABLE media_backfill_audit ADD CONSTRAINT operator_audit_target CHECK(service_id IS NULL OR event_id IS NULL);
CREATE OR REPLACE FUNCTION preserve_media_backfill_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.service_id,NEW.event_id,NEW.source_content_type,NEW.intent_id,NEW.asset_id,NEW.source_version,NEW.source_size,NEW.source_sha256,NEW.source_binding_sha256,NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id,OLD.service_id,OLD.event_id,OLD.source_content_type,OLD.intent_id,OLD.asset_id,OLD.source_version,OLD.source_size,OLD.source_sha256,OLD.source_binding_sha256,OLD.created_at) OR OLD.outcome<>'pending' THEN RAISE EXCEPTION 'Backfill source identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE OR REPLACE FUNCTION preserve_media_backfill_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.policy_id,NEW.purpose,NEW.plan_sha256,NEW.max_rows,NEW.max_bytes,NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id,OLD.policy_id,OLD.purpose,OLD.plan_sha256,OLD.max_rows,OLD.max_bytes,OLD.created_at) OR (OLD.completed AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Backfill job identity is immutable' USING ERRCODE='23514';END IF;
 IF NEW.fence<>OLD.fence THEN IF NEW.fence<>OLD.fence+1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()) OR NEW.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Backfill job lease is invalid' USING ERRCODE='23514';END IF;
 ELSIF NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at>OLD.lease_expires_at THEN RAISE EXCEPTION 'Backfill lease extension needs a new fence' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE FUNCTION lock_media_backfill_video_organizer(expected_plan text,expected_event uuid)
RETURNS TABLE(owner_id uuid,principal_id uuid,scope_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT u.user_id,p.principal_id,r.scope_id FROM community_events e
 JOIN users u ON u.user_id=e.organizer_ref AND u.community_id=e.community_id AND u.active
 JOIN principals p ON p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
 JOIN resource_scopes r ON r.community_ref=e.community_id AND r.kind='community' AND r.status='active'
 WHERE e.event_id=expected_event AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.event-video')
 FOR SHARE OF u,p,r;
END;
CREATE FUNCTION lock_media_backfill_video_consent(expected_plan text)
RETURNS SETOF domain_media_storage_policy LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT d.* FROM domain_media_storage_policy d WHERE d.purpose='community.event-video' AND d.mode='bridge' AND d.persistence_allowed
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.event-video') FOR SHARE OF d;
END;
REVOKE ALL ON FUNCTION lock_media_backfill_video_organizer(text,uuid),lock_media_backfill_video_consent(text) FROM PUBLIC;
CREATE FUNCTION publish_media_backfill_video(expected_plan text, expected_job uuid, expected_event uuid, expected_fence bigint, expected_token uuid)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 UPDATE community_event_videos c SET storage_source='asset',updated_at=clock_timestamp()
 WHERE c.event_id=expected_event AND c.storage_source='legacy'
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan))
 AND EXISTS(SELECT 1 FROM media_backfill_jobs j
 JOIN media_backfill_items m ON m.job_id=j.job_id
 JOIN asset_upload_intents i ON i.intent_id=m.intent_id AND i.asset_id=m.asset_id
 JOIN assets a ON a.asset_id=m.asset_id
 JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='community.event-video' AND o.variant='video' AND o.profile_id='community.event-video'
 JOIN community_event_video_asset_targets t ON t.event_id=m.event_id AND t.asset_id=a.asset_id
 JOIN community_events s ON s.event_id=m.event_id
 JOIN users u ON u.user_id=s.organizer_ref AND u.active
 JOIN principals pr ON pr.principal_id=a.owner_principal_id AND pr.user_ref=u.user_id AND pr.kind='person' AND pr.status='active'
 JOIN resource_scopes rs ON rs.scope_id=a.scope_id AND rs.community_ref=s.community_id AND rs.kind='community' AND rs.status='active'
 JOIN domain_media_storage_policy dp ON dp.purpose=a.purpose AND dp.mode='bridge' AND dp.persistence_allowed AND dp.policy_revision=a.policy_revision
 WHERE j.policy_id IN(SELECT policy_id FROM lock_media_backfill_operator_approval(expected_plan) WHERE purpose='community.event-video')
 AND j.purpose='community.event-video' AND m.purpose='community.event-video' AND j.job_id=expected_job AND j.plan_sha256=expected_plan AND j.fence=expected_fence AND j.lease_token=expected_token
 AND j.lease_expires_at>clock_timestamp() AND NOT j.completed AND m.event_id=expected_event AND m.outcome='pending'
 AND i.state='stored' AND i.lease_expires_at>clock_timestamp() AND i.expires_at>clock_timestamp()
 AND a.state='ready' AND a.deletion_fence=0 AND a.purpose='community.event-video'
 AND s.aggregate_version=m.source_version+1 AND t.linked_at_version=s.aggregate_version
 AND s.organizer_ref=a.owner_user_id AND s.state IN ('pending','published','rejected','cancelled')
 AND c.media_bytes IS NOT NULL AND octet_length(c.media_bytes)=m.source_size
 AND encode(sha256(c.media_bytes),'hex')=m.source_sha256
 AND encode(sha256(convert_to(concat_ws('|',s.event_id,s.organizer_ref,s.community_id,s.state,m.source_version,pr.principal_id,rs.scope_id,m.source_sha256,m.source_size,c.mime_type),'UTF8')),'hex')=m.source_binding_sha256
 AND i.expected_version=m.source_version AND i.source_sha256=m.source_sha256
 AND i.source_byte_size=m.source_size AND i.target_video_event_id=m.event_id AND i.target_community_id=s.community_id AND i.source_content_type=c.mime_type
 AND m.source_content_type=c.mime_type AND o.content_type=c.mime_type AND o.byte_size=m.source_size AND o.content_sha256=m.source_sha256 AND o.policy_revision=a.policy_revision AND o.representation_id=i.representation_id
 AND o.transform_version='community.event-video.legacy-bytes.v1'
 AND i.purpose='community.event-video' AND i.target_kind='community.event-video')
 RETURNING c.event_id;
END;
REVOKE ALL ON FUNCTION publish_media_backfill_video(text,uuid,uuid,bigint,uuid) FROM PUBLIC;
-- Existing attachment triggers use unqualified names. Pin their invocation to
-- the trusted migration schema, never the caller's search_path or public.
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.publish_media_backfill_video(text,uuid,uuid,bigint,uuid) SET search_path = pg_catalog,%I',current_schema(),current_schema());
END $$;
