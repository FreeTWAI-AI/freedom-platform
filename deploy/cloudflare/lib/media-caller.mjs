import {planIsolatedCandidate} from './isolated-candidate.mjs';
/** Add-on only; does not alter the foundation two-Worker profile or activate jobs. */
export function planMediaOperatorCaller(request,manifest){
 const report=(errors,extra={})=>({schema:'freedom.media-operator-caller-admission/v1',status:errors.length?'invalid':'unavailable',structural:errors.length===0,
   deployment_authority:false,execution_authority:false,provider_mutations:0,database_connections:0,remote_acceptance:'not_run',errors,...extra});
 if(!request||Object.keys(request).length!==4||!['schema','foundation','callerName','storeBindingId'].every(key=>Object.hasOwn(request,key))||request.schema!=='freedom.media-operator-caller-request/v1')return report(['closed_caller_request_required']);
 const base=planIsolatedCandidate(request.foundation,manifest);
 if(!base.structural||base.profile!=='foundation-media'||typeof request.callerName!=='string'||!/^fp-base-candidate-[a-z0-9-]{1,35}-caller$/.test(request.callerName)||
  Object.values(request.foundation.workers).includes(request.callerName)||typeof request.storeBindingId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.storeBindingId))return report(['caller_installation_invalid']);
 return report([],{
  blockers:base.blockers,
  config:{name:request.callerName,main:'apps/media-operator-caller/src/worker.ts',compatibility_date:'2026-09-21',compatibility_flags:['nodejs_compat'],
   workers_dev:false,preview_urls:false,routes:[],triggers:{crons:[]},
   services:[{binding:'MEDIA_OPERATOR',service:request.foundation.workers.operator,entrypoint:'MediaOperator'}],
   vars:{FREEDOM_MEDIA_CALLER_ENABLED:'false',FREEDOM_MEDIA_CALLER_ENVIRONMENT:'staging',FREEDOM_MEDIA_CALLER_RELEASE_SHA:request.foundation.releaseSha,FREEDOM_MEDIA_CALLER_STORE_BINDING_ID:request.storeBindingId}},
  remaining_checks:['approved_private_binding_installation_and_account_permissions','provider_binding_identity_readback','operator_cache_off_and_physical_branch','exact_installed_plan_and_current_sql_approval','separately_approved_schedule_and_activation','remote_rpc_acceptance'].map(check_id=>({check_id,status:'not_run'}))
 });
}
