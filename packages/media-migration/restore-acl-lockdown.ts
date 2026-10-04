import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {Pool} from 'pg';
import {transaction} from '../db/transaction.js';
import {validateInventoryTarget,type InventoryTarget} from './inventory.js';

const root=new URL('../../',import.meta.url),migrations=Object.freeze(['105_operator_service_cover_backfill.sql','107_operator_event_video_backfill.sql','109_banner_social_operator_backfill.sql','110_skill_highlight_operator_backfill.sql','111_operator_avatar_backfill.sql']);
const signatures=Object.freeze(['lock_media_backfill_operator_approval(text)','lock_media_backfill_cover_owner(text,uuid)','lock_media_backfill_cover_consent(text)','publish_media_backfill_cover(text,uuid,uuid,bigint,uuid)','lock_media_backfill_video_organizer(text,uuid)','lock_media_backfill_video_consent(text)','publish_media_backfill_video(text,uuid,uuid,bigint,uuid)','lock_media_backfill_banner_organizer(text,uuid)','lock_media_backfill_banner_consent(text)','publish_media_backfill_banner(text,uuid,uuid,bigint,uuid)','lock_media_backfill_social_author(text,uuid)','lock_media_backfill_social_consent(text)','publish_media_backfill_social(text,uuid,uuid,bigint,uuid)','lock_media_backfill_skill_owner(text,uuid)','lock_media_backfill_skill_consent(text)','publish_media_backfill_skill(text,uuid,uuid,bigint,uuid)','lock_media_backfill_highlight_uploader(text,uuid)','lock_media_backfill_highlight_consent(text)','publish_media_backfill_highlight(text,uuid,uuid,bigint,uuid)','lock_media_backfill_highlight_bytes(text,uuid)','lock_media_backfill_avatar_owner(text,uuid)','lock_media_backfill_avatar_consent(text)','operator_avatar_intent_admitted(uuid)','publish_media_backfill_avatar(text,uuid,uuid,bigint,uuid)']);
export interface RestoreAclOptions {readonly target:InventoryTarget;readonly runtimeRole:string}
export class RestoreAclError extends Error {
 constructor(readonly code:'invalid_target'|'canonical_source_unavailable'|'target_mismatch'|'ledger_mismatch'|'runtime_role_unsafe'|'runtime_active'|'function_shape_mismatch'|'lockdown_unavailable'){super(code);this.name='RestoreAclError';}
}
function options(raw:RestoreAclOptions){
 if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).length!==2||!Object.hasOwn(raw,'target')||!Object.hasOwn(raw,'runtimeRole'))throw new RestoreAclError('invalid_target');
 for(const key of ['target','runtimeRole'])if(!('value' in Object.getOwnPropertyDescriptor(raw,key)!))throw new RestoreAclError('invalid_target');
 try{const target=validateInventoryTarget(raw.target);validateInventoryTarget({...target,role:raw.runtimeRole});if(target.role===raw.runtimeRole)throw Error();return Object.freeze({target,runtimeRole:raw.runtimeRole});}catch{throw new RestoreAclError('invalid_target');}
}
async function source(){
 try{
  // Reuse the canonical scanner and its exact reviewed-definer source exception.
  // No caller path, SQL, manifest or override can replace the installed source.
  const {loadManifest,validateManifest}=await import(new URL('deploy/cloudflare/lib/manifest.mjs',root).href);
  const {checkMigrations}=await import(new URL('deploy/cloudflare/lib/migrations.mjs',root).href);
  const manifest=loadManifest(fileURLToPath(new URL('deploy/cloudflare/environments.json',root)));if(validateManifest(manifest).ok!==true)throw Error();
  const scan=checkMigrations(fileURLToPath(new URL('migrations/',root)),manifest.database_defaults.migrations);
  if(scan.ok!==true||scan.reviewed_privileged?.length!==migrations.length)throw Error();
  const revocations:string[]=[],reviewedSources:{migration:string;sha256:string}[]=[];
  for(const migration of migrations){
   const reviewed=scan.reviewed_privileged.find((r:{file:string})=>r.file===migration);
   if(!reviewed||!scan.ledger.some((r:{name:string;sha256:string})=>r.name===migration&&r.sha256===reviewed.sha256))throw Error();
   const sql=await readFile(new URL('migrations/'+migration,root),'utf8');
   revocations.push(...[...sql.matchAll(/REVOKE ALL ON FUNCTION [\s\S]*? FROM PUBLIC;/g)].map(m=>m[0]));
   reviewedSources.push({migration,sha256:reviewed.sha256});
  }
  const selected=revocations.flatMap(statement=>{
   const list=/^REVOKE ALL ON FUNCTION ([\s\S]+) FROM PUBLIC;$/.exec(statement)?.[1];if(!list)throw Error();
   const found=[...list.matchAll(/[a-z_]+\([a-z,]+\)/g)].map(m=>m[0]);if(found.join(',')!==list.replace(/\s/g,''))throw Error();return found;
  });
  if(revocations.length!==17||JSON.stringify(selected)!==JSON.stringify(signatures))throw Error();
  return {manifest,statements:Object.freeze(revocations),ledger:scan.ledger as {name:string;sha256:string}[],ledgerDigest:scan.ledger_digest as string,reviewedSources:Object.freeze(reviewedSources)};
 }catch{throw new RestoreAclError('canonical_source_unavailable');}
}
function assertEnvironment(installed:ReturnType<typeof options>,canonical:Awaited<ReturnType<typeof source>>){
 const {target,runtimeRole}=installed;if(target.environment==='local'){if(!runtimeRole.startsWith('fp_'))throw new RestoreAclError('invalid_target');return;}
 const profile=Object.values(canonical.manifest.environments).find((p:any)=>p.freedom_env===target.environment) as any;
 if(!profile||target.schema!=='public'||profile.database.dbname!==target.database||profile.database.roles.migrator!==target.role||profile.database.roles.runtime!==runtimeRole)throw new RestoreAclError('invalid_target');
}
export async function planRestoredMediaAcl(raw:RestoreAclOptions){
 const installed=options(raw),canonical=await source();assertEnvironment(installed,canonical);return Object.freeze({format:'freedom.media-restore-acl/v1',...installed,execution:'not_run',dataMoved:false,applicationInstalled:false,deploymentReady:false,releaseBinding:'operator_declared_not_runtime_verified',reviewedSources:canonical.reviewedSources,ledgerDigest:canonical.ledgerDigest,functions:signatures,statements:canonical.statements});
}
/** Only restores the canonical PUBLIC lockdown lost by --no-privileges dumps.
 * No role provisioning, application grant, operator approval or data authority. */
export async function lockdownRestoredMediaAcl(pool:Pool,raw:RestoreAclOptions){
 const installed=options(raw),canonical=await source(),{target,runtimeRole}=installed;assertEnvironment(installed,canonical);
 try{return await transaction(pool,async q=>{
  await q.query("SET LOCAL statement_timeout='10000';SET LOCAL lock_timeout='5000';SET LOCAL search_path=pg_catalog");
  await q.query('SELECT pg_advisory_xact_lock(2026092000)');
  const actual=(await q.query('SELECT current_database() database,current_user role,session_user session_role')).rows[0];
  if(actual.database!==target.database||actual.role!==target.role||actual.session_role!==target.role)throw new RestoreAclError('target_mismatch');
  if(target.environment!=='local'){const operator=(await q.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,(SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) memberships FROM pg_roles r WHERE rolname=current_user')).rows[0];if(!operator||operator.rolsuper||operator.rolcreatedb||operator.rolcreaterole||operator.rolreplication||operator.rolbypassrls||operator.memberships!==0)throw new RestoreAclError('target_mismatch');}
  const namespace=(await q.query("SELECT pg_get_userbyid(nspowner) owner,has_schema_privilege(current_user,oid,'USAGE') usable FROM pg_namespace WHERE nspname=$1",[target.schema])).rows[0];if(namespace?.usable!==true)throw new RestoreAclError('target_mismatch');
  // Identifier is validated by the canonical target validator, then quoted.
  await q.query(`SET LOCAL search_path=pg_catalog,"${target.schema}"`);
  const ledger=(await q.query('SELECT name,sha256 FROM schema_migrations ORDER BY name FOR SHARE')).rows;if(JSON.stringify(ledger)!==JSON.stringify(canonical.ledger))throw new RestoreAclError('ledger_mismatch');
  const role=(await q.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,(SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) memberships FROM pg_roles r WHERE rolname=$1',[runtimeRole])).rows[0];
  if(!role||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolreplication||role.rolbypassrls||role.memberships!==0)throw new RestoreAclError('runtime_role_unsafe');
  if((await q.query("SELECT has_schema_privilege($1,$2,'CREATE') allowed",[runtimeRole,target.schema])).rows[0].allowed!==false)throw new RestoreAclError('runtime_role_unsafe');
  if((await q.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND pid<>pg_backend_pid()',[target.database,runtimeRole])).rows[0].n!==0)throw new RestoreAclError('runtime_active');
  const expectedFunctions:string[]=[];
  for(const signature of signatures){
   const row=(await q.query('SELECT p.oid::text oid,pg_get_userbyid(p.proowner) owner,p.prosecdef FROM pg_proc p WHERE p.oid=to_regprocedure($1)',[`"${target.schema}".${signature}`])).rows[0];
   if(row?.owner!==target.role||row.prosecdef!==true)throw new RestoreAclError('function_shape_mismatch');expectedFunctions.push(row.oid);
  }
  const observedFunctions=(await q.query('SELECT p.oid::text oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prosecdef ORDER BY p.oid::text',[target.schema])).rows.map(r=>r.oid);if(JSON.stringify(observedFunctions)!==JSON.stringify(expectedFunctions.sort()))throw new RestoreAclError('function_shape_mismatch');
  for(const statement of canonical.statements)await q.query(statement);
  for(const signature of signatures)if((await q.query("SELECT has_function_privilege($1,to_regprocedure($2),'EXECUTE') allowed",[runtimeRole,`"${target.schema}".${signature}`])).rows[0].allowed!==false)throw new RestoreAclError('runtime_role_unsafe');
  return Object.freeze({format:'freedom.media-restore-acl/v1',...installed,execution:'public_execute_revoked',functionsRevoked:signatures.length,dataMoved:false,applicationInstalled:false,deploymentReady:false,releaseBinding:'operator_declared_not_runtime_verified',fullRecoveryAuthority:'not_run',reviewedSources:canonical.reviewedSources,ledgerDigest:canonical.ledgerDigest});
 });}catch(error){if(error instanceof RestoreAclError)throw error;throw new RestoreAclError('lockdown_unavailable');}
}
