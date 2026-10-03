import {Problem} from '../../packages/shared/problem.js';
import {objectKey,readPinnedObjectRange,readVerifiedObject,sha256,type ObjectStore} from '../../packages/asset-storage/index.js';
import {planObjectHttpRequest,type ObjectHttpPlan} from '../../packages/asset-storage/http-range.js';
import type {DomainMediaSnapshot} from '../../packages/media-migration/domain-bridge.js';
const missing=()=>new Problem(404,'media_not_found','找不到活動影片。');
const unavailable=()=>new Problem(503,'media_unavailable','內容暫時無法讀取。');
function identity(s:DomainMediaSnapshot){return JSON.stringify([s.purpose,s.targetId,s.variant,s.domainVersion,s.authorizationVersion,s.source,s.assetId,s.scopeId,s.representationId,s.metadata,s.legacyContentType]);}
/** Fresh original domain ACL before transport, and again after obtaining bytes
 * or a lazy stream. Partial ranges prove immutable ETag identity, never the
 * whole SHA-256. HEAD does not download the object. No retained SQL fallback. */
export async function readEventVideoHttp(snapshot:()=>Promise<DomainMediaSnapshot|undefined>,request:{method:'GET'|'HEAD';rangeHeader?:string; ifRangeHeader?:string},store?:ObjectStore):Promise<{plan:ObjectHttpPlan;body:Uint8Array|ReadableStream<Uint8Array>|null;wholeDigestVerified:boolean}>{
 const first=await snapshot();if(!first||first.purpose!=='community.event-video'||first.variant!=='video')throw missing();const pin=identity(first);
 const recheck=async()=>{const last=await snapshot();if(!last||identity(last)!==pin||(first.source==='legacy'&&(!last.legacyBytes||!first.legacyBytes||await sha256(last.legacyBytes)!==await sha256(first.legacyBytes))))throw missing();};
 if(first.source==='legacy'){
  if(!first.legacyBytes)throw missing();const etag=await sha256(first.legacyBytes),plan=planObjectHttpRequest({...request,byteSize:first.legacyBytes.length,contentType:first.legacyContentType!,etag});await recheck();return {plan,body:plan.sendBody?new Uint8Array(plan.range?first.legacyBytes.subarray(plan.range.offset,plan.range.offset+plan.range.length):first.legacyBytes):null,wholeDigestVerified:plan.sendBody&&!plan.range};
 }
 if(!store||!first.metadata||first.metadata.profileId!=='community.event-video'||!first.assetId||!first.scopeId||!first.representationId)throw unavailable();
 const key=objectKey({scopeId:first.scopeId,assetId:first.assetId,representationId:first.representationId});let body:ReadableStream<Uint8Array>|undefined;
 try{
  const head=await store.head(key);if(!head?.etag||!(['contentType','byteSize','sha256','transformVersion','policyRevision','profileId'] as const).every(field=>head.metadata[field]===first.metadata![field]))throw unavailable();
  const plan=planObjectHttpRequest({...request,byteSize:first.metadata.byteSize,contentType:first.metadata.contentType,etag:head.etag});
  if(!plan.sendBody){await recheck();return {plan,body:null,wholeDigestVerified:false};}
  if(plan.range){const ranged=await readPinnedObjectRange(store,key,first.metadata,plan.range,head.etag);body=ranged.body;await recheck();return {plan,body,wholeDigestVerified:false};}
  const full=await readVerifiedObject(store,key,first.metadata);if(full.etag!==head.etag)throw unavailable();await recheck();return {plan,body:full.bytes,wholeDigestVerified:true};
 }catch(error){if(body)await body.cancel().catch(()=>{});if(error instanceof Problem)throw error;throw unavailable();}
}
