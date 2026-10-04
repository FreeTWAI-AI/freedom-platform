-- Finite retired-domain GC admission and actual immutable PUT-effect evidence.
-- Existing/old-writer assets remain uncovered; no activation or reconciliation.
ALTER TABLE assets ADD COLUMN write_effect_coverage boolean NOT NULL DEFAULT false;
ALTER TABLE asset_maintenance_policy ADD COLUMN domain_media_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE asset_object_write_effects (
 effect_id uuid PRIMARY KEY,intent_id uuid NOT NULL,asset_id uuid NOT NULL,
 intent_fence bigint NOT NULL CHECK(intent_fence>0),settlement_nonce uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','fulfilled','unknown','not_started')),
 begun_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 FOREIGN KEY(intent_id,asset_id) REFERENCES asset_upload_intents(intent_id,asset_id),
 CHECK((state='started')=(finished_at IS NULL))
);
CREATE INDEX asset_object_write_effects_by_asset ON asset_object_write_effects(asset_id,state);
CREATE FUNCTION preserve_asset_write_effect_coverage() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.write_effect_coverage IS DISTINCT FROM OLD.write_effect_coverage THEN RAISE EXCEPTION 'Write coverage cannot be adopted retrospectively' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER preserve_asset_write_effect_coverage BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION preserve_asset_write_effect_coverage();
CREATE FUNCTION preserve_asset_object_write_effect() RETURNS trigger LANGUAGE plpgsql AS $$
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
  OR i.purpose NOT IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight')
  OR i.state NOT IN ('processing','stored') OR i.expires_at<=clock_timestamp() OR i.lease_expires_at<=clock_timestamp()
  OR a.state<>'pending' OR a.deletion_fence<>0 THEN RAISE EXCEPTION 'Write effect admission is invalid' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER preserve_asset_object_write_effect BEFORE INSERT OR UPDATE OR DELETE ON asset_object_write_effects FOR EACH ROW EXECUTE FUNCTION preserve_asset_object_write_effect();
REVOKE ALL ON asset_object_write_effects FROM PUBLIC;
-- The finite domain lock order precedes common intent/Asset locks and the
-- original backup/maintenance gate. No SQL locks span remote object I/O.
CREATE FUNCTION lock_asset_deletion_domain(expected_asset uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a assets%ROWTYPE;i asset_upload_intents%ROWTYPE;event_ref uuid;
BEGIN
 SELECT * INTO STRICT a FROM assets WHERE asset_id=expected_asset;
 IF a.purpose='member.avatar' THEN
  PERFORM 1 FROM member_avatars WHERE user_id=a.owner_user_id FOR UPDATE;
  PERFORM 1 FROM member_avatar_asset_targets WHERE user_id=a.owner_user_id FOR UPDATE;
 ELSE
  IF a.purpose NOT IN ('member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight') THEN RAISE EXCEPTION 'Maintenance profile not supported' USING ERRCODE='23514';END IF;
  SELECT * INTO STRICT i FROM asset_upload_intents WHERE asset_id=a.asset_id;
  PERFORM 1 FROM users WHERE user_id=a.owner_user_id FOR SHARE;
  PERFORM 1 FROM principals WHERE principal_id=a.owner_principal_id FOR SHARE;
  PERFORM 1 FROM resource_scopes WHERE scope_id=a.scope_id FOR SHARE;
  CASE a.purpose
   WHEN 'member.service-cover' THEN
    PERFORM 1 FROM member_services WHERE service_id=i.target_service_id FOR UPDATE;
    PERFORM 1 FROM member_service_cover_asset_targets WHERE service_id=i.target_service_id FOR UPDATE;
   WHEN 'community.event-banner' THEN
    PERFORM 1 FROM community_events WHERE event_id=i.target_event_id FOR UPDATE;
    PERFORM 1 FROM community_event_banner_asset_targets WHERE event_id=i.target_event_id FOR UPDATE;
   WHEN 'community.event-video' THEN
    PERFORM 1 FROM community_events WHERE event_id=i.target_video_event_id FOR UPDATE;
    PERFORM 1 FROM community_event_video_asset_targets WHERE event_id=i.target_video_event_id FOR UPDATE;
   WHEN 'community.social-thumbnail' THEN
    PERFORM 1 FROM community_social_posts WHERE post_id=i.target_post_id FOR UPDATE;
    PERFORM 1 FROM community_social_thumbnail_asset_targets WHERE post_id=i.target_post_id FOR UPDATE;
   WHEN 'skill.submission-image' THEN
    PERFORM 1 FROM skill_submissions WHERE submission_id=i.target_submission_id FOR UPDATE;
    PERFORM 1 FROM skill_submission_image_asset_targets WHERE submission_id=i.target_submission_id FOR UPDATE;
   WHEN 'community.event-highlight' THEN
    SELECT event_id INTO STRICT event_ref FROM community_event_highlight_asset_targets WHERE media_id=i.target_highlight_media_id;
    PERFORM 1 FROM community_events WHERE event_id=event_ref FOR UPDATE;
    PERFORM 1 FROM community_event_highlights WHERE media_id=i.target_highlight_media_id FOR UPDATE;
    PERFORM 1 FROM community_event_highlight_asset_targets WHERE media_id=i.target_highlight_media_id FOR UPDATE;
  END CASE;
 END IF;
 PERFORM 1 FROM asset_upload_intents WHERE asset_id=expected_asset FOR UPDATE;
 PERFORM 1 FROM assets WHERE asset_id=expected_asset FOR UPDATE;
END$$;
CREATE OR REPLACE FUNCTION check_asset_deletion_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target assets%ROWTYPE;policy asset_maintenance_policy%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deletion tombstones are permanent' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.asset_id,NEW.policy_revision,NEW.fenced_at) IS DISTINCT FROM ROW(OLD.asset_id,OLD.policy_revision,OLD.fenced_at) THEN RAISE EXCEPTION 'Deletion identity is immutable' USING ERRCODE='23514';END IF;
  IF NEW.attempt IS DISTINCT FROM OLD.attempt THEN
   SELECT * INTO STRICT target FROM assets WHERE asset_id=NEW.asset_id;
   SELECT * INTO STRICT policy FROM asset_maintenance_policy WHERE singleton FOR SHARE;
   IF target.purpose<>'member.avatar' AND (NOT policy.enabled OR NOT policy.domain_media_enabled) THEN RAISE EXCEPTION 'Domain maintenance disabled' USING ERRCODE='23514';END IF;
   IF NEW.attempt<>OLD.attempt+1 OR OLD.lease_expires_at>clock_timestamp() OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Invalid delete lease takeover' USING ERRCODE='23514';END IF;
  ELSIF NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at>OLD.lease_expires_at THEN RAISE EXCEPTION 'Delete lease extension requires new attempt' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 -- RLS/unsupported relation shapes must not hide effects or protection rows.
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['assets','asset_upload_intents','asset_object_write_effects','asset_maintenance_policy','asset_backup_captures','asset_backup_pins','member_avatar_asset_targets','member_service_cover_asset_targets','community_event_banner_asset_targets','community_event_video_asset_targets','community_social_thumbnail_asset_targets','skill_submission_image_asset_targets','community_event_highlight_asset_targets']) AS required(name)
  LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=TG_TABLE_SCHEMA
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=required.name
  WHERE c.oid IS NULL OR c.relkind NOT IN ('r','p') OR c.relrowsecurity) THEN RAISE EXCEPTION 'Maintenance source shape unavailable' USING ERRCODE='23514';END IF;
 PERFORM lock_asset_deletion_domain(NEW.asset_id);
 SELECT * INTO STRICT target FROM assets WHERE asset_id=NEW.asset_id FOR UPDATE;
 SELECT * INTO STRICT policy FROM asset_maintenance_policy WHERE singleton FOR SHARE;
 IF NOT policy.enabled OR NEW.policy_revision<>policy.revision OR NEW.attempt<>1 OR NEW.lease_expires_at<=clock_timestamp() OR NEW.lease_expires_at>clock_timestamp()+make_interval(secs=>policy.delete_lease_seconds) THEN RAISE EXCEPTION 'Maintenance is not configured or lease invalid' USING ERRCODE='23514';END IF;
 IF target.purpose='member.avatar' THEN
  IF EXISTS(SELECT 1 FROM member_avatar_asset_targets WHERE asset_id=NEW.asset_id) THEN RAISE EXCEPTION 'Asset references or backup protection remain' USING ERRCODE='23514';END IF;
  IF NOT ((target.state IN ('pending','rejected') AND target.created_at+make_interval(secs=>policy.orphan_retention_seconds)<=clock_timestamp()) OR (target.state='retired' AND target.retired_at+make_interval(secs=>policy.retired_retention_seconds)<=clock_timestamp())) THEN RAISE EXCEPTION 'Asset retention has not elapsed' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT policy.domain_media_enabled OR NOT target.write_effect_coverage OR target.state<>'retired' OR target.retired_at+make_interval(secs=>policy.retired_retention_seconds)>clock_timestamp() THEN RAISE EXCEPTION 'Domain asset retention or write coverage unavailable' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM asset_upload_intents WHERE asset_id=NEW.asset_id AND state='finalized')
   OR NOT EXISTS(SELECT 1 FROM asset_object_write_effects WHERE asset_id=NEW.asset_id AND state='fulfilled')
   OR EXISTS(SELECT 1 FROM asset_object_write_effects WHERE asset_id=NEW.asset_id AND state IN ('started','unknown')) THEN RAISE EXCEPTION 'Domain write effects are not settled' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM member_service_cover_asset_targets WHERE asset_id=NEW.asset_id)
   OR EXISTS(SELECT 1 FROM community_event_banner_asset_targets WHERE asset_id=NEW.asset_id)
   OR EXISTS(SELECT 1 FROM community_event_video_asset_targets WHERE asset_id=NEW.asset_id)
   OR EXISTS(SELECT 1 FROM community_social_thumbnail_asset_targets WHERE asset_id=NEW.asset_id)
   OR EXISTS(SELECT 1 FROM skill_submission_image_asset_targets WHERE asset_id=NEW.asset_id)
   OR EXISTS(SELECT 1 FROM community_event_highlight_asset_targets WHERE image_asset_id=NEW.asset_id OR thumb_asset_id=NEW.asset_id) THEN RAISE EXCEPTION 'Domain asset references remain' USING ERRCODE='23514';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM asset_upload_intents WHERE asset_id=NEW.asset_id AND state<>'finalized' AND expires_at>clock_timestamp())
  OR EXISTS(SELECT 1 FROM asset_backup_captures WHERE state='capturing')
  OR EXISTS(SELECT 1 FROM asset_backup_pins p JOIN asset_backup_captures c USING(capture_id) WHERE p.asset_id=NEW.asset_id AND c.state='pinned') THEN RAISE EXCEPTION 'Asset references or backup protection remain' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
