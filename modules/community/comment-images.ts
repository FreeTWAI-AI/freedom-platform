import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {digest,type Command} from '../../packages/db/index.js';
import {AssetStorageError,snapshotBoundedBytes,type ObjectStore} from '../../packages/asset-storage/index.js';
import {commentImageMemberCommand} from '../../packages/scoped-commands/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import type {DomainMediaSnapshot} from '../../packages/media-migration/domain-bridge.js';
import {readDomainMedia} from '../../packages/media-migration/domain-bridge.js';
import type {Actor} from '../identity-membership/service.js';
import {MESSAGE_IMAGE_INPUT_BYTES,assertMessageImageSource,lockCommentPost,type CommentImageAssetService} from '../assets/comment-image.js';
type CommentImage={content_type:'image/webp';byte_size:number};

export interface CommentImageUpload extends CommentImage {image_id:string}
const unavailable=()=>new Problem(503,'media_upload_unavailable','圖片傳送暫時無法使用。');

/** The draft target id is derived from the sender and the Idempotency-Key, so a
 * lost response replays to the same image instead of creating another upload. */
function imageIdFor(actor:Actor,postId:string,key:string){
  const hex=createHash('sha256').update(digest({purpose:'community.comment-image',owner:actor.user_id,postId,key})).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

/** Upload one image for a later comment on `postId`. Orchestrates the
 * Asset lifecycle server-side so a browser never holds an upload lease. */
export async function uploadCommentImage(pool:Pool,raw:Command,rawPostId:string,file:{bytes:Buffer;mime:string},assets?:CommentImageAssetService):Promise<CommentImageUpload>{
  const postId=rawPostId.toLowerCase();
  const bytes=Buffer.from(snapshotBoundedBytes(file.bytes,MESSAGE_IMAGE_INPUT_BYTES)),mime=file.mime;
  assertMessageImageSource(mime,bytes);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const actor=Object.freeze({...raw.actor}),operation=`POST /api/v1/social-posts/${postId}/comment-images`;
  const input:Command=Object.freeze({...raw,actor,operation,body:{sha256}});
  const imageId=imageIdFor(actor,postId,raw.key);
  const authorize=async(q:PoolClient)=>{await lockCommentPost(q,actor,postId);};
  const result=async(q:Pick<PoolClient,'query'>):Promise<CommentImageUpload>=>{
    const row=(await q.query(`SELECT o.byte_size FROM community_comment_image_asset_targets t JOIN asset_objects o ON o.asset_id=t.asset_id AND o.purpose='community.comment-image'
      WHERE t.image_id=$1 AND t.owner_user_id=$2 AND t.post_id=$3`,[imageId,actor.user_id,postId])).rows[0];
    requireCondition(row,404,'image_not_available','找不到這張圖片。');
    return {image_id:imageId,content_type:'image/webp',byte_size:row.byte_size as number};
  };
  const probe=async()=>{const miss=new Error('comment_image_receipt_miss');try{return await commentImageMemberCommand<CommentImageUpload>(pool,input,imageId,authorize,async()=>{throw miss;});}catch(error){if(error!==miss)throw error;return undefined;}};
  // A committed original request replays without rereading or rewriting bytes.
  const replay=await probe();if(replay)return replay;
  requireCondition(assets,503,'media_upload_unavailable','圖片傳送暫時無法使用。');
  const key=digest({operation,key:raw.key});
  try{
    // Successful original receipts already returned above. Fully validate new
    // input before prepare persists an Asset/intent and reserves retained quota.
    const api=await assets!.forPost(postId,{bytes,mime});
    const prepared=await api.prepare(actor,{key,targetImageId:imageId,expectedVersion:'1',contentType:mime as 'image/png'|'image/jpeg'|'image/webp',byteSize:bytes.length,sha256});
    const lease=await api.resumeUpload(actor,{key,intentId:prepared.intentId});
    const binding={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
    if(lease.state==='prepared'||lease.state==='processing')await api.write(actor,{...binding,key:digest({key,phase:'write',fence:lease.fence})},new ReadableStream({start(c){c.enqueue(bytes);c.close();}}));
    let publicationClient!:PoolClient;
    return await api.finalizeVia<CommentImageUpload>(actor,{...binding,key:digest({key,phase:'finalize'})},{
      operation:'community.comment-image.upload',
      execute:run=>commentImageMemberCommand(pool,input,imageId,authorize,async(q,context)=>{publicationClient=q;return run(q,context);}),
      validateIntent:row=>requireCondition(row.target_comment_image_id===imageId&&row.source_sha256===sha256&&row.expected_version==='1',409,'asset_source_mismatch','上傳內容與準備紀錄不同。'),
      result:()=>result(publicationClient),
    });
  }catch(error){
    const committed=await probe().catch(()=>undefined);if(committed)return committed;
    if(error instanceof AssetStorageError)throw unavailable();throw error;
  }
}

/** The comment and parent post are authoritative, before and after object I/O. */
async function imageSnapshot(pool:Pool,actor:Actor,postId:string,commentId:string):Promise<DomainMediaSnapshot|undefined>{
 const row=(await pool.query(`SELECT t.asset_id,t.scope_id,a.representation_id,o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision,o.profile_id
 FROM community_social_comments c JOIN community_social_posts p USING(post_id)
 JOIN community_comment_image_asset_targets t ON t.comment_id=c.comment_id AND t.post_id=p.post_id
 JOIN assets a ON a.asset_id=t.asset_id AND a.purpose='community.comment-image' AND a.state='ready' AND a.deletion_fence=0
 JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose=a.purpose
 JOIN users v ON v.user_id=$3 AND v.community_id=$2 AND v.active AND (NOT v.onboarding_required OR v.onboarding_completed_at IS NOT NULL)
 JOIN sessions s ON s.token_hash=$5 AND s.user_id=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 WHERE c.comment_id=$1 AND c.community_id=$2 AND p.community_id=$2 AND p.post_id=$4 AND c.state='active' AND p.state='active'`,
 [commentId,actor.community_id,actor.user_id,postId,actor.session_hash])).rows[0];
 if(!row)return;
 return {purpose:'community.comment-image',targetId:commentId,variant:'image',domainVersion:'1',source:'asset',authorizationVersion:postId,legacyBytes:null,
 assetId:row.asset_id,scopeId:row.scope_id,representationId:row.representation_id,
 metadata:{contentType:row.content_type,byteSize:row.byte_size,sha256:row.content_sha256,transformVersion:row.transform_version,policyRevision:row.policy_revision,profileId:row.profile_id}};
}
export async function readCommentImage(pool:Pool,actor:Actor,postId:string,commentId:string,store?:ObjectStore){
 return (await readDomainMedia(()=>imageSnapshot(pool,actor,postId,commentId),{purpose:'community.comment-image',targetId:commentId,variant:'image'},store)).bytes;
}
