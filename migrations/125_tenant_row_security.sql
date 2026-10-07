-- Tenant row security is a second line of defence, not authorization.
-- Membership, capability and target checks stay in application code.
--
-- Trust model. Transaction-local settings freedom.principal_id,
-- freedom.tenant_id and freedom.tenant_scope_id are written only by
-- isolatedTransaction helpers with set_config(name, value, true). A fourth
-- setting, freedom.platform_admin_id, is written only after the application
-- has accepted an admin session and an unrevoked recovery capability. It is
-- not a tenant selector: the recovery read policy that uses it is off unless
-- the setting is present, and it admits rows only while no tenant is bound.
-- The settings are not authentication: any code that can run arbitrary SQL
-- as the runtime role can set them. Missing or empty settings read as NULL,
-- and every policy below is false for NULL, so a request with no bound
-- context sees no tenant row. The reader functions are invoker SQL, with no
-- function-level setting, so the planner can inline them. This migration
-- does not force row security: the runtime role is not the table owner, so
-- enabling it already applies to that role. Forcing it would also subject
-- the migrator, reviewed definer functions, and owner-run evidence.
--
-- Enabled tables: tenants, tenant_memberships, tenant_invitations,
-- workspaces, tenant_authority_audit, module_instances, deployment_bindings,
-- workspace_module_bindings, tenant_work_results, tenant_work_result_targets,
-- tenant_capacity_policies (the NULL row is the platform default),
-- work_items (personal and community rows keep a NULL tenant), the scoped
-- receipt, journal and outbox (only scope_kind tenant is hidden),
-- tenant_high_risk_verifications, tenant_ownership_transfers and
-- tenant_recovery_cases.
--
-- Exempt: assets, asset_upload_intents, asset_objects (maintenance must see
-- every asset row; tenant bytes stay on scoped queries, composite keys and
-- the purpose allow-list), resource_scopes (scope identity), users, sessions,
-- principals, and every community table with no tenant column.
-- tenant_authority_policies and platform_admin_tenant_recovery_capabilities
-- have no tenant column and are not enabled here. No other table is enabled.

CREATE FUNCTION freedom_ctx_principal() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(pg_catalog.current_setting('freedom.principal_id', true), '')::uuid
$$;
CREATE FUNCTION freedom_ctx_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(pg_catalog.current_setting('freedom.tenant_id', true), '')::uuid
$$;
CREATE FUNCTION freedom_ctx_tenant_scope() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(pg_catalog.current_setting('freedom.tenant_scope_id', true), '')::uuid
$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_tenant ON tenants FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());
CREATE POLICY tenants_principal_read ON tenants FOR SELECT TO PUBLIC
  USING (
    freedom_ctx_tenant() IS NULL
    AND freedom_ctx_principal() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM tenant_memberships AS m
        WHERE m.tenant_id = tenants.tenant_id AND m.principal_id = freedom_ctx_principal()
      )
      OR EXISTS (
        SELECT 1 FROM tenant_invitations AS i
        WHERE i.tenant_id = tenants.tenant_id AND i.invitee_principal_id = freedom_ctx_principal()
      )
    )
  );

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_memberships_tenant ON tenant_memberships FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());
CREATE POLICY tenant_memberships_principal_read ON tenant_memberships FOR SELECT TO PUBLIC
  USING (freedom_ctx_tenant() IS NULL AND principal_id = freedom_ctx_principal());

ALTER TABLE tenant_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_invitations_tenant ON tenant_invitations FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());
CREATE POLICY tenant_invitations_invitee_read ON tenant_invitations FOR SELECT TO PUBLIC
  USING (freedom_ctx_tenant() IS NULL AND invitee_principal_id = freedom_ctx_principal());
CREATE POLICY tenant_invitations_invitee_expire ON tenant_invitations FOR UPDATE TO PUBLIC
  USING (freedom_ctx_tenant() IS NULL AND invitee_principal_id = freedom_ctx_principal())
  WITH CHECK (
    freedom_ctx_tenant() IS NULL
    AND invitee_principal_id = freedom_ctx_principal()
    AND state = 'expired'
  );

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspaces_tenant ON workspaces FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());
CREATE POLICY workspaces_principal_read ON workspaces FOR SELECT TO PUBLIC
  USING (
    freedom_ctx_tenant() IS NULL
    AND freedom_ctx_principal() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM tenant_memberships AS m
      WHERE m.tenant_id = workspaces.tenant_id
        AND m.principal_id = freedom_ctx_principal()
        AND m.status = 'active'
    )
  );

ALTER TABLE tenant_authority_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_authority_audit_tenant ON tenant_authority_audit FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE module_instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_instances_tenant ON module_instances FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE deployment_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY deployment_bindings_tenant ON deployment_bindings FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE workspace_module_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_module_bindings_tenant ON workspace_module_bindings FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE tenant_work_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_work_results_tenant ON tenant_work_results FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE tenant_work_result_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_work_result_targets_tenant ON tenant_work_result_targets FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE tenant_capacity_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_capacity_policies_tenant ON tenant_capacity_policies FOR ALL TO PUBLIC
  USING (tenant_id IS NULL OR tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id IS NULL OR tenant_id = freedom_ctx_tenant());

ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_items_tenant ON work_items FOR ALL TO PUBLIC
  USING (tenant_id IS NULL OR tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id IS NULL OR tenant_id = freedom_ctx_tenant());

ALTER TABLE scoped_command_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY scoped_command_receipts_tenant_scope ON scoped_command_receipts FOR ALL TO PUBLIC
  USING (scope_kind <> 'tenant' OR scope_id = freedom_ctx_tenant_scope())
  WITH CHECK (scope_kind <> 'tenant' OR scope_id = freedom_ctx_tenant_scope());

ALTER TABLE scoped_transition_journal ENABLE ROW LEVEL SECURITY;
CREATE POLICY scoped_transition_journal_tenant_scope ON scoped_transition_journal FOR ALL TO PUBLIC
  USING (scope_kind <> 'tenant' OR scope_id = freedom_ctx_tenant_scope())
  WITH CHECK (scope_kind <> 'tenant' OR scope_id = freedom_ctx_tenant_scope());

ALTER TABLE scoped_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY scoped_outbox_tenant_scope ON scoped_outbox FOR ALL TO PUBLIC
  USING (scope_kind <> 'tenant' OR scope_id = freedom_ctx_tenant_scope())
  WITH CHECK (scope_kind <> 'tenant' OR scope_id = freedom_ctx_tenant_scope());

-- Recovery case-id routes peek the tenant with this setting, then bind that
-- tenant. The setting alone is not enough: the policy also requires a live
-- capability row, and it is silent once a tenant context is bound.
CREATE FUNCTION freedom_ctx_platform_admin() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(pg_catalog.current_setting('freedom.platform_admin_id', true), '')::uuid
$$;

ALTER TABLE tenant_high_risk_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_high_risk_verifications_tenant ON tenant_high_risk_verifications FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());

ALTER TABLE tenant_ownership_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_ownership_transfers_tenant ON tenant_ownership_transfers FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());
CREATE POLICY tenant_ownership_transfers_recipient_read ON tenant_ownership_transfers FOR SELECT TO PUBLIC
  USING (freedom_ctx_tenant() IS NULL AND to_principal_id = freedom_ctx_principal());
CREATE POLICY tenant_ownership_transfers_recipient_expire ON tenant_ownership_transfers FOR UPDATE TO PUBLIC
  USING (
    freedom_ctx_tenant() IS NULL
    AND to_principal_id = freedom_ctx_principal()
    AND state = 'pending'
  )
  WITH CHECK (
    freedom_ctx_tenant() IS NULL
    AND to_principal_id = freedom_ctx_principal()
    AND state = 'expired'
  );
CREATE POLICY tenant_ownership_transfers_principal_invalidate ON tenant_ownership_transfers FOR UPDATE TO PUBLIC
  USING (
    freedom_ctx_tenant() IS NULL
    AND freedom_ctx_principal() IS NOT NULL
    AND state = 'pending'
    AND (from_principal_id = freedom_ctx_principal() OR to_principal_id = freedom_ctx_principal())
  )
  WITH CHECK (
    freedom_ctx_tenant() IS NULL
    AND freedom_ctx_principal() IS NOT NULL
    AND state = 'invalidated'
    AND (from_principal_id = freedom_ctx_principal() OR to_principal_id = freedom_ctx_principal())
  );

ALTER TABLE tenant_recovery_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_recovery_cases_tenant ON tenant_recovery_cases FOR ALL TO PUBLIC
  USING (tenant_id = freedom_ctx_tenant())
  WITH CHECK (tenant_id = freedom_ctx_tenant());
CREATE POLICY tenant_recovery_cases_proposed_owner_read ON tenant_recovery_cases FOR SELECT TO PUBLIC
  USING (freedom_ctx_tenant() IS NULL AND proposed_owner_principal_id = freedom_ctx_principal());
CREATE POLICY tenant_recovery_cases_platform_admin_read ON tenant_recovery_cases FOR SELECT TO PUBLIC
  USING (
    freedom_ctx_tenant() IS NULL
    AND freedom_ctx_platform_admin() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM platform_admin_tenant_recovery_capabilities AS c
      WHERE c.admin_id = freedom_ctx_platform_admin() AND c.revoked_at IS NULL
    )
  );

-- A transfer recipient or proposed owner may not be a member. The display
-- name join can see that one tenant and no other. It does not widen the
-- member policy.
CREATE POLICY tenants_counterparty_read ON tenants FOR SELECT TO PUBLIC
  USING (
    freedom_ctx_tenant() IS NULL
    AND freedom_ctx_principal() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM tenant_ownership_transfers AS tr
        WHERE tr.tenant_id = tenants.tenant_id AND tr.to_principal_id = freedom_ctx_principal()
      )
      OR EXISTS (
        SELECT 1 FROM tenant_recovery_cases AS rc
        WHERE rc.tenant_id = tenants.tenant_id AND rc.proposed_owner_principal_id = freedom_ctx_principal()
      )
    )
  );
