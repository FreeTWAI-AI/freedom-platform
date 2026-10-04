import type { Pool } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { MemberExecutionVersionSchema } from '../../contracts/execution/v1/member-execution.js';
import { PRIVATE_TEXT_MAX_BYTES } from '../../packages/asset-storage/index.js';
import { freezeTree } from '../../packages/execution-state/decode.js';
import { MemberModelHttpOverviewSchema } from '../../contracts/execution/v2/member-model-http.js';
import type { RuntimeEnvironment } from '../../contracts/execution/v1/runtime-registration.js';

/** Bounded discovery for the current member. SQL selects only public metadata;
 * no binding, observation, credential, prompt or object key enters this port. */
export async function readMemberModelOverview(pool: Pool, actor: Actor, environment: RuntimeEnvironment, clientId: string) {
  return withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{
    requireCondition((await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)',[actor.user_id])).rowCount===1,
      403,'onboarding_required','Complete onboarding.');
    // Distinguish an authoritative absent/withdrawn policy from a failed SQL
    // source. Metadata history/control remains available; private Work content
    // and export choices require the current persistence policy.
    let policy: {revision:string;persistence_allowed:boolean;retained_byte_limit:string}|undefined;
    try { policy=(await q.query(`SELECT revision::text,persistence_allowed,retained_byte_limit::text FROM private_work_persistence_policy
      WHERE scope_id=$1 AND owner_principal_id=$2 AND purpose='work.private-draft' FOR SHARE`,
      [context.scope.scope_id,context.subject_principal.principal_id])).rows[0]; }
    catch { throw new Problem(503,'member_model_http_unavailable','Policy source unavailable.'); }
    const persistenceAvailable=policy?.persistence_allowed===true && MemberExecutionVersionSchema.safeParse(policy.revision).success
      && MemberExecutionVersionSchema.safeParse(policy.retained_byte_limit).success && BigInt(policy.retained_byte_limit)>=BigInt(PRIVATE_TEXT_MAX_BYTES);
    const owners=[actor.user_id,context.subject_principal.principal_id,context.scope.scope_id];
    const owned='owner_user_id=$1 AND owner_principal_id=$2 AND scope_id=$3';
    const configured=owned+' AND environment=$4 AND client_id=$5';
    const configuration=[...owners,environment,clientId];
    const rows=async(sql:string,values:unknown[]) => {
      try { return (await q.query(sql,values)).rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))); }
      catch { throw new Problem(503,'member_model_http_unavailable','Metadata source unavailable.'); }
    };
    const works=persistenceAvailable?await rows(`SELECT work_item_id AS "workId",title,state,aggregate_version::text AS "aggregateVersion" FROM work_items
      WHERE owner_ref=$1 AND owner_principal_id=$2 AND scope_id=$3 AND work_mode='personal_execution' ORDER BY created_at DESC,work_item_id LIMIT 50`,owners):[];
    const runs=await rows(`SELECT run_id AS "runId",work_item_id AS "workId",input_work_version::text AS "inputWorkVersion",state,aggregate_version::text AS "aggregateVersion"
      FROM execution_runs WHERE ${owned} ORDER BY created_at DESC,run_id LIMIT 50`,owners);
    const connections=await rows(`SELECT connection_id AS "connectionId",runtime_device_id AS "runtimeDeviceId",state,aggregate_version::text AS "aggregateVersion",expires_at AS "expiresAt"
      FROM agent_connections WHERE ${configured} ORDER BY issued_at DESC,connection_id LIMIT 50`,configuration);
    const models=await rows(`SELECT model_connection_id AS "modelConnectionId",connection_id AS "connectionId",runtime_device_id AS "runtimeDeviceId",family_id AS "familyId",
      environment,client_id AS "clientId",selection,state,aggregate_version::text AS "aggregateVersion",created_at AS "createdAt",false AS operational_authority
      FROM model_connections WHERE ${configured} ORDER BY created_at DESC,model_connection_id LIMIT 50`,configuration);
    const grants=await rows(`SELECT grant_id AS "grantId",run_id AS "runId",work_item_id AS "workId",input_work_version::text AS "inputWorkVersion",run_version::text AS "runVersion",
      task_lease_epoch::text AS "taskLeaseEpoch",control_epoch::text AS "controlEpoch",connection_id AS "connectionId",connection_version::text AS "connectionVersion",
      runtime_device_id AS "runtimeDeviceId",family_id AS "familyId",model_connection_id AS "modelConnectionId",model_version::text AS "modelVersion",selection,
      persistence_policy_revision AS "policyRevision",state,aggregate_version::text AS "aggregateVersion",created_at AS "issuedAt",expires_at AS "expiresAt",purpose,false AS operational_authority
      FROM execution_grants WHERE ${configured} ORDER BY created_at DESC,grant_id LIMIT 50`,configuration);
    const approvals=await rows(`SELECT approval_id AS "approvalId",run_id AS "runId",work_item_id AS "workId",grant_id AS "grantId",input_work_version::text AS "inputWorkVersion",
      selection,export_policy_revision::text AS "exportPolicyRevision",max_output_tokens AS "maxOutputTokens",context_sha256 AS "contextSha256",input_byte_size AS "inputByteSize",
      aggregate_version::text AS "aggregateVersion",state,issued_at AS "issuedAt",expires_at AS "expiresAt",false AS operational_authority
      FROM model_export_approvals WHERE ${configured} ORDER BY issued_at DESC,approval_id LIMIT 50`,configuration);
    const steps=await rows(`SELECT s.step_id AS "stepId",s.attempt_id AS "attemptId",a.attempt_number AS "attemptNumber",s.run_id AS "runId",s.work_item_id AS "workId",
      s.binding->>'inputWorkVersion' AS "inputWorkVersion",s.approval_id AS "approvalId",s.state,s.aggregate_version::text AS "aggregateVersion",
      s.activated_run_version::text AS "activatedRunVersion",s.task_lease_epoch::text AS "taskLeaseEpoch",s.control_epoch::text AS "controlEpoch",s.binding->'selection' AS selection,
      s.evidence_origin AS "evidenceOrigin",s.lease_expires_at AS "expiresAt",s.usage_status AS "usageStatus",'unknown' AS "costStatus",false AS operational_authority
      FROM model_text_steps s JOIN execution_attempts a ON a.attempt_id=s.attempt_id
      WHERE s.owner_user_id=$1 AND s.owner_principal_id=$2 AND s.scope_id=$3 AND s.environment=$4 AND s.client_id=$5 ORDER BY s.created_at DESC,s.step_id LIMIT 50`,configuration);
    const allowedSelections=persistenceAvailable?await rows(`SELECT selection,max_output_tokens AS "maxOutputTokens" FROM model_inference_export_policy
      WHERE scope_id=$1 AND owner_principal_id=$2 AND environment=$3 AND client_id=$4 AND purpose='model.private-draft' AND export_allowed
      ORDER BY policy_id LIMIT 50 FOR SHARE`,[context.scope.scope_id,context.subject_principal.principal_id,environment,clientId]):[];
    // Refresh the real DB clock after all potentially waiting metadata queries.
    // The scope transaction still holds user/session/principal/scope locks.
    await assertCurrentSessionClock(q,actor);
    const dto=MemberModelHttpOverviewSchema.safeParse({works,runs,connections,models,grants,approvals,steps,allowedSelections,persistenceAvailable,configuration:"configured",limit:50,operational_authority:false});
    if(!dto.success) throw new Error('invalid_model_overview_metadata');
    return freezeTree(dto.data);
  });
}
