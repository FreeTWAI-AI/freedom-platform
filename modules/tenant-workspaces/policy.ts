import type { PoolClient } from 'pg';
import { Problem } from '../../packages/shared/problem.js';

export interface AuthorityPolicy {
  fresh_auth_ttl_seconds: number;
  transfer_ttl_seconds: number;
  recovery_approval_ttl_seconds: number;
  max_open_recovery_cases_per_tenant: number;
}

/** Operator policy. Absence is policy_unconfigured, not a guessed default. */
export async function loadActivePolicy(q: PoolClient): Promise<AuthorityPolicy> {
  const row = (await q.query<AuthorityPolicy>(`SELECT fresh_auth_ttl_seconds, transfer_ttl_seconds,
    recovery_approval_ttl_seconds, max_open_recovery_cases_per_tenant
    FROM tenant_authority_policies WHERE status='active' FOR SHARE`)).rows[0];
  if (!row) throw new Problem(403, 'policy_unconfigured', '業務空間權限政策尚未設定。');
  return row;
}
