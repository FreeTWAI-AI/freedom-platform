import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import type {MemberScopeContext} from '../../packages/resource-scopes/index.js';
import {OpaqueId} from '../../contracts/common/v1/identity.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import {normalizeImage} from '../../packages/shared/image-runtime.js';
import {readBounded,snapshotBoundedBytes,prepareLegacyMediaRepresentation,type ObjectStore} from '../../packages/asset-storage/index.js';
import {COVER_MAX_DIMENSION,COVER_MAX_PIXELS,rasterFormat,rejectAnimation} from '../skill-submissions/payload.js';
import {assetCommandKey,assetVersion,createAssetLifecycle,type LifecyclePolicy,type LifecycleTarget} from './engine.js';

/** Direct-message image attachments (#230). Sender-owned personal Assets bound to
 * one recipient; read authority is the message row, never the Asset scope. */
export const MESSAGE_IMAGE_INPUT_BYTES=2*1024*1024;
export const MESSAGE_IMAGE_OUTPUT_BYTES=1024*1024;
/** Longest edge of the re-encoded WebP. Smaller images are never enlarged. */
export const MESSAGE_IMAGE_MAX_EDGE=1920;
export const MESSAGE_IMAGE_MIME_TYPES=new Set(['image/jpeg','image/png','image/webp']);
const invalidImage=()=>new Problem(422,'invalid_message_image','圖片無法使用。請選擇完整的靜態 JPEG、PNG 或 WebP，長寬各不超過 4096 像素。');

/** Cheap structural gate run before any database or object work. */
export function assertMessageImageSource(mime:string,bytes:Buffer){
  requireCondition(MESSAGE_IMAGE_MIME_TYPES.has(mime),415,'message_image_format','請選擇 JPEG、PNG 或 WebP 圖片。');
  requireCondition(bytes.length>0,422,'invalid_message_image','請先選擇圖片。');
  requireCondition(bytes.length<=MESSAGE_IMAGE_INPUT_BYTES,413,'message_image_too_large','圖片需為 2 MB 以下的檔案。');
  const format=rasterFormat(bytes);
  if(!format||mime!==`image/${format}`)throw invalidImage();
  try{rejectAnimation(bytes,format);}catch(error){if(error instanceof Problem)throw invalidImage();throw error;}
  return format;
}
/** Full decode, orientation, metadata removal and re-encode as canonical WebP. */
export async function normalizeMessageImage(mime:string,bytes:Buffer):Promise<Buffer>{
  const format=assertMessageImageSource(mime,bytes);
  try{
    const webp=await normalizeImage(bytes,{purpose:'message_image',format,maxDimension:COVER_MAX_DIMENSION,maxPixels:COVER_MAX_PIXELS,maxOutputBytes:MESSAGE_IMAGE_OUTPUT_BYTES,
      output:{width:MESSAGE_IMAGE_MAX_EDGE,height:MESSAGE_IMAGE_MAX_EDGE,fit:'inside',quality:80,effort:4}});
    requireCondition(webp.length>0&&webp.length<=MESSAGE_IMAGE_OUTPUT_BYTES,422,'message_image_too_large','這張圖片壓縮後仍過大，請換一張較小或較簡單的圖片。');
    return webp;
  }catch(error){if(error instanceof Problem)throw error;throw invalidImage();}
}

const input=z.object({key:assetCommandKey,targetImageId:OpaqueId,expectedVersion:assetVersion,contentType:z.enum(['image/png','image/jpeg','image/webp']),
  byteSize:z.number().int().min(1).max(MESSAGE_IMAGE_INPUT_BYTES),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export type MessageImagePrepareInput=z.infer<typeof input>;
export interface MessageImageAssetDependencies {readonly store:ObjectStore;readonly intentTtlSeconds?:number;readonly leaseSeconds?:number;readonly maxPendingIntents?:number}
const unavailable=()=>new Problem(503,'media_upload_unavailable','圖片傳送暫時無法使用。');

/** There is no legacy byte source: 'legacy' is OFF; 'bridge' and 'r2_only' are the same ON state. */
export async function messageImageStorageMode(q:Pick<PoolClient,'query'>):Promise<'legacy'|'bridge'|'r2_only'>{
  const row=(await q.query("SELECT mode FROM domain_media_storage_policy WHERE purpose='member.message-image' FOR SHARE")).rows[0];
  requireCondition(row,503,'media_upload_unavailable','圖片傳送暫時無法使用。');return row.mode;
}
export async function resolveMessageImageUploadPolicy(q:PoolClient):Promise<LifecyclePolicy>{
  const row=(await q.query("SELECT mode,policy_revision,persistence_allowed,retained_byte_limit::text AS retained_byte_limit FROM domain_media_storage_policy WHERE purpose='member.message-image' FOR SHARE")).rows[0];
  requireCondition(row&&row.mode!=='legacy'&&row.persistence_allowed===true&&typeof row.policy_revision==='string'&&typeof row.retained_byte_limit==='string'&&BigInt(row.retained_byte_limit)>=BigInt(MESSAGE_IMAGE_OUTPUT_BYTES),503,'media_upload_unavailable','圖片傳送暫時無法使用。');
  return Object.freeze({revision:row.policy_revision as string,platformPersistenceAllowed:true,retainedByteLimit:row.retained_byte_limit as string});
}
/** A recipient must be a current, onboarded member of the sender's community. */
export async function lockMessageRecipient(q:PoolClient,actor:Actor,recipientId:string){
  requireCondition(recipientId!==actor.user_id,404,'member_not_found','找不到這位會員。');
  const row=await q.query(`SELECT 1 FROM users u WHERE u.user_id=$1 AND u.community_id=$2 AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) FOR SHARE`,[recipientId,actor.community_id]);
  requireCondition(row.rowCount===1,404,'member_not_found','找不到這位會員。');
}

interface ValidatedSource {readonly mime:string;readonly byteSize:number;readonly sha256:string;readonly webp:Buffer}
function lifecycle(pool:Pool,dependencies:MessageImageAssetDependencies,recipientId:string,source:ValidatedSource){
  async function lockTarget(q:PoolClient,context:MemberScopeContext,actor:Actor,id:string,create:boolean):Promise<LifecycleTarget>{
    requireCondition(context.scope.kind==='personal',403,'asset_scope_required','需要本人的私人範圍。');
    if(create){
      await lockMessageRecipient(q,actor,recipientId);
      await q.query('INSERT INTO member_message_image_asset_targets(image_id,community_id,scope_id,owner_principal_id,owner_user_id,recipient_user_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id,recipientId]);
    }
    const pointer=(await q.query('SELECT asset_id,recipient_user_id FROM member_message_image_asset_targets WHERE image_id=$1 AND community_id=$2 AND scope_id=$3 AND owner_principal_id=$4 AND owner_user_id=$5 FOR UPDATE',
      [id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id])).rows[0];
    requireCondition(pointer&&pointer.recipient_user_id===recipientId,404,'asset_target_not_found','找不到這個目標。');
    // One draft target links one Asset once; a different upload needs a new image id.
    if(create)requireCondition(pointer.asset_id===null,409,'message_image_exists','這張圖片已經上傳。');
    return {targetId:id,aggregateVersion:'1',assetId:pointer.asset_id};
  }
  return createAssetLifecycle<MessageImagePrepareInput,{intentId:string;assetId:string;imageId:string}>(pool,dependencies,{
    purpose:'member.message-image',targetKind:'member.message-image',variant:'image',inputMaxBytes:MESSAGE_IMAGE_INPUT_BYTES,outputMaxBytes:MESSAGE_IMAGE_OUTPUT_BYTES,retireReplacedAsset:false,
    parsePrepare:raw=>{
      const value=input.parse(raw);
      requireCondition(value.contentType===source.mime&&value.byteSize===source.byteSize&&value.sha256===source.sha256,
        409,'asset_source_mismatch','上傳內容與準備紀錄不同。');
      return value;
    },targetId:value=>value.targetImageId,lockTarget,
    resolvePolicy:(q)=>resolveMessageImageUploadPolicy(q),
    async requireCapacity(q,context,_actor,_target,policy,reserve){
      const used=(await q.query("SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,1048576)::bigint),0) AS used FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE a.scope_id=$1 AND a.purpose='member.message-image'",[context.scope.scope_id])).rows[0];
      requireCondition(BigInt(used.used)+BigInt(reserve)<=BigInt(policy.retainedByteLimit),409,'asset_retained_quota','圖片儲存容量已達上限。');
    },
    async prepareRepresentation(body,mime,policy){
      const raw=await readBounded(body,MESSAGE_IMAGE_INPUT_BYTES);
      requireCondition(mime===source.mime&&raw.length===source.byteSize&&createHash('sha256').update(raw).digest('hex')===source.sha256,
        409,'asset_source_mismatch','上傳內容與準備紀錄不同。');
      // Reuse only this request's fully decoded representation. Source binding
      // still matches the intent; no caller-supplied canonical bytes are accepted.
      return prepareLegacyMediaRepresentation(new ReadableStream({start(c){c.enqueue(Buffer.from(source.webp));c.close();}}),'image/webp','member.message-image',policy);
    },
    async lockPublication(q,_context,actor){await lockMessageRecipient(q,actor,recipientId);return messageImageStorageMode(q);},
    async publish(q,_context,_actor,row,target,mode){
      requireCondition(mode!=='legacy',503,'media_upload_unavailable','圖片傳送暫時無法使用。');
      const linked=await q.query('UPDATE member_message_image_asset_targets SET asset_id=$2,linked_at_version=1 WHERE image_id=$1 AND asset_id IS NULL',[target.targetId,row.asset_id]);
      requireCondition(linked.rowCount===1,409,'message_image_exists','這張圖片已經上傳。');
      const result={intentId:row.intent_id,assetId:row.asset_id,imageId:target.targetId};
      // Journal only: private content never reaches the community outbox.
      return {aggregateVersion:'1',result,fact:{aggregateType:'member_message_image',id:target.targetId,data:{asset_id:row.asset_id,intent_id:row.intent_id}}};
    },
  });
}
/** One lifecycle per request/recipient. Decode before prepare can commit quota;
 * failed input must not leave a permanently retained pending Asset. The upload
 * facade checks its original receipt before asking for this new-effect port. */
export function createMessageImageAssetService(pool:Pool,dependencies:MessageImageAssetDependencies){
  if(!dependencies?.store)throw unavailable();
  return Object.freeze({async forRecipient(recipientId:string,file:{mime:string;bytes:Buffer}){
    const id=OpaqueId.parse(recipientId),mime=file.mime;
    const bytes=Buffer.from(snapshotBoundedBytes(file.bytes,MESSAGE_IMAGE_INPUT_BYTES));
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const webp=Buffer.from(await normalizeMessageImage(mime,bytes));
    return lifecycle(pool,dependencies,id,Object.freeze({mime,byteSize:bytes.length,sha256,webp}));
  }});
}
export type MessageImageAssetService=ReturnType<typeof createMessageImageAssetService>;
