import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import sharp from 'sharp';
import { migrate } from '../../scripts/database.js';
import { createPool, type Command } from '../../packages/db/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { avatarMetadata, readAvatar, saveAvatar } from '../../modules/identity-membership/avatars.js';
import { publicMemberAvatar, publicMemberCard } from '../../modules/identity-membership/member-sharing.js';
import { memberCard } from '../../modules/identity-membership/members.js';
import { createAvatarAssetService } from '../../modules/assets/index.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256, type ObjectStore } from '../../packages/asset-storage/index.js';
import { normalizeImage, runWithImageProcessor } from '../../packages/shared/image-runtime.js';
import { Problem } from '../../packages/shared/problem.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Avatar bridge tests require explicit isolated TEST_DATABASE_URL');
const schema = `fp_avatar_bridge_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(), origin = 'http://127.0.0.1:4310';
let initialized = false, png: Buffer, normalized: Buffer;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); initialized = true; await migrate(pool);
  png = await sharp({ create: { width: 30, height: 40, channels: 3, background: 'red' } }).png().toBuffer();
  normalized = await sharp(png).resize(256,256).webp().toBuffer();
});
after(async () => { await pool.end(); if (initialized) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities,avatar_storage_policy,auth_rate_limits CASCADE');
  await pool.query('INSERT INTO avatar_storage_policy DEFAULT VALUES');
  await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Synthetic bridge tests']);
});
type Member = Actor & { token: string };
async function member(): Promise<Member> {
  const id = randomUUID(), token = randomBytes(32).toString('base64url'), hash = tokenHash(token);
  const row = (await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [id,community,id+'@bridge.local.test','Synthetic member','not-a-login-hash',randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [hash,id]);
  return { ...row,session_hash:hash,csrf_token:'synthetic',token };
}
const command = (actor: Actor, expected='1', removing=false): Command => ({ actor,expected,key:randomUUID(),operation:removing?'POST /api/v1/me/avatar/remove':'POST /api/v1/me/avatar',body:{} });
const problem = (code: string) => (error: unknown) => error instanceof Problem && error.code === code;
const sqlCode = (code: string) => (error: unknown) => (error as { code?: string })?.code === code;
const stream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(png); c.close(); } });
const latch = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve=r; }); return { promise,resolve }; };
async function bridge(owner: Actor, options: { mode?: 'bridge'|'r2_only'; legacy?: boolean; store?: FakeObjectStore } = {}) {
  if (options.legacy) await saveAvatar(pool,command(owner),{bytes:png,mime:'image/png'});
  await pool.query('UPDATE avatar_storage_policy SET mode=$1', [options.mode??'bridge']);
  const store=options.store??new FakeObjectStore();
  const api=createAvatarAssetService(pool,{store,normalizeAvatar:(bytes,spec)=>normalizeImage(Buffer.from(bytes),spec),
    // Explicit SYNTHETIC test policy; this is not runtime activation wiring.
    resolvePolicy:async()=>({revision:'synthetic-policy',platformPersistenceAllowed:true,retainedByteLimit:'10485760'})});
  const intent=await api.prepare(owner,{key:randomUUID(),targetUserId:owner.user_id,expectedVersion:options.legacy?'2':'1',contentType:'image/png',byteSize:png.length,sha256:await sha256(png)});
  const lease=await api.claim(owner,{key:randomUUID(),intentId:intent.intentId});
  const input={intentId:intent.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  await api.write(owner,{key:randomUUID(),...input},stream());
  const finalized=await api.finalize(owner,{key:randomUUID(),...input});
  return {store,api,intent,input,finalized};
}
async function share(owner: Actor) {
  const token=randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO member_card_shares(user_id,community_id,share_token,enabled,include_avatar) VALUES($1,$2,$3,true,true)',[owner.user_id,owner.community_id,token]);
  return token;
}
function blockedGet(store: FakeObjectStore) {
  const started=latch(),release=latch(),original=store.get.bind(store); let gets=0;
  store.get=async(...args)=>{gets++;const value=await original(...args);started.resolve();await release.promise;return value;};
  return {started,release,gets:()=>gets};
}

test('BRIDGE-01 migration defaults legacy; legacy bytes, URL and wire shape remain readable', async()=>{
  const owner=await member(),saved=await saveAvatar(pool,command(owner),{bytes:png,mime:'image/png'});
  assert.equal((await pool.query('SELECT mode FROM avatar_storage_policy')).rows[0].mode,'legacy');
  assert.equal((await pool.query('SELECT storage_source FROM member_avatars')).rows[0].storage_source,'legacy');
  assert.equal((await readAvatar(pool,owner,owner.user_id,'2')).aggregate_version,'2');
  assert.deepEqual(await avatarMetadata(pool,owner),saved);
  assert.deepEqual(Object.keys(saved).sort(),['aggregate_version','avatar_url']);
});

test('BRIDGE-02 asset source serves one verified object, presence and current URL without exposing storage identity', async()=>{
  const owner=await member(),viewer=await member(),{store,finalized}=await bridge(owner,{legacy:true});
  let gets=0;const original=store.get.bind(store);store.get=async(...args)=>{gets++;return original(...args);};
  const result=await readAvatar(pool,viewer,owner.user_id,finalized.aggregateVersion,store);
  assert.equal(gets,1); assert.equal((await sharp(result.image_bytes).metadata()).format,'webp');
  const metadata=await avatarMetadata(pool,owner),card=await memberCard(pool,viewer,owner.user_id);
  assert.equal(metadata.avatar_url,`/api/v1/members/${owner.user_id}/avatar?v=3`);
  assert.equal(card.avatar_url,metadata.avatar_url);
  assert.deepEqual(Object.keys(result).sort(),['aggregate_version','image_bytes']);
  assert.equal((await pool.query('SELECT image_bytes IS NOT NULL AS retained,storage_source FROM member_avatars')).rows[0].retained,true);
  assert.equal((await pool.query('SELECT present FROM member_avatar_presence')).rows[0].present,true);
});

test('BRIDGE-03 missing binding, missing object and corrupt bytes never fall back to retained DB bytes', async()=>{
  const owner=await member(),{store}=await bridge(owner,{legacy:true});
  await assert.rejects(readAvatar(pool,owner,owner.user_id,undefined),problem('avatar_unavailable'));
  const original=store.get.bind(store);
  store.get=async()=>null;
  await assert.rejects(readAvatar(pool,owner,owner.user_id,undefined,store),problem('avatar_unavailable'));
  store.get=async(...args)=>{const value=await original(...args);return value&&{...value,body:new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.close();}})};};
  await assert.rejects(readAvatar(pool,owner,owner.user_id,undefined,store),problem('avatar_unavailable'));
  assert.equal((await pool.query('SELECT storage_source FROM member_avatars')).rows[0].storage_source,'asset');
});

test('BRIDGE-04 same URLs authenticate GET/HEAD/Range/conditional; anonymous share is opt-in and no-store',async()=>{
  const owner=await member(),viewer=await member(),{store}=await bridge(owner),token=await share(owner);
  const app=createApp(pool,origin,'local',{avatarAssetStore:store}),path=`/api/v1/members/${owner.user_id}/avatar?v=2`;
  for(const method of ['GET','HEAD']){
    const response=await app.request(origin+path,{method,headers:{Cookie:`freedom_local_session=${viewer.token}`,Range:'bytes=0-1','If-None-Match':'"2"'}});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal(response.headers.get('content-type'),'image/webp');
    assert.equal((await response.arrayBuffer()).byteLength===0,method==='HEAD');
  }
  assert.equal((await app.request(origin+path,{method:'HEAD',headers:{'If-None-Match':'"2"'}})).status,401);
  const publicPath=`/api/v1/public/member-cards/${token}/avatar`;
  const response=await app.request(origin+publicPath,{method:'HEAD',headers:{Range:'bytes=0-1'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(Number(response.headers.get('content-length'))>1);
  assert.equal((await publicMemberCard(pool,token)).avatar_url,publicPath);
  await pool.query('UPDATE member_card_shares SET include_avatar=false,aggregate_version=aggregate_version+1');
  assert.equal((await publicMemberCard(pool,token)).avatar_url,null);
  assert.equal((await app.request(origin+publicPath,{method:'HEAD',headers:{'If-None-Match':'"2"'}})).status,404);
});

for(const revoke of ['session','owner','viewer','scope','principal','expiry'] as const){
  test(`BRIDGE-05 ${revoke} revocation commits while GET waits and final ACL denies bytes`,async()=>{
    const owner=await member(),viewer=await member(),{store}=await bridge(owner),barrier=blockedGet(store);
    const pending=readAvatar(pool,viewer,owner.user_id,undefined,store); const rejected=assert.rejects(pending,problem('avatar_not_found'));
    await barrier.started.promise;
    try{
      if(revoke==='session')await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[viewer.session_hash]);
      if(revoke==='expiry')await pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[viewer.session_hash]);
      if(revoke==='owner'||revoke==='viewer')await pool.query('UPDATE users SET active=false WHERE user_id=$1',[revoke==='owner'?owner.user_id:viewer.user_id]);
      if(revoke==='scope')await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=(SELECT scope_id FROM member_avatar_asset_targets WHERE user_id=$1)",[owner.user_id]);
      if(revoke==='principal')await pool.query("UPDATE principals SET status='disabled' WHERE user_ref=$1",[owner.user_id]);
    }finally{barrier.release.resolve();}
    await rejected; assert.equal(barrier.gets(),1);
  });
}

for(const change of ['disable','rotate','optout','generation'] as const){
  test(`BRIDGE-06 share ${change} during GET rejects using the same generation`,async()=>{
    const owner=await member(),{store}=await bridge(owner),token=await share(owner),barrier=blockedGet(store);
    const pending=publicMemberAvatar(pool,token,store),rejected=assert.rejects(pending,problem('avatar_not_found'));await barrier.started.promise;
    try{
      if(change==='disable')await pool.query('UPDATE member_card_shares SET enabled=false,aggregate_version=aggregate_version+1');
      if(change==='rotate')await pool.query('UPDATE member_card_shares SET share_token=$1,aggregate_version=aggregate_version+1',[randomBytes(32).toString('base64url')]);
      if(change==='optout')await pool.query('UPDATE member_card_shares SET include_avatar=false,aggregate_version=aggregate_version+1');
      if(change==='generation')await pool.query('UPDATE member_card_shares SET aggregate_version=aggregate_version+1');
    }finally{barrier.release.resolve();}
    await rejected;assert.equal(barrier.gets(),1);
  });
}

test('BRIDGE-07 removal during GET detaches, retires and advances only real version; stale receipts cannot restore',async()=>{
  const owner=await member(),{store,intent,api,input}=await bridge(owner,{legacy:true}),barrier=blockedGet(store);
  const pending=readAvatar(pool,owner,owner.user_id,'3',store),rejected=assert.rejects(pending,problem('avatar_not_found'));await barrier.started.promise;
  const remove=command(owner,'3',true);
  try{assert.deepEqual(await saveAvatar(pool,remove,null),{avatar_url:null,aggregate_version:'4'});}finally{barrier.release.resolve();}
  await rejected;
  assert.deepEqual(await saveAvatar(pool,remove,null),{avatar_url:null,aggregate_version:'4'});
  assert.equal((await pool.query('SELECT state FROM assets WHERE asset_id=$1',[intent.assetId])).rows[0].state,'retired');
  assert.deepEqual((await pool.query('SELECT storage_source,image_bytes,aggregate_version FROM member_avatars')).rows[0],{storage_source:'asset',image_bytes:null,aggregate_version:'4'});
  assert.equal((await avatarMetadata(pool,owner)).avatar_url,null);
  await assert.rejects(api.finalize(owner,{key:randomUUID(),...input}),problem('asset_intent_state'));
});

test('BRIDGE-08 actor mutation while GET waits cannot switch final authorization to an unrevoked viewer',async()=>{
  const owner=await member(),viewer=await member(),peer=await member(),{store}=await bridge(owner),barrier=blockedGet(store);
  const actor={...viewer}; const pending=readAvatar(pool,actor,owner.user_id,undefined,store),rejected=assert.rejects(pending,problem('avatar_not_found'));
  await barrier.started.promise;
  try{Object.assign(actor,peer);await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[viewer.session_hash]);}finally{barrier.release.resolve();}
  await rejected;
});

test('BRIDGE-09 initial ACL and version failure perform zero object I/O',async()=>{
  const owner=await member(),viewer=await member(),{store}=await bridge(owner);let gets=0;store.get=async()=>{gets++;throw new Error('must not read');};
  await assert.rejects(readAvatar(pool,viewer,owner.user_id,'1',store),problem('avatar_not_found'));
  const token=await share(owner);await pool.query('UPDATE member_card_shares SET include_avatar=false');
  await assert.rejects(publicMemberAvatar(pool,token,store),problem('avatar_not_found'));
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[viewer.session_hash]);
  await assert.rejects(readAvatar(pool,viewer,owner.user_id,undefined,store),problem('avatar_not_found'));assert.equal(gets,0);
});

test('BRIDGE-10 direct old SQL cannot replace bytes, delete, downgrade source or desynchronize the active pointer',async()=>{
  const owner=await member();await bridge(owner,{legacy:true});
  for(const sql of [
    "UPDATE member_avatars SET image_bytes='\\x01',aggregate_version=aggregate_version+1",
    'UPDATE member_avatars SET image_bytes=image_bytes',
    "UPDATE member_avatars SET storage_source='legacy'",
    'UPDATE member_avatars SET aggregate_version=aggregate_version+1',
    'UPDATE member_avatars SET image_bytes=NULL,aggregate_version=aggregate_version+1',
    'UPDATE member_avatar_asset_targets SET linked_at_version=1',
    'UPDATE member_avatar_asset_targets SET asset_id=NULL,linked_at_version=NULL',
  ])await assert.rejects(pool.query(sql),sqlCode('23514'));
  await assert.rejects(pool.query('DELETE FROM member_avatars'),sqlCode('23503'));
  await assert.rejects(pool.query("UPDATE avatar_storage_policy SET mode='legacy'"),sqlCode('23514'));
  await pool.query('UPDATE member_avatars SET updated_at=clock_timestamp()');
  await pool.query('UPDATE member_avatars SET image_bytes=NULL'); // permitted retained-byte cleanup, not a source fallback
  assert.equal((await pool.query('SELECT present FROM member_avatar_presence')).rows[0].present,true);
});

test('BRIDGE-11 r2_only rejects new and same-byte legacy SQL yet preserves read/remove and bridge rollback floor',async()=>{
  const owner=await member(),peer=await member();await saveAvatar(pool,command(peer),{bytes:png,mime:'image/png'});
  const {store}=await bridge(owner,{mode:'r2_only'});
  await assert.rejects(pool.query('UPDATE member_avatars SET image_bytes=image_bytes WHERE user_id=$1',[peer.user_id]),sqlCode('23514'));
  const newcomer=await member();
  await assert.rejects(pool.query('INSERT INTO member_avatars(user_id,community_id,image_bytes) VALUES($1,$2,$3)',[newcomer.user_id,community,normalized]),sqlCode('23514'));
  await assert.rejects(saveAvatar(pool,command(owner,'2'),{bytes:png,mime:'image/png'}),problem('avatar_upload_unavailable'));
  await assert.rejects(saveAvatar(pool,command(peer,'2'),{bytes:png,mime:'image/png'}),problem('avatar_upload_unavailable'));
  assert.equal((await readAvatar(pool,owner,owner.user_id,undefined,store)).aggregate_version,'2');
  assert.equal((await readAvatar(pool,peer,peer.user_id)).aggregate_version,'2');
  await pool.query("UPDATE avatar_storage_policy SET mode='bridge'");
  await assert.rejects(pool.query("UPDATE avatar_storage_policy SET mode='legacy'"),sqlCode('23514'));
});

test('BRIDGE-12 legacy receipt replay skips unavailable normalization after mode change without resurrecting pixels',async()=>{
  const owner=await member(),input=command(owner),saved=await saveAvatar(pool,input,{bytes:png,mime:'image/png'});
  await saveAvatar(pool,command(owner,'2',true),null);await pool.query("UPDATE avatar_storage_policy SET mode='r2_only'");
  let decodes=0;
  const replay=await runWithImageProcessor({name:'unavailable-test',async normalize(){decodes++;throw new Error('no effect expected');}},()=>saveAvatar(pool,input,{bytes:png,mime:'image/png'}));
  assert.deepEqual(replay,saved);assert.equal(decodes,0);assert.equal((await avatarMetadata(pool,owner)).avatar_url,null);
});

test('BRIDGE-13 legacy normalization holds no user/session/domain locks and rechecks auth before saving',async()=>{
  const owner=await member(),started=latch(),release=latch();
  const pending=runWithImageProcessor({name:'delayed-test',async normalize(){started.resolve();await release.promise;return normalized;}},()=>saveAvatar(pool,command(owner),{bytes:png,mime:'image/png'}));
  const rejected=assert.rejects(pending,problem('session_expired'));await started.promise;
  try{await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[owner.session_hash]);}finally{release.resolve();}
  await rejected;assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_avatars')).rows[0].n,0);
});

test('BRIDGE-14 removal clock recheck rejects a session that expired during a real target row-lock wait',async()=>{
  const owner=await member();await bridge(owner);
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1.2 seconds' WHERE token_hash=$1",[owner.session_hash]);
  const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM member_avatars WHERE user_id=$1 FOR UPDATE',[owner.user_id]);
  const pending=saveAvatar(pool,command(owner,'2',true),null),rejected=assert.rejects(pending,problem('session_expired'));
  try{
    let blocked=false;
    for(let i=0;i<100;i++){
      const row=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE 'SELECT aggregate_version,storage_source%') AS blocked")).rows[0];
      if(row.blocked){blocked=true;break;}await delay(10);
    }
    assert.ok(blocked,'must observe actual blocked query');
    while(!(await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE token_hash=$1',[owner.session_hash])).rows[0].expired)await delay(20);
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  await rejected;assert.equal((await pool.query('SELECT aggregate_version FROM member_avatars')).rows[0].aggregate_version,'2');
});
