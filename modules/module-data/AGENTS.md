# Module data notes

- The catalog is the coverage list. It is not authorization and it does not grant a read.
- Add a physical location when a new tenant column, tenant foreign key, tenant scope check, or tenant asset purpose appears. Do not mark retention `forever`, `needed`, or `analytics`.
- Purpose detection reads only `pg_get_constraintdef` of `asset_scope_purpose`, the `scope_kind = 'tenant'` branch.
- Do not enable row security on the exempt asset tables. Maintenance has to see every asset row.
- Do not enable row security on `tenant_authority_policies` or `platform_admin_tenant_recovery_capabilities` unless a tenant column or a tenant foreign key appears.
- Do not add `FORCE ROW LEVEL SECURITY`. The runtime role is already subject to row security because it does not own the tables.
