-- Real existing commerce-shop service backing. No data backfill, token rotation,
-- legacy environment inference, policy activation or old receipt rewrite.
ALTER TABLE principals
 ADD COLUMN service_shop_ref uuid UNIQUE REFERENCES commerce_shops(shop_id),
 ALTER COLUMN user_ref DROP NOT NULL,
 DROP CONSTRAINT principals_kind_check,
 ADD CONSTRAINT principal_backing_shape CHECK (
  (kind='person' AND user_ref IS NOT NULL AND service_shop_ref IS NULL)
  OR (kind='service' AND user_ref IS NULL AND service_shop_ref IS NOT NULL)),
 ADD CONSTRAINT principal_shop_identity UNIQUE(principal_id,kind,service_shop_ref);

-- Preserve the personal-owner columns and their existing generated-person FK.
ALTER TABLE resource_scopes
 ADD COLUMN site_shop_ref uuid UNIQUE REFERENCES commerce_shops(shop_id),
 ADD COLUMN service_principal_id uuid UNIQUE,
 ADD COLUMN service_principal_kind text GENERATED ALWAYS AS (CASE WHEN kind='site' THEN 'service' END) STORED,
 DROP CONSTRAINT resource_scopes_kind_check,
 DROP CONSTRAINT resource_scopes_check,
 ADD CONSTRAINT resource_scope_backing_shape CHECK (
  (kind='community' AND community_ref IS NOT NULL AND owner_principal_id IS NULL AND site_shop_ref IS NULL AND service_principal_id IS NULL)
  OR (kind='personal' AND community_ref IS NULL AND owner_principal_id IS NOT NULL AND site_shop_ref IS NULL AND service_principal_id IS NULL)
  OR (kind='site' AND community_ref IS NULL AND owner_principal_id IS NULL AND site_shop_ref IS NOT NULL AND service_principal_id IS NOT NULL)),
 ADD CONSTRAINT site_service_backing FOREIGN KEY(service_principal_id,service_principal_kind,site_shop_ref)
  REFERENCES principals(principal_id,kind,service_shop_ref),
 ADD CONSTRAINT scope_site_identity UNIQUE(scope_id,kind,service_principal_id);

CREATE OR REPLACE FUNCTION preserve_principal_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Disable principal mappings instead of deleting them' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.principal_id,NEW.kind,NEW.user_ref,NEW.service_shop_ref,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.principal_id,OLD.kind,OLD.user_ref,OLD.service_shop_ref,OLD.created_at) THEN
  RAISE EXCEPTION 'Principal identity mapping is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION preserve_resource_scope_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Disable resource scope mappings instead of deleting them' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.scope_id,NEW.kind,NEW.owner_principal_id,NEW.community_ref,NEW.site_shop_ref,NEW.service_principal_id,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.scope_id,OLD.kind,OLD.owner_principal_id,OLD.community_ref,OLD.site_shop_ref,OLD.service_principal_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Resource scope identity mapping is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

ALTER TABLE commerce_shop_keys
 ADD COLUMN credential_id uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN credential_profile text NOT NULL DEFAULT 'legacy-shop-key/v1',
 ADD COLUMN purpose text,
 ADD COLUMN issuer text,
 ADD COLUMN audience text,
 ADD COLUMN environment text,
 ADD CONSTRAINT shop_key_credential_id UNIQUE(credential_id),
 ADD CONSTRAINT shop_key_binding_shape CHECK (
  (credential_profile='legacy-shop-key/v1' AND purpose IS NULL AND issuer IS NULL AND audience IS NULL AND environment IS NULL)
  OR (credential_profile='freedom.shop-service-key/v1' AND purpose='shop-api'
   AND purpose IS NOT NULL AND issuer IS NOT NULL AND audience IS NOT NULL AND environment IS NOT NULL
   AND length(issuer) BETWEEN 8 AND 2048
   AND audience=issuer||'/shop-api/v1' AND environment IN ('local','staging','public')));
-- Preserve 117's exact execution-token branch and composite authorization FK.
-- Missing 117 columns/constraints fail the migration instead of skipping it.
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['scoped_command_receipts','scoped_transition_journal'] LOOP
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I, DROP CONSTRAINT %I, DROP CONSTRAINT %I',
   relation,relation||'_principal_kind_check',relation||'_scope_kind_check',relation||'_authn_binding');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (
   (authn_kind=''member_session'' AND principal_kind=''person'' AND scope_kind IN (''personal'',''community'')
    AND execution_authorization_id IS NULL AND execution_attempt_id IS NULL AND execution_grant_id IS NULL
    AND execution_runtime_device_id IS NULL AND execution_connection_id IS NULL)
   OR (authn_kind=''execution_token'' AND principal_kind=''person'' AND scope_kind=''personal''
    AND execution_authorization_id IS NOT NULL AND execution_attempt_id IS NOT NULL AND execution_grant_id IS NOT NULL
    AND execution_runtime_device_id IS NOT NULL AND execution_connection_id IS NOT NULL)
   OR (authn_kind=''shop_service_key'' AND principal_kind=''service'' AND scope_kind=''site''
    AND execution_authorization_id IS NULL AND execution_attempt_id IS NULL AND execution_grant_id IS NULL
    AND execution_runtime_device_id IS NULL AND execution_connection_id IS NULL))',relation,relation||'_authn_binding');
  EXECUTE format('ALTER TABLE %I ADD COLUMN site_service_principal_id uuid GENERATED ALWAYS AS
   (CASE WHEN scope_kind=''site'' THEN principal_id END) STORED,
   ADD CONSTRAINT %I FOREIGN KEY(scope_id,scope_kind,site_service_principal_id)
   REFERENCES resource_scopes(scope_id,kind,service_principal_id)',relation,relation||'_site_binding');
 END LOOP;
END $$;
ALTER TABLE scoped_outbox DROP CONSTRAINT scoped_outbox_scope_kind_check,
 ADD CONSTRAINT scoped_outbox_scope_kind_check CHECK(scope_kind IN ('personal','community','site'));
