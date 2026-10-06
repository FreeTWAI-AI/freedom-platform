import type { PoolClient } from 'pg';
import { PrincipalRefSchema, ResourceScopeRefSchema } from '../../contracts/common/v1/identity.js';
import type { MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { PRIVATE_TEXT_MAX_BYTES } from '../../packages/asset-storage/index.js';
import type { LifecyclePolicy } from '../assets/engine.js';

const unavailable = () => requireCondition(false, 503, 'private_work_policy_unavailable', '私人內容政策暫時無法使用。');
const positiveBigint = (value: unknown): value is string => typeof value === 'string'
  && /^[1-9][0-9]{0,18}$(?![\s\S])/.test(value) && BigInt(value) <= 9223372036854775807n;

/** Operator-configured DB source, shared by closed human Work and Result
 * services. This is NOT authentication or a standalone target ACL. Caller must
 * already hold current member/session/principal/personal-scope and Work/Asset
 * locks on this SAME transaction; refresh the current session DB clock after
 * this query and every later blocking query before replay/return/effect.
 *
 * No caller policy/purpose, environment defaults, provider or external I/O.
 * Policy writers must lock policy only, never reverse-acquire Work/Asset locks.
 * The resulting frozen value is an in-process policy snapshot, not authority.
 */
export async function resolvePrivateWorkPersistencePolicy(q: PoolClient, context: MemberScopeContext): Promise<LifecyclePolicy> {
  const principal = PrincipalRefSchema.safeParse(context?.subject_principal);
  const scope = ResourceScopeRefSchema.safeParse(context?.scope);
  if (context?.authn_kind !== 'member_session' || !principal.success || principal.data.kind !== 'person'
    || !scope.success || scope.data.kind !== 'personal') unavailable();
  return readLockedPrivateWorkPersistencePolicy(q,principal.data!.principal_id,scope.data!.scope_id);
}

/** Internal DB lookup only, not authentication or a target ACL. Authenticated
 * adapters must hold exact owner/scope/domain locks and recheck their clock. */
export async function readLockedPrivateWorkPersistencePolicy(q:PoolClient,principalId:string,scopeId:string):Promise<LifecyclePolicy>{
  let row: { revision: string; persistence_allowed: boolean; retained_byte_limit: string | null } | undefined;
  try {
    row = (await q.query(`SELECT revision::text,persistence_allowed,retained_byte_limit::text
      FROM private_work_persistence_policy
      WHERE scope_id=$1 AND owner_principal_id=$2 AND purpose='work.private-draft' FOR SHARE`,
    [scopeId,principalId])).rows[0];
  } catch { unavailable(); }
  if (!row || row.persistence_allowed !== true || !positiveBigint(row.revision)
    || !positiveBigint(row.retained_byte_limit) || BigInt(row.retained_byte_limit) < BigInt(PRIVATE_TEXT_MAX_BYTES)) unavailable();
  return Object.freeze({ revision: `private-work.v${row!.revision}`, platformPersistenceAllowed: true,
    retainedByteLimit: row!.retained_byte_limit! });
}
