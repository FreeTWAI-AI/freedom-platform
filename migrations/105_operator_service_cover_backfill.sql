-- Explicit closed operator service-cover backfill. No policy activation/grants,
-- member credentials, machine principal, cutover, erasure or storage duplicate.
CREATE TABLE media_backfill_operator_policy (
 policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 role_name text NOT NULL CHECK(role_name ~ '^(fp_media_migrator_[a-z0-9_]+|freedom_media_migrator)$'),
 environment text NOT NULL CHECK(environment IN ('local','staging','public')),
 database_name text NOT NULL CHECK(database_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
 schema_name text NOT NULL CHECK(schema_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
 release_sha text NOT NULL CHECK(release_sha ~ '^[0-9a-f]{40}$'),
 logical_store text NOT NULL DEFAULT 'MEDIA' CHECK(logical_store='MEDIA'),
 store_binding_id text NOT NULL CHECK(store_binding_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 migration_id text NOT NULL CHECK(migration_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$'),
 purpose text NOT NULL DEFAULT 'member.service-cover' CHECK(purpose='member.service-cover'),
 approved_plan_sha256 text NOT NULL CHECK(approved_plan_sha256 ~ '^[0-9a-f]{64}$'),
 allowed boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(role_name,environment,database_name,schema_name,release_sha,logical_store,store_binding_id,migration_id,purpose,approved_plan_sha256)
);
CREATE TABLE media_backfill_jobs (
 job_id uuid PRIMARY KEY,policy_id uuid NOT NULL REFERENCES media_backfill_operator_policy,
 plan_sha256 text NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
 after_service_id uuid,max_rows integer NOT NULL CHECK(max_rows BETWEEN 1 AND 16),
 max_bytes integer NOT NULL CHECK(max_bytes BETWEEN 1 AND 8388608),
 fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),lease_token uuid,lease_expires_at timestamptz,
 completed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((fence=0 AND lease_token IS NULL AND lease_expires_at IS NULL) OR (fence>0 AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
ALTER TABLE asset_upload_intents ADD CONSTRAINT operator_common_intent_asset UNIQUE(intent_id,asset_id);
CREATE TABLE media_backfill_items (
 job_id uuid NOT NULL REFERENCES media_backfill_jobs,service_id uuid NOT NULL REFERENCES member_services,
 intent_id uuid NOT NULL,asset_id uuid NOT NULL,
 source_version bigint NOT NULL CHECK(source_version>0),source_size integer NOT NULL CHECK(source_size BETWEEN 1 AND 524288),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 source_binding_sha256 text NOT NULL CHECK(source_binding_sha256 ~ '^[0-9a-f]{64}$'),
 outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','linked','stale')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 PRIMARY KEY(job_id,service_id),UNIQUE(intent_id),UNIQUE(asset_id),
 FOREIGN KEY(intent_id,asset_id) REFERENCES asset_upload_intents(intent_id,asset_id),
 CHECK((outcome='pending')=(finished_at IS NULL))
);
CREATE TABLE media_backfill_audit (
 audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,job_id uuid NOT NULL REFERENCES media_backfill_jobs,
 service_id uuid,event text NOT NULL CHECK(event IN ('claimed','prepared','stored','linked','stale','complete','object_outcome_unknown')),
 operator_role text NOT NULL,job_fence bigint NOT NULL CHECK(job_fence>0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION preserve_media_backfill_operator_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['allowed','expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['allowed','expires_at']) THEN RAISE EXCEPTION 'Operator approval identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER preserve_media_backfill_operator_policy BEFORE UPDATE OR DELETE ON media_backfill_operator_policy FOR EACH ROW EXECUTE FUNCTION preserve_media_backfill_operator_policy();
CREATE FUNCTION preserve_media_backfill_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.policy_id,NEW.plan_sha256,NEW.max_rows,NEW.max_bytes,NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id,OLD.policy_id,OLD.plan_sha256,OLD.max_rows,OLD.max_bytes,OLD.created_at) OR (OLD.completed AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Backfill job identity is immutable' USING ERRCODE='23514';END IF;
 IF NEW.fence<>OLD.fence THEN IF NEW.fence<>OLD.fence+1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()) OR NEW.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Backfill job lease is invalid' USING ERRCODE='23514';END IF;
 ELSIF NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_expires_at>OLD.lease_expires_at THEN RAISE EXCEPTION 'Backfill lease extension needs a new fence' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER preserve_media_backfill_job BEFORE UPDATE OR DELETE ON media_backfill_jobs FOR EACH ROW EXECUTE FUNCTION preserve_media_backfill_job();
CREATE FUNCTION preserve_media_backfill_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.service_id,NEW.intent_id,NEW.asset_id,NEW.source_version,NEW.source_size,NEW.source_sha256,NEW.source_binding_sha256,NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id,OLD.service_id,OLD.intent_id,OLD.asset_id,OLD.source_version,OLD.source_size,OLD.source_sha256,OLD.source_binding_sha256,OLD.created_at) OR OLD.outcome<>'pending' THEN RAISE EXCEPTION 'Backfill source identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER preserve_media_backfill_item BEFORE UPDATE OR DELETE ON media_backfill_items FOR EACH ROW EXECUTE FUNCTION preserve_media_backfill_item();
CREATE FUNCTION preserve_media_backfill_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Operator audit is append-only' USING ERRCODE='23514';END $$;
CREATE TRIGGER preserve_media_backfill_audit BEFORE UPDATE OR DELETE ON media_backfill_audit FOR EACH ROW EXECUTE FUNCTION preserve_media_backfill_audit();
REVOKE ALL ON media_backfill_operator_policy,media_backfill_jobs,media_backfill_items,media_backfill_audit FROM PUBLIC;
-- The dedicated login may read its live approval without receiving UPDATE on
-- policy. SQL-standard body binds the table at migration time, not caller path.
CREATE FUNCTION lock_media_backfill_operator_approval(expected_plan text)
RETURNS SETOF media_backfill_operator_policy LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT p.* FROM media_backfill_operator_policy p
 WHERE p.role_name=session_user AND p.approved_plan_sha256=expected_plan
 AND p.database_name=current_database()
 AND p.schema_name=(SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=p.tableoid)
 AND p.allowed AND p.expires_at>clock_timestamp() FOR SHARE;
END;
REVOKE ALL ON FUNCTION lock_media_backfill_operator_approval(text) FROM PUBLIC;
-- Lock only original owner authority. This read port cannot re-enable users or
-- mutate scope/persistence policy and is bound to its migration schema.
CREATE FUNCTION lock_media_backfill_cover_owner(expected_plan text, expected_user uuid)
RETURNS TABLE(owner_id uuid,principal_id uuid,scope_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT u.user_id,p.principal_id,s.scope_id FROM users u
 JOIN principals p ON p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
 JOIN resource_scopes s ON s.owner_principal_id=p.principal_id AND s.kind='personal' AND s.status='active'
 WHERE u.user_id=expected_user AND u.active
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan))
 FOR SHARE OF u,p,s;
END;
CREATE FUNCTION lock_media_backfill_cover_consent(expected_plan text)
RETURNS SETOF domain_media_storage_policy LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog
BEGIN ATOMIC
 SELECT p.* FROM domain_media_storage_policy p
 WHERE p.purpose='member.service-cover' AND p.mode='bridge' AND p.persistence_allowed
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan))
 FOR SHARE OF p;
END;
REVOKE ALL ON FUNCTION lock_media_backfill_cover_owner(text,uuid),lock_media_backfill_cover_consent(text) FROM PUBLIC;
-- Original cover fence requires a policy row lock. This finite publication port
-- avoids giving the operator UPDATE on consent merely to satisfy that lock.
CREATE FUNCTION publish_media_backfill_cover(expected_plan text, expected_job uuid, expected_service uuid, expected_fence bigint, expected_token uuid)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
BEGIN ATOMIC
 UPDATE member_service_covers c SET storage_source='asset',updated_at=clock_timestamp()
 WHERE c.service_id=expected_service AND c.storage_source='legacy'
 AND EXISTS(SELECT 1 FROM lock_media_backfill_operator_approval(expected_plan))
 AND EXISTS(SELECT 1 FROM media_backfill_jobs j
 JOIN media_backfill_items m ON m.job_id=j.job_id
 JOIN asset_upload_intents i ON i.intent_id=m.intent_id AND i.asset_id=m.asset_id
 JOIN assets a ON a.asset_id=m.asset_id
 JOIN member_service_cover_asset_targets t ON t.service_id=m.service_id AND t.asset_id=a.asset_id
 JOIN member_services s ON s.service_id=m.service_id
 JOIN users u ON u.user_id=s.owner_user_id AND u.active
 JOIN principals pr ON pr.principal_id=a.owner_principal_id AND pr.user_ref=u.user_id AND pr.kind='person' AND pr.status='active'
 JOIN resource_scopes rs ON rs.scope_id=a.scope_id AND rs.owner_principal_id=pr.principal_id AND rs.kind='personal' AND rs.status='active'
 JOIN domain_media_storage_policy dp ON dp.purpose=a.purpose AND dp.mode='bridge' AND dp.persistence_allowed AND dp.policy_revision=a.policy_revision
 WHERE j.policy_id IN(SELECT policy_id FROM lock_media_backfill_operator_approval(expected_plan))
 AND j.job_id=expected_job AND j.plan_sha256=expected_plan AND j.fence=expected_fence AND j.lease_token=expected_token
 AND j.lease_expires_at>clock_timestamp() AND NOT j.completed AND m.service_id=expected_service AND m.outcome='pending'
 AND i.state='stored' AND i.lease_expires_at>clock_timestamp() AND i.expires_at>clock_timestamp()
 AND a.state='ready' AND a.deletion_fence=0 AND a.purpose='member.service-cover'
 AND s.aggregate_version=m.source_version+1 AND t.linked_at_version=s.aggregate_version
 AND s.owner_user_id=a.owner_user_id AND s.state IN ('active','paused')
 AND c.image_bytes IS NOT NULL AND octet_length(c.image_bytes)=m.source_size
 AND encode(sha256(c.image_bytes),'hex')=m.source_sha256
 AND encode(sha256(convert_to(concat_ws('|',s.service_id,s.owner_user_id,s.community_id,s.state,m.source_version,pr.principal_id,rs.scope_id,m.source_sha256,m.source_size),'UTF8')),'hex')=m.source_binding_sha256
 AND i.expected_version=m.source_version AND i.source_sha256=m.source_sha256
 AND i.source_byte_size=m.source_size AND i.target_service_id=m.service_id
 AND i.purpose='member.service-cover' AND i.target_kind='member.service-cover')
 RETURNING c.service_id;
END;
REVOKE ALL ON FUNCTION publish_media_backfill_cover(text,uuid,uuid,bigint,uuid) FROM PUBLIC;
-- Existing attachment triggers use unqualified names. Pin their invocation to
-- the trusted migration schema, never the caller's search_path or public.
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.publish_media_backfill_cover(text,uuid,uuid,bigint,uuid) SET search_path = pg_catalog,%I',current_schema(),current_schema());
END $$;
