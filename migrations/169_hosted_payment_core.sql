-- Expand-only commerce setup. This schema enables no payment writer/callback
-- capability or release floor; payment processing arrives separately.
INSERT INTO module_definitions(module_key,release_ref,data_schema_version,data_catalog_ref,contract_ref,
  portable_profile_ref,runtime_profiles,capabilities,config_schema_ref,supported_upgrade_paths,
  license_review_ref,license_state,release_status,version)
SELECT module_key,'storefront@1.1.0',data_schema_version,data_catalog_ref,contract_ref,
  portable_profile_ref,runtime_profiles,
  '["store:manage","store:read","store:write","store:publish","store:orders:read","store:customers:read","store:finance:read","store:orders:manage","store:fulfil","store:refund","store:invoices","store:settlements"]'::jsonb,
  config_schema_ref,'[]'::jsonb,license_review_ref,license_state,release_status,1
FROM module_definitions WHERE module_key='storefront' AND release_ref='storefront@1.0.0';

INSERT INTO application_definitions(application_key,release_ref,display_name,runtime_profiles,source_commit,artifact_digest,
  launch_policy_ref,skill_book_refs,module_requirements,entry_capability,customization_schema_ref,license_review_ref,license_state,release_status,version)
SELECT application_key,'hosted-store@1.1.0',display_name,runtime_profiles,source_commit,artifact_digest,
  launch_policy_ref,'["storefront"]'::jsonb,
  jsonb_build_array((module_requirements->0) || jsonb_build_object('module_release_ref','storefront@1.1.0',
    'capabilities',(SELECT capabilities FROM module_definitions WHERE release_ref='storefront@1.1.0'))),
  entry_capability,customization_schema_ref,license_review_ref,license_state,release_status,1
FROM application_definitions WHERE application_key='hosted-store' AND release_ref='hosted-store@1.0.0';

INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,
  display_order,launch_policy_ref,version)
SELECT gen_random_uuid(),community_id,guild_key,application_key,'hosted-store@1.1.0','offered',display_order,launch_policy_ref,1
FROM guild_application_offerings WHERE release_ref='hosted-store@1.0.0' AND status='offered';
UPDATE guild_application_offerings SET status='withdrawn',version=version+1
WHERE release_ref='hosted-store@1.0.0' AND status='offered';

-- This immutable relation, rather than the historical definition JSON, is the
-- authority for paired application/module upgrades.
CREATE TABLE module_release_upgrades (
  module_key text NOT NULL,
  from_release_ref text NOT NULL,
  to_release_ref text NOT NULL,
  from_application_release_ref text NOT NULL REFERENCES application_definitions(release_ref),
  to_application_release_ref text NOT NULL REFERENCES application_definitions(release_ref),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(module_key,from_release_ref,from_application_release_ref),
  FOREIGN KEY(module_key,from_release_ref) REFERENCES module_definitions(module_key,release_ref),
  FOREIGN KEY(module_key,to_release_ref) REFERENCES module_definitions(module_key,release_ref)
);
CREATE INDEX module_release_upgrades_target ON module_release_upgrades(module_key,to_release_ref);
CREATE INDEX module_release_upgrades_from_application ON module_release_upgrades(from_application_release_ref);
CREATE INDEX module_release_upgrades_to_application ON module_release_upgrades(to_application_release_ref);
CREATE FUNCTION preserve_module_release_upgrade() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_keys jsonb; target_keys jsonb; target_requirements jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'release upgrade paths are immutable' USING ERRCODE='23514';
  END IF;
  SELECT capabilities INTO source_keys FROM module_definitions
    WHERE module_key=NEW.module_key AND release_ref=NEW.from_release_ref;
  SELECT capabilities INTO target_keys FROM module_definitions
    WHERE module_key=NEW.module_key AND release_ref=NEW.to_release_ref;
  SELECT module_requirements INTO target_requirements FROM application_definitions
    WHERE release_ref=NEW.to_application_release_ref;
  IF source_keys IS NULL OR target_keys IS NULL OR NOT target_keys @> source_keys
    OR NEW.from_release_ref=NEW.to_release_ref
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(target_requirements) r
      WHERE r->>'module_key'=NEW.module_key AND r->>'module_release_ref'=NEW.to_release_ref)
    OR NOT EXISTS(SELECT 1 FROM application_definitions a, jsonb_array_elements(a.module_requirements) r
      WHERE a.release_ref=NEW.from_application_release_ref AND r->>'module_key'=NEW.module_key
        AND r->>'module_release_ref'=NEW.from_release_ref) THEN
    RAISE EXCEPTION 'release upgrade must preserve capabilities and application requirements' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_module_release_upgrade BEFORE INSERT OR UPDATE OR DELETE ON module_release_upgrades
  FOR EACH ROW EXECUTE FUNCTION preserve_module_release_upgrade();
INSERT INTO module_release_upgrades(module_key,from_release_ref,to_release_ref,from_application_release_ref,to_application_release_ref)
VALUES('storefront','storefront@1.0.0','storefront@1.1.0','hosted-store@1.0.0','hosted-store@1.1.0');

CREATE OR REPLACE FUNCTION preserve_module_instance_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Module instance identity is retained' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.instance_id,NEW.tenant_id,NEW.module_key,NEW.created_by_principal_id,NEW.origin_guild_key,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.instance_id,OLD.tenant_id,OLD.module_key,OLD.created_by_principal_id,OLD.origin_guild_key,OLD.created_at) THEN
    RAISE EXCEPTION 'Module instance identity is immutable' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.module_release_ref,NEW.application_release_ref)
    IS DISTINCT FROM ROW(OLD.module_release_ref,OLD.application_release_ref) THEN
    IF NOT EXISTS(SELECT 1 FROM module_release_upgrades u WHERE u.module_key=OLD.module_key
      AND u.from_release_ref=OLD.module_release_ref AND u.from_application_release_ref=OLD.application_release_ref
      AND u.to_release_ref=NEW.module_release_ref AND u.to_application_release_ref=NEW.application_release_ref)
      OR (to_jsonb(NEW)-'module_release_ref'-'application_release_ref'-'version'-'created_by_principal_kind')
        IS DISTINCT FROM (to_jsonb(OLD)-'module_release_ref'-'application_release_ref'-'version'-'created_by_principal_kind')
      OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'Module release changes require a registered paired upgrade' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Constraint name verified against the base PostgreSQL catalog.
ALTER TABLE tenant_high_risk_verifications DROP CONSTRAINT tenant_high_risk_verifications_purpose_check,
  ADD CONSTRAINT tenant_high_risk_verifications_purpose_check CHECK(purpose IN
    ('tenant.ownership.propose','tenant.ownership.accept','tenant.recovery.accept',
     'commerce.provider_account.write','commerce.store_export.create'));

-- Non-PII platform control facts must be available before tenant context is
-- bound (admin admission and machine repair). Domain authorization is required.
CREATE TABLE commerce_control_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  instance_id uuid,
  kind text NOT NULL CHECK(kind IN ('storefront.upgraded','provider_account.created','provider_service.created',
    'provider_service.state_changed','provider_credential.rotated','provider_credential.retired','provider_credential.resealed',
    'store_admission.admitted','store_admission.revoked')),
  subject_id uuid NOT NULL,
  detail jsonb NOT NULL CHECK(jsonb_typeof(detail)='object' AND octet_length(detail::text)<=1024
    AND detail-ARRAY['purpose','profile','environment','from_state','to_state','credential_version','module_release_ref']='{}'::jsonb),
  actor_kind text NOT NULL CHECK(actor_kind IN ('person','platform_admin','system')),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  journaled_at timestamptz CHECK(journaled_at IS NULL OR journaled_at>=occurred_at),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id)
);
CREATE INDEX commerce_control_events_store ON commerce_control_events(tenant_id,instance_id,occurred_at,event_id);
CREATE INDEX commerce_control_events_unjournaled ON commerce_control_events(occurred_at,event_id) WHERE journaled_at IS NULL;
CREATE FUNCTION preserve_commerce_control_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'journaled_at') IS DISTINCT FROM (to_jsonb(OLD)-'journaled_at')
    OR (OLD.journaled_at IS NOT NULL AND NEW.journaled_at IS DISTINCT FROM OLD.journaled_at) THEN
    RAISE EXCEPTION 'commerce control events are append only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_control_event BEFORE UPDATE OR DELETE ON commerce_control_events
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_control_event();
