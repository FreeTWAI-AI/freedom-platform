import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {AssetStorageError,MEDIA_OBJECT_PROFILES,OBJECT_IO_MAX_BYTES,objectKey,prepareLegacyMediaRepresentation,
  prepareAvatar,preparePrivateText,readBounded,readPinnedObjectRange,readVerifiedObject,writeVerifiedObject,
  validateMetadata,sha256,type ObjectMetadata} from '../../packages/asset-storage/index.js';
import {createR2ObjectStore,type AssetR2Binding} from '../../packages/asset-storage/r2.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
const policy={revision:'synthetic-media-policy',platformPersistenceAllowed:true};
const key=()=>objectKey({scopeId:randomUUID(),assetId:randomUUID(),representationId:randomUUID()});
const stream=(bytes:Uint8Array)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close();}});
const code=(wanted:string)=>(e:unknown)=>e instanceof AssetStorageError&&e.code===wanted&&e.message===wanted;
const mp4=(size:number)=>{const bytes=new Uint8Array(size);bytes.set([0,0,0,12,102,116,121,112,105,115,111,109]);return bytes;};
let mf:Miniflare,bucket:AssetR2Binding;
before(async()=>{mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'fp-media-profile-test',modules:true,
  script:'export default {fetch(){return new Response("synthetic");}}',compatibilityDate:'2026-09-21',r2Buckets:['MEDIA'] }]}));await mf.ready;bucket=await mf.getR2Bucket('MEDIA') as unknown as AssetR2Binding;});
after(async()=>{await mf?.dispose();});
function port(overrides:Partial<AssetR2Binding>):AssetR2Binding{return {put:bucket.put.bind(bucket),get:bucket.get.bind(bucket),head:bucket.head.bind(bucket),delete:bucket.delete.bind(bucket),...overrides};}

test('MEDIA-01 actual20MiB legacy MP4 passes shared preparation/write/readback and native range without avatar cap',async()=>{
  const bytes=mp4(OBJECT_IO_MAX_BYTES),value=await prepareLegacyMediaRepresentation(stream(bytes),'video/mp4','community.event-video',policy),store=createR2ObjectStore(bucket),id=key();
  assert.equal(value.metadata.byteSize,20*1024*1024);assert.equal(value.metadata.profileId,'community.event-video');
  const verified=await writeVerifiedObject(store,id,value,policy);assert.equal(verified.metadata.sha256,await sha256(bytes));assert(verified.etag);
  const ranged=await readPinnedObjectRange(store,id,value.metadata,{offset:12*1024*1024,length:1024*1024},verified.etag!);
  assert.equal(ranged.integrity,'immutable-etag-range');assert.equal(ranged.wholeDigestVerified,false);
  assert.deepEqual(await readBounded(ranged.body,1024*1024),bytes.subarray(12*1024*1024,13*1024*1024));
  assert.equal((await readVerifiedObject(store,id,value.metadata)).bytes.length,OBJECT_IO_MAX_BYTES);
});
test('MEDIA-02 capoverflow cancels actual chunks; forbidden policy/MIME/purpose never reads or writes',async()=>{
  let cancelled=0;const overflow=new ReadableStream<Uint8Array>({start(c){c.enqueue(mp4(OBJECT_IO_MAX_BYTES));c.enqueue(new Uint8Array(1));},cancel(){cancelled++;}});
  await assert.rejects(prepareLegacyMediaRepresentation(overflow,'video/mp4','community.event-video',policy),code('too_large'));assert.equal(cancelled,1);assert.equal(overflow.locked,false);
  for(const [mime,profile,p]of [['video/mp4','community.event-banner',policy],['video/mp4','arbitrary-user-profile',policy],['video/mp4','community.event-video',{...policy,platformPersistenceAllowed:false}]] as const){
    let reads=0;const body=new ReadableStream<Uint8Array>({pull(){reads++;throw Error('must not pull');}},{highWaterMark:0});
    await assert.rejects(prepareLegacyMediaRepresentation(body,mime,profile as any,p),AssetStorageError);assert.equal(reads,0);
  }
});
test('MEDIA-03 explicit purpose caps and transforms cannot be forged or inherited from arbitrary WebP',async()=>{
  const value=await prepareLegacyMediaRepresentation(stream(mp4(12)),'video/mp4','community.event-video',policy);
  const invalid=[{...value.metadata,profileId:undefined},{...value.metadata,profileId:'member.avatar'},
    {...value.metadata,transformVersion:'avatar.webp.v1'},{...value.metadata,byteSize:OBJECT_IO_MAX_BYTES+1},
    {...value.metadata,extra:'untrusted'},{...value.metadata,profileId:'__proto__'}];
  for(const metadata of invalid)assert.throws(()=>validateMetadata(metadata as ObjectMetadata),code('invalid_metadata'));
  for(const [id,profile]of Object.entries(MEDIA_OBJECT_PROFILES)){
    validateMetadata({contentType:profile.contentTypes[0],byteSize:profile.maxBytes,sha256:'a'.repeat(64),profileId:id as any,transformVersion:profile.transformVersion,policyRevision:policy.revision});
    assert.throws(()=>validateMetadata({contentType:profile.contentTypes[0],byteSize:profile.maxBytes+1,sha256:'a'.repeat(64),profileId:id as any,transformVersion:profile.transformVersion,policyRevision:policy.revision}),code('invalid_metadata'));
  }
  assert.equal(MEDIA_OBJECT_PROFILES['community.event-highlight.thumbnail'].maxBytes,200*1024);
});
test('MEDIA-04 non-avatar WebP stored byte-for-byte while old avatar/text validations remain distinct',async()=>{
  const webp=await sharp({create:{width:1200,height:675,channels:3,background:'#226677'}}).webp().toBuffer();
  const value=await prepareLegacyMediaRepresentation(stream(webp),'image/webp','community.event-banner',policy),store=new FakeObjectStore(),id=key();
  await writeVerifiedObject(store,id,value,policy);assert.deepEqual(Buffer.from((await readVerifiedObject(store,id,value.metadata)).bytes),webp);
  assert.equal(value.metadata.transformVersion,'community.event-banner.legacy-bytes.v1');
  await assert.rejects(writeVerifiedObject(store,key(),{bytes:webp,metadata:{contentType:'image/webp',byteSize:webp.length,sha256:await sha256(webp),transformVersion:'avatar.webp.v1',policyRevision:policy.revision}},policy),code('invalid_content'));
  const text=await preparePrivateText(stream(new TextEncoder().encode('私人文字')),'text/plain',policy);assert.equal(text.metadata.profileId,undefined);await writeVerifiedObject(store,key(),text,policy);
  await assert.rejects(preparePrivateText(stream(mp4(12)),'video/mp4',policy),code('unsupported_content_type'));
  await assert.rejects(prepareAvatar(stream(webp),'image/webp',policy,async()=>webp),code('invalid_content'));
});
test('MEDIA-05 both legacy video signatures and raster framing reject MIME lies without normalization',async()=>{
  const good=new Uint8Array([0x1a,0x45,0xdf,0xa3,0]);const webm=await prepareLegacyMediaRepresentation(stream(good),'video/webm','community.event-video',policy);assert.deepEqual(webm.bytes,good);
  for(const [bytes,mime,profile]of [[good,'video/mp4','community.event-video'],[mp4(12),'video/webm','community.event-video'],[new Uint8Array([1,2,3]),'image/webp','skill.submission-image']] as const)
    await assert.rejects(prepareLegacyMediaRepresentation(stream(bytes),mime,profile,policy),code('invalid_content'));
});
test('MEDIA-06 streaming native range is lazy, forwards exact conditional request, and consumer cancellation reaches native body',async()=>{
  const id=key(),value=await prepareLegacyMediaRepresentation(stream(mp4(1024*1024)),'video/mp4','community.event-video',policy);
  await createR2ObjectStore(bucket).putImmutable(id,value);const object=await bucket.head(id);assert(object);
  let pulls=0,cancels=0,options:any;const upstream=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(new Uint8Array(65536));},cancel(){cancels++;}},{highWaterMark:0});
  const store=createR2ObjectStore(port({get:async(_key:any,received:any)=>{options=received;return {...object,range:{offset:12,length:512*1024},body:upstream} as never;}}));
  const ranged=await readPinnedObjectRange(store,id,value.metadata,{offset:12,length:512*1024},object.etag);assert.equal(pulls,0,'no whole or partial body buffered before consumption');
  assert.deepEqual(options,{range:{offset:12,length:512*1024},onlyIf:{etagMatches:object.etag}});
  const reader=ranged.body.getReader();assert.equal((await reader.read()).value!.length,65536);assert.equal(pulls,1);
  await reader.cancel();reader.releaseLock();assert.equal(cancels,1);assert.equal(upstream.locked,false);assert.equal(pulls,1);
});
test('MEDIA-07 short/long streaming ranges fail while consumed with fixed errors and no full allocation',async()=>{
  const id=key(),value=await prepareLegacyMediaRepresentation(stream(mp4(12)),'video/mp4','community.event-video',policy);await createR2ObjectStore(bucket).putImmutable(id,value);const object=await bucket.head(id);assert(object);
  for(const size of [2,4]){let cancelled=false;const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(size));if(size===2)c.close();},cancel(){cancelled=true;}},{highWaterMark:0});
    const store=createR2ObjectStore(port({get:async()=>({...object,range:{offset:1,length:3},body}) as never}));const result=await store.get(id,{offset:1,length:3});assert(result);
    await assert.rejects(readBounded(result.body,3),code('invalid_content'));if(size===4)assert(cancelled);
  }
});
test('MEDIA-08 stale ETag or metadata pin cancels partial output, never asserts full-object digest evidence',async()=>{
  const id=key(),value=await prepareLegacyMediaRepresentation(stream(mp4(12)),'video/mp4','community.event-video',policy);const store=createR2ObjectStore(bucket);await store.putImmutable(id,value);
  const head=await store.head(id);assert(head?.etag);
  await assert.rejects(readPinnedObjectRange(store,id,value.metadata,{offset:0,length:3},'different-etag'),code('integrity_mismatch'));
  await assert.rejects(readPinnedObjectRange(store,id,{...value.metadata,sha256:'a'.repeat(64)},{offset:0,length:3},head.etag),code('integrity_mismatch'));
  for(const range of [{offset:-1,length:1},{offset:12,length:1},{offset:0,length:13}])await assert.rejects(readPinnedObjectRange(store,id,value.metadata,range,head.etag),code('invalid_range'));
});
test('MEDIA-09 immutable conflict and unknown PUT outcomes still require actual shared whole-object digest readback',async()=>{
  const id=key(),a=await prepareLegacyMediaRepresentation(stream(mp4(12)),'video/mp4','community.event-video',policy),b=await prepareLegacyMediaRepresentation(stream(mp4(13)),'video/mp4','community.event-video',policy);
  const fake=new FakeObjectStore();await writeVerifiedObject(fake,id,a,policy);await assert.rejects(fake.putImmutable(id,b),code('object_conflict'));
  await assert.rejects(writeVerifiedObject(fake,id,b,policy),code('integrity_mismatch'));
  let writes=0;const unknown=createR2ObjectStore(port({put:async(...args:any[])=>{writes++;await (bucket.put as any)(...args);throw Error('RAW_PRIVATE_DIAGNOSTIC');}}));
  await writeVerifiedObject(unknown,key(),a,policy);assert.equal(writes,1);
  const wrong={...a,bytes:mp4(13)};await assert.rejects(writeVerifiedObject(unknown,key(),wrong,policy),code('too_large'));assert.equal(writes,1);
});

test('MEDIA-10 streaming transport errors cannot smuggle upstream codes or private diagnostics',async()=>{
  const id=key(),value=await prepareLegacyMediaRepresentation(stream(mp4(12)),'video/mp4','community.event-video',policy);await createR2ObjectStore(bucket).putImmutable(id,value);const object=await bucket.head(id);assert(object);
  const upstream=new AssetStorageError('invalid_content');upstream.message='RAW_PRIVATE_DIAGNOSTIC';
  const store=createR2ObjectStore(port({get:async()=>({...object,range:{offset:0,length:3},body:new ReadableStream<Uint8Array>({pull(){throw upstream;}},{highWaterMark:0})}) as never}));
  const result=await store.get(id,{offset:0,length:3});assert(result);const reader=result.body.getReader();
  await assert.rejects(reader.read(),code('object_unavailable'));reader.releaseLock();
  assert.throws(()=>validateMetadata({...value.metadata,get sha256():string{throw Error('RAW_PRIVATE_DIAGNOSTIC');}}),code('invalid_metadata'));
});

test('MEDIA-11 fake immutable version pin changes after delete/recreate even for identical bytes',async()=>{
  const id=key(),store=new FakeObjectStore(),value=await prepareLegacyMediaRepresentation(stream(mp4(12)),'video/mp4','community.event-video',policy);
  const old=await writeVerifiedObject(store,id,value,policy);assert(old.etag);await store.delete(id);const fresh=await writeVerifiedObject(store,id,value,policy);assert.notEqual(fresh.etag,old.etag);
  await assert.rejects(readPinnedObjectRange(store,id,value.metadata,{offset:0,length:3},old.etag),code('integrity_mismatch'));
});
