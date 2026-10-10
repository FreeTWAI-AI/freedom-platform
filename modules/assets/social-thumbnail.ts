import {z} from 'zod';
import {createHash} from 'node:crypto';
import {digest,type Command} from '../../packages/db/index.js';
import type {LinkPreview} from '../community/link-preview.js';
import {socialPostCreateMemberCommand} from '../../packages/scoped-commands/index.js';
import {AssetStorageError,sha256} from '../../packages/asset-storage/index.js';
import {Problem} from '../../packages/shared/problem.js';
import type {Pool,PoolClient} from 'pg';
import type {MemberScopeContext} from '../../packages/resource-scopes/index.js';
import {OpaqueId} from '../../contracts/common/v1/identity.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {normalizeSocialThumbnail} from '../skill-submissions/payload.js';
import {authorizeNativeSocialReplay,authorizeSocialThumbnailWrite,preparedSocialPost,authorizeSocialCreate,publishSocialCreate,shownSocial,type NativeSocialDraft,type SocialCreationDraft,type SocialPostView} from '../community/social-posts.js';
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
/** Manual uploads, closed automatic-preview create and note-with-image create use the same finite profile. */
export function createSocialThumbnailAssetService(pool:Pool,dependencies:SocialThumbnailAssetDependencies){
 type Creation={id:string;command:Command;draft:SocialCreationDraft;source:'youtube'|'page'|'upload';now:Date;sourceDigest:string;key:string};
 function lifecycle(creation?:Creation){return createAssetLifecycle<z.infer<typeof input>,{intentId:string;assetId:string;postId:string;aggregateVersion:string}>(pool,dependencies,{
  purpose:'community.social-thumbnail',targetKind:'community.social-thumbnail',variant:'thumbnail',inputMaxBytes:524288,outputMaxBytes:524288,retireReplacedAsset:true,
  parsePrepare:raw=>input.parse(raw),targetId:raw=>raw.targetPostId,
  async lockTarget(q,context,actor,id,create){
   requireCondition(context.scope.kind==='community',403,'asset_scope_required','需要貼文的社群範圍。');
   let version:string;
   if(creation){requireCondition(id===creation.id&&actor.user_id===creation.command.actor.user_id,404,'asset_target_not_found','找不到這個目標。');await authorizeSocialCreate(q,actor,creation.draft,creation.now);
    if(create)await q.query('INSERT INTO community_social_thumbnail_asset_targets(post_id,community_id,scope_id,owner_principal_id,owner_user_id,create_key,create_digest,create_draft,create_source,create_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING',[id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id,creation.key,creation.sourceDigest,creation.draft,creation.source,creation.now]);
    const source=(await q.query('SELECT create_digest,create_at FROM community_social_thumbnail_asset_targets WHERE post_id=$1 FOR UPDATE',[id])).rows[0];requireCondition(source?.create_digest===creation.sourceDigest,409,'asset_source_mismatch','預覽來源已改變。');creation.now=new Date(source.create_at);version='1';
   }else version=(await authorizeSocialThumbnailWrite(q,actor,id,true)).media_version;
   if(create&&!creation)await q.query('INSERT INTO community_social_thumbnail_asset_targets(post_id,community_id,scope_id,owner_principal_id,owner_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id]);
   const pointer=(await q.query('SELECT asset_id FROM community_social_thumbnail_asset_targets WHERE post_id=$1 AND community_id=$2 AND scope_id=$3 AND owner_principal_id=$4 AND owner_user_id=$5 FOR UPDATE',[id,actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id])).rows[0];
   requireCondition(pointer,404,'asset_target_not_found','找不到這個目標。');return {targetId:id,aggregateVersion:version,assetId:pointer.asset_id};
  },
  async resolvePolicy(q,context,id){const canonical=await resolveSocialThumbnailUploadPolicy(q,context,id),installed=await dependencies.resolvePolicy(q,context,id);requireCondition(installed?.platformPersistenceAllowed===true&&installed.revision===canonical.revision&&typeof installed.retainedByteLimit==='string'&&/^[1-9][0-9]{0,18}$/.test(installed.retainedByteLimit),503,'media_upload_unavailable','內容上傳暫時無法使用。');return Object.freeze({...canonical,retainedByteLimit:BigInt(installed.retainedByteLimit)<BigInt(canonical.retainedByteLimit)?installed.retainedByteLimit:canonical.retainedByteLimit});},
  async requireCapacity(q,context,actor,_target,policy,reserve){
   const used=(await q.query("SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,524288)::bigint),0) AS used FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id) WHERE a.scope_id=$1 AND a.purpose='community.social-thumbnail'",[context.scope.scope_id])).rows[0];
   const legacy=(await q.query('SELECT COALESCE(sum(octet_length(t.image_bytes)),0) AS used FROM community_social_post_thumbnails t JOIN community_social_posts p USING(post_id) WHERE p.community_id=$1',[actor.community_id])).rows[0];
   requireCondition(BigInt(used.used)+BigInt(legacy.used)+BigInt(reserve)<=BigInt(policy.retainedByteLimit),409,'asset_retained_quota','內容儲存容量已達上限。');
  },
  async prepareRepresentation(body,mime,policy){if(creation)return prepareLegacyMediaRepresentation(body,mime,'community.social-thumbnail',policy);const raw=await readBounded(body,524288),webp=await normalizeSocialThumbnail(mime,Buffer.from(raw));return prepareLegacyMediaRepresentation(new ReadableStream({start(c){c.enqueue(webp);c.close();}}),'image/webp','community.social-thumbnail',policy);},
  async lockPublication(q,_context,actor,row){if(creation)await authorizeSocialCreate(q,actor,creation.draft,creation.now);else await authorizeSocialThumbnailWrite(q,actor,row.target_post_id!,true);return socialThumbnailStorageMode(q);},
  async publish(q,_context,actor,row,target,mode){
   requireCondition(mode!=='legacy',503,'media_upload_unavailable','內容上傳暫時無法使用。');if(creation)await publishSocialCreate(q,actor,target.targetId,creation.draft,creation.now);await authorizeSocialThumbnailWrite(q,actor,target.targetId,true);
   const saved=(await q.query('UPDATE community_social_posts SET media_version=media_version+1,updated_at=clock_timestamp() WHERE post_id=$1 AND media_version=$2 RETURNING media_version',[target.targetId,row.expected_version])).rows[0];requireCondition(saved,412,'version_conflict','資料已更新，請重新整理後再操作。');
   await q.query('UPDATE community_social_thumbnail_asset_targets SET asset_id=$2,linked_at_version=$3 WHERE post_id=$1',[target.targetId,row.asset_id,saved.media_version]);
   await q.query("INSERT INTO community_social_post_thumbnails(post_id,image_bytes,source,storage_source) VALUES($1,NULL,$2,'asset') ON CONFLICT(post_id) DO UPDATE SET source=EXCLUDED.source,storage_source='asset',updated_at=clock_timestamp()",[target.targetId,creation?.source??'upload']);
   const result={intentId:row.intent_id,assetId:row.asset_id,postId:target.targetId,aggregateVersion:saved.media_version as string};return {aggregateVersion:result.aggregateVersion,result,fact:{aggregateType:'social_post',id:target.targetId,data:{asset_id:row.asset_id,intent_id:row.intent_id},eventType:creation?.source==='upload'?'freedom.community.social.note.created.v1':creation?'freedom.community.social.preview.created.v1':'freedom.community.social.thumbnail.replaced.v1'}};
  },
 });}
 const manual=lifecycle();
 /** Reserve a deterministic post id for this command, upload the WebP, then publish post and pointer in one finalize. */
 async function publishCreation(command:Command,draft:SocialCreationDraft,source:Creation['source'],image:Buffer,now:Date){
  const hash=await sha256(image),key=digest({key:command.key,operation:command.operation});
  const hex=createHash('sha256').update(digest({owner:command.actor.user_id,key})).digest('hex'),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
  const authorizeReplay=(q:PoolClient)=>source==='upload'?authorizeNativeSocialReplay(q,command):Promise.resolve(false);
  const probe=async()=>{const miss=new Error('social_create_receipt_miss');try{return await socialPostCreateMemberCommand<SocialPostView>(pool,command,id,authorizeReplay,async()=>{throw miss;});}catch(e){if(e!==miss)throw e;}};const previous=await probe();if(previous)return previous;
  const create={id,command,draft,source,now,sourceDigest:digest({body:command.body,draft,source,hash,size:image.length}),key},api=lifecycle(create);
  try{const prepared=await api.prepare(command.actor,{key: digest({key,phase:'prepare'}),targetPostId:id,expectedVersion:'1',contentType:'image/webp',byteSize:image.length,sha256:hash}),lease=await api.resumeUpload(command.actor,{key,intentId:prepared.intentId}),bind={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
   if(lease.state==='prepared'||lease.state==='processing')await api.write(command.actor,{...bind,key:digest({key,phase:'write',fence:lease.fence})},new ReadableStream({start(c){c.enqueue(image);c.close();}}));let live:PoolClient;
   return await api.finalizeVia(command.actor,{...bind,key:digest({key,phase:'finalize'})},{operation:'community.social.post.create',validateIntent:row=>requireCondition(row.target_post_id===id&&row.source_sha256===hash,409,'asset_source_mismatch','圖片來源已改變。'),execute:run=>socialPostCreateMemberCommand(pool,command,id,async q=>{if(!await authorizeReplay(q))await authorizeSocialCreate(q,command.actor,draft,create.now);},async(q,context)=>{live=q;return run(q,context);}),result:()=>shownSocial(live!,command.actor,id)});
  }catch(error){const committed=await probe();if(committed)return committed;if(error instanceof AssetStorageError)throw new Problem(503,'media_upload_unavailable','圖片上傳暫時無法使用。');throw error;}
 }
 async function createPost(raw:Command,preview:LinkPreview,now:Date,publicOrigin:string){
  const command=Object.freeze({...raw,actor:Object.freeze({...raw.actor}),body:JSON.parse(JSON.stringify(raw.body))}),draft=preparedSocialPost(command.body,preview,publicOrigin);requireCondition(preview.image&&preview.source,503,'media_upload_unavailable','預覽來源暫時無法取得。');
  return publishCreation(command,draft,preview.source,Buffer.from(preview.image),now);
 }
 /** `image` is the already-normalized 640×360 WebP; the command body carries only the source digest. */
 async function createNativePost(raw:Command,draft:NativeSocialDraft,image:Buffer,now:Date){
  const command=Object.freeze({...raw,actor:Object.freeze({...raw.actor}),body:JSON.parse(JSON.stringify(raw.body))});
  return publishCreation(command,draft,'upload',Buffer.from(image),now);
 }
 return Object.freeze({...manual,createPost,createNativePost});
}
export type SocialThumbnailAssetService=ReturnType<typeof createSocialThumbnailAssetService>;
