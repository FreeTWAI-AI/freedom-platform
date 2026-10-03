import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import type {MemberScopeContext} from '../../packages/resource-scopes/index.js';
import {OpaqueId} from '../../contracts/common/v1/identity.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {normalizeSocialThumbnail} from '../skill-submissions/payload.js';
import {authorizeSocialThumbnailWrite} from '../community/social-posts.js';
import {readBounded,prepareLegacyMediaRepresentation,type ObjectStore} from '../../packages/asset-storage/index.js';
import {assetCommandKey,assetVersion,createAssetLifecycle,type LifecyclePolicy} from './engine.js';
const input=z.object({key:assetCommandKey,targetPostId:OpaqueId,expectedVersion:assetVersion,contentType:z.enum(['image/png','image/jpeg','image/webp']),byteSize:z.number().int().min(1).max(524288),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export interface SocialThumbnailAssetDependencies {readonly store:ObjectStore;readonly resolvePolicy:(q:PoolClient,context:MemberScopeContext,id:string)=>Promise<LifecyclePolicy>;readonly intentTtlSeconds?:number;readonly leaseSeconds?:number;readonly maxPendingIntents?:number;}
export async function socialThumbnailStorageMode(q:Pick<PoolClient,'query'>):Promise<'legacy'|'bridge'|'r2_only'>{const row=(await q.query("SELECT mode FROM domain_media_storage_policy WHERE purpose='community.social-thumbnail' FOR SHARE")).rows[0];requireCondition(row,503,'media_upload_unavailable','內容上傳暫時無法使用。');return row.mode;}
export async function resolveSocialThumbnailUploadPolicy(q:PoolClient,context:MemberScopeContext,_id:string):Promise<LifecyclePolicy>{
 requireCondition(context.scope.kind==='community',403,'asset_scope_required','需要貼文的社群範圍。');
 const row=(await q.query("SELECT mode,policy_revision,persistence_allowed,retained_byte_limit::text AS retained_byte_limit FROM domain_media_storage_policy WHERE purpose='community.social-thumbnail' FOR SHARE")).rows[0];
 requireCondition(row&&row.mode!=='legacy'&&row.persistence_allowed===true&&typeof row.policy_revision==='string'&&typeof row.retained_byte_limit==='string'&&BigInt(row.retained_byte_limit)>=524288n,503,'media_upload_unavailable','內容上傳暫時無法使用。');
 return Object.freeze({revision:row.policy_revision,platformPersistenceAllowed:true,retainedByteLimit:row.retained_byte_limit});
}
/** Manual thumbnail uploads only; automatic previews remain original legacy writers. */
export function createSocialThumbnailAssetService(pool:Pool,dependencies:SocialThumbnailAssetDependencies){
 return createAssetLifecycle<z.infer<typeof input>,{intentId:string;assetId:string;postId:string;aggregateVersion:string}>(pool,dependencies,{
  purpose:'community.social-thumbnail',targetKind:'community.social-thumbnail',variant:'thumbnail',inputMaxBytes:524288,outputMaxBytes:524288,retireReplacedAsset:true,
  parsePrepare:raw=>input.parse(raw),targetId:raw=>raw.targetPostId,
  async lockTarget(q,context,actor,id,create){
   requireCondition(context.scope.kind==='community',403,'asset_scope_required','需要貼文的社群範圍。');
   const post=await authorizeSocialThumbnailWrite(q,actor,id,true);
   if(create)await q.query('INSERT INTO community_social_thumbnail_asset_targets(post_id,community_id,scope_id,owner_principal_id,owner_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id]);
   const pointer=(await q.query('SELECT asset_id FROM community_social_thumbnail_asset_targets WHERE post_id=$1 AND community_id=$2 AND scope_id=$3 AND owner_principal_id=$4 AND owner_user_id=$5 FOR UPDATE',[id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id])).rows[0];
   requireCondition(pointer,404,'asset_target_not_found','找不到這個目標。');return {targetId:id,aggregateVersion:post.media_version,assetId:pointer.asset_id};
  },
  async resolvePolicy(q,context,id){const canonical=await resolveSocialThumbnailUploadPolicy(q,context,id),installed=await dependencies.resolvePolicy(q,context,id);requireCondition(installed?.platformPersistenceAllowed===true&&installed.revision===canonical.revision&&typeof installed.retainedByteLimit==='string'&&/^[1-9][0-9]{0,18}$/.test(installed.retainedByteLimit),503,'media_upload_unavailable','內容上傳暫時無法使用。');return Object.freeze({...canonical,retainedByteLimit:BigInt(installed.retainedByteLimit)<BigInt(canonical.retainedByteLimit)?installed.retainedByteLimit:canonical.retainedByteLimit});},
  async requireCapacity(q,context,actor,_target,policy,reserve){
   const used=(await q.query("SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,524288)::bigint),0) AS used FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE a.scope_id=$1 AND a.purpose='community.social-thumbnail'",[context.scope.scope_id])).rows[0];
   const legacy=(await q.query('SELECT COALESCE(sum(octet_length(t.image_bytes)),0) AS used FROM community_social_post_thumbnails t JOIN community_social_posts p USING(post_id) WHERE p.community_id=$1',[actor.community_id])).rows[0];
   requireCondition(BigInt(used.used)+BigInt(legacy.used)+BigInt(reserve)<=BigInt(policy.retainedByteLimit),409,'asset_retained_quota','內容儲存容量已達上限。');
  },
  async prepareRepresentation(body,mime,policy){const raw=await readBounded(body,524288),webp=await normalizeSocialThumbnail(mime,Buffer.from(raw));return prepareLegacyMediaRepresentation(new ReadableStream({start(c){c.enqueue(webp);c.close();}}),'image/webp','community.social-thumbnail',policy);},
  async lockPublication(q,_context,actor,row){await authorizeSocialThumbnailWrite(q,actor,row.target_post_id!,true);return socialThumbnailStorageMode(q);},
  async publish(q,_context,actor,row,target,mode){
   requireCondition(mode!=='legacy',503,'media_upload_unavailable','內容上傳暫時無法使用。');await authorizeSocialThumbnailWrite(q,actor,target.targetId,true);
   const saved=(await q.query('UPDATE community_social_posts SET media_version=media_version+1,updated_at=clock_timestamp() WHERE post_id=$1 AND media_version=$2 RETURNING media_version',[target.targetId,row.expected_version])).rows[0];requireCondition(saved,412,'version_conflict','資料已更新，請重新整理後再操作。');
   await q.query('UPDATE community_social_thumbnail_asset_targets SET asset_id=$2,linked_at_version=$3 WHERE post_id=$1',[target.targetId,row.asset_id,saved.media_version]);
   await q.query("INSERT INTO community_social_post_thumbnails(post_id,image_bytes,source,storage_source) VALUES($1,NULL,'upload','asset') ON CONFLICT(post_id) DO UPDATE SET source='upload',storage_source='asset',updated_at=clock_timestamp()",[target.targetId]);
   const result={intentId:row.intent_id,assetId:row.asset_id,postId:target.targetId,aggregateVersion:saved.media_version as string};return {aggregateVersion:result.aggregateVersion,result,fact:{aggregateType:'social_post',id:target.targetId,data:{asset_id:row.asset_id,intent_id:row.intent_id},eventType:'freedom.community.social.thumbnail.replaced.v1'}};
  },
 });
}
export type SocialThumbnailAssetService=ReturnType<typeof createSocialThumbnailAssetService>;
