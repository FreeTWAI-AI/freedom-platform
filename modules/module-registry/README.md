# Module registry

Tenant manual Work is enabled here. The registry owns `module_instances`, `deployment_bindings`, `workspace_module_bindings`, and the operator-owned `tenant_capacity_policies` table. It does not own Work rows or Result bytes.

`enableManualWork` binds a workspace to one `work` instance at `work:create`. An existing binding is returned unchanged. A reuse choice that names a different instance is a conflict. When the tenant already has active `work` instances and the caller sends no choice, the command fails with `instance_selection_required` and does not store a receipt. `{kind:'create_new'}` still creates an instance, under the capacity policy. `{kind:'reuse', instance_id, expected_version}` binds that active `work` instance when the version matches.

Constants for this slice: `application_release_ref` `manual-workspace@1.0.0`, `data_schema_version` `1`, `contract_ref` null, deployment `hosted` / `hosted-shared` / `active`.

Capacity limits are read from `tenant_capacity_policies`. No migration seeds a row. A missing active row rejects enablement and other writes with `policy_unconfigured`. Reads keep working. Runtime SQL may `SELECT` and `UPDATE (policy_lock)` only. `policy_lock` is the generated constant `0`, so that update is a lock privilege, not a way to change a limit.

Guild full membership gates enablement only. The caller needs an active `member_tier='full'` row for the named catalog key in the tenant's community. Any full guild qualifies. Interns do not. Work commands do not repeat the guild check.
