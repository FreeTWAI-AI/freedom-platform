import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import type {MemberScopeContext} from '../../packages/resource-scopes/index.js';
import type {Actor} from '../identity-membership/service.js';
import {digest,type Command} from '../../packages/db/index.js';
import {OpaqueId} from '../../contracts/common/v1/identity.js';
import {requireCondition,Problem} from '../../packages/shared/problem.js';
import {highlightMemberCommand} from '../../packages/scoped-commands/index.js';
import {AssetStorageError,prepareLegacyMediaRepresentation,sha256,type ObjectStore} from '../../packages/asset-storage/index.js';
import {authorizeHighlightUpload,publishHighlightAssetPair,cleanHighlightTitle} from '../community/event-highlights.js';
import {createAssetLifecycle,assetCommandKey,type LifecyclePolicy,type LifecycleIntent} from './engine.js';
const IMAGE_MAX=1048576,THUMB_MAX=204800,PAIR_MAX=IMAGE_MAX+THUMB_MAX;
const bodySchema=z.object({sha256:z.string().regex(/^[0-9a-f]{64}$/),orientation:z.enum(['landscape','portrait']),title:z.string().max(120).nullable()}).strict();
const prepareSchema=z.object({key:assetCommandKey,targetMediaId:OpaqueId,expectedVersion:z.literal('1'),contentType:z.literal('image/webp'),byteSize:z.number().int().positive(),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
type Prepare=z.infer<typeof prepareSchema>;
type Published=Awaited<ReturnType<typeof publishHighlightAssetPair>>;
export interface EventHighlightAssetDependencies {readonly store:ObjectStore;readonly resolvePolicy:(q:PoolClient,context:MemberScopeContext,id:string)=>Promise<LifecyclePolicy>;readonly intentTtlSeconds?:number;readonly leaseSeconds?:number;readonly maxPendingIntents?:number;}
export async function highlightStorageMode(q:Pick<PoolClient,'query'>):Promise<'legacy'|'bridge'|'r2_only'>{const row=(await q.query("SELECT mode FROM domain_media_storage_policy WHERE purpose='community.event-highlight' FOR SHARE")).rows[0];requireCondition(row,503,'media_upload_unavailable','內容上傳暫時無法使用。');return row.mode;}
export async function resolveEventHighlightUploadPolicy(q:PoolClient,context:MemberScopeContext,_id:string):Promise<LifecyclePolicy>{
 requireCondition(context.scope.kind==='community',403,'asset_scope_required','需要活動的社群範圍。');
 const row=(await q.query("SELECT mode,policy_revision,persistence_allowed,retained_byte_limit::text AS retained_byte_limit FROM domain_media_storage_policy WHERE purpose='community.event-highlight' FOR SHARE")).rows[0];
 requireCondition(row&&row.mode!=='legacy'&&row.persistence_allowed===true&&typeof row.policy_revision==='string'&&typeof row.retained_byte_limit==='string'&&BigInt(row.retained_byte_limit)>=BigInt(PAIR_MAX),503,'media_upload_unavailable','內容上傳暫時無法使用。');
 return Object.freeze({revision:row.policy_revision,platformPersistenceAllowed:true,retainedByteLimit:row.retained_byte_limit});
}
function pairId(actor:Actor,input:Command){const bytes=createHash('sha256').update(digest({operation:input.operation,key:input.key,user:actor.user_id,community:actor.community_id})).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
/** Server-only paired facade. Two common lifecycle callbacks are captured after
 * closed verification transactions, then consumed immediately on ONE original
 * receipt transaction. No SQL locks span object I/O; no context is exported. */
export function createEventHighlightAssetService(pool:Pool,dependencies:EventHighlightAssetDependencies){
 async function uploadPair(raw:Command,eventId:string,kind:'photo'|'poster',rawImage:Buffer,rawThumb:Buffer,orientation:'landscape'|'portrait',rawTitle:string|null):Promise<Published>{
  const actor=Object.freeze({...raw.actor}),body=Object.freeze(bodySchema.parse(raw.body)),title=cleanHighlightTitle(rawTitle);
  requireCondition(body.orientation===orientation&&body.title===title&&raw.operation===`POST /api/v1/event-highlights/${OpaqueId.parse(eventId)}/${kind==='photo'?'photos':'posters'}`,400,'invalid_highlight_command','集錦操作資料無效。');
  const input=Object.freeze({...raw,actor,body}),mediaId=pairId(actor,input),image=Buffer.from(rawImage),thumb=Buffer.from(rawThumb);
  requireCondition(image.length>0&&image.length<=IMAGE_MAX&&thumb.length>0&&thumb.length<=THUMB_MAX,413,'highlight_image_too_large','圖片變體過大。');
  const imageSha=await sha256(image),thumbSha=await sha256(thumb),sourceDigest=digest({eventId,kind,body,imageSha,thumbSha,imageSize:image.length,thumbSize:thumb.length});
  const authorize=(q:PoolClient)=>authorizeHighlightUpload(q,actor,eventId,kind);
  const probe=async()=>{const miss=new Error('highlight_receipt_miss');try{return await highlightMemberCommand<Published>(pool,input,mediaId,authorize,async()=>{throw miss;});}catch(error){if(error!==miss)throw error;return undefined;}};
  const previous=await probe();if(previous)return previous;
  let imageAssetId:string,thumbAssetId:string;
  async function policy(q:PoolClient,context:MemberScopeContext,id:string){const canonical=await resolveEventHighlightUploadPolicy(q,context,id),installed=await dependencies.resolvePolicy(q,context,id);requireCondition(installed?.platformPersistenceAllowed===true&&installed.revision===canonical.revision&&typeof installed.retainedByteLimit==='string'&&/^[1-9][0-9]{0,18}$/.test(installed.retainedByteLimit),503,'media_upload_unavailable','內容上傳暫時無法使用。');return Object.freeze({...canonical,retainedByteLimit:BigInt(installed.retainedByteLimit)<BigInt(canonical.retainedByteLimit)?installed.retainedByteLimit:canonical.retainedByteLimit});}
  function component(variant:'image'|'thumb'){
   const size=variant==='image'?IMAGE_MAX:THUMB_MAX,bytes=variant==='image'?image:thumb,sourceSha=variant==='image'?imageSha:thumbSha,profileId=variant==='image'?'community.event-highlight' as const:'community.event-highlight.thumbnail' as const;
   return createAssetLifecycle<Prepare,Published|undefined>(pool,{...dependencies,maxPendingIntents:dependencies.maxPendingIntents??6},{
    purpose:'community.event-highlight',targetKind:variant==='image'?'community.event-highlight.image':'community.event-highlight.thumb',variant,inputMaxBytes:size,outputMaxBytes:size,retireReplacedAsset:false,
    parsePrepare(raw){const parsed=prepareSchema.parse(raw);requireCondition(parsed.targetMediaId===mediaId&&parsed.byteSize===bytes.length&&parsed.sha256===sourceSha,409,'asset_source_mismatch','上傳內容與準備紀錄不同。');return parsed;},targetId:p=>p.targetMediaId,
    async lockTarget(q,context,current,id,create){
     requireCondition(context.scope.kind==='community'&&id===mediaId&&current.user_id===actor.user_id,404,'asset_target_not_found','找不到這個目標。');await authorizeHighlightUpload(q,current,eventId,kind,true,true);
     if(create)await q.query('INSERT INTO community_event_highlight_asset_targets(media_id,event_id,community_id,scope_id,owner_principal_id,owner_user_id,source_digest) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[mediaId,eventId,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id,sourceDigest]);
     const target=(await q.query('SELECT source_digest FROM community_event_highlight_asset_targets WHERE media_id=$1 AND event_id=$2 AND community_id=$3 AND scope_id=$4 AND owner_principal_id=$5 AND owner_user_id=$6 FOR UPDATE',[mediaId,eventId,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id])).rows[0];requireCondition(target&&target.source_digest===sourceDigest,409,'asset_source_mismatch','上傳內容與準備紀錄不同。');return {targetId:mediaId,aggregateVersion:'1',assetId:null};
    },resolvePolicy:policy,
    async requireCapacity(q,context,_actor,_target,resolved){
     const used=(await q.query(`SELECT COALESCE((SELECT sum(COALESCE(o.byte_size,i.reserved_bytes,1048576)::bigint) FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE a.scope_id=$1 AND a.purpose='community.event-highlight'),0)
      + (SELECT count(*)*204800 FROM community_event_highlight_asset_targets t WHERE t.scope_id=$1 AND EXISTS(SELECT 1 FROM asset_upload_intents i WHERE i.target_highlight_media_id=t.media_id AND i.target_kind='community.event-highlight.image') AND NOT EXISTS(SELECT 1 FROM asset_upload_intents i WHERE i.target_highlight_media_id=t.media_id AND i.target_kind='community.event-highlight.thumb')) AS used`,[context.scope.scope_id])).rows[0];
     const legacy=(await q.query('SELECT COALESCE(sum(octet_length(i.bytes)),0) AS used FROM community_event_highlight_images i JOIN community_event_highlights h USING(media_id) WHERE h.community_id=$1',[actor.community_id])).rows[0];
     requireCondition(BigInt(used.used)+BigInt(legacy.used)+BigInt(variant==='image'?PAIR_MAX:0)<=BigInt(resolved.retainedByteLimit),409,'asset_retained_quota','內容儲存容量已達上限。');
    },prepareRepresentation:(body,mime,resolved)=>prepareLegacyMediaRepresentation(body,mime,profileId,resolved),
    async lockPublication(q,_context,current){await authorizeHighlightUpload(q,current,eventId,kind,true,true);return highlightStorageMode(q);},
    async publish(q,_context,current,row,_target,mode){
     requireCondition(mode!=='legacy',503,'media_upload_unavailable','內容上傳暫時無法使用。');
     let result:Published|undefined;
     if(variant==='thumb'){
      const ready=(await q.query("SELECT asset_id FROM assets WHERE asset_id=ANY($1::uuid[]) AND state='ready' AND purpose='community.event-highlight' ORDER BY asset_id",[[imageAssetId,thumbAssetId]])).rows;
      requireCondition(ready.length===2,409,'asset_pair_incomplete','圖片變體尚未就緒。');
      result=await publishHighlightAssetPair(q,current,eventId,mediaId,kind,image.length,orientation,title);
      await q.query('UPDATE community_event_highlight_asset_targets SET image_asset_id=$2,thumb_asset_id=$3,published_at=clock_timestamp() WHERE media_id=$1',[mediaId,imageAssetId,thumbAssetId]);
     }
     return {aggregateVersion:'1',result,fact:{aggregateType:'community_event_highlight',id:mediaId,data:{image_asset_id:imageAssetId,thumb_asset_id:thumbAssetId,variant,intent_id:row.intent_id}}};
    },
   });
  }
  const main=component('image'),preview=component('thumb'),key=digest({operation:input.operation,key:input.key});
  try{
   const preparedImage=await main.prepare(actor,{key:digest({key,variant:'image'}),targetMediaId:mediaId,expectedVersion:'1',contentType:'image/webp',byteSize:image.length,sha256:imageSha});
   const preparedThumb=await preview.prepare(actor,{key:digest({key,variant:'thumb'}),targetMediaId:mediaId,expectedVersion:'1',contentType:'image/webp',byteSize:thumb.length,sha256:thumbSha});
   imageAssetId=preparedImage.assetId;thumbAssetId=preparedThumb.assetId;
   const imageLease=await main.resumeUpload(actor,{key,intentId:preparedImage.intentId}),thumbLease=await preview.resumeUpload(actor,{key,intentId:preparedThumb.intentId});
   const bind=(lease:typeof imageLease)=>({intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken});
   if(imageLease.state==='prepared'||imageLease.state==='processing')await main.write(actor,{...bind(imageLease),key:digest({key,phase:'write-image',fence:imageLease.fence})},new ReadableStream({start(c){c.enqueue(image);c.close();}}));
   if(thumbLease.state==='prepared'||thumbLease.state==='processing')await preview.write(actor,{...bind(thumbLease),key:digest({key,phase:'write-thumb',fence:thumbLease.fence})},new ReadableStream({start(c){c.enqueue(thumb);c.close();}}));
   const validate=(row:LifecycleIntent,variant:'image'|'thumb')=>requireCondition(row.target_highlight_media_id===mediaId&&row.source_sha256===(variant==='image'?imageSha:thumbSha),409,'asset_source_mismatch','上傳內容與準備紀錄不同。');
   const result=await main.finalizeVia<Published|undefined>(actor,{...bind(imageLease),key:digest({key,phase:'finalize-image'})},{operation:'community.event.highlight.create',validateIntent:row=>validate(row,'image'),result:value=>value,
    execute:runImage=>preview.finalizeVia<Published>(actor,{...bind(thumbLease),key:digest({key,phase:'finalize-thumb'})},{operation:'community.event.highlight.create',validateIntent:row=>validate(row,'thumb'),result:value=>{requireCondition(value,409,'asset_pair_incomplete','圖片變體尚未就緒。');return value;},
     execute:runThumb=>highlightMemberCommand(pool,input,mediaId,async(q,context)=>{
      await authorizeHighlightUpload(q,actor,eventId,kind,true,true);
      const target=(await q.query('SELECT source_digest FROM community_event_highlight_asset_targets WHERE media_id=$1 AND scope_id=$2 AND owner_principal_id=$3 FOR UPDATE',[mediaId,context.scope.scope_id,context.subject_principal.principal_id])).rows[0];requireCondition(target?.source_digest===sourceDigest,409,'asset_source_mismatch','上傳內容與準備紀錄不同。');
      await q.query('SELECT asset_id FROM assets WHERE asset_id=ANY($1::uuid[]) ORDER BY asset_id FOR UPDATE',[[imageAssetId,thumbAssetId]]);await policy(q,context,mediaId);
     },async(q,context)=>{await runImage(q,context);return runThumb(q,context);})})});
   requireCondition(result,409,'asset_pair_incomplete','圖片變體尚未就緒。');return result;
  }catch(error){const committed=await probe();if(committed)return committed;if(error instanceof AssetStorageError)throw new Problem(503,'media_upload_unavailable','內容上傳暫時無法使用。');throw error;}
 }
 return Object.freeze({uploadPair});
}
export type EventHighlightAssetService=ReturnType<typeof createEventHighlightAssetService>;
