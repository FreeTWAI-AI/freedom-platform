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
