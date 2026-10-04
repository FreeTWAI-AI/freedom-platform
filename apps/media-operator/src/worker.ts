import {WorkerEntrypoint} from 'cloudflare:workers';
import {z} from 'zod';
import type {Pool} from 'pg';
import {createRequestPool} from '../../../packages/db/index.js';
import {parseBoundedJson} from '../../../packages/execution-state/decode.js';
import {validateInventoryTarget} from '../../../packages/media-migration/inventory.js';
import {planOperatorBackfill,createOperatorMediaBackfill} from '../../../packages/media-migration/operator-backfill.js';
import {createR2ObjectStore,type AssetR2Binding} from '../../../packages/asset-storage/r2.js';

export interface MediaOperatorBindings {
 FREEDOM_MEDIA_OPERATOR_ENABLED?:string;
 FREEDOM_MEDIA_OPERATOR_ENVIRONMENT?:string;
 FREEDOM_MEDIA_OPERATOR_RELEASE_SHA?:string;
 FREEDOM_MEDIA_OPERATOR_STORE_BINDING_ID?:string;
 FREEDOM_MEDIA_OPERATOR_PROFILE?:string;
 OPERATOR_HYPERDRIVE?:{connectionString:string};
 MEDIA?:AssetR2Binding;
}
const profileSchema=z.object({target:z.unknown(),logicalStore:z.literal('MEDIA'),storeBindingId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),purposes:z.array(z.enum(['member.service-cover','community.event-video','community.event-banner','community.social-thumbnail'])).min(1).max(4)}).strict();
const unavailable=()=>new Error('operator_media_unavailable');
function installation(env:MediaOperatorBindings){
 if(env.FREEDOM_MEDIA_OPERATOR_ENABLED!=='true'||!env.FREEDOM_MEDIA_OPERATOR_PROFILE||env.FREEDOM_MEDIA_OPERATOR_PROFILE.length>4096||!env.OPERATOR_HYPERDRIVE?.connectionString||!env.MEDIA)throw unavailable();
 const profile=profileSchema.parse(parseBoundedJson(env.FREEDOM_MEDIA_OPERATOR_PROFILE)),target=validateInventoryTarget(profile.target);
 if(target.environment!==env.FREEDOM_MEDIA_OPERATOR_ENVIRONMENT||target.releaseSha!==env.FREEDOM_MEDIA_OPERATOR_RELEASE_SHA||profile.storeBindingId!==env.FREEDOM_MEDIA_OPERATOR_STORE_BINDING_ID||new Set(profile.purposes).size!==profile.purposes.length)throw unavailable();
 if(target.environment==='local'){
  if(!/^fp_media_migrator_[a-z0-9_]+$/.test(target.role))throw unavailable();
 }else if(target.schema!=='public'||target.role!=='freedom_media_migrator'||target.database!==(target.environment==='staging'?'freedom_staging_next':'freedom_next'))throw unavailable();
 // Creates only the installed native MEDIA port; deletion stays disabled.
 const store=createR2ObjectStore(env.MEDIA);
 return {profile,target,store,connectionString:env.OPERATOR_HYPERDRIVE.connectionString};
}
async function verifyRole(pool:Pool,target:ReturnType<typeof validateInventoryTarget>){
 const q=await pool.connect();try{
  await q.query('BEGIN');await q.query("SELECT set_config('search_path',$1,true),set_config('statement_timeout','5000',true)",[target.schema]);
  const role=(await q.query(`SELECT current_user role,session_user session_role,current_database() database,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
   (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) memberships,
   has_schema_privilege(current_user,$1,'CREATE') ddl,
   has_table_privilege(current_user,'broker_credential_vault','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') vault,
   has_any_column_privilege(current_user,'broker_credential_vault','SELECT,INSERT,UPDATE,REFERENCES') vault_columns,
   EXISTS(SELECT 1 FROM unnest(ARRAY['media_backfill_operator_policy','domain_media_storage_policy','users','principals','resource_scopes']) t
    WHERE has_table_privilege(current_user,t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR has_any_column_privilege(current_user,t,'INSERT,UPDATE,REFERENCES')) authority_write
   FROM pg_roles r WHERE rolname=current_user`,[target.schema])).rows[0];
  if(!role||role.role!==target.role||role.session_role!==target.role||role.database!==target.database||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolreplication||role.rolbypassrls||role.memberships!==0||role.ddl||role.vault||role.vault_columns||role.authority_write)throw unavailable();
  await q.query('COMMIT');
 }catch{await q.query('ROLLBACK').catch(()=>{});throw unavailable();}finally{q.release();}
}
/** Native private service RPC only; no route, bearer fallback or caller store. */
export class MediaOperator extends WorkerEntrypoint<MediaOperatorBindings> {
 async fetch(){return new Response(null,{status:404});}
 async execute(raw:unknown){
  let pool:Pool|undefined;
  try{
   const installed=installation(this.env);
   if(!raw||Object.getPrototypeOf(raw)!==Object.prototype)throw unavailable();
   const {planSha256,...body}=raw as Record<string,unknown>,plan=planOperatorBackfill(body);
   if(planSha256!==plan.planSha256||JSON.stringify(plan.target)!==JSON.stringify(installed.target)||plan.logicalStore!==installed.profile.logicalStore||plan.storeBindingId!==installed.profile.storeBindingId||!installed.profile.purposes.includes(plan.purpose))throw unavailable();
   // Sockets and Pool clients are owned by this RPC request and never cached.
   pool=createRequestPool(installed.connectionString);await verifyRole(pool,installed.target);
   return await createOperatorMediaBackfill(pool,{store:installed.store,logicalStore:installed.profile.logicalStore,storeBindingId:installed.profile.storeBindingId}).run(plan);
  }catch{throw unavailable();}finally{await pool?.end().catch(()=>{});}
 }
}
export default {fetch(){return new Response(null,{status:404});}};
