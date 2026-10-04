import {planOperatorBackfill} from '../../../packages/media-migration/operator-backfill.js';
import {parseBoundedJson} from '../../../packages/execution-state/decode.js';
interface CallerEnv {
 FREEDOM_MEDIA_CALLER_ENABLED?:string;
 FREEDOM_MEDIA_CALLER_ENVIRONMENT?:string;
 FREEDOM_MEDIA_CALLER_RELEASE_SHA?:string;
 FREEDOM_MEDIA_CALLER_STORE_BINDING_ID?:string;
 FREEDOM_MEDIA_CALLER_PLAN?:string;
 MEDIA_OPERATOR?:{execute(plan:unknown):Promise<unknown>};
}
const unavailable=()=>new Error('media_operator_caller_unavailable');
export default {
 fetch(){return new Response(null,{status:404});},
 async scheduled(_event:unknown,env:CallerEnv){
  if(env.FREEDOM_MEDIA_CALLER_ENABLED==='false'||env.FREEDOM_MEDIA_CALLER_ENABLED===undefined)return;
  try{
   if(env.FREEDOM_MEDIA_CALLER_ENABLED!=='true'||!env.FREEDOM_MEDIA_CALLER_PLAN||env.FREEDOM_MEDIA_CALLER_PLAN.length>8192||!env.MEDIA_OPERATOR||typeof env.MEDIA_OPERATOR.execute!=='function')throw unavailable();
   const raw=parseBoundedJson(env.FREEDOM_MEDIA_CALLER_PLAN);
   if(!raw||Object.getPrototypeOf(raw)!==null)throw unavailable();
   const {planSha256,...input}=raw as Record<string,unknown>,plan=planOperatorBackfill(input);
   const target=plan.target;
   if(planSha256!==plan.planSha256||!['staging','public'].includes(target.environment)||target.environment!==env.FREEDOM_MEDIA_CALLER_ENVIRONMENT||
     target.releaseSha!==env.FREEDOM_MEDIA_CALLER_RELEASE_SHA||plan.storeBindingId!==env.FREEDOM_MEDIA_CALLER_STORE_BINDING_ID||
     target.schema!=='public'||target.role!=='freedom_media_migrator'||target.database!==(target.environment==='staging'?'freedom_staging_next':'freedom_next'))throw unavailable();
   // Exactly one attempt per platform event, no retry or mutable plan authority.
   // The installed operator must recheck current DB approval/CAS/effect fences.
   await env.MEDIA_OPERATOR.execute(plan);
  }catch{throw unavailable();}
 }
};
