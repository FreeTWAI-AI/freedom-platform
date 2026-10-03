import type { PoolClient } from 'pg';
import type { MemberScopeContext } from '../../packages/resource-scopes/index.js';
import type { ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import { ModelSelectionSchema, MemberExecutionVersionSchema } from '../../contracts/execution/v1/member-execution.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { freezeTree } from '../../packages/execution-state/decode.js';

export interface InferenceExportPolicy {
  readonly policyId: string; readonly revision: string; readonly selection: ModelSelection;
  readonly maxPromptBytes: number; readonly maxOutputTokens: number;
}
/** DB-only operator policy, separate from persistence and member consent.
 * Caller holds current member/backing/Step locks in this same transaction.
 * The snapshot alone is never a dispatch permit. Absent policy always denies. */
export async function resolveInferenceExportPolicy(q: PoolClient, context: MemberScopeContext,
  environment: string, clientId: string, selection: ModelSelection): Promise<InferenceExportPolicy> {
  const row = (await q.query<{ policy_id:string; revision:string; export_allowed:boolean; selection:ModelSelection;
    max_prompt_bytes:number; max_output_tokens:number }>(`SELECT policy_id,revision::text,export_allowed,selection,max_prompt_bytes,max_output_tokens
    FROM model_inference_export_policy WHERE scope_id=$1 AND owner_principal_id=$2 AND purpose='model.private-draft'
    AND environment=$3 AND client_id=$4 AND selection=$5::jsonb FOR SHARE`,
  [context.scope.scope_id,context.subject_principal.principal_id,environment,clientId,JSON.stringify(selection)])).rows[0];
  requireCondition(context.authn_kind==='member_session' && context.scope.kind==='personal' && row?.export_allowed===true
    && MemberExecutionVersionSchema.safeParse(row.revision).success && ModelSelectionSchema.safeParse(row.selection).success
    && Number.isInteger(row.max_prompt_bytes) && row.max_prompt_bytes>=1 && row.max_prompt_bytes<=16384
    && Number.isInteger(row.max_output_tokens) && row.max_output_tokens>=1 && row.max_output_tokens<=4096,
  403,'model_export_policy_denied','目前政策不允許匯出模型輸入。');
  return freezeTree({policyId:row.policy_id,revision:row.revision,selection:row.selection,
    maxPromptBytes:row.max_prompt_bytes,maxOutputTokens:row.max_output_tokens});
}
