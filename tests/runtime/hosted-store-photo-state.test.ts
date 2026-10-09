import assert from 'node:assert/strict';
import {test} from 'node:test';
import {photoAcknowledgement,retainedPhotoFailure,reviewPhotoAttempt,holdPhotoAttempt,heldPhotoAttempt,restorePhotoAttempt,releasePhotoAttempt,forgetRefusedPhotoAttempt,photoBlocksLeaving,type PhotoAttempt} from '../../apps/portal-web/src/modules/hosted-store-photo-state.js';
import {HOSTED_STORE_MEDIA_PROFILE} from '../../contracts/guild-launchpad/v1/hosted-store-media.js';
const tenantId='10000000-0000-4000-8000-000000000001',instanceId='10000000-0000-4000-8000-000000000002',productId='10000000-0000-4000-8000-000000000003';
const file={name:'same-original.png',type:'image/png'} as File;
const attempt:PhotoAttempt=Object.freeze({tenantId,instanceId,productId,expected:'7',key:'same-original-key',file,action:'upload',hadUnknown:false});
const ack={profile:HOSTED_STORE_MEDIA_PROFILE,product_id:productId,completed_version:'8',changed:true,current:{profile:HOSTED_STORE_MEDIA_PROFILE,product_id:productId,version:'10',photo:null}};
test('PHOTO-STATE-01 unknown remains sticky across later known errors and refuses a new key/version',()=>{
  const unknown=retainedPhotoFailure(attempt,true),later=retainedPhotoFailure(unknown,false);
  assert.equal(later.hadUnknown,true);assert.equal(later.file,file);assert.equal(later.key,attempt.key);assert.equal(later.expected,'7');
  assert.throws(()=>reviewPhotoAttempt(later,'10','replacement-key'),/unknown/);
});
test('PHOTO-STATE-02 manual review alone replaces CAS/key while retaining the original File',()=>{
  const next=reviewPhotoAttempt(retainedPhotoFailure(attempt,false),'10','manual-review-key');
  assert.equal(next.file,file);assert.equal(next.expected,'10');assert.equal(next.key,'manual-review-key');assert.equal(attempt.expected,'7');
});
test('PHOTO-STATE-03 strict ACK binds original completion and allows a newer current state',()=>{
  assert.deepEqual(photoAcknowledgement(ack,attempt),ack);
  for(const wrong of [{...ack,completed_version:'10'},{...ack,changed:false},{...ack,asset_id:tenantId},{...ack,product_id:instanceId}])assert.equal(photoAcknowledgement(wrong,attempt),null);
  const photo={content_type:'image/webp',byte_size:12,width:1,height:1,read_path:`/api/v1/tenants/${instanceId}/storefronts/${instanceId}/products/${productId}/photo/10`};
  assert.equal(photoAcknowledgement({...ack,current:{...ack.current,photo}},attempt),null);
  assert.ok(photoAcknowledgement({...ack,completed_version:'7',changed:false},{...attempt,action:'remove',file:null}));
});


test('PHOTO-STATE-04 pending original File survives same-client re-login but cannot cross member or product placement',()=>{
  const client={},otherClient={};holdPhotoAttempt(client,'member-a',attempt);
  const restored=restorePhotoAttempt(client,'member-a',attempt)!;
  assert.equal(restored.file,file);assert.equal(restored.key,attempt.key);assert.equal(restored.hadUnknown,true);
  assert.equal(heldPhotoAttempt(client,'member-b',attempt),null);assert.equal(heldPhotoAttempt(otherClient,'member-a',attempt),null);
  assert.equal(heldPhotoAttempt(client,'member-a',{...attempt,instanceId:tenantId}),null);
  releasePhotoAttempt(client,'member-a',{...attempt,key:'another-key'});assert.ok(heldPhotoAttempt(client,'member-a',attempt));
  releasePhotoAttempt(client,'member-a',attempt);assert.equal(heldPhotoAttempt(client,'member-a',attempt),null);
});


test('PHOTO-STATE-05 late refusal cannot erase remounted uncertainty, and late ACK cannot clear a newer tuple',()=>{
  const client={};holdPhotoAttempt(client,'member',attempt);
  assert.equal(heldPhotoAttempt(client,'member',attempt)?.hadUnknown,false);
  const remounted=restorePhotoAttempt(client,'member',attempt)!;
  assert.throws(()=>holdPhotoAttempt(client,'member',{...attempt,key:'new-key-before-confirmation'}),/unknown/);
  forgetRefusedPhotoAttempt(client,'member',attempt);assert.equal(heldPhotoAttempt(client,'member',attempt)?.hadUnknown,true);
  assert.equal(photoBlocksLeaving(remounted,false),true);assert.equal(photoBlocksLeaving(attempt,true),true);assert.equal(photoBlocksLeaving(attempt,false),false);
  releasePhotoAttempt(client,'member',attempt);assert.equal(heldPhotoAttempt(client,'member',attempt),null);
  const next={...attempt,key:'next-operation-key',expected:'10'};holdPhotoAttempt(client,'member',next);
  releasePhotoAttempt(client,'member',attempt);assert.equal(heldPhotoAttempt(client,'member',attempt)?.key,next.key);
  forgetRefusedPhotoAttempt(client,'member',next);assert.equal(heldPhotoAttempt(client,'member',attempt),null);
});

test('PHOTO-STATE-06 pending memory keeps the close warning after controls unmount and removes it only after completion',()=>{
  const target=new EventTarget(),prior=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:target});
  const client={};
  try{
    holdPhotoAttempt(client,'member',attempt);
    const during=new Event('beforeunload',{cancelable:true});target.dispatchEvent(during);assert.equal(during.defaultPrevented,true);
    restorePhotoAttempt(client,'member',attempt);
    const remounted=new Event('beforeunload',{cancelable:true});target.dispatchEvent(remounted);assert.equal(remounted.defaultPrevented,true);
    releasePhotoAttempt(client,'member',attempt);
    const complete=new Event('beforeunload',{cancelable:true});target.dispatchEvent(complete);assert.equal(complete.defaultPrevented,false);
  }finally{releasePhotoAttempt(client,'member',attempt);if(prior)Object.defineProperty(globalThis,'window',prior);else Reflect.deleteProperty(globalThis,'window');}
});
