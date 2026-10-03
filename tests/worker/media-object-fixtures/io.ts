import type {R2Bucket} from '@cloudflare/workers-types';
import {OBJECT_IO_MAX_BYTES,objectKey,prepareLegacyMediaRepresentation,writeVerifiedObject,readVerifiedObject,readPinnedObjectRange} from '../../../packages/asset-storage/index.js';
import {createR2ObjectStore,type AssetR2Binding} from '../../../packages/asset-storage/r2.js';

// Synthetic storage execution inside workerd. Header fixture is not a playable
// video. No SQL, public URLs, player, cloud deployment or quota proof.
export default {async fetch(_request:Request,env:{MEDIA:R2Bucket}){
  const key=objectKey({scopeId:crypto.randomUUID(),assetId:crypto.randomUUID(),representationId:crypto.randomUUID()});
  let offset=0;
  const source=new ReadableStream<Uint8Array>({pull(controller){
    if(offset===OBJECT_IO_MAX_BYTES){controller.close();return;}
    const chunk=new Uint8Array(Math.min(65536,OBJECT_IO_MAX_BYTES-offset));
    if(offset===0)chunk.set([0,0,0,12,102,116,121,112,105,115,111,109]);
    offset+=chunk.length;controller.enqueue(chunk);
  }},{highWaterMark:0});
  const policy={revision:'synthetic-worker-media',platformPersistenceAllowed:true};
  const prepared=await prepareLegacyMediaRepresentation(source,'video/mp4','community.event-video',policy);
  const store=createR2ObjectStore(env.MEDIA),written=await writeVerifiedObject(store,key,prepared,policy);
  const full=await readVerifiedObject(store,key,prepared.metadata);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(full.bytes)));
  const independentSha=Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('');
  let nativePulls=0,nativeCancels=0,nativeRequestedRange=false,nativeConditional=false,nativeReleased=false;
  const rangeStore=createR2ObjectStore({
    put:env.MEDIA.put.bind(env.MEDIA),head:env.MEDIA.head.bind(env.MEDIA),delete:env.MEDIA.delete.bind(env.MEDIA),
    async get(nativeKey:any,options:any){
      nativeRequestedRange=options?.range?.offset===12*1024*1024&&options?.range?.length===1024*1024;
      nativeConditional=options?.onlyIf?.etagMatches===written.etag;
      const result=await env.MEDIA.get(nativeKey,options);if(!result||!('body' in result))return result;
      const reader=result.body.getReader();
      const body=new ReadableStream<Uint8Array>({
        async pull(controller){nativePulls++;const next=await reader.read();if(next.done){reader.releaseLock();nativeReleased=true;controller.close();}else controller.enqueue(next.value);},
        async cancel(){nativeCancels++;try{await reader.cancel();}finally{reader.releaseLock();nativeReleased=true;}},
      },{highWaterMark:0});
      return {key:result.key,size:result.size,etag:result.etag,httpMetadata:result.httpMetadata,customMetadata:result.customMetadata,range:result.range,body} as never;
    },
  } as AssetR2Binding);
  const partial=await readPinnedObjectRange(rangeStore,key,prepared.metadata,{offset:12*1024*1024,length:1024*1024},written.etag!);
  const pullsBeforeRead=nativePulls,reader=partial.body.getReader(),first=await reader.read();
  const firstSize=first.value?.length??0;
  const firstMatches=first.value!==undefined&&first.value.every(value=>value===0);
  await reader.cancel();reader.releaseLock();
  return Response.json({profile:'synthetic.worker-media-io/v1',preparedBytes:prepared.metadata.byteSize,verifiedBytes:full.bytes.length,
    digestMatches:independentSha===prepared.metadata.sha256&&written.metadata.sha256===independentSha,
    sha256:independentSha,pullsBeforeRead,nativePulls,nativeCancels,nativeReleased,firstSize,firstMatches,nativeRequestedRange,nativeConditional,
    rangeLength:partial.range.length,integrity:partial.integrity,wholeDigestVerified:partial.wholeDigestVerified,
    cloudDeployment:false,playerVerification:false,productionQuotaVerification:false});
}};
