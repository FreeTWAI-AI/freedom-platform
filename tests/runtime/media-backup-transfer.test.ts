import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { objectKey, preparePrivateText, prepareLegacyMediaRepresentation, readVerifiedObject,
  type ObjectStore, type AssetObjectKey } from '../../packages/asset-storage/index.js';
import { transferBackup, transferRestore, MediaBackupError, type BackupCapture } from '../../packages/media-migration/backup-transfer.js';

const stream=(bytes:Uint8Array)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close();}});
const policy={revision:'synthetic-transfer',platformPersistenceAllowed:true};
const code=(expected:string)=>(e:unknown)=>e instanceof MediaBackupError&&e.code===expected&&!e.message.includes('RAW_PRIVATE');
async function fixture(video=false){
  const source=new FakeObjectStore(),destination=new FakeObjectStore();
  const value=video?await prepareLegacyMediaRepresentation(stream(Object.assign(new Uint8Array(20*1024*1024),
    {4:102,5:116,6:121,7:112})),'video/mp4','community.event-video',policy)
    :await preparePrivateText(stream(new TextEncoder().encode('Synthetic immutable backup text')),'text/plain',policy);
  const assetId=randomUUID(),scopeId=randomUUID(),representationId=randomUUID(),key=objectKey({assetId,scopeId,representationId});
  await source.putImmutable(key,value);
  const capture:BackupCapture={captureId:randomUUID(),referenceSnapshot:'100:200:150',sourceRelease:'a'.repeat(40),sourceSchema:'fp_synthetic_backup',
    references:[{asset_id:assetId,scope_id:scopeId,representation_id:representationId,policy_revision:policy.revision,
      byte_size:value.metadata.byteSize,content_sha256:value.metadata.sha256}]};
  let checks=0,renewals=0;
  const protection={async renew(){renewals++;},async assertCurrent(){checks++;return structuredClone(capture);}};
  return {source,destination,value,key,capture,protection,checks:()=>checks,renewals:()=>renewals};
}

test('Backup transfers exact20MiB profile and restores actual bytes after source loss; immutable resume remains verified',async()=>{
  const f=await fixture(true),manifest=await transferBackup(f.capture,f.source,f.destination,f.protection);
  assert.equal(manifest.objects.length,1);assert.equal(manifest.objects[0].metadata.profileId,'community.event-video');
  assert.equal(f.renewals(),1);assert.equal(f.checks(),3);assert(Object.isFrozen(manifest)&&Object.isFrozen(manifest.objects)&&Object.isFrozen(manifest.capture.references));
  await transferBackup(f.capture,f.source,f.destination,f.protection);
  await f.source.delete(f.key);const restored=new FakeObjectStore();let allowed=0;
  const result=await transferRestore(manifest,f.destination,restored,{async assertAllowed(){allowed++;}});
  assert.equal(result.byteCount,20*1024*1024);assert.equal(allowed,3);
  assert.deepEqual((await readVerifiedObject(restored,f.key,f.value.metadata)).bytes,f.value.bytes);
});
test('Backup reconciles committed PUT errors and resumes failed PUT without declaring incomplete copy complete',async()=>{
  const f=await fixture();f.destination.failNext('put-before');
  await assert.rejects(transferBackup(f.capture,f.source,f.destination,f.protection),code('transfer_failed'));
  assert.equal(await f.destination.head(f.key),null);f.destination.failNext('put-after');
  const complete=await transferBackup(f.capture,f.source,f.destination,f.protection);assert.equal(complete.status,'objects_verified');
  assert.deepEqual((await readVerifiedObject(f.destination,f.key,f.value.metadata)).bytes,f.value.bytes);
});
test('Backup duplicate references and transfer budgets reject before any source/destination I/O',async()=>{
  const f=await fixture();let touched=0;f.source.head=async()=>{touched++;return null;};
  await assert.rejects(transferBackup({...f.capture,references:[...f.capture.references,...f.capture.references]},f.source,f.destination,f.protection),code('invalid_capture'));
  await assert.rejects(transferBackup(f.capture,f.source,f.destination,f.protection,{maxBytes:1}),code('budget_exceeded'));
  await assert.rejects(transferBackup(f.capture,f.source,f.destination,f.protection,{maxObjects:10001}),code('invalid_options'));
  assert.equal(touched,0);assert.equal(f.renewals(),0);
});
test('Backup detects missing, metadata mismatch, actual-byte tampering and conflicting destination',async()=>{
  const missing=await fixture();await missing.source.delete(missing.key);
  await assert.rejects(transferBackup(missing.capture,missing.source,missing.destination,missing.protection),code('object_missing'));
  const metadata=await fixture();const wrongCapture={...metadata.capture,references:[{...metadata.capture.references[0],content_sha256:'f'.repeat(64)}]};
  await assert.rejects(transferBackup(wrongCapture,metadata.source,metadata.destination,{...metadata.protection,async assertCurrent(){return wrongCapture;}}),code('object_mismatch'));
  const corrupt=await fixture();const get=corrupt.source.get.bind(corrupt.source);
  corrupt.source.get=async(...args)=>{const object=await get(...args);assert(object);return {...object,body:stream(new Uint8Array(corrupt.value.bytes.length).fill(1))};};
  await assert.rejects(transferBackup(corrupt.capture,corrupt.source,corrupt.destination,corrupt.protection),code('transfer_failed'));
  const conflict=await fixture();const other=await preparePrivateText(stream(new TextEncoder().encode('Different immutable object')),'text/plain',policy);
  await conflict.destination.putImmutable(conflict.key,other);
  await assert.rejects(transferBackup(conflict.capture,conflict.source,conflict.destination,conflict.protection),code('object_mismatch'));
});
test('Backup protection expiry, pin mutation and changes after actual PUT refuse completion',async()=>{
  const f=await fixture();await assert.rejects(transferBackup(f.capture,f.source,f.destination,{...f.protection,async renew(){throw Error('RAW_PRIVATE');}}),code('protection_lost'));
  await assert.rejects(transferBackup(f.capture,f.source,f.destination,{...f.protection,async assertCurrent(){return {...f.capture,sourceRelease:'b'.repeat(40)};}}),code('capture_changed'));
  let reads=0;await assert.rejects(transferBackup(f.capture,f.source,f.destination,{...f.protection,async assertCurrent(){return ++reads===1?f.capture:{...f.capture,references:[]};}}),code('capture_changed'));
  assert(await f.destination.head(f.key),'real incomplete effects are retained for reconciliation');
});
test('Backup never exposes a forged upstream MediaBackupError message',async()=>{
  const f=await fixture();f.source.head=async()=>{const e=new MediaBackupError('object_missing');e.message='RAW_PRIVATE upstream secret';throw e;};
  await assert.rejects(transferBackup(f.capture,f.source,f.destination,f.protection),code('transfer_failed'));
});
test('Restore validates exact manifest/pin bijection before I/O and denies current authorization before touching storage',async()=>{
  const f=await fixture(),manifest=await transferBackup(f.capture,f.source,f.destination,f.protection),target=new FakeObjectStore();let touched=0;
  const get=f.destination.head.bind(f.destination);f.destination.head=async(key)=>{touched++;return get(key);};
  await assert.rejects(transferRestore({...manifest,objects:[]},f.destination,target,{async assertAllowed(){}}),code('invalid_manifest'));
  const entry=manifest.objects[0];await assert.rejects(transferRestore({...manifest,objects:[{...entry,metadata:{...entry.metadata,sha256:'f'.repeat(64)}}]},f.destination,target,{async assertAllowed(){}}),code('invalid_manifest'));
  await assert.rejects(transferRestore(manifest,f.destination,target,{async assertAllowed(){throw Error('RAW_PRIVATE current revocation');}}),code('restore_unauthorized'));
  assert.equal(touched,0);assert.equal(await target.head(f.key),null);
});
test('Restore revocation during I/O prevents success and mutable caller manifest cannot change pinned identity',async()=>{
  const f=await fixture(),manifest=await transferBackup(f.capture,f.source,f.destination,f.protection),target=new FakeObjectStore();let allowed=0;
  await assert.rejects(transferRestore(manifest,f.destination,target,{async assertAllowed(){if(++allowed===2)throw Error('revoked');}}),code('restore_unauthorized'));
  assert(await target.head(f.key),'no unsafe deletion to pretend effects were rolled back');
  const mutable={...manifest,objects:manifest.objects.map(entry=>({key:entry.key,metadata:{...entry.metadata}}))},target2=new FakeObjectStore();let called=false;
  const result=await transferRestore(mutable,f.destination,target2,{async assertAllowed(){if(!called){called=true;mutable.objects[0].metadata.sha256='f'.repeat(64);mutable.objects[0].key=objectKey({scopeId:randomUUID(),assetId:randomUUID(),representationId:randomUUID()});}}});
  assert.equal(result.objectCount,1);assert.deepEqual((await readVerifiedObject(target2,f.key,f.value.metadata)).bytes,f.value.bytes);
});
