-- Ordinary per-instance member grants. Export/purpose-bound grants remain closed.
CREATE TABLE tenant_module_permissions (
  permission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  capabilities text[] NOT NULL,
  purpose text,
  expires_at timestamptz,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  granted_by_principal_id uuid NOT NULL REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT tenant_module_permissions_membership FOREIGN KEY (tenant_id, principal_id)
    REFERENCES tenant_memberships(tenant_id, principal_id),
  CONSTRAINT tenant_module_permissions_instance FOREIGN KEY (tenant_id, instance_id)
    REFERENCES module_instances(tenant_id, instance_id),
  CONSTRAINT tenant_module_permissions_ordinary CHECK (purpose IS NULL AND expires_at IS NULL),
  CONSTRAINT tenant_module_permissions_capabilities CHECK (
    cardinality(capabilities) BETWEEN 1 AND 100
    AND array_position(capabilities, NULL) IS NULL
    AND array_to_string(capabilities, '') !~ ','
    AND array_to_string(capabilities, ',') ~ '^[a-z][a-z0-9_.:-]{0,159}(,[a-z][a-z0-9_.:-]{0,159})*$'
    AND NOT (capabilities && ARRAY['module.data.export', 'module.authority.transfer', 'module.binding.manage',
      'tenant.ownership.transfer', 'instance.manage']::text[])),
  CONSTRAINT tenant_module_permissions_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX tenant_module_permissions_one_ordinary
  ON tenant_module_permissions(tenant_id, principal_id, instance_id) WHERE purpose IS NULL;

ALTER TABLE tenant_module_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_module_permissions_tenant ON tenant_module_permissions FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant()) WITH CHECK (tenant_id = freedom_ctx_tenant());

-- Grant validation relies on the instance's registered module release remaining fixed.
CREATE OR REPLACE FUNCTION preserve_module_instance_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Module instance identity is retained' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.instance_id, NEW.tenant_id, NEW.module_key, NEW.application_release_ref, NEW.created_by_principal_id, NEW.origin_guild_key, NEW.created_at, NEW.module_release_ref)
    IS DISTINCT FROM ROW(OLD.instance_id, OLD.tenant_id, OLD.module_key, OLD.application_release_ref, OLD.created_by_principal_id, OLD.origin_guild_key, OLD.created_at, OLD.module_release_ref) THEN
    RAISE EXCEPTION 'Module instance identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
