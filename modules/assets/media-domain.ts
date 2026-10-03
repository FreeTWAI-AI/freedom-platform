import { z } from 'zod';
import type { Pool,PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import type { MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { normalizeServiceCover } from '../skill-submissions/payload.js';
import { readBounded,prepareLegacyMediaRepresentation,type ObjectStore } from '../../packages/asset-storage/index.js';
import { assetCommandKey,assetVersion,createAssetLifecycle,type LifecyclePolicy,type LifecycleTarget } from './engine.js';

const input=z.object({key:assetCommandKey,targetServiceId:OpaqueId,expectedVersion:assetVersion,contentType:z.enum(['image/png','image/jpeg','image/webp']),byteSize:z.number().int().min(1).max(4194304),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export type ServiceCoverPrepareInput=z.infer<typeof input>;
export interface ServiceCoverAssetDependencies {
 readonly store:ObjectStore;
 /** Server-installed DB-only policy; a request cannot grant persistence. */
 readonly resolvePolicy:(q:PoolClient,context:MemberScopeContext,targetServiceId:string)=>Promise<LifecyclePolicy>;
 readonly intentTtlSeconds?:number;readonly leaseSeconds?:number;readonly maxPendingIntents?:number;
}
export async function serviceCoverStorageMode(q:Pick<PoolClient,'query'>):Promise<'legacy'|'bridge'|'r2_only'> {
 const row=(await q.query("SELECT mode FROM domain_media_storage_policy WHERE purpose='member.service-cover' FOR SHARE")).rows[0];
 requireCondition(row,503,'media_upload_unavailable','內容上傳暫時無法使用。');return row.mode;
}
/** Existing service owner/CAS is authoritative; no new public ACL is introduced. */
export function createServiceCoverAssetService(pool:Pool,dependencies:ServiceCoverAssetDependencies) {
 async function lockTarget(q:PoolClient,context:MemberScopeContext,actor:Actor,id:string,create:boolean):Promise<LifecycleTarget> {
  requireCondition(context.scope.kind==='personal',403,'asset_scope_required','需要本人的私人範圍。');
  const service=(await q.query("SELECT service_id,aggregate_version FROM member_services WHERE service_id=$1 AND community_id=$2 AND owner_user_id=$3 AND state IN ('active','paused') FOR UPDATE",[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(service,404,'asset_target_not_found','找不到這個目標。');
  if(create)await q.query('INSERT INTO member_service_cover_asset_targets(service_id,scope_id,owner_principal_id,owner_user_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id]);
  const pointer=(await q.query('SELECT asset_id FROM member_service_cover_asset_targets WHERE service_id=$1 AND scope_id=$2 AND owner_principal_id=$3 AND owner_user_id=$4 FOR UPDATE',[id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id])).rows[0];
  requireCondition(pointer,404,'asset_target_not_found','找不到這個目標。');
  return {targetId:id,aggregateVersion:service.aggregate_version,assetId:pointer.asset_id};
 }
 return createAssetLifecycle<ServiceCoverPrepareInput,{intentId:string;assetId:string;serviceId:string;aggregateVersion:string}>(pool,dependencies,{
  purpose:'member.service-cover',targetKind:'member.service-cover',variant:'cover',inputMaxBytes:4194304,outputMaxBytes:524288,retireReplacedAsset:true,
  parsePrepare:raw=>input.parse(raw),targetId:value=>value.targetServiceId,lockTarget,
  async resolvePolicy(q,context,id){requireCondition(await serviceCoverStorageMode(q)!=='legacy',503,'media_upload_unavailable','內容上傳暫時無法使用。');return dependencies.resolvePolicy(q,context,id);},
  async requireCapacity(q,_context,actor,_target,policy,reserve){
   const row=(await q.query(`SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,524288)::bigint),0) AS used FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE a.owner_user_id=$1 AND a.purpose='member.service-cover'`,[actor.user_id])).rows[0];
   const legacy=(await q.query('SELECT COALESCE(sum(octet_length(c.image_bytes)),0) AS used FROM member_service_covers c JOIN member_services s USING(service_id) WHERE s.owner_user_id=$1',[actor.user_id])).rows[0];
   requireCondition(BigInt(row.used)+BigInt(legacy.used)+BigInt(reserve)<=BigInt(policy.retainedByteLimit),409,'asset_retained_quota','內容儲存容量已達上限。');
  },
  async prepareRepresentation(body,mime,policy){
   const raw=await readBounded(body,4194304),bytes=await normalizeServiceCover(mime,Buffer.from(raw));
   return prepareLegacyMediaRepresentation(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),'image/webp','member.service-cover',policy);
  },
  lockPublication:async q=>serviceCoverStorageMode(q),
  async publish(q,_context,_actor,row,target,publication){
   requireCondition(publication!=='legacy',503,'media_upload_unavailable','內容上傳暫時無法使用。');
   const saved=(await q.query('UPDATE member_services SET aggregate_version=aggregate_version+1,updated_at=clock_timestamp() WHERE service_id=$1 AND aggregate_version=$2 RETURNING aggregate_version',[target.targetId,row.expected_version])).rows[0];
   requireCondition(saved,412,'version_conflict','內容版本已改變。');
   await q.query('UPDATE member_service_cover_asset_targets SET asset_id=$2,linked_at_version=$3 WHERE service_id=$1',[target.targetId,row.asset_id,saved.aggregate_version]);
   await q.query("INSERT INTO member_service_covers(service_id,image_bytes,storage_source) VALUES($1,NULL,'asset') ON CONFLICT(service_id) DO UPDATE SET image_bytes=CASE WHEN $2='bridge' THEN member_service_covers.image_bytes ELSE NULL END,storage_source='asset',updated_at=clock_timestamp()",[target.targetId,publication]);
   const result={intentId:row.intent_id,assetId:row.asset_id,serviceId:target.targetId,aggregateVersion:saved.aggregate_version as string};
   return {aggregateVersion:result.aggregateVersion,result,fact:{aggregateType:'member_service',id:target.targetId,data:{asset_id:row.asset_id,intent_id:row.intent_id},eventType:'freedom.member.service.cover.replaced.v1'}};
  },
 });
}
export type ServiceCoverAssetService=ReturnType<typeof createServiceCoverAssetService>;
