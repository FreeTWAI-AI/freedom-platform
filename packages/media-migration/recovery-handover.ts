import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {readVerifiedObject,type AssetObjectKey,type ObjectMetadata,type ObjectRange,type ObjectStore} from '../asset-storage/index.js';
import {readbackRecoverySet,restoreRecoverySet,restoredReferenceAuthorization,type RecoverySetIdentity} from './backup-archive.js';
import {collectSchemaEvidence,encodeEvidence,evidenceSha256} from './backup-evidence.js';
import {openRecoveryBundle} from './recovery-bundle.js';
import {MEDIA_ACL_SIGNATURES,lockdownRestoredMediaAcl} from './restore-acl-lockdown.js';
import {withOwnedRecoveryTarget} from './owned-recovery-target.js';

/** Restore-only composition. The source is an already downloaded operator
 * artifact, never an original DB pool, provider credential or capture adapter.
 * Current external revocations and real second-operator acceptance remain
 * separate; this entry always destroys its quarantined target after checking. */
const SCHEMA=/^fp_[a-z0-9_]{0,62}$/;
export class RecoveryHandoverError extends Error {
  constructor(readonly code:'recovery_handover_unavailable'|'recovery_handover_evidence_required'|'recovery_handover_restore_incomplete'|'recovery_handover_fence_unavailable',readonly detail?:string){super(detail?code+':'+detail:code);this.name='RecoveryHandoverError';}
}
const fail=(code:RecoveryHandoverError['code']='recovery_handover_unavailable',detail?:string):never=>{throw new RecoveryHandoverError(code,detail);};
const quote=(value:string)=>{if(!SCHEMA.test(value))fail();return `"${value}"`;};
export function recoverySessionFingerprint(tokenHashes:readonly string[]):string{
  if(!tokenHashes.every(value=>typeof value==='string'&&value.length>0&&value.length<=256))fail();
  return createHash('sha256').update([...tokenHashes].sort().join('\n')).digest('hex');
}
async function observeEvidence(pool:Pool,schema:string){
  const client=await pool.connect();let destroy=false;
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try{return await collectSchemaEvidence(client,schema);}
    finally{try{await client.query('ROLLBACK');}catch{destroy=true;}}
  }finally{client.release(destroy);}
}
function recordingStore(inner:ObjectStore,written:{key:AssetObjectKey;metadata:ObjectMetadata}[]):ObjectStore{
  return Object.freeze({
    async putImmutable(key:AssetObjectKey,value:{bytes:Uint8Array;metadata:ObjectMetadata}){
      const outcome=await inner.putImmutable(key,value);
      if(written.some(entry=>entry.key===key))fail('recovery_handover_restore_incomplete','duplicate_object');
      written.push({key,metadata:Object.freeze({...value.metadata})});return outcome;
    },
    get:(key:AssetObjectKey,range?:ObjectRange)=>inner.get(key,range),head:(key:AssetObjectKey)=>inner.head(key),delete:(key:AssetObjectKey)=>inner.delete(key),
  });
}
export async function restoreRecoveryHandover(input:{expected:RecoverySetIdentity;operatorSource:string;bundleDirectory:string;
 runDirectory:string;targetDatabase:string;signal:AbortSignal}){
  const expected=Object.freeze({...input.expected}),started=Date.now();
  if(!SCHEMA.test(expected.schema)||!/^fp_[a-z0-9_]{1,55}$/.test(input.targetDatabase))fail();
  const bundle=await openRecoveryBundle(input.bundleDirectory,expected.setId);
  const verified=await readbackRecoverySet({...bundle,setId:expected.setId,expected,verifiedAt:new Date().toISOString()});
  if(verified.evidence.status!=='captured')fail('recovery_handover_evidence_required');
  input.signal.throwIfAborted();
  const schema=quote(expected.schema);
  const owned=await withOwnedRecoveryTarget({runDirectory:input.runDirectory,database:input.targetDatabase,schema:expected.schema,signal:input.signal},async target=>{
    const written:{key:AssetObjectKey;metadata:ObjectMetadata}[]=[];
    const restored=await restoreRecoverySet({...bundle,setId:expected.setId,expected,destinationObjects:recordingStore(target.objects,written),
      restoredPool:target.pool,restoredDatabase:target.databaseName,database:target.database,
      objectAuthority:restoredReferenceAuthorization(target.pool,{database:target.databaseName,schema:expected.schema,current:{mode:'quarantine'}})});
    if(restored.evidence.status!=='matched')fail('recovery_handover_restore_incomplete','evidence');
    if(restored.exposure!=='quarantine_not_approved_for_exposure')fail('recovery_handover_restore_incomplete','exposure');
    const evidence=await observeEvidence(target.pool,expected.schema);
    const evidenceDigest=evidenceSha256(encodeEvidence(evidence));
    const assets=(await target.pool.query(`SELECT asset_id::text AS asset_id FROM ${schema}.assets ORDER BY asset_id`)).rows.map(row=>String(row.asset_id));
    const sessions=(await target.pool.query(`SELECT token_hash FROM ${schema}.sessions ORDER BY token_hash`)).rows.map(row=>String(row.token_hash));
    const unfencedBefore=(await target.pool.query(`SELECT count(*)::int AS n FROM ${schema}.sessions WHERE revoked_at IS NULL`)).rows[0]?.n;
    const pins=(await target.pool.query(`SELECT count(*)::int AS n FROM ${schema}.asset_backup_pins`)).rows[0]?.n;
    if(typeof unfencedBefore!=='number'||typeof pins!=='number')fail('recovery_handover_restore_incomplete','row_counts');
    const entries=[];
    for(const item of written){const read=await readVerifiedObject(target.objects,item.key,item.metadata);
      entries.push({key:item.key,sha256:read.metadata.sha256,byteSize:read.metadata.byteSize});}
    entries.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    if(entries.length!==restored.objects.objectCount||entries.reduce((sum,entry)=>sum+entry.byteSize,0)!==restored.objects.byteCount)fail('recovery_handover_restore_incomplete','objects');
    await target.pool.query(`CREATE ROLE ${quote('fp_recovery_app')} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    const acl=await lockdownRestoredMediaAcl(target.pool,{target:{environment:'local',database:target.databaseName,schema:expected.schema,role:'postgres',releaseSha:input.operatorSource},runtimeRole:target.runtimeRole});
    // PostgreSQL 18 identity-argument text keeps parameter names. Input type oids are the canonical signature.
    const routines=(await target.pool.query(`SELECT p.proname || '(' || coalesce((SELECT string_agg(replace(regexp_replace(pg_catalog.format_type(u.t::oid,NULL),'^pg_catalog\\.',''),' ',''),',' ORDER BY u.n) FROM unnest(string_to_array(p.proargtypes::text,' ')) WITH ORDINALITY AS u(t,n) WHERE u.t<>''),'') || ')' AS signature,
      has_function_privilege($2,p.oid,'EXECUTE') AS allowed
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.prosecdef ORDER BY 1`,[expected.schema,target.runtimeRole])).rows as {signature:string;allowed:boolean}[];
    const observed=routines.map(row=>row.signature).sort();
    const canonical=[...MEDIA_ACL_SIGNATURES].sort();
    if(acl.functionsRevoked!==MEDIA_ACL_SIGNATURES.length)fail('recovery_handover_restore_incomplete','acl_count');
    if(observed.length!==canonical.length||observed.some((signature,index)=>signature!==canonical[index]))fail('recovery_handover_restore_incomplete','acl_signature');
    if(routines.some(row=>row.allowed!==false))fail('recovery_handover_restore_incomplete','acl_execute');
    const q=await target.pool.connect();let fenced=0;
    try{
      await q.query('BEGIN');
      fenced=(await q.query(`UPDATE ${schema}.sessions SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL`)).rowCount??0;
      await q.query(`UPDATE ${schema}.asset_maintenance_policy SET enabled=false,domain_media_enabled=false`);
      const check=(await q.query(`SELECT (SELECT count(*)::int FROM ${schema}.sessions WHERE revoked_at IS NULL) AS unfenced,
        (SELECT count(*)::int FROM ${schema}.asset_maintenance_policy WHERE enabled OR domain_media_enabled) AS enabled`)).rows[0];
      if(check?.unfenced!==0||check?.enabled!==0||fenced!==unfencedBefore)fail('recovery_handover_fence_unavailable');
      await q.query('COMMIT');
    }catch(error){try{await q.query('ROLLBACK');}catch{/* transaction already closed */}throw error;}finally{q.release();}
    return {restored,evidenceDigest,fingerprints:evidence.tables.map(table=>({table:table.table,count:table.count,fingerprint:table.fingerprint})),
      assetIds:assets,sessionFingerprint:recoverySessionFingerprint(sessions),unfencedSessionsBefore:unfencedBefore,backupPins:pins,entries,
      acl:{functionsRevoked:acl.functionsRevoked,ledgerDigest:acl.ledgerDigest,signatures:observed,runtimeExecuteDenied:true},importedSessionsFenced:fenced,containerId:target.containerId};
  });
  const body=owned.result;
  return Object.freeze({format:'freedom.recovery-handover/v1',status:'quarantine_restore_verified',expected,operatorSource:input.operatorSource,
    sourceSetCreatedAt:verified.createdAt,snapshotTimeAuthority:'producer_recorded_set_time_not_exact_snapshot_timestamp',
    recoveryScope:'Writes after the exported MVCC snapshot are not in this set; no PITR or promised RPO.',
    restoreDurationMs:Date.now()-started,dump:verified.dump,targetContainerId:body.containerId,
    evidence:Object.freeze({...(body.restored.evidence.status==='matched'?body.restored.evidence:fail('recovery_handover_restore_incomplete','evidence')),
      sha256:body.evidenceDigest,fingerprints:body.fingerprints}),
    objects:Object.freeze({...body.restored.objects,entries:body.entries}),
    rows:Object.freeze({assetIds:body.assetIds,sessionFingerprint:body.sessionFingerprint,unfencedSessionsBefore:body.unfencedSessionsBefore,backupPins:body.backupPins}),
    acl:body.acl,importedSessionsFenced:body.importedSessionsFenced,
    maintenance:Object.freeze({enabled:false,domainMediaEnabled:false,unfencedSessions:0}),
    exposure:'quarantine_not_approved_for_exposure',cleanupVerified:owned.cleanupVerified,
    secondOperatorAcceptance:'not_run',externalRecoveryAuthority:'not_run',oldExecutionTokenAcceptance:'not_run',
    applicationInstalled:false,dispatchStarted:false,cutoverAuthorized:false,sourcePins:'untouched',retentionExecuted:false});
}
