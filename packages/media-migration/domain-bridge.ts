import { createHash } from 'node:crypto';
import { Problem } from '../shared/problem.js';
import { objectKey,readVerifiedObject,type ObjectStore,type ObjectMetadata } from '../asset-storage/index.js';
import { validDomainVariant,type DomainMediaPurpose,type DomainMediaVariant } from '../../modules/assets/schema.js';

/** Domain snapshots come from the same original ACL query before and after I/O.
 * No caller-selected object key, raw owner type, or byte fallback is accepted. */
export interface DomainMediaSnapshot {
 readonly purpose:DomainMediaPurpose; readonly targetId:string; readonly variant:DomainMediaVariant;
 readonly domainVersion:string; readonly source:'legacy'|'asset'; readonly authorizationVersion:string;
 readonly legacyBytes:Buffer|null; readonly legacyContentType?:string; readonly assetId:string|null; readonly scopeId:string|null;
 readonly representationId:string|null; readonly metadata:ObjectMetadata|null;
}
const missing=()=>new Problem(404,'media_not_found','找不到內容。');
const unavailable=()=>new Problem(503,'media_unavailable','內容暫時無法讀取。');
function identity(row:DomainMediaSnapshot){return JSON.stringify([row.purpose,row.targetId,row.variant,row.domainVersion,row.source,row.authorizationVersion,row.assetId,row.scopeId,row.representationId,row.metadata,row.legacyContentType,row.legacyBytes?createHash('sha256').update(row.legacyBytes).digest('hex'):null]);}
export async function readDomainMedia(snapshot:()=>Promise<DomainMediaSnapshot|undefined>,expected:{purpose:DomainMediaPurpose;targetId:string;variant:DomainMediaVariant},store?:ObjectStore) {
 if(!validDomainVariant(expected.purpose,expected.variant))throw missing();
 const first=await snapshot();
 if(!first||first.purpose!==expected.purpose||first.targetId!==expected.targetId||first.variant!==expected.variant)throw missing();
 const pinned=identity(first);
 let bytes:Buffer;
 if(first.source==='legacy'){
  if(!first.legacyBytes)throw missing();bytes=Buffer.from(first.legacyBytes);
 }else if(first.source==='asset'){
  if(!store||!first.assetId||!first.scopeId||!first.representationId||!first.metadata)throw unavailable();
  const profile=first.purpose==='community.event-highlight'&&first.variant==='thumb'?'community.event-highlight.thumbnail':first.purpose;
  if(first.metadata.profileId!==profile)throw unavailable();
  try{const object=await readVerifiedObject(store,objectKey({scopeId:first.scopeId,assetId:first.assetId,representationId:first.representationId}),first.metadata);bytes=Buffer.from(object.bytes);}catch{throw unavailable();}
 }else throw missing();
 const last=await snapshot();if(!last||pinned!==identity(last))throw missing();
 return {bytes,contentType:first.metadata?.contentType??first.legacyContentType??'image/webp',domainVersion:first.domainVersion};
}

import type { Pool } from 'pg';
import type { Actor } from '../../modules/identity-membership/service.js';
import { withMemberScope } from '../resource-scopes/index.js';
import { digest } from '../db/index.js';
import { assertCurrentSessionClock } from '../db/member-session.js';
import { requireCondition } from '../shared/problem.js';
import { createServiceCoverBackfillAssetService,type ServiceCoverAssetDependencies } from '../../modules/assets/media-domain.js';
import { assetCommandKey,assetVersion } from '../../modules/assets/engine.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { z } from 'zod';
const backfillInput=z.object({key:assetCommandKey,serviceId:OpaqueId,expectedVersion:assetVersion}).strict();
/** Explicit authenticated host operation, not a cutover or an original writer.
 * Retains SQL bytes and uses the same fenced immutable lifecycle as uploads.
 * Retries reuse the original intent, including a PUT whose response was lost. */
export async function backfillServiceCover(pool:Pool,dependencies:ServiceCoverAssetDependencies,actor:Actor,raw:z.infer<typeof backfillInput>){
 actor=Object.freeze({...actor});
 const input=Object.freeze(backfillInput.parse(raw)),key=digest({operation:'media.backfill.service-cover.v1',key:input.key});
 const source=await withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{
  const service=(await q.query("SELECT aggregate_version FROM member_services WHERE service_id=$1 AND community_id=$2 AND owner_user_id=$3 AND state IN ('active','paused') FOR SHARE",[input.serviceId,actor.community_id,actor.user_id])).rows[0];
  requireCondition(service,404,'asset_target_not_found','找不到這個目標。');
  const cover=(await q.query('SELECT image_bytes,storage_source FROM member_service_covers WHERE service_id=$1 FOR SHARE',[input.serviceId])).rows[0];
  requireCondition(cover?.image_bytes,409,'media_source_changed','原始內容已改變，請重新建立移轉計畫。');
  if(cover.storage_source!=='legacy'){
   const completed=(await q.query("SELECT 1 FROM asset_upload_intents i JOIN member_service_cover_asset_targets t ON t.service_id=i.target_service_id AND t.asset_id=i.asset_id WHERE i.target_service_id=$1 AND i.prepare_key=$2 AND i.scope_id=$3 AND i.owner_principal_id=$4 AND i.state='finalized' AND i.expected_version=$5",[input.serviceId,key,context.scope.scope_id,context.subject_principal.principal_id,input.expectedVersion])).rowCount;
   requireCondition(completed===1,409,'media_source_changed','原始內容已改變，請重新建立移轉計畫。');
  }
  await assertCurrentSessionClock(q,actor);return Buffer.from(cover.image_bytes);
 });
 const pinned={serviceId:input.serviceId,expectedVersion:input.expectedVersion,byteSize:source.length,sha256:createHash('sha256').update(source).digest('hex')};
 const api=createServiceCoverBackfillAssetService(pool,dependencies,pinned);
 const intent=await api.prepare(actor,{key,targetServiceId:input.serviceId,expectedVersion:input.expectedVersion,contentType:'image/webp',byteSize:pinned.byteSize,sha256:pinned.sha256});
 const resumed=await api.resumeUpload(actor,{key,intentId:intent.intentId}),lease={intentId:resumed.intentId,fence:resumed.fence,leaseToken:resumed.leaseToken};
 if(resumed.state!=='finalized'){
  if(resumed.state!=='stored')await api.write(actor,{...lease,key:digest({key,phase:'write',fence:lease.fence})},new ReadableStream({start(c){c.enqueue(source);c.close();}}));
  return api.finalize(actor,{...lease,key:digest({key,phase:'finalize'})});
 }
 // A replay reports the real original publication version, not a new mutation.
 return withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{
  const row=(await q.query(`SELECT t.linked_at_version,c.image_bytes FROM member_service_cover_asset_targets t JOIN member_services s USING(service_id) JOIN member_service_covers c USING(service_id) WHERE t.service_id=$1 AND t.asset_id=$2 AND t.scope_id=$3 AND t.owner_principal_id=$4 AND s.owner_user_id=$5 AND s.community_id=$6 AND s.state IN ('active','paused') AND c.storage_source='asset'`,[input.serviceId,intent.assetId,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id,actor.community_id])).rows[0];
  requireCondition(row?.image_bytes&&createHash('sha256').update(row.image_bytes).digest('hex')===pinned.sha256,409,'media_source_changed','原始內容已改變，請重新建立移轉計畫。');
  await assertCurrentSessionClock(q,actor);return {intentId:intent.intentId,assetId:intent.assetId,serviceId:input.serviceId,aggregateVersion:row.linked_at_version as string};
 });
}
