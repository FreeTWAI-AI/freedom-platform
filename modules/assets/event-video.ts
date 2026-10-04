import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import type {MemberScopeContext} from '../../packages/resource-scopes/index.js';
import {OpaqueId} from '../../contracts/common/v1/identity.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {authorizeEventBannerWrite} from '../community/events.js';
import {prepareLegacyMediaRepresentation,type ObjectStore} from '../../packages/asset-storage/index.js';
import {assetCommandKey,assetVersion,createAssetLifecycle,type LifecyclePolicy} from './engine.js';
const input=z.object({key:assetCommandKey,targetEventId:OpaqueId,expectedVersion:assetVersion,contentType:z.enum(['video/mp4','video/webm']),byteSize:z.number().int().min(1).max(20971520),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export interface EventVideoAssetDependencies {readonly store:ObjectStore;readonly resolvePolicy:(q:PoolClient,context:MemberScopeContext,id:string)=>Promise<LifecyclePolicy>;readonly intentTtlSeconds?:number;readonly leaseSeconds?:number;readonly maxPendingIntents?:number;}
export async function eventVideoStorageMode(q:Pick<PoolClient,'query'>):Promise<'legacy'|'bridge'|'r2_only'>{const row=(await q.query("SELECT mode FROM domain_media_storage_policy WHERE purpose='community.event-video' FOR SHARE")).rows[0];requireCondition(row,503,'media_upload_unavailable','內容上傳暫時無法使用。');return row.mode;}
/** Policy is independent from MEDIA presence and every installed callback. */
export async function resolveEventVideoUploadPolicy(q:PoolClient,context:MemberScopeContext,_id:string):Promise<LifecyclePolicy>{
 requireCondition(context.scope.kind==='community',403,'asset_scope_required','需要活動的社群範圍。');
 const row=(await q.query("SELECT mode,policy_revision,persistence_allowed,retained_byte_limit::text AS retained_byte_limit FROM domain_media_storage_policy WHERE purpose='community.event-video' FOR SHARE")).rows[0];
 requireCondition(row&&row.mode!=='legacy'&&row.persistence_allowed===true&&typeof row.policy_revision==='string'&&typeof row.retained_byte_limit==='string'&&BigInt(row.retained_byte_limit)>=20971520n,503,'media_upload_unavailable','內容上傳暫時無法使用。');
 return Object.freeze({revision:row.policy_revision,platformPersistenceAllowed:true,retainedByteLimit:row.retained_byte_limit});
}
/** Exactly one community-owned video profile, retaining original domain ACL. */
export function createEventVideoAssetService(pool:Pool,dependencies:EventVideoAssetDependencies){
 return createAssetLifecycle<z.infer<typeof input>,{intentId:string;assetId:string;eventId:string;aggregateVersion:string}>(pool,dependencies,{
  purpose:'community.event-video',targetKind:'community.event-video',variant:'video',inputMaxBytes:20971520,outputMaxBytes:20971520,retireReplacedAsset:true,
  parsePrepare:raw=>input.parse(raw),targetId:raw=>raw.targetEventId,
  async lockTarget(q,context,actor,id,create){
   requireCondition(context.scope.kind==='community',403,'asset_scope_required','需要活動的社群範圍。');
   const event=await authorizeEventBannerWrite(q,actor,id,true);
   if(create)await q.query('INSERT INTO community_event_video_asset_targets(event_id,community_id,scope_id,owner_principal_id,owner_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id]);
   const pointer=(await q.query('SELECT asset_id FROM community_event_video_asset_targets WHERE event_id=$1 AND community_id=$2 AND scope_id=$3 AND owner_principal_id=$4 AND owner_user_id=$5 FOR UPDATE',[id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id])).rows[0];
   requireCondition(pointer,404,'asset_target_not_found','找不到這個目標。');return {targetId:id,aggregateVersion:event.aggregate_version,assetId:pointer.asset_id};
  },
  async resolvePolicy(q,context,id){const canonical=await resolveEventVideoUploadPolicy(q,context,id),installed=await dependencies.resolvePolicy(q,context,id);requireCondition(installed?.platformPersistenceAllowed===true&&installed.revision===canonical.revision&&typeof installed.retainedByteLimit==='string'&&/^[1-9][0-9]{0,18}$/.test(installed.retainedByteLimit),503,'media_upload_unavailable','內容上傳暫時無法使用。');return Object.freeze({...canonical,retainedByteLimit:BigInt(installed.retainedByteLimit)<BigInt(canonical.retainedByteLimit)?installed.retainedByteLimit:canonical.retainedByteLimit});},
  async requireCapacity(q,context,_actor,_target,policy,reserve){
   const used=(await q.query("SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,20971520)::bigint),0) AS used FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE a.scope_id=$1 AND a.purpose='community.event-video'",[context.scope.scope_id])).rows[0];
   const legacy=(await q.query('SELECT COALESCE(sum(octet_length(b.media_bytes)),0) AS used FROM community_event_videos b JOIN community_events e USING(event_id) WHERE e.community_id=$1',[_actor.community_id])).rows[0];
   requireCondition(BigInt(used.used)+BigInt(legacy.used)+BigInt(reserve)<=BigInt(policy.retainedByteLimit),409,'asset_retained_quota','內容儲存容量已達上限。');
  },
  async prepareRepresentation(body,mime,policy){return prepareLegacyMediaRepresentation(body,mime as 'video/mp4'|'video/webm','community.event-video',policy);},
  async lockPublication(q,_context,actor,row){await authorizeEventBannerWrite(q,actor,row.target_video_event_id!,true);return eventVideoStorageMode(q);},
  async publish(q,_context,actor,row,target,mode){
   requireCondition(mode!=='legacy',503,'media_upload_unavailable','內容上傳暫時無法使用。');await authorizeEventBannerWrite(q,actor,target.targetId,true);
   const saved=(await q.query('UPDATE community_events SET aggregate_version=aggregate_version+1,updated_at=clock_timestamp() WHERE event_id=$1 AND aggregate_version=$2 RETURNING aggregate_version',[target.targetId,row.expected_version])).rows[0];requireCondition(saved,412,'version_conflict','資料已更新，請重新整理後再操作。');
   await q.query('UPDATE community_event_video_asset_targets SET asset_id=$2,linked_at_version=$3 WHERE event_id=$1',[target.targetId,row.asset_id,saved.aggregate_version]);
   await q.query("INSERT INTO community_event_videos(event_id,media_bytes,mime_type,storage_source) VALUES($1,NULL,$2,'asset') ON CONFLICT(event_id) DO UPDATE SET mime_type=EXCLUDED.mime_type,storage_source='asset',updated_at=clock_timestamp()",[target.targetId,row.source_content_type]);
   const result={intentId:row.intent_id,assetId:row.asset_id,eventId:target.targetId,aggregateVersion:saved.aggregate_version as string};return {aggregateVersion:result.aggregateVersion,result,fact:{aggregateType:'community_event',id:target.targetId,data:{asset_id:row.asset_id,intent_id:row.intent_id},eventType:'freedom.community.event.video.replaced.v1'}};
  },
 });
}
export type EventVideoAssetService=ReturnType<typeof createEventVideoAssetService>;
