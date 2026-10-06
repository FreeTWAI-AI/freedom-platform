-- Tenant workspaces: business boundary separate from user, community, and guild.
-- Personal and community scope rows stay unchanged. Tenant scopes are inserted
-- only by the tenant create command, never by a read-time mapping.
-- No privilege changes. plpgsql is the existing trusted language.

CREATE TABLE tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(community_id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120 AND octet_length(display_name) <= 480),
  public_slug text CHECK (
    public_slug IS NULL OR (
      char_length(public_slug) BETWEEN 3 AND 64
      AND public_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','recovery_required','archived')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  authorization_revision bigint NOT NULL DEFAULT 1 CHECK (authorization_revision > 0),
  created_by_principal_id uuid NOT NULL,
  created_by_principal_kind text NOT NULL DEFAULT 'person' CHECK (created_by_principal_kind = 'person'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (created_by_principal_id, created_by_principal_kind) REFERENCES principals(principal_id, kind)
);
CREATE UNIQUE INDEX tenants_public_slug_unique ON tenants (public_slug) WHERE public_slug IS NOT NULL;

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  principal_id uuid NOT NULL,
  principal_kind text NOT NULL DEFAULT 'person' CHECK (principal_kind = 'person'),
  role text NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id),
  FOREIGN KEY (principal_id, principal_kind) REFERENCES principals(principal_id, kind),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND accepted_at IS NOT NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX tenant_memberships_by_principal ON tenant_memberships (principal_id, tenant_id);

CREATE TABLE workspaces (
  workspace_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND octet_length(name) <= 480),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id)
);
CREATE UNIQUE INDEX workspaces_one_default ON workspaces (tenant_id) WHERE is_default;

CREATE TABLE tenant_invitations (
  invitation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  invitee_principal_id uuid NOT NULL,
  invitee_principal_kind text NOT NULL DEFAULT 'person' CHECK (invitee_principal_kind = 'person'),
  role text NOT NULL CHECK (role IN ('admin','operator','viewer')),
  instance_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(instance_capabilities) = 'array' AND octet_length(instance_capabilities::text) <= 8192),
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','accepted','declined','revoked','expired')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_principal_id uuid NOT NULL,
  created_by_principal_kind text NOT NULL DEFAULT 'person' CHECK (created_by_principal_kind = 'person'),
  revoked_reason text CHECK (revoked_reason IS NULL OR char_length(revoked_reason) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invitee_principal_id, invitee_principal_kind) REFERENCES principals(principal_id, kind),
  FOREIGN KEY (created_by_principal_id, created_by_principal_kind) REFERENCES principals(principal_id, kind)
);
CREATE UNIQUE INDEX tenant_invitations_one_pending ON tenant_invitations (tenant_id, invitee_principal_id) WHERE state = 'pending';
CREATE INDEX tenant_invitations_by_invitee ON tenant_invitations (invitee_principal_id, invitation_id);

CREATE TABLE tenant_authority_audit (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  actor_principal_id uuid NOT NULL,
  actor_principal_kind text NOT NULL DEFAULT 'person' CHECK (actor_principal_kind = 'person'),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,159}$'),
  target_principal_id uuid,
  old_revision bigint NOT NULL CHECK (old_revision > 0),
  new_revision bigint NOT NULL CHECK (new_revision > 0),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  proof_ref uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (actor_principal_id, actor_principal_kind) REFERENCES principals(principal_id, kind)
);
CREATE FUNCTION preserve_tenant_authority_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tenant authority audit is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER preserve_tenant_authority_audit
  BEFORE UPDATE OR DELETE ON tenant_authority_audit
  FOR EACH ROW EXECUTE FUNCTION preserve_tenant_authority_audit();

-- An active tenant always has at least one active owner. recovery_required,
-- suspended, and archived are the legal exceptions. Deferred so create can
-- insert the tenant and its owner in one transaction.
CREATE FUNCTION tenant_requires_active_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tid uuid;
  st text;
  owners integer;
BEGIN
  tid := COALESCE(NEW.tenant_id, OLD.tenant_id);
  -- Lock the tenant before counting. Two READ COMMITTED demotions must not
  -- each observe the other owner and both commit.
  SELECT status INTO st FROM tenants WHERE tenant_id = tid FOR NO KEY UPDATE;
  IF st = 'active' THEN
    SELECT count(*)::integer INTO owners FROM tenant_memberships
      WHERE tenant_id = tid AND role = 'owner' AND status = 'active';
    IF owners < 1 THEN
      RAISE EXCEPTION 'active tenant requires an active owner' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER tenant_active_owner_on_tenant
  AFTER INSERT OR UPDATE OF status ON tenants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tenant_requires_active_owner();
CREATE CONSTRAINT TRIGGER tenant_active_owner_on_membership
  AFTER INSERT OR UPDATE OR DELETE ON tenant_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tenant_requires_active_owner();

-- Extend resource scope backing. Drop and re-add only the shape check.
-- Personal, community, and site branches keep tenant_ref empty.
ALTER TABLE resource_scopes
  ADD COLUMN tenant_ref uuid UNIQUE REFERENCES tenants(tenant_id),
  DROP CONSTRAINT resource_scope_backing_shape,
  ADD CONSTRAINT resource_scope_backing_shape CHECK (
    (kind = 'community' AND community_ref IS NOT NULL AND owner_principal_id IS NULL AND site_shop_ref IS NULL AND service_principal_id IS NULL AND tenant_ref IS NULL)
    OR (kind = 'personal' AND community_ref IS NULL AND owner_principal_id IS NOT NULL AND site_shop_ref IS NULL AND service_principal_id IS NULL AND tenant_ref IS NULL)
    OR (kind = 'site' AND community_ref IS NULL AND owner_principal_id IS NULL AND site_shop_ref IS NOT NULL AND service_principal_id IS NOT NULL AND tenant_ref IS NULL)
    OR (kind = 'tenant' AND community_ref IS NULL AND owner_principal_id IS NULL AND site_shop_ref IS NULL AND service_principal_id IS NULL AND tenant_ref IS NOT NULL)),
  ADD CONSTRAINT scope_tenant_identity UNIQUE (scope_id, kind, tenant_ref);

CREATE OR REPLACE FUNCTION preserve_resource_scope_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Disable resource scope mappings instead of deleting them' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW.scope_id, NEW.kind, NEW.owner_principal_id, NEW.community_ref, NEW.site_shop_ref, NEW.service_principal_id, NEW.tenant_ref, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.scope_id, OLD.kind, OLD.owner_principal_id, OLD.community_ref, OLD.site_shop_ref, OLD.service_principal_id, OLD.tenant_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'Resource scope identity mapping is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Keep the three existing receipt/journal binding branches and add member_session person tenant.
-- Execution columns stay empty on the tenant branch. Do not drop the site binding columns.
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['scoped_command_receipts','scoped_transition_journal'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', relation, relation || '_authn_binding');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (
      (authn_kind=''member_session'' AND principal_kind=''person'' AND scope_kind IN (''personal'',''community'')
        AND execution_authorization_id IS NULL AND execution_attempt_id IS NULL AND execution_grant_id IS NULL
        AND execution_runtime_device_id IS NULL AND execution_connection_id IS NULL)
      OR (authn_kind=''execution_token'' AND principal_kind=''person'' AND scope_kind=''personal''
        AND execution_authorization_id IS NOT NULL AND execution_attempt_id IS NOT NULL AND execution_grant_id IS NOT NULL
        AND execution_runtime_device_id IS NOT NULL AND execution_connection_id IS NOT NULL)
      OR (authn_kind=''shop_service_key'' AND principal_kind=''service'' AND scope_kind=''site''
        AND execution_authorization_id IS NULL AND execution_attempt_id IS NULL AND execution_grant_id IS NULL
        AND execution_runtime_device_id IS NULL AND execution_connection_id IS NULL)
      OR (authn_kind=''member_session'' AND principal_kind=''person'' AND scope_kind=''tenant''
        AND execution_authorization_id IS NULL AND execution_attempt_id IS NULL AND execution_grant_id IS NULL
        AND execution_runtime_device_id IS NULL AND execution_connection_id IS NULL))', relation, relation || '_authn_binding');
  END LOOP;
END $$;

ALTER TABLE scoped_outbox DROP CONSTRAINT scoped_outbox_scope_kind_check,
  ADD CONSTRAINT scoped_outbox_scope_kind_check CHECK (scope_kind IN ('personal','community','site','tenant'));
