# Module data

This module owns the tenant data-responsibility catalog and the checker that compares it with an installed schema. It does not expose an HTTP route, and it does not delete, export, or restore tenant rows.

`catalog.ts` freezes catalog version `1` for the datasets tenant data touches today: DC-04, DC-06, DC-13 and DC-14. DC-04 also registers `tenant_high_risk_verifications`, `tenant_ownership_transfers` and `tenant_recovery_cases`. `tenant_authority_policies` and `platform_admin_tenant_recovery_capabilities` have no tenant column and stay without row security. `catalog-check.ts` reads `pg_catalog` and reports a sorted finding when a tenant-bearing table, column, policy, asset purpose, or unbounded retention string is missing or stale. Retention stays `policy_undecided` until OPEN-07 (and OPEN-05 for receipt windows) names a duration. Row security is enabled without `FORCE` (OPEN-14).
