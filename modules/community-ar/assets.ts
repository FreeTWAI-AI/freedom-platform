import {z} from 'zod';
import type {Pool} from 'pg';
import {digest} from '../../packages/db/index.js';
import type {Actor} from '../identity-membership/service.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {OpaqueId} from '../../contracts/common/v1/identity.js';
import {readBounded,snapshotBoundedBytes,prepareLegacyMediaRepresentation,sha256,type ObjectStore} from '../../packages/asset-storage/index.js';
import {inspectArExperience,createArExperience,bindingMetadata,AR_EXPERIENCE_MAX_BYTES,type ArBindingMetadata} from '../../packages/asset-storage/ar-target.js';
import {normalizeMessageImage} from '../assets/message-image.js';
import {createAssetLifecycle,assetCommandKey,assetVersion} from '../assets/engine.js';
import {arPolicy,lockOwnAr,lockArParent,patternFingerprint} from './index.js';

const Prepare=z.object({key:assetCommandKey,targetId:OpaqueId,expectedVersion:assetVersion,contentType:z.literal('application/octet-stream'),byteSize:z.number().int().min(32).max(AR_EXPERIENCE_MAX_BYTES),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
function createArTargetAssets(pool:Pool,store:ObjectStore,fingerprint:string,config:ArBindingMetadata|null){
  return createAssetLifecycle<z.infer<typeof Prepare>,{target_id:string;aggregate_version:string}>(pool,{store},{
    purpose:'member.ar-target',targetKind:'member.ar-target',variant:'image',inputMaxBytes:AR_EXPERIENCE_MAX_BYTES,outputMaxBytes:AR_EXPERIENCE_MAX_BYTES,retireReplacedAsset:false,
    parsePrepare:raw=>Prepare.parse(raw),targetId:value=>value.targetId,
    async lockTarget(q,context,actor,id,create){
      const row=await lockOwnAr(q,actor,id);
      requireCondition(row.scope_id===context.scope.scope_id&&row.owner_principal_id===context.subject_principal.principal_id,404,'ar_target_not_found','找不到這個圖案。');
      await lockArParent(q,actor,row);
      requireCondition((row.kind==='custom')===!!config,422,'ar_content_mismatch','圖案內容與綁定類型不同，請重新製作。');
      // Current ACL belongs before replay; new-effect admission belongs below,
      // after the common core has had a chance to return the original receipt.
      return {targetId:id,aggregateVersion:row.aggregate_version,assetId:row.asset_id};
    },resolvePolicy:q=>arPolicy(q),
    async requireCapacity(q,context,_actor,target,policy,reserve){
      requireCondition(!target.assetId,409,'ar_pattern_exists','請建立新圖案，已發布的圖案不會被替換。');
      const row=(await q.query("SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,20971520)::bigint),0) AS used FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE a.scope_id=$1 AND a.purpose='member.ar-target'",[context.scope.scope_id])).rows[0];
      requireCondition(BigInt(row.used)+BigInt(reserve)<=BigInt(policy.retainedByteLimit),409,'ar_storage_limit','圖案儲存空間已達上限。');
    },
    async prepareRepresentation(body,mime,policy){
      const bytes=await readBounded(body,AR_EXPERIENCE_MAX_BYTES),experience=inspectArExperience(bytes);
      if(experience.binding?.kind==='image'){
        const media=await normalizeMessageImage(experience.binding.mime,Buffer.from(experience.binding.media));
        const output=createArExperience(bytes,{...experience.binding,mime:'image/webp',media});
        return prepareLegacyMediaRepresentation(new ReadableStream({start(c){c.enqueue(output);c.close();}}),mime,'member.ar-target',policy);
      }
      return prepareLegacyMediaRepresentation(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),mime,'member.ar-target',policy);
    },
    async lockPublication(q,_context,actor,intent,target){
      const row=await lockOwnAr(q,actor,target.targetId);await lockArParent(q,actor,row);await arPolicy(q);
      return intent.source_sha256;
    },
    async publish(q,_context,_actor,intent,target){
      const row=(await q.query('UPDATE community_ar_targets SET asset_id=$2,linked_at_version=aggregate_version+1,target_sha256=$3,content_config=$4,aggregate_version=aggregate_version+1 WHERE target_id=$1 AND asset_id IS NULL RETURNING aggregate_version',[target.targetId,intent.asset_id,fingerprint,config?JSON.stringify(config):null])).rows[0];
      requireCondition(row,409,'ar_pattern_exists','這個圖案已經上傳。');
      return {aggregateVersion:row.aggregate_version,result:{target_id:target.targetId,aggregate_version:row.aggregate_version},fact:{aggregateType:'ar_target',id:target.targetId,data:{asset_id:intent.asset_id}}};
    },
  });
}
/** Bounded, validated binary HTTP facade. Receipt keys are stable across a
 * lost response; existing phases perform current authority before replay. */
export async function uploadArPattern(pool:Pool,store:ObjectStore,actor:Actor,id:string,expected:string,key:string,bytes:Uint8Array){
  bytes=snapshotBoundedBytes(bytes,AR_EXPERIENCE_MAX_BYTES);
  const experience=inspectArExperience(bytes),hash=await sha256(bytes),fingerprint=patternFingerprint(bytes,experience.target);
  const config=experience.binding?bindingMetadata(experience.binding):null;if(config?.kind==='image')config.mime='image/webp';
  const api=createArTargetAssets(pool,store,fingerprint,config);
  const prepareKey=digest({key,id});
  const prepared=await api.prepare(actor,{key:prepareKey,targetId:id,expectedVersion:expected,contentType:'application/octet-stream',byteSize:bytes.length,sha256:hash});
  const lease=await api.resumeUpload(actor,{key:prepareKey,intentId:prepared.intentId});
  const fields={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  if(lease.state==='prepared'||lease.state==='processing')await api.write(actor,{...fields,key:digest({prepareKey,phase:'write',fence:fields.fence})},new ReadableStream({start(c){c.enqueue(bytes);c.close();}}));
  return api.finalize(actor,{...fields,key:digest({prepareKey,phase:'finalize'})});
}
