-- Expand-only hosted payment schema. The release gate requires a binary that
-- retains the inbound payment writer before applying or restoring this schema.
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
      -- Stored generated columns are not populated in NEW in a BEFORE trigger.
      OR (to_jsonb(NEW)-'module_release_ref'-'application_release_ref'-'version'-'created_by_principal_kind')
        IS DISTINCT FROM (to_jsonb(OLD)-'module_release_ref'-'application_release_ref'-'version'-'created_by_principal_kind')
      OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'Module instance identity is immutable' USING ERRCODE='23514';
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
  IF TG_OP='INSERT' THEN
    IF NEW.journaled_at IS NOT NULL THEN RAISE EXCEPTION 'control events start unjournaled' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'journaled_at') IS DISTINCT FROM (to_jsonb(OLD)-'journaled_at')
    OR (OLD.journaled_at IS NOT NULL AND NEW.journaled_at IS DISTINCT FROM OLD.journaled_at) THEN
    RAISE EXCEPTION 'commerce control events are append only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_control_event BEFORE INSERT OR UPDATE OR DELETE ON commerce_control_events
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_control_event();

CREATE TABLE commerce_provider_accounts (
  account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider='ecpay'),
  environment text NOT NULL CHECK(environment IN ('sandbox','live')),
  merchant_id text NOT NULL CHECK(merchant_id ~ '^[0-9]{7,10}$'),
  created_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  UNIQUE(instance_id,provider,environment,merchant_id),
  UNIQUE(account_id,tenant_id,instance_id,environment)
);
CREATE INDEX commerce_provider_accounts_store ON commerce_provider_accounts(tenant_id,instance_id,created_at,account_id);
CREATE INDEX commerce_provider_accounts_creator ON commerce_provider_accounts(created_by_principal_id);
CREATE FUNCTION preserve_commerce_provider_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'version'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'version'-'updated_at')
    OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'provider account identity is retained' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_provider_account BEFORE UPDATE OR DELETE ON commerce_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_provider_account();

CREATE TABLE commerce_provider_account_services (
  account_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('payment','logistics','invoice')),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('sandbox','live')),
  profile text NOT NULL CHECK((purpose='payment' AND profile='ecpay.aio.credit.v1')
    OR (purpose='logistics' AND profile='ecpay.logistics.domestic.v1') OR (purpose='invoice' AND profile='ecpay.invoice.b2c.v1')),
  credential_version integer NOT NULL CHECK(credential_version>=1),
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','suspended','retired')),
  throttled_until timestamptz,
  activated_at timestamptz,
  activation_ref text CHECK(activation_ref IS NULL OR char_length(activation_ref) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(account_id,purpose),
  UNIQUE(account_id,purpose,tenant_id,instance_id,environment),
  FOREIGN KEY(account_id,tenant_id,instance_id,environment) REFERENCES commerce_provider_accounts(account_id,tenant_id,instance_id,environment),
  CHECK((activated_at IS NULL)=(activation_ref IS NULL)),
  CHECK(state NOT IN ('active','suspended') OR activated_at IS NOT NULL),
  CHECK(state<>'draft' OR activated_at IS NULL)
);
CREATE INDEX commerce_provider_services_store ON commerce_provider_account_services(tenant_id,instance_id,environment);
CREATE UNIQUE INDEX commerce_provider_services_one_active ON commerce_provider_account_services(instance_id,environment,profile) WHERE state='active';

CREATE TABLE commerce_provider_credentials (
  credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  purpose text NOT NULL,
  credential_version integer NOT NULL CHECK(credential_version>=1),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  environment text NOT NULL,
  key_id text NOT NULL CHECK(key_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  sealed text NOT NULL CHECK(char_length(sealed) BETWEEN 40 AND 2048),
  created_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz CHECK(retired_at IS NULL OR retired_at>=created_at),
  UNIQUE(account_id,purpose,credential_version),
  FOREIGN KEY(account_id,purpose,tenant_id,instance_id,environment) REFERENCES commerce_provider_account_services(account_id,purpose,tenant_id,instance_id,environment)
);
CREATE INDEX commerce_provider_credentials_store ON commerce_provider_credentials(tenant_id,instance_id);
CREATE INDEX commerce_provider_credentials_creator ON commerce_provider_credentials(created_by_principal_id);
CREATE INDEX commerce_provider_credentials_reseal ON commerce_provider_credentials(key_id,credential_id);
-- The deferred current-version FK permits inserting the draft service before
-- its first credential, without permitting an orphan at commit.
ALTER TABLE commerce_provider_account_services ADD CONSTRAINT commerce_provider_service_current_credential
  FOREIGN KEY(account_id,purpose,credential_version) REFERENCES commerce_provider_credentials(account_id,purpose,credential_version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION preserve_commerce_provider_service() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'provider services are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'draft' OR NEW.credential_version<>1 OR NEW.activated_at IS NOT NULL THEN
      RAISE EXCEPTION 'provider services start as draft' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','credential_version','throttled_until','activated_at','activation_ref','updated_at','version'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','credential_version','throttled_until','activated_at','activation_ref','updated_at','version'])
    -- Retirement stops new effects, not read-only queries or their 403 throttle.
    -- Every other retired-service fact, including credentials, remains frozen.
    OR (OLD.state='retired' AND ((to_jsonb(NEW)-ARRAY['throttled_until','updated_at','version'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['throttled_until','updated_at','version'])
      OR NEW.throttled_until IS NOT DISTINCT FROM OLD.throttled_until))
    OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
    OR (OLD.activated_at IS NOT NULL AND ROW(NEW.activated_at,NEW.activation_ref) IS DISTINCT FROM ROW(OLD.activated_at,OLD.activation_ref))
    OR (OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL AND NOT (OLD.state='draft' AND NEW.state='active')) THEN
    RAISE EXCEPTION 'provider service identity and activation are retained' USING ERRCODE='23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state='draft' AND NEW.state='active' AND NEW.activated_at IS NOT NULL AND NEW.activation_ref IS NOT NULL)
    OR (OLD.state='active' AND NEW.state='suspended')
    OR (OLD.state='suspended' AND NEW.state='active' AND OLD.activated_at IS NOT NULL)
    OR NEW.state='retired') THEN
    RAISE EXCEPTION 'invalid provider service transition' USING ERRCODE='23514';
  END IF;
  IF NEW.credential_version IS DISTINCT FROM OLD.credential_version AND (NEW.credential_version<>OLD.credential_version+1
    OR NEW.state<>OLD.state OR NOT EXISTS(SELECT 1 FROM commerce_provider_credentials c WHERE c.account_id=NEW.account_id
      AND c.purpose=NEW.purpose AND c.credential_version=NEW.credential_version AND c.retired_at IS NULL)) THEN
    RAISE EXCEPTION 'provider credential version must advance to an existing credential' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_provider_service BEFORE INSERT OR UPDATE OR DELETE ON commerce_provider_account_services
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_provider_service();
CREATE FUNCTION preserve_commerce_provider_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.retired_at IS NOT NULL THEN RAISE EXCEPTION 'credentials start unretired' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['key_id','sealed','retired_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['key_id','sealed','retired_at'])
    OR ((NEW.key_id IS DISTINCT FROM OLD.key_id)<>(NEW.sealed IS DISTINCT FROM OLD.sealed))
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
    OR (NEW.retired_at IS NOT NULL AND EXISTS(SELECT 1 FROM commerce_provider_account_services s
      WHERE s.account_id=OLD.account_id AND s.purpose=OLD.purpose AND s.credential_version=OLD.credential_version)) THEN
    RAISE EXCEPTION 'provider credential history and current version are retained' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_provider_credential BEFORE INSERT OR UPDATE OR DELETE ON commerce_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_provider_credential();
CREATE FUNCTION require_commerce_storefront_instance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM module_instances i WHERE i.tenant_id=NEW.tenant_id AND i.instance_id=NEW.instance_id AND i.module_key='storefront') THEN
    RAISE EXCEPTION 'commerce setup requires a storefront instance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER require_commerce_provider_storefront BEFORE INSERT ON commerce_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION require_commerce_storefront_instance();
ALTER TABLE commerce_provider_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_provider_accounts_tenant ON commerce_provider_accounts FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());
ALTER TABLE commerce_provider_account_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_provider_account_services_tenant ON commerce_provider_account_services FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());
ALTER TABLE commerce_provider_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_provider_credentials_tenant ON commerce_provider_credentials FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());

-- Machine routing contains identifiers only, no credential/token plaintext or
-- PII. It resolves the tenant before a machine transaction can bind tenant RLS.
CREATE TABLE commerce_entry_routes (
  route_kind text NOT NULL CHECK(route_kind IN ('provider_account','payment_handoff','cvs_map','cvs_map_return','label_print')),
  route_key text NOT NULL,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz CHECK(expires_at IS NULL OR expires_at>=created_at),
  revoked_at timestamptz CHECK(revoked_at IS NULL OR revoked_at>=created_at),
  PRIMARY KEY(route_kind,route_key),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  CHECK((route_kind='provider_account' AND route_key ~ '^[0-9a-hjkmnp-tv-z]{26}$' AND expires_at IS NULL)
    OR (route_kind<>'provider_account' AND route_key ~ '^[a-f0-9]{64}$'))
);
CREATE UNIQUE INDEX commerce_entry_provider_target ON commerce_entry_routes(route_kind,target_id) WHERE route_kind='provider_account';
CREATE INDEX commerce_entry_routes_store ON commerce_entry_routes(tenant_id,instance_id);
CREATE INDEX commerce_entry_routes_expiry ON commerce_entry_routes(expires_at) WHERE revoked_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX commerce_entry_payment_handoff_target ON commerce_entry_routes(target_id,created_at) WHERE route_kind='payment_handoff';
CREATE FUNCTION preserve_commerce_entry_route() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'entry routes start unrevoked' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'commerce entry routes are retained' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_entry_route BEFORE INSERT OR UPDATE OR DELETE ON commerce_entry_routes
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_entry_route();

-- Independent platform admission is a non-PII control decision, read before
-- tenant context is known on public checkout. It does not verify a payment.
CREATE TABLE commerce_store_admissions (
  admission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('sandbox','live')),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  admitted_by uuid NOT NULL REFERENCES platform_admins(admin_id),
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 500 AND char_length(btrim(reason))>0),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES platform_admins(admin_id),
  revoke_reason text CHECK(revoke_reason IS NULL OR (char_length(revoke_reason) BETWEEN 1 AND 500 AND char_length(btrim(revoke_reason))>0)),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL AND revoked_at>=admitted_at))
);
CREATE UNIQUE INDEX commerce_store_admissions_one_active ON commerce_store_admissions(instance_id,environment) WHERE revoked_at IS NULL;
CREATE INDEX commerce_store_admissions_tenant ON commerce_store_admissions(tenant_id,instance_id,admitted_at DESC,admission_id DESC);
CREATE INDEX commerce_store_admissions_admitted_by ON commerce_store_admissions(admitted_by);
CREATE INDEX commerce_store_admissions_revoked_by ON commerce_store_admissions(revoked_by) WHERE revoked_by IS NOT NULL;
CREATE TRIGGER require_commerce_admission_storefront BEFORE INSERT ON commerce_store_admissions
  FOR EACH ROW EXECUTE FUNCTION require_commerce_storefront_instance();
CREATE FUNCTION preserve_commerce_store_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'admissions start unrevoked' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revoke_reason'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revoke_reason'])
    OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'store admissions and revocations are retained' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_store_admission BEFORE INSERT OR UPDATE OR DELETE ON commerce_store_admissions
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_store_admission();

-- Composite targets retain merchant and order provenance even for machine
-- callers, which resolve these non-PII rows before binding tenant RLS.
ALTER TABLE commerce_provider_accounts ADD CONSTRAINT commerce_provider_account_payment_identity
  UNIQUE(account_id,tenant_id,instance_id,environment,merchant_id);
ALTER TABLE commerce_checkout_orders ADD CONSTRAINT commerce_checkout_order_payment_identity
  UNIQUE(order_id,tenant_id,instance_id,environment);
CREATE TABLE commerce_payment_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('order','service_activation')),
  order_id uuid,
  sequence integer NOT NULL CHECK(sequence>=1),
  account_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'payment' CHECK(purpose='payment'),
  environment text NOT NULL CHECK(environment IN ('sandbox','live')),
  merchant_id text NOT NULL,
  credential_version integer NOT NULL,
  provider text NOT NULL DEFAULT 'ecpay' CHECK(provider='ecpay'),
  profile text NOT NULL DEFAULT 'ecpay.aio.credit.v1' CHECK(profile='ecpay.aio.credit.v1'),
  merchant_trade_no text NOT NULL CHECK(merchant_trade_no ~ '^F[0-9A-HJKMNP-TV-Z]{19}$'),
  amount_minor bigint NOT NULL CHECK(amount_minor>=500 AND amount_minor<=99999999900 AND amount_minor%100=0),
  currency text NOT NULL CHECK(currency='TWD'),
  state text NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','paid','confirmed','failed','superseded','expired_unpaid')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  journaled_at timestamptz CHECK(journaled_at IS NULL OR journaled_at>=created_at),
  handed_off_at timestamptz CHECK(handed_off_at IS NULL OR (journaled_at IS NOT NULL AND handed_off_at>=journaled_at)),
  paid_at timestamptz CHECK(paid_at IS NULL OR paid_at>=created_at),
  confirmed_at timestamptz CHECK(confirmed_at IS NULL OR (paid_at IS NOT NULL AND confirmed_at>=paid_at)),
  failed_at timestamptz CHECK(failed_at IS NULL OR failed_at>=created_at),
  superseded_at timestamptz CHECK(superseded_at IS NULL OR superseded_at>=created_at),
  expired_at timestamptz CHECK(expired_at IS NULL OR expired_at>=created_at),
  trade_no text CHECK(trade_no ~ '^[0-9A-Z]{1,20}$'),
  payment_date timestamptz,
  payment_type text CHECK(payment_type ~ '^[A-Za-z0-9_]{1,40}$'),
  charge_fee_minor bigint CHECK(charge_fee_minor>=0),
  gwsr text CHECK(gwsr ~ '^[0-9]{1,20}$'),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  -- QueryTradeInfo can prove payment without returning PaymentDate.
  CHECK(state NOT IN ('paid','confirmed') OR trade_no IS NOT NULL),
  CHECK((kind='order' AND order_id IS NOT NULL AND sequence<=5) OR (kind='service_activation' AND order_id IS NULL)),
  FOREIGN KEY(account_id,tenant_id,instance_id,environment,merchant_id)
    REFERENCES commerce_provider_accounts(account_id,tenant_id,instance_id,environment,merchant_id),
  FOREIGN KEY(account_id,purpose,credential_version)
    REFERENCES commerce_provider_credentials(account_id,purpose,credential_version),
  FOREIGN KEY(order_id,tenant_id,instance_id,environment)
    REFERENCES commerce_checkout_orders(order_id,tenant_id,instance_id,environment),
  UNIQUE(order_id,sequence),
  UNIQUE(provider,environment,merchant_id,merchant_trade_no),
  UNIQUE(attempt_id,account_id,tenant_id,instance_id)
);
CREATE UNIQUE INDEX commerce_payment_activation_sequence ON commerce_payment_attempts(account_id,sequence) WHERE kind='service_activation';
-- Re-pay supersedes the previous issued attempt before inserting its successor.
CREATE UNIQUE INDEX commerce_payment_attempt_one_issued_order ON commerce_payment_attempts(order_id) WHERE kind='order' AND state='issued';
CREATE INDEX commerce_payment_attempt_account_trade ON commerce_payment_attempts(account_id,merchant_trade_no);
CREATE INDEX commerce_payment_attempt_account_identity ON commerce_payment_attempts(account_id,tenant_id,instance_id,environment,merchant_id);
CREATE INDEX commerce_payment_attempt_credential ON commerce_payment_attempts(account_id,purpose,credential_version);
CREATE INDEX commerce_payment_attempt_store ON commerce_payment_attempts(tenant_id,instance_id);
CREATE FUNCTION preserve_commerce_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text; transition_field text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payment attempts are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'issued' OR NEW.version<>1 OR NEW.journaled_at IS NOT NULL OR NEW.handed_off_at IS NOT NULL
      OR NEW.paid_at IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.failed_at IS NOT NULL
      OR NEW.superseded_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.trade_no IS NOT NULL
      OR NEW.payment_date IS NOT NULL OR NEW.payment_type IS NOT NULL OR NEW.charge_fee_minor IS NOT NULL OR NEW.gwsr IS NOT NULL THEN
      RAISE EXCEPTION 'payment attempts start issued without provider facts' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','journaled_at','handed_off_at','paid_at','confirmed_at','failed_at','superseded_at','expired_at',
      'trade_no','payment_date','payment_type','charge_fee_minor','gwsr','version'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','journaled_at','handed_off_at','paid_at','confirmed_at','failed_at','superseded_at','expired_at',
      'trade_no','payment_date','payment_type','charge_fee_minor','gwsr','version']) OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'payment attempt identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state='issued' AND NEW.state IN ('paid','failed','superseded','expired_unpaid'))
      OR (OLD.state='superseded' AND NEW.state IN ('paid','failed','expired_unpaid'))
      OR (OLD.state IN ('failed','expired_unpaid') AND NEW.state='paid') OR (OLD.state='paid' AND NEW.state='confirmed')) THEN
      RAISE EXCEPTION 'invalid payment attempt transition' USING ERRCODE='23514';
    END IF;
    transition_field=CASE NEW.state WHEN 'expired_unpaid' THEN 'expired_at' ELSE NEW.state||'_at' END;
    IF to_jsonb(NEW)->>transition_field IS NULL THEN
      RAISE EXCEPTION 'payment transition requires its timestamp' USING ERRCODE='23514';
    END IF;
  END IF;
  FOREACH field IN ARRAY ARRAY['journaled_at','handed_off_at','paid_at','confirmed_at','failed_at','superseded_at','expired_at',
      'trade_no','payment_date','payment_type','charge_fee_minor','gwsr'] LOOP
    IF to_jsonb(OLD)->>field IS NOT NULL AND (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) THEN
      RAISE EXCEPTION 'payment facts are set once' USING ERRCODE='23514';
    END IF;
    IF field IN ('paid_at','confirmed_at','failed_at','superseded_at','expired_at')
      AND (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) AND field IS DISTINCT FROM transition_field THEN
      RAISE EXCEPTION 'payment timestamp requires its transition' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_payment_attempt BEFORE INSERT OR UPDATE OR DELETE ON commerce_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_payment_attempt();

CREATE TABLE commerce_hosted_payment_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  account_id uuid NOT NULL,
  attempt_id uuid,
  source text NOT NULL CHECK(source IN ('notification','query','browser_return')),
  outcome text NOT NULL,
  merchant_trade_no text CHECK(merchant_trade_no ~ '^[0-9A-Z]{1,20}$'),
  trade_no text CHECK(trade_no ~ '^[0-9A-Z]{1,20}$'),
  -- The protocol accepts signed 10-digit integers, beyond PostgreSQL int4.
  rtn_code bigint,
  simulate_paid boolean,
  payment_date timestamptz,
  payment_type text CHECK(payment_type ~ '^[A-Za-z0-9_]{1,40}$'),
  trade_amt_minor bigint CHECK(trade_amt_minor>=0 AND trade_amt_minor<=99999999900),
  charge_fee_minor bigint CHECK(charge_fee_minor>=0),
  trade_status text CHECK(trade_status ~ '^[0-9]{1,10}$'),
  handling_charge_minor bigint CHECK(handling_charge_minor>=0),
  unknown_reason text CHECK(unknown_reason IN ('missing_field','invalid_field','unrecognized_status')),
  unknown_field text CHECK(unknown_field ~ '^[A-Za-z]{1,40}$'),
  query_trigger text CHECK(query_trigger IN ('schedule','window_end','notification','browser_return','buyer','seller','repay','activation')),
  gwsr text CHECK(gwsr ~ '^[0-9]{1,20}$'),
  credential_version integer,
  body_sha256 text CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
  dedupe_key text CHECK(dedupe_key ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz CHECK(applied_at IS NULL OR applied_at>=received_at),
  CHECK(outcome<>'paid' OR (trade_no IS NOT NULL AND trade_amt_minor IS NOT NULL
    AND (source<>'notification' OR payment_date IS NOT NULL))),
  CHECK((source='notification' AND outcome IN ('paid','failed','pending_confirmation','simulated') AND dedupe_key IS NOT NULL)
    OR (source='query' AND outcome IN ('paid','unpaid','failed','amount_mismatch','trade_no_mismatch','unknown') AND dedupe_key IS NULL)
    OR (source='browser_return' AND outcome='returned' AND dedupe_key IS NULL)),
  CHECK(source='query' OR (trade_status IS NULL AND handling_charge_minor IS NULL AND unknown_reason IS NULL AND unknown_field IS NULL AND query_trigger IS NULL)),
  CHECK((query_trigger IS NOT NULL)=(source='query')),
  CHECK((unknown_reason IS NOT NULL)=(outcome='unknown')),
  CHECK(unknown_field IS NULL OR (unknown_reason IS NOT NULL AND unknown_reason IN ('missing_field','invalid_field'))),
  -- Unknown parser results have no keyIndex, even when their MAC was verified.
  CHECK(source<>'query' OR (outcome='unknown' AND credential_version IS NULL) OR (outcome<>'unknown' AND credential_version IS NOT NULL)),
  FOREIGN KEY(account_id) REFERENCES commerce_provider_accounts(account_id),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  -- Inbox insertion precedes order/attempt locks. Deferring this FK avoids
  -- taking an attempt KEY SHARE lock before that documented lock position.
  FOREIGN KEY(attempt_id,account_id,tenant_id,instance_id)
    REFERENCES commerce_payment_attempts(attempt_id,account_id,tenant_id,instance_id) DEFERRABLE INITIALLY DEFERRED
);
-- Account provenance is also enforced for unmatched events, which have no attempt.
CREATE FUNCTION check_commerce_hosted_payment_events_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM commerce_provider_accounts a WHERE a.account_id=NEW.account_id
    AND a.tenant_id=NEW.tenant_id AND a.instance_id=NEW.instance_id) THEN
    RAISE EXCEPTION 'payment event account binding is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.credential_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commerce_provider_credentials c
    WHERE c.account_id=NEW.account_id AND c.purpose='payment' AND c.credential_version=NEW.credential_version) THEN
    RAISE EXCEPTION 'payment event credential binding is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_commerce_hosted_payment_events_account BEFORE INSERT ON commerce_hosted_payment_events
  FOR EACH ROW EXECUTE FUNCTION check_commerce_hosted_payment_events_account();
CREATE UNIQUE INDEX commerce_hosted_payment_events_dedupe ON commerce_hosted_payment_events(account_id,dedupe_key) WHERE dedupe_key IS NOT NULL;
-- A browser return is only an existence hint, retained once per attempt.
CREATE UNIQUE INDEX commerce_hosted_payment_events_browser_return ON commerce_hosted_payment_events(attempt_id) WHERE source='browser_return';
CREATE INDEX commerce_hosted_payment_events_account ON commerce_hosted_payment_events(account_id,received_at,event_id);
CREATE INDEX commerce_hosted_payment_events_attempt ON commerce_hosted_payment_events(attempt_id,received_at,event_id);
CREATE INDEX commerce_hosted_payment_events_store ON commerce_hosted_payment_events(tenant_id,instance_id);
CREATE INDEX commerce_hosted_payment_events_unapplied ON commerce_hosted_payment_events(received_at,event_id) WHERE source IN ('notification','query') AND applied_at IS NULL;
CREATE FUNCTION preserve_commerce_hosted_payment_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'applied_at') IS DISTINCT FROM (to_jsonb(OLD)-'applied_at')
    OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at) THEN
    RAISE EXCEPTION 'payment events are append only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_hosted_payment_events BEFORE UPDATE OR DELETE ON commerce_hosted_payment_events
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_hosted_payment_events();

-- Non-PII cross-tenant scheduling index. Executors lease/delete completed rows;
-- kind and target identify work, not authority to perform a provider operation.
CREATE TABLE commerce_due_work (
  due_work_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('payment_query','payment_window_end','email')),
  target_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  -- Calls and consecutive inconclusive runs are separate counters.
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  last_query_at timestamptz,
  last_error text CHECK(last_error IN ('timeout','network','response_too_large','http_status','http_403',
    'verify_failed','merchant_mismatch','merchant_trade_no_mismatch','platform_mismatch',
    'keyring_unavailable','credential_unavailable','throttled','tenant_inactive','environment_mismatch','internal')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  UNIQUE(kind,target_id)
);
CREATE INDEX commerce_due_work_claim ON commerce_due_work(due_at,due_work_id);
CREATE INDEX commerce_due_work_store ON commerce_due_work(tenant_id,instance_id);

CREATE TABLE commerce_outbound_emails (
  email_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  order_id uuid NOT NULL REFERENCES commerce_checkout_orders(order_id),
  template text NOT NULL CHECK(template IN ('order_confirmed','paid_unallocatable','order_access')),
  application_id uuid REFERENCES commerce_checkout_payment_applications(application_id),
  access_request_id uuid,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sent','suppressed','expired','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  last_error text CHECK(last_error ~ '^[a-z0-9_]{1,64}$'),
  journaled_at timestamptz,
  sent_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  UNIQUE(application_id,template),
  UNIQUE(access_request_id),
  CHECK((template IN ('order_confirmed','paid_unallocatable') AND application_id IS NOT NULL AND access_request_id IS NULL)
    OR (template='order_access' AND application_id IS NULL AND access_request_id IS NOT NULL)),
  CHECK(expires_at=created_at+interval '7 days'),
  CHECK((state='sent')=(sent_at IS NOT NULL)),
  CHECK(state<>'sent' OR journaled_at IS NOT NULL)
);
CREATE INDEX commerce_outbound_emails_store ON commerce_outbound_emails(tenant_id,instance_id);
CREATE INDEX commerce_outbound_emails_order ON commerce_outbound_emails(order_id);
CREATE INDEX commerce_outbound_emails_retention ON commerce_outbound_emails(state,updated_at);
CREATE FUNCTION preserve_commerce_outbound_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'queued' OR NEW.attempts<>0 OR NEW.journaled_at IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.last_error IS NOT NULL THEN
      RAISE EXCEPTION 'outbound emails start queued without delivery facts' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM commerce_checkout_orders o WHERE o.order_id=NEW.order_id
      AND o.tenant_id=NEW.tenant_id AND o.instance_id=NEW.instance_id) THEN
      RAISE EXCEPTION 'outbound email order binding is invalid' USING ERRCODE='23514';
    END IF;
    IF NEW.application_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commerce_checkout_payment_applications a
      WHERE a.application_id=NEW.application_id AND a.order_id=NEW.order_id) THEN
      RAISE EXCEPTION 'outbound email application binding is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state<>'queued'
      OR (to_jsonb(NEW)-ARRAY['state','attempts','last_error','journaled_at','sent_at','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempts','last_error','journaled_at','sent_at','updated_at'])
      OR (OLD.journaled_at IS NOT NULL AND NEW.journaled_at IS DISTINCT FROM OLD.journaled_at) THEN
      RAISE EXCEPTION 'outbound email identity and closed state are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='queued' OR OLD.updated_at>clock_timestamp()-interval '45 days' THEN
    RAISE EXCEPTION 'outbound emails are retained until 45 days after closure' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER preserve_commerce_outbound_email BEFORE INSERT OR UPDATE OR DELETE ON commerce_outbound_emails
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_outbound_email();

CREATE TABLE commerce_exception_cases (
  case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  order_id uuid REFERENCES commerce_checkout_orders(order_id),
  kind text NOT NULL CHECK(kind IN ('unmatched_payment','amount_mismatch','paid_unallocatable','paid_after_cancel','overpaid','payment_unconfirmed','contradicting_event')),
  subject_kind text NOT NULL CHECK(subject_kind IN ('payment_attempt','payment_event')),
  subject_id uuid NOT NULL,
  responsible_party text NOT NULL CHECK(responsible_party IN ('retailer','executor','buyer')),
  executor_tenant_id uuid REFERENCES tenants(tenant_id),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
  due_at timestamptz NOT NULL,
  resolution_code text CHECK(resolution_code ~ '^[a-z0-9_]{1,64}$'),
  resolution_note text CHECK(char_length(resolution_note)<=1000),
  opened_by_kind text NOT NULL CHECK(opened_by_kind IN ('system','person')),
  opened_by_principal_id uuid REFERENCES principals(principal_id),
  resolved_by_principal_id uuid REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  CHECK((opened_by_kind='system' AND opened_by_principal_id IS NULL) OR (opened_by_kind='person' AND opened_by_principal_id IS NOT NULL)),
  CHECK((status='open' AND resolution_code IS NULL AND resolution_note IS NULL AND resolved_by_principal_id IS NULL)
    OR (status IN ('resolved','dismissed') AND resolution_code IS NOT NULL AND resolution_note IS NOT NULL AND resolved_by_principal_id IS NOT NULL))
);
CREATE UNIQUE INDEX commerce_exception_case_open ON commerce_exception_cases(kind,subject_kind,subject_id) WHERE status='open';
CREATE INDEX commerce_exception_case_store ON commerce_exception_cases(tenant_id,instance_id,status,due_at,case_id);
CREATE INDEX commerce_exception_case_store_closed ON commerce_exception_cases(tenant_id,instance_id,updated_at,case_id) WHERE status<>'open';
CREATE INDEX commerce_exception_case_order ON commerce_exception_cases(order_id);
CREATE INDEX commerce_exception_case_executor ON commerce_exception_cases(executor_tenant_id);
CREATE INDEX commerce_exception_case_opener ON commerce_exception_cases(opened_by_principal_id);
CREATE INDEX commerce_exception_case_resolver ON commerce_exception_cases(resolved_by_principal_id);
CREATE FUNCTION preserve_commerce_exception_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'open' OR NEW.version<>1 THEN RAISE EXCEPTION 'exception cases start open' USING ERRCODE='23514'; END IF;
    IF NEW.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commerce_checkout_orders o WHERE o.order_id=NEW.order_id
      AND o.tenant_id=NEW.tenant_id AND o.instance_id=NEW.instance_id) THEN
      RAISE EXCEPTION 'exception case order binding is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR OLD.status<>'open' OR NEW.status NOT IN ('resolved','dismissed')
    OR (to_jsonb(NEW)-ARRAY['status','resolution_code','resolution_note','resolved_by_principal_id','updated_at','version'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolution_code','resolution_note','resolved_by_principal_id','updated_at','version'])
    OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'exception case identity and closing are retained' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_exception_case BEFORE INSERT OR UPDATE OR DELETE ON commerce_exception_cases
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_exception_case();
ALTER TABLE commerce_exception_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_exception_cases_tenant ON commerce_exception_cases FOR ALL TO PUBLIC
  USING(tenant_id=freedom_ctx_tenant()) WITH CHECK(tenant_id=freedom_ctx_tenant());

-- Manual records of money never applied to an order. These non-PII ledgers are
-- machine-readable before tenant binding; participant authority lives in APIs.
CREATE TABLE commerce_refunds (
  refund_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  order_id uuid NOT NULL REFERENCES commerce_checkout_orders(order_id),
  application_id uuid NOT NULL,
  attempt_id uuid NOT NULL REFERENCES commerce_payment_attempts(attempt_id),
  basis text NOT NULL CHECK(basis='unapplied_payment'),
  mode text NOT NULL CHECK(mode='manual_record'),
  state text NOT NULL CHECK(state='recorded'),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  refunded_on date NOT NULL,
  provider_reference text CHECK(provider_reference ~ '^[A-Za-z0-9_-]{1,64}$'),
  recorded_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK(version=1),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES module_instances(tenant_id,instance_id),
  FOREIGN KEY(application_id,order_id) REFERENCES commerce_checkout_payment_applications(application_id,order_id)
);
CREATE INDEX commerce_refund_store ON commerce_refunds(tenant_id,instance_id);
CREATE INDEX commerce_refund_order ON commerce_refunds(order_id,created_at,refund_id);
CREATE INDEX commerce_refund_application ON commerce_refunds(application_id,order_id);
CREATE INDEX commerce_refund_attempt ON commerce_refunds(attempt_id);
CREATE INDEX commerce_refund_recorder ON commerce_refunds(recorded_by_principal_id);
CREATE TABLE commerce_refund_lines (
  refund_id uuid NOT NULL REFERENCES commerce_refunds(refund_id),
  line_no smallint NOT NULL CHECK(line_no>=1),
  kind text NOT NULL CHECK(kind='unapplied'),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  PRIMARY KEY(refund_id,line_no)
);
CREATE FUNCTION preserve_commerce_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE application commerce_checkout_payment_applications%ROWTYPE; target commerce_checkout_orders%ROWTYPE; refunded numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'refund ledger is append only' USING ERRCODE='23514';
  END IF;
  SELECT * INTO application FROM commerce_checkout_payment_applications WHERE application_id=NEW.application_id FOR UPDATE;
  SELECT * INTO target FROM commerce_checkout_orders WHERE order_id=NEW.order_id;
  IF application.application_id IS NULL OR target.order_id IS NULL
    OR application.order_id<>NEW.order_id OR target.tenant_id<>NEW.tenant_id OR target.instance_id<>NEW.instance_id
    OR application.payment_ref<>NEW.attempt_id OR application.outcome NOT IN ('overpaid','after_cancel','amount_mismatch')
    OR application.currency<>NEW.currency THEN
    RAISE EXCEPTION 'refund payment binding is invalid' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(sum(amount_minor),0) INTO refunded FROM commerce_refunds WHERE application_id=NEW.application_id AND state<>'failed';
  IF refunded+NEW.amount_minor>application.amount_minor THEN
    RAISE EXCEPTION 'refund exceeds payment' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_refund BEFORE INSERT OR UPDATE OR DELETE ON commerce_refunds
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_refund();
CREATE FUNCTION preserve_commerce_refund_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'refund lines are append only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER preserve_commerce_refund_line BEFORE UPDATE OR DELETE ON commerce_refund_lines
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_refund_line();
CREATE FUNCTION check_commerce_refund_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; target bigint; count_lines bigint;
BEGIN
  SELECT amount_minor INTO target FROM commerce_refunds WHERE refund_id=NEW.refund_id;
  SELECT count(*),coalesce(sum(amount_minor),0) INTO count_lines,total FROM commerce_refund_lines WHERE refund_id=NEW.refund_id;
  IF count_lines=0 OR total<>target THEN
    RAISE EXCEPTION 'refund lines must equal refund amount' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER commerce_refund_lines_balance AFTER INSERT ON commerce_refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_refund_lines();
CREATE CONSTRAINT TRIGGER commerce_refund_line_balance AFTER INSERT ON commerce_refund_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_refund_lines();
CREATE INDEX commerce_checkout_order_store_recent ON commerce_orders(public_shop_id,created_at,order_id) WHERE order_profile='hosted_checkout';
