-- Ownership transfer, fresh verification, and controlled recovery.
-- Expand only. No seed policy, no capability grants, no privilege changes.
-- plpgsql is the existing trusted language.

CREATE TABLE tenant_high_risk_verifications (
  verification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id),
  principal_id uuid NOT NULL,
  principal_kind text NOT NULL DEFAULT 'person' CHECK (principal_kind = 'person'),
  session_hash text NOT NULL REFERENCES sessions(token_hash),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  purpose text NOT NULL CHECK (purpose IN ('tenant.ownership.propose','tenant.ownership.accept','tenant.recovery.accept')),
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > verified_at),
  consumed_at timestamptz,
  consumed_by text CHECK (consumed_by IS NULL OR consumed_by ~ '^[0-9a-f]{64}$'),
  CHECK ((consumed_at IS NULL) = (consumed_by IS NULL)),
  FOREIGN KEY (principal_id, principal_kind) REFERENCES principals(principal_id, kind)
);
CREATE INDEX tenant_high_risk_verifications_by_session ON tenant_high_risk_verifications (session_hash) WHERE consumed_at IS NULL;

CREATE FUNCTION preserve_tenant_high_risk_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'high-risk verification cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.consumed_by IS NOT NULL THEN
      RAISE EXCEPTION 'high-risk verification must start unconsumed' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM principals p
      WHERE p.principal_id = NEW.principal_id AND p.kind = 'person' AND p.user_ref = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'high-risk verification principal does not match the user' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.consumed_by IS NULL THEN
    RAISE EXCEPTION 'high-risk verification can be consumed only once' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.verification_id, NEW.user_id, NEW.principal_id, NEW.principal_kind, NEW.session_hash, NEW.tenant_id, NEW.purpose, NEW.verified_at, NEW.expires_at)
    IS DISTINCT FROM
    ROW(OLD.verification_id, OLD.user_id, OLD.principal_id, OLD.principal_kind, OLD.session_hash, OLD.tenant_id, OLD.purpose, OLD.verified_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'high-risk verification identity is frozen' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_tenant_high_risk_verification
  BEFORE INSERT OR UPDATE OR DELETE ON tenant_high_risk_verifications
  FOR EACH ROW EXECUTE FUNCTION preserve_tenant_high_risk_verification();

-- Operator-owned. The migration seeds no row: values are an operator decision.
-- policy_lock exists only so the runtime role can take FOR SHARE.
CREATE TABLE tenant_authority_policies (
  policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision bigint NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('active','retired')),
  fresh_auth_ttl_seconds integer NOT NULL CHECK (fresh_auth_ttl_seconds BETWEEN 60 AND 3600),
  transfer_ttl_seconds integer NOT NULL CHECK (transfer_ttl_seconds BETWEEN 300 AND 604800),
  recovery_approval_ttl_seconds integer NOT NULL CHECK (recovery_approval_ttl_seconds BETWEEN 300 AND 604800),
  max_open_recovery_cases_per_tenant integer NOT NULL CHECK (max_open_recovery_cases_per_tenant BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  policy_lock integer GENERATED ALWAYS AS (0) STORED
);
CREATE UNIQUE INDEX tenant_authority_policies_one_active ON tenant_authority_policies (status) WHERE status = 'active';

CREATE FUNCTION preserve_tenant_authority_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenant authority policy cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.policy_id IS NOT DISTINCT FROM OLD.policy_id
    AND NEW.revision IS NOT DISTINCT FROM OLD.revision
    AND NEW.fresh_auth_ttl_seconds IS NOT DISTINCT FROM OLD.fresh_auth_ttl_seconds
    AND NEW.transfer_ttl_seconds IS NOT DISTINCT FROM OLD.transfer_ttl_seconds
    AND NEW.recovery_approval_ttl_seconds IS NOT DISTINCT FROM OLD.recovery_approval_ttl_seconds
    AND NEW.max_open_recovery_cases_per_tenant IS NOT DISTINCT FROM OLD.max_open_recovery_cases_per_tenant
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'retired'
    AND NEW.policy_id IS NOT DISTINCT FROM OLD.policy_id
    AND NEW.revision IS NOT DISTINCT FROM OLD.revision
    AND NEW.fresh_auth_ttl_seconds IS NOT DISTINCT FROM OLD.fresh_auth_ttl_seconds
    AND NEW.transfer_ttl_seconds IS NOT DISTINCT FROM OLD.transfer_ttl_seconds
    AND NEW.recovery_approval_ttl_seconds IS NOT DISTINCT FROM OLD.recovery_approval_ttl_seconds
    AND NEW.max_open_recovery_cases_per_tenant IS NOT DISTINCT FROM OLD.max_open_recovery_cases_per_tenant
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tenant authority policy is frozen' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER preserve_tenant_authority_policy
  BEFORE UPDATE OR DELETE ON tenant_authority_policies
  FOR EACH ROW EXECUTE FUNCTION preserve_tenant_authority_policy();

CREATE TABLE tenant_ownership_transfers (
  transfer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  from_principal_id uuid NOT NULL,
  from_principal_kind text NOT NULL DEFAULT 'person' CHECK (from_principal_kind = 'person'),
  to_principal_id uuid NOT NULL,
  to_principal_kind text NOT NULL DEFAULT 'person' CHECK (to_principal_kind = 'person'),
  from_role_after text NOT NULL CHECK (from_role_after IN ('admin','operator','viewer','revoked')),
  state text NOT NULL CHECK (state IN ('pending','accepted','declined','cancelled','expired','invalidated')),
  expires_at timestamptz NOT NULL,
  tenant_authorization_revision bigint NOT NULL CHECK (tenant_authorization_revision > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  accepted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_principal_id <> from_principal_id),
  CHECK ((decided_at IS NULL) = (state = 'pending')),
  CHECK ((accepted_at IS NULL) = (state <> 'accepted')),
  FOREIGN KEY (from_principal_id, from_principal_kind) REFERENCES principals(principal_id, kind),
  FOREIGN KEY (to_principal_id, to_principal_kind) REFERENCES principals(principal_id, kind),
  FOREIGN KEY (tenant_id, from_principal_id) REFERENCES tenant_memberships(tenant_id, principal_id)
);
CREATE UNIQUE INDEX tenant_ownership_transfers_one_pending ON tenant_ownership_transfers (tenant_id) WHERE state = 'pending';
CREATE INDEX tenant_ownership_transfers_by_recipient ON tenant_ownership_transfers (to_principal_id, transfer_id);

CREATE FUNCTION preserve_tenant_ownership_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  community uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenant ownership transfer cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.decided_at IS NOT NULL OR NEW.accepted_at IS NOT NULL OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'tenant ownership transfer must start pending' USING ERRCODE = '23514';
    END IF;
    SELECT t.community_id INTO community FROM tenants t WHERE t.tenant_id = NEW.tenant_id;
    IF community IS NULL THEN
      RAISE EXCEPTION 'tenant ownership transfer tenant is missing' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM principals p JOIN users u ON u.user_id = p.user_ref
      WHERE p.principal_id = NEW.from_principal_id AND p.kind = 'person' AND p.status = 'active'
        AND u.active AND u.community_id = community
    ) OR NOT EXISTS (
      SELECT 1 FROM principals p JOIN users u ON u.user_id = p.user_ref
      WHERE p.principal_id = NEW.to_principal_id AND p.kind = 'person' AND p.status = 'active'
        AND u.active AND u.community_id = community
    ) THEN
      RAISE EXCEPTION 'tenant ownership transfer principals must be active people in the tenant community' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'pending' OR NEW.state NOT IN ('accepted','declined','cancelled','expired','invalidated') OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'tenant ownership transfer transition is illegal' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'tenant ownership transfer decision stamp is required' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.transfer_id, NEW.tenant_id, NEW.from_principal_id, NEW.from_principal_kind, NEW.to_principal_id, NEW.to_principal_kind, NEW.from_role_after, NEW.expires_at, NEW.tenant_authorization_revision, NEW.reason, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.transfer_id, OLD.tenant_id, OLD.from_principal_id, OLD.from_principal_kind, OLD.to_principal_id, OLD.to_principal_kind, OLD.from_role_after, OLD.expires_at, OLD.tenant_authorization_revision, OLD.reason, OLD.created_at) THEN
    RAISE EXCEPTION 'tenant ownership transfer identity is frozen' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_tenant_ownership_transfer
  BEFORE INSERT OR UPDATE OR DELETE ON tenant_ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION preserve_tenant_ownership_transfer();

-- opened stays in the check for the published enum. Commands insert evidence_required.
CREATE TABLE tenant_recovery_cases (
  case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  state text NOT NULL CHECK (state IN ('opened','evidence_required','approved','executed','denied','cancelled')),
  proposed_owner_principal_id uuid NOT NULL,
  proposed_owner_principal_kind text NOT NULL DEFAULT 'person' CHECK (proposed_owner_principal_kind = 'person'),
  approved_scope jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    approved_scope = '[]'::jsonb OR approved_scope = '["tenant.owner.restore"]'::jsonb),
  expires_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_ref uuid,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  evidence_ref uuid NOT NULL,
  opened_by_admin_id uuid NOT NULL REFERENCES platform_admins(admin_id),
  approved_by_admin_id uuid REFERENCES platform_admins(admin_id),
  executed_by_admin_id uuid REFERENCES platform_admins(admin_id),
  recipient_accepted_at timestamptz,
  closed_reason text CHECK (closed_reason IS NULL OR char_length(closed_reason) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (proposed_owner_principal_id, proposed_owner_principal_kind) REFERENCES principals(principal_id, kind),
  CHECK (
    (state IN ('opened','evidence_required') AND approved_by_admin_id IS NULL AND executed_by_admin_id IS NULL AND closed_reason IS NULL AND expires_at IS NULL AND approved_scope = '[]'::jsonb)
    OR (state = 'approved' AND approved_by_admin_id IS NOT NULL AND executed_by_admin_id IS NULL AND closed_reason IS NULL AND expires_at IS NOT NULL AND approved_scope = '["tenant.owner.restore"]'::jsonb)
    OR (state = 'executed' AND approved_by_admin_id IS NOT NULL AND executed_by_admin_id IS NOT NULL AND closed_reason IS NULL AND expires_at IS NOT NULL AND approved_scope = '["tenant.owner.restore"]'::jsonb)
    OR (state IN ('denied','cancelled') AND executed_by_admin_id IS NULL AND closed_reason IS NOT NULL
      AND ((approved_by_admin_id IS NULL AND approved_scope = '[]'::jsonb AND expires_at IS NULL)
        OR (approved_by_admin_id IS NOT NULL AND approved_scope = '["tenant.owner.restore"]'::jsonb AND expires_at IS NOT NULL)))
  ),
  CONSTRAINT tenant_recovery_cases_approver_distinct CHECK (
    approved_by_admin_id IS NULL OR approved_by_admin_id <> opened_by_admin_id),
  CONSTRAINT tenant_recovery_cases_executor_distinct CHECK (
    executed_by_admin_id IS NULL OR (
      approved_by_admin_id IS NOT NULL
      AND executed_by_admin_id <> approved_by_admin_id
      AND executed_by_admin_id <> opened_by_admin_id))
);
CREATE INDEX tenant_recovery_cases_by_tenant ON tenant_recovery_cases (tenant_id, case_id);
CREATE INDEX tenant_recovery_cases_by_owner ON tenant_recovery_cases (proposed_owner_principal_id, case_id);

CREATE FUNCTION preserve_tenant_recovery_case() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  community uuid;
  acceptance_only boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenant recovery case cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'evidence_required' OR NEW.version <> 1 OR NEW.approved_by_admin_id IS NOT NULL
      OR NEW.executed_by_admin_id IS NOT NULL OR NEW.recipient_accepted_at IS NOT NULL OR NEW.closed_reason IS NOT NULL THEN
      RAISE EXCEPTION 'tenant recovery case must start at evidence_required' USING ERRCODE = '23514';
    END IF;
    SELECT t.community_id INTO community FROM tenants t WHERE t.tenant_id = NEW.tenant_id AND t.status = 'recovery_required';
    IF community IS NULL OR NOT EXISTS (
      SELECT 1 FROM principals p JOIN users u ON u.user_id = p.user_ref
      WHERE p.principal_id = NEW.proposed_owner_principal_id AND p.kind = 'person' AND p.status = 'active'
        AND u.active AND u.community_id = community
    ) THEN
      RAISE EXCEPTION 'tenant recovery case requires a recovery_required tenant and an active person in its community' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('executed','denied','cancelled') THEN
    RAISE EXCEPTION 'tenant recovery case is frozen' USING ERRCODE = '23514';
  END IF;
  acceptance_only := NEW.state = OLD.state AND OLD.recipient_accepted_at IS NULL AND NEW.recipient_accepted_at IS NOT NULL
    AND OLD.state IN ('evidence_required','approved');
  IF NOT acceptance_only AND NOT (
    (OLD.state = 'evidence_required' AND NEW.state IN ('approved','denied','cancelled'))
    OR (OLD.state = 'approved' AND NEW.state IN ('executed','denied','cancelled'))
  ) THEN
    RAISE EXCEPTION 'tenant recovery case transition is illegal' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'tenant recovery case version must increase by one' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.case_id, NEW.tenant_id, NEW.proposed_owner_principal_id, NEW.proposed_owner_principal_kind, NEW.reason, NEW.evidence_ref, NEW.opened_by_admin_id, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.case_id, OLD.tenant_id, OLD.proposed_owner_principal_id, OLD.proposed_owner_principal_kind, OLD.reason, OLD.evidence_ref, OLD.opened_by_admin_id, OLD.created_at) THEN
    RAISE EXCEPTION 'tenant recovery case identity is frozen' USING ERRCODE = '23514';
  END IF;
  IF acceptance_only AND (
    NEW.approved_scope IS DISTINCT FROM OLD.approved_scope
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.approved_by_admin_id IS DISTINCT FROM OLD.approved_by_admin_id
    OR NEW.executed_by_admin_id IS DISTINCT FROM OLD.executed_by_admin_id
    OR NEW.closed_reason IS DISTINCT FROM OLD.closed_reason
    OR NEW.audit_ref IS DISTINCT FROM OLD.audit_ref
  ) THEN
    RAISE EXCEPTION 'tenant recovery acceptance cannot change the case' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_tenant_recovery_case
  BEFORE INSERT OR UPDATE OR DELETE ON tenant_recovery_cases
  FOR EACH ROW EXECUTE FUNCTION preserve_tenant_recovery_case();

-- No API and no seed. Operators grant rows through the prod-admin procedure.
-- capability_lock exists only so the runtime role can take FOR SHARE.
CREATE TABLE platform_admin_tenant_recovery_capabilities (
  capability_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES platform_admins(admin_id),
  capability text NOT NULL CHECK (capability IN ('tenant.recovery.open','tenant.recovery.review','tenant.recovery.execute','tenant.recovery.read')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  capability_lock integer GENERATED ALWAYS AS (0) STORED
);
CREATE UNIQUE INDEX platform_admin_tenant_recovery_capabilities_active
  ON platform_admin_tenant_recovery_capabilities (admin_id, capability) WHERE revoked_at IS NULL;

CREATE FUNCTION preserve_tenant_recovery_capability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenant recovery capability cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.capability_id IS NOT DISTINCT FROM OLD.capability_id
    AND NEW.admin_id IS NOT DISTINCT FROM OLD.admin_id
    AND NEW.capability IS NOT DISTINCT FROM OLD.capability
    AND NEW.granted_at IS NOT DISTINCT FROM OLD.granted_at
    AND NEW.revoked_at IS NOT DISTINCT FROM OLD.revoked_at THEN
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
    AND NEW.capability_id IS NOT DISTINCT FROM OLD.capability_id
    AND NEW.admin_id IS NOT DISTINCT FROM OLD.admin_id
    AND NEW.capability IS NOT DISTINCT FROM OLD.capability
    AND NEW.granted_at IS NOT DISTINCT FROM OLD.granted_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tenant recovery capability is frozen' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER preserve_tenant_recovery_capability
  BEFORE UPDATE OR DELETE ON platform_admin_tenant_recovery_capabilities
  FOR EACH ROW EXECUTE FUNCTION preserve_tenant_recovery_capability();
