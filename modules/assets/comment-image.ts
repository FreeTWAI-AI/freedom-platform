import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import {normalizeMessageImage, assertMessageImageSource, MESSAGE_IMAGE_INPUT_BYTES, MESSAGE_IMAGE_OUTPUT_BYTES} from './message-image.js';
export {assertMessageImageSource, MESSAGE_IMAGE_INPUT_BYTES, MESSAGE_IMAGE_OUTPUT_BYTES};
import type {MemberScopeContext} from '../../packages/resource-scopes/index.js';
import {OpaqueId} from '../../contracts/common/v1/identity.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import {readBounded,snapshotBoundedBytes,prepareLegacyMediaRepresentation,type ObjectStore} from '../../packages/asset-storage/index.js';
import {assetCommandKey,assetVersion,createAssetLifecycle,type LifecyclePolicy,type LifecycleTarget} from './engine.js';

const input=z.object({key:assetCommandKey,targetImageId:OpaqueId,expectedVersion:assetVersion,contentType:z.enum(['image/png','image/jpeg','image/webp']),
  byteSize:z.number().int().min(1).max(MESSAGE_IMAGE_INPUT_BYTES),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export type CommentImagePrepareInput=z.infer<typeof input>;
export interface CommentImageAssetDependencies {readonly store:ObjectStore;readonly intentTtlSeconds?:number;readonly leaseSeconds?:number;readonly maxPendingIntents?:number}
const unavailable=()=>new Problem(503,'media_upload_unavailable','圖片傳送暫時無法使用。');

/** There is no legacy byte source: 'legacy' is OFF; 'bridge' and 'r2_only' are the same ON state. */
export async function commentImageStorageMode(q:Pick<PoolClient,'query'>):Promise<'legacy'|'bridge'|'r2_only'>{
  const row=(await q.query("SELECT mode FROM domain_media_storage_policy WHERE purpose='community.comment-image' FOR SHARE")).rows[0];
  requireCondition(row,503,'media_upload_unavailable','圖片傳送暫時無法使用。');return row.mode;
}
export async function resolveCommentImageUploadPolicy(q:PoolClient):Promise<LifecyclePolicy>{
  const row=(await q.query("SELECT mode,policy_revision,persistence_allowed,retained_byte_limit::text AS retained_byte_limit FROM domain_media_storage_policy WHERE purpose='community.comment-image' FOR SHARE")).rows[0];
  requireCondition(row&&row.mode!=='legacy'&&row.persistence_allowed===true&&typeof row.policy_revision==='string'&&typeof row.retained_byte_limit==='string'&&BigInt(row.retained_byte_limit)>=BigInt(MESSAGE_IMAGE_OUTPUT_BYTES),503,'media_upload_unavailable','圖片傳送暫時無法使用。');
  return Object.freeze({revision:row.policy_revision as string,platformPersistenceAllowed:true,retainedByteLimit:row.retained_byte_limit as string});
}
/** Post visibility is checked and locked at every lifecycle phase, including replay. */
export async function lockCommentPost(q:PoolClient,actor:Actor,postId:string){
 const row=await q.query("SELECT 1 FROM community_social_posts WHERE post_id=$1 AND community_id=$2 AND state='active' FOR UPDATE",[postId,actor.community_id]);
 requireCondition(row.rowCount===1,404,'not_found','找不到這則貼文。');
}

interface ValidatedSource {readonly mime:string;readonly byteSize:number;readonly sha256:string;readonly webp:Buffer}
function lifecycle(pool:Pool,dependencies:CommentImageAssetDependencies,postId:string,source:ValidatedSource){
  async function lockTarget(q:PoolClient,context:MemberScopeContext,actor:Actor,id:string,create:boolean):Promise<LifecycleTarget>{
    requireCondition(context.scope.kind==='personal',403,'asset_scope_required','需要本人的私人範圍。');
    // Keep current post authority locked through target publication and replay.
    await lockCommentPost(q,actor,postId);
    if(create){
      await q.query('INSERT INTO community_comment_image_asset_targets(image_id,community_id,scope_id,owner_principal_id,owner_user_id,post_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id,postId]);
    }
    const pointer=(await q.query('SELECT asset_id,post_id FROM community_comment_image_asset_targets WHERE image_id=$1 AND community_id=$2 AND scope_id=$3 AND owner_principal_id=$4 AND owner_user_id=$5 FOR UPDATE',
      [id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id])).rows[0];
    requireCondition(pointer&&pointer.post_id===postId,404,'asset_target_not_found','找不到這個目標。');
    // One draft target links one Asset once; a different upload needs a new image id.
    if(create)requireCondition(pointer.asset_id===null,409,'comment_image_exists','這張圖片已經上傳。');
    return {targetId:id,aggregateVersion:'1',assetId:pointer.asset_id};
  }
  return createAssetLifecycle<CommentImagePrepareInput,{intentId:string;assetId:string;imageId:string}>(pool,dependencies,{
    purpose:'community.comment-image',targetKind:'community.comment-image',variant:'image',inputMaxBytes:MESSAGE_IMAGE_INPUT_BYTES,outputMaxBytes:MESSAGE_IMAGE_OUTPUT_BYTES,retireReplacedAsset:false,
    parsePrepare:raw=>{
      const value=input.parse(raw);
      requireCondition(value.contentType===source.mime&&value.byteSize===source.byteSize&&value.sha256===source.sha256,
        409,'asset_source_mismatch','上傳內容與準備紀錄不同。');
      return value;
    },targetId:value=>value.targetImageId,lockTarget,
    resolvePolicy:(q)=>resolveCommentImageUploadPolicy(q),
    async requireCapacity(q,context,_actor,_target,policy,reserve){
      const used=(await q.query("SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,1048576)::bigint),0) AS used FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE a.scope_id=$1 AND a.purpose='community.comment-image'",[context.scope.scope_id])).rows[0];
      requireCondition(BigInt(used.used)+BigInt(reserve)<=BigInt(policy.retainedByteLimit),409,'asset_retained_quota','圖片儲存容量已達上限。');
    },
    async prepareRepresentation(body,mime,policy){
      const raw=await readBounded(body,MESSAGE_IMAGE_INPUT_BYTES);
      requireCondition(mime===source.mime&&raw.length===source.byteSize&&createHash('sha256').update(raw).digest('hex')===source.sha256,
        409,'asset_source_mismatch','上傳內容與準備紀錄不同。');
      // Reuse only this request's fully decoded representation. Source binding
      // still matches the intent; no caller-supplied canonical bytes are accepted.
      return prepareLegacyMediaRepresentation(new ReadableStream({start(c){c.enqueue(Buffer.from(source.webp));c.close();}}),'image/webp','community.comment-image',policy);
    },
    async lockPublication(q,_context,actor){await lockCommentPost(q,actor,postId);return commentImageStorageMode(q);},
    async publish(q,_context,_actor,row,target,mode){
      requireCondition(mode!=='legacy',503,'media_upload_unavailable','圖片傳送暫時無法使用。');
      const linked=await q.query('UPDATE community_comment_image_asset_targets SET asset_id=$2,linked_at_version=1 WHERE image_id=$1 AND asset_id IS NULL',[target.targetId,row.asset_id]);
      requireCondition(linked.rowCount===1,409,'comment_image_exists','這張圖片已經上傳。');
      const result={intentId:row.intent_id,assetId:row.asset_id,imageId:target.targetId};
      // Journal only: private content never reaches the community outbox.
      return {aggregateVersion:'1',result,fact:{aggregateType:'community_comment_image',id:target.targetId,data:{asset_id:row.asset_id,intent_id:row.intent_id}}};
    },
  });
}
/** One lifecycle per request/post. Decode before prepare can commit quota;
 * failed input must not leave a permanently retained pending Asset. The upload
 * facade checks its original receipt before asking for this new-effect port. */
export function createCommentImageAssetService(pool:Pool,dependencies:CommentImageAssetDependencies){
  if(!dependencies?.store)throw unavailable();
  return Object.freeze({async forPost(postId:string,file:{mime:string;bytes:Buffer}){
    const id=OpaqueId.parse(postId),mime=file.mime;
    const bytes=Buffer.from(snapshotBoundedBytes(file.bytes,MESSAGE_IMAGE_INPUT_BYTES));
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const webp=Buffer.from(await normalizeMessageImage(mime,bytes));
    return lifecycle(pool,dependencies,id,Object.freeze({mime,byteSize:bytes.length,sha256,webp}));
  }});
}
export type CommentImageAssetService=ReturnType<typeof createCommentImageAssetService>;
