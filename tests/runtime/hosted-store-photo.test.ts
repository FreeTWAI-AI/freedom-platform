import {retainedByteUsage} from '../../modules/opportunity-project-work/tenant-capacity.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,after,beforeEach,test} from 'node:test';
import {createHostedStorePhotoHarness,photoSourcePng,type HostedStorePhotoHarness} from '../helpers/hosted-store-photo.js';

let f:HostedStorePhotoHarness;
before(async()=>{f=await createHostedStorePhotoHarness();});
after(async()=>{await f?.stop();});
beforeEach(async()=>{await f.reset();});
type Store=Awaited<ReturnType<HostedStorePhotoHarness['openStore']>>;
async function enable(){await f.h.pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=true,policy_revision='synthetic-photo-test-1',retained_byte_limit=16777216 WHERE purpose='storefront.product-photo'");}
async function upload(s:Store,version:string,key=randomUUID(),bytes=photoSourcePng,app=f.app){
  const response=await app.request(f.h.origin+'/api/v1'+s.root+'/products/'+s.productId+'/photo',{method:'POST',headers:{Origin:f.h.origin,Cookie:s.owner.cookie,'X-CSRF-Token':s.owner.csrf,'Content-Type':'image/png','Idempotency-Key':key,'If-Match':`"${version}"`},body:new Uint8Array(bytes)});
  return {status:response.status,data:await response.json() as any,response};
}
async function publish(s:Store,action='publish'){
  const view=f.ok(await f.call('GET',s.root,s.owner));return f.ok(await f.post(s.root+'/'+action,s.owner,{},view.version));
}
const media=(s:Store)=>f.app.request(f.h.origin+'/api/v1/public/stores/'+s.slug+'/media');

test.skip('PHOTO-DOMAIN-01 add, replace and remove preserve publication history and original completion under policy OFF',async()=>{
  const s=await f.openStore();await enable();
  const removed=f.ok(await f.post(s.root+'/products/'+s.productId+'/photo/remove',s.owner,{},'1'));
  assert.equal(removed.changed,false);assert.equal(removed.completed_version,'1');
  const key=randomUUID(),first=f.ok(await upload(s,'1',key));assert.equal(first.completed_version,'2');
  const firstPath=first.current.photo.read_path;assert.equal((await f.app.request(f.h.origin+firstPath,{headers:{Cookie:s.owner.cookie}})).status,200);
  await publish(s);const one=await(await media(s)).json() as any,oldPath=one.photos[0].photo.read_path;
  const saved=(await f.h.pool.query('SELECT * FROM commerce_storefront_publications WHERE instance_id=$1 ORDER BY revision',[s.instanceId])).rows[0];
  const second=f.ok(await upload(s,'2'));assert.equal(second.completed_version,'3');
  assert.equal(f.ok(await f.call('GET',s.root+'/preview',s.owner)).dirty,true);
  assert.equal((await f.app.request(f.h.origin+firstPath,{headers:{Cookie:s.owner.cookie}})).status,404);
  assert.equal((await f.app.request(f.h.origin+oldPath)).status,200);
  await publish(s);assert.equal((await f.app.request(f.h.origin+oldPath)).status,404);
  const rows=(await f.h.pool.query('SELECT * FROM commerce_storefront_publications WHERE instance_id=$1 ORDER BY revision',[s.instanceId])).rows;
  assert.deepEqual(rows[0],saved);assert.equal(rows[0].projection_sha256,rows[1].projection_sha256);assert.notEqual(rows[0].media_sha256,rows[1].media_sha256);
  const two=await(await media(s)).json() as any;
  f.ok(await f.post(s.root+'/products/'+s.productId+'/photo/remove',s.owner,{},'3'));
  assert.equal((await f.app.request(f.h.origin+two.photos[0].photo.read_path)).status,200);
  await publish(s);assert.deepEqual((await(await media(s)).json() as any).photos,[]);
  await f.h.pool.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='storefront.product-photo'");
  const puts=f.store.puts,replay=f.ok(await upload(s,'1',key,photoSourcePng,f.application(false)));
  assert.equal(replay.completed_version,'2');assert.equal(replay.current.version,'4');assert.equal(replay.current.photo,null);assert.equal(f.store.puts,puts);
  assert.equal((await upload(s,'1',key,Buffer.concat([photoSourcePng,Buffer.from('different')]))).status,409);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE purpose='storefront.product-photo'")).rows[0].n,2);
});

test('PHOTO-DOMAIN-02 bytes and HEAD recheck the same publication after I/O; old JSON shares deployment liveness',async()=>{
  const s=await f.openStore();await enable();f.ok(await upload(s,'1'));await publish(s);
  const page=await(await media(s)).json() as any,path=page.photos[0].photo.read_path;
  const before=f.store.gets;
  const head=await f.app.request(f.h.origin+path,{method:'HEAD',headers:{'If-None-Match':'*'}});
  assert.equal(head.status,200);assert.equal(head.headers.get('cache-control'),'no-store');assert.equal(head.headers.get('x-content-type-options'),'nosniff');assert.equal(head.headers.get('content-type'),'image/webp');assert.equal(await head.text(),'');assert(f.store.gets>before);
  const html=await f.app.request(f.h.origin+'/shops/'+s.slug);assert.equal(html.headers.get('cache-control'),'no-store');assert.match(await html.text(),/shop-product-photo/);
  f.store.afterGet=async()=>{f.store.afterGet=undefined;await publish(s,'unpublish');};
  assert.equal((await f.app.request(f.h.origin+path)).status,404);
  await publish(s);await f.h.pool.query("UPDATE deployment_bindings SET state='suspended' WHERE tenant_id=$1 AND instance_id=$2",[s.tenantId,s.instanceId]);
  for(const route of ['/shops/'+s.slug,'/api/v1/public/stores/'+s.slug,'/api/v1/public/stores/'+s.slug+'/media'])assert.equal((await f.app.request(f.h.origin+route)).status,404);
});

test('PHOTO-DOMAIN-03 real product deletion clears draft pointer while retained intent and publication refs survive',async()=>{
  const s=await f.openStore();await enable();const first=f.ok(await upload(s,'1'));await publish(s);
  const page=await(await media(s)).json() as any;
  f.ok(await f.post(s.root+'/products/'+s.productId+'/remove',s.owner,{},first.current.version));
  const target=(await f.h.pool.query('SELECT asset_id,representation_id,policy_revision,linked_at_product_version FROM commerce_product_photo_targets WHERE product_id=$1',[s.productId])).rows[0];
  assert.deepEqual(target,{asset_id:null,representation_id:null,policy_revision:null,linked_at_product_version:null});
  assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM asset_upload_intents WHERE target_product_id=$1',[s.productId])).rows[0].n,1);
  assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM commerce_publication_photo_refs WHERE instance_id=$1',[s.instanceId])).rows[0].n,1);
  assert.equal((await f.app.request(f.h.origin+page.photos[0].photo.read_path)).status,200);
});

test('PHOTO-DOMAIN-04 foreign product/session and invalid decoding cause no retained effect; absent host is closed',async()=>{
  const s=await f.openStore(),other=await f.openStore();await enable();
  const initial=f.store.puts;
  assert.equal((await upload({...s,productId:other.productId},'1')).status,404);
  assert.equal((await upload(s,'1',randomUUID(),photoSourcePng.subarray(0,-1))).status,422);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE purpose='storefront.product-photo'")).rows[0].n,0);assert.equal(f.store.puts,initial);
  f.ok(await upload(s,'1'));
  const privateView=f.ok(await f.call('GET',s.root+'/product-media',s.owner));
  const path=privateView.items[0].photo.read_path;
  assert.equal((await f.app.request(f.h.origin+path,{headers:{Cookie:other.owner.cookie}})).status,404);
  f.ok(await f.post('/auth/logout',s.owner,{}));
  const gets=f.store.gets;assert.equal((await f.app.request(f.h.origin+path,{headers:{Cookie:s.owner.cookie}})).status,401);assert.equal(f.store.gets,gets);
  const fresh=await f.h.signIn(s.owner.user.email,f.app);
  assert.equal((await f.app.request(f.h.origin+path,{headers:{Cookie:fresh.cookie}})).status,200);
  assert.equal((await f.h.closed.request(f.h.origin+'/api/v1'+s.root+'/product-media',{headers:{Cookie:fresh.cookie}})).status,404);
});

test('PHOTO-DOMAIN-05 an unknown immutable PUT retries the same original tuple without a second intent or version',async()=>{
  const s=await f.openStore();await enable();const key=randomUUID();
  f.store.failNext('put-after');f.store.failNext('get');
  const first=await upload(s,'1',key);assert.equal(first.status,503);
  const pending=(await f.h.pool.query('SELECT intent_id,asset_id,state,scope_id,fence,reserved_bytes FROM asset_upload_intents WHERE target_product_id=$1',[s.productId])).rows;
  assert.equal(pending.length,1);assert.equal(pending[0].state,'processing');assert.equal(Number(pending[0].reserved_bytes),1048576);
  assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM asset_objects WHERE asset_id=$1',[pending[0].asset_id])).rows[0].n,0);
  assert.equal(f.ok(await f.call('GET',s.root+'/product-media',s.owner)).items[0].photo,null);
  const effect=(await f.h.pool.query('SELECT effect_id,state FROM asset_object_write_effects WHERE asset_id=$1',[pending[0].asset_id])).rows;
  assert.equal(effect.length,1);assert.equal(effect[0].state,'unknown');
  const q=await f.h.pool.connect();try{assert.equal(await retainedByteUsage(q,pending[0].scope_id,s.tenantId),1048576n);}finally{q.release();}
  const retry=f.ok(await upload(s,'1',key));assert.equal(retry.completed_version,'2');
  const final=(await f.h.pool.query('SELECT intent_id,asset_id,state,scope_id,fence,reserved_bytes FROM asset_upload_intents WHERE target_product_id=$1',[s.productId])).rows;
  assert.equal(final.length,1);assert.equal(final[0].intent_id,pending[0].intent_id);assert.equal(final[0].asset_id,pending[0].asset_id);assert.equal(final[0].state,'finalized');assert.equal(final[0].fence,pending[0].fence);
  assert.equal((await f.h.pool.query('SELECT state FROM asset_object_write_effects WHERE effect_id=$1',[effect[0].effect_id])).rows[0].state,'unknown');
  const effects=(await f.h.pool.query('SELECT state FROM asset_object_write_effects WHERE asset_id=$1 ORDER BY state',[pending[0].asset_id])).rows;
  assert.deepEqual(effects,[{state:'fulfilled'},{state:'unknown'}]);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE asset_id=$1 AND state='ready'",[pending[0].asset_id])).rows[0].n,1);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM scoped_transition_journal WHERE aggregate_id=$1 AND operation='storefront.product.photo.upload'",[s.productId])).rows[0].n,1);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE target_id=$1 AND operation='storefront.product.photo.upload' AND idempotency_key=$2",[s.productId,key])).rows[0].n,1);
  const replay=f.ok(await upload(s,'1',key));assert.equal(replay.completed_version,'2');assert.equal(replay.current.version,'2');
});

test('PHOTO-DOMAIN-06 current exact-instance permissions protect receipt replay and private bytes after uploader revocation',async()=>{
  const s=await f.openStore();await enable();
  async function join(name:string,keys:string[]){
    const person=(await f.h.person(name)).session;
    const principal=f.ok(await f.call('GET',`/tenants/invite-candidates?user_id=${person.user.user_id}`,s.owner)).principal_id;
    const invitation=f.ok(await f.post(`/tenants/${s.tenantId}/invitations`,s.owner,{invitee_principal_id:principal,role:'operator',instance_capabilities:[{instance_id:s.instanceId,capabilities:keys}],expires_at:new Date(Date.now()+86400000).toISOString()}),201);
    f.ok(await f.post(`/tenants/${s.tenantId}/invitations/${invitation.invitation_id}/accept`,person,{},invitation.version));
    return {person,principal};
  }
  const viewer=await join('照片只讀會員',['store:read']);
  assert.equal((await upload({...s,owner:viewer.person},'1')).status,403);
  const writer=await join('照片寫入會員',['store:read','store:write']),key=randomUUID();
  const first=f.ok(await upload({...s,owner:writer.person},'1',key));await publish(s);
  const page=await(await media(s)).json() as any;
  const membership=f.ok(await f.call('GET',`/tenants/${s.tenantId}/members`,s.owner)).items.find((m:any)=>m.principal_id===writer.principal);
  f.ok(await f.post(`/tenants/${s.tenantId}/members/${writer.principal}/change`,s.owner,{role:'operator',status:'active',instance_capabilities:[],reason:'撤銷照片寫入'},membership.version));
  assert.equal((await upload({...s,owner:writer.person},'1',key)).status,404);
  assert.equal((await f.app.request(f.h.origin+first.current.photo.read_path,{headers:{Cookie:writer.person.cookie}})).status,404);
  assert.equal((await f.app.request(f.h.origin+first.current.photo.read_path,{headers:{Cookie:viewer.person.cookie}})).status,200);
  assert.equal((await f.app.request(f.h.origin+page.photos[0].photo.read_path)).status,200);
  await f.h.pool.query("UPDATE commerce_resource_tenants SET mapping_state='ambiguous' WHERE resource_id=(SELECT supply_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1)",[s.instanceId]);
  for(const route of ['/shops/'+s.slug,'/api/v1/public/stores/'+s.slug,'/api/v1/public/stores/'+s.slug+'/media',page.photos[0].photo.read_path])assert.equal((await f.app.request(f.h.origin+route)).status,404);
});
