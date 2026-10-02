import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool,type PoolClient } from 'pg';
import sharp from 'sharp';
import { migrate } from '../../scripts/database.js';
import { createPool,digest } from '../../packages/db/index.js';
import { tokenHash,type Actor } from '../../modules/identity-membership/service.js';
import { createAvatarAssetService } from '../../modules/assets/index.js';
import { createAssetLifecycle,type LifecycleProfile,type LifecyclePrepare } from '../../modules/assets/engine.js';
import { normalizeImage } from '../../packages/shared/image-runtime.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256 } from '../../packages/asset-storage/index.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString=process.env.TEST_DATABASE_URL;
if(!connectionString)throw new Error('Asset engine tests require explicit isolated TEST_DATABASE_URL');
const schema=`fp_asset_engine_${process.pid}_${Date.now()}`,admin=createPool(connectionString);
const pool=new Pool({connectionString,options:`-c search_path=${schema} -c statement_timeout=10000`,max:12}),community=randomUUID();
let initialized=false,png:Buffer;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);initialized=true;await migrate(pool);png=await sharp({create:{width:20,height:30,channels:3,background:'green'}}).png().toBuffer();});
after(async()=>{await pool.end();if(initialized)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities CASCADE');await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic neutral engine']);});
async function member():Promise<Actor>{
  const id=randomUUID(),hash=tokenHash(randomUUID());
  const row=(await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,community,id+'@engine.local.test','Synthetic member','not-a-login-hash',randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[hash,id]);return {...row,session_hash:hash,csrf_token:'synthetic'};
}
function service(store=new FakeObjectStore()){
  return {store,api:createAvatarAssetService(pool,{store,normalizeAvatar:(bytes,spec)=>normalizeImage(Buffer.from(bytes),spec),resolvePolicy:async()=>({revision:'synthetic-v1',platformPersistenceAllowed:true,retainedByteLimit:'1048576'})})};
}
async function prepare(owner:Actor,api=service().api,expectedVersion='1'){
  const input={key:randomUUID(),targetUserId:owner.user_id,expectedVersion,contentType:'image/png' as const,byteSize:png.length,sha256:await sha256(png)};
  return {input,intent:await api.prepare(owner,input)};
}
async function stored(owner:Actor,api:ReturnType<typeof service>['api'],version='1'){
  const prepared=await prepare(owner,api,version),claim=await api.claim(owner,{key:randomUUID(),intentId:prepared.intent.intentId});
  const lease={intentId:claim.intentId,fence:claim.fence,leaseToken:claim.leaseToken};
  await api.write(owner,{key:randomUUID(),...lease},new ReadableStream({start(c){c.enqueue(png);c.close();}}));return {...prepared,lease};
}
const problem=(code:string)=>(error:unknown)=>error instanceof Problem&&error.code===code;
async function blockedBy(client:PoolClient){
  const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  for(let i=0;i<150;i++){
    const row=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0];
    if(row.blocked)return;await delay(10);
  }assert.fail('expected a demonstrated lock wait');
}
async function expire(owner:Actor){
  while(!(await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE token_hash=$1',[owner.session_hash])).rows[0].expired)await delay(20);
}

test('ENGINE-01 prepare quota advisory is owner/profile-bound and acquired before target locks',async()=>{
  const owner=await member(),peer=await member(),{api}=service();await prepare(owner,api);
  const scope=(await pool.query('SELECT scope_id FROM member_avatar_asset_targets WHERE user_id=$1',[owner.user_id])).rows[0].scope_id;
  const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`asset.quota/v1/${scope}/member.avatar`]);
  const pending=prepare(owner,api);
  try{
    await blockedBy(blocker);
    // A quota-blocked preparation must not own a domain row yet.
    await pool.query('SELECT 1 FROM member_avatars WHERE user_id=$1 FOR UPDATE NOWAIT',[owner.user_id]);
    await prepare(peer,api); // another owner's reservation is independent
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  await pending;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_upload_intents WHERE target_user_id=$1',[owner.user_id])).rows[0].n,2);
});

test('ENGINE-02 actual-clock expiry while quota-blocked commits no new reservation',async()=>{
  const owner=await member(),{api}=service();await prepare(owner,api);
  const scope=(await pool.query('SELECT scope_id FROM member_avatar_asset_targets WHERE user_id=$1',[owner.user_id])).rows[0].scope_id;
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1.2 seconds' WHERE token_hash=$1",[owner.session_hash]);
  const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`asset.quota/v1/${scope}/member.avatar`]);
  const pending=prepare(owner,api),rejected=assert.rejects(pending,problem('session_expired'));
  try{await blockedBy(blocker);await expire(owner);}finally{await blocker.query('ROLLBACK');blocker.release();}
  await rejected;assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_upload_intents')).rows[0].n,1);
});

test('ENGINE-03 previous Asset is prelocked before current-clock decisions or storage readback',async()=>{
  const owner=await member(),{api,store}=service(),first=await stored(owner,api);await api.finalize(owner,{key:randomUUID(),...first.lease});
  const next=await stored(owner,api,'2');let gets=0;const original=store.get.bind(store);store.get=async(...args)=>{gets++;return original(...args)};
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1.2 seconds' WHERE token_hash=$1",[owner.session_hash]);
  const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT asset_id FROM assets WHERE asset_id=$1 FOR SHARE',[first.intent.assetId]);
  const pending=api.finalize(owner,{key:randomUUID(),...next.lease}),rejected=assert.rejects(pending,problem('session_expired'));
  try{await blockedBy(blocker);await expire(owner);}finally{await blocker.query('ROLLBACK');blocker.release();}
  await rejected;assert.equal(gets,0);
  assert.equal((await pool.query('SELECT aggregate_version FROM member_avatars')).rows[0].aggregate_version,'2');
  assert.equal((await pool.query('SELECT asset_id FROM member_avatar_asset_targets')).rows[0].asset_id,first.intent.assetId);
});

test('ENGINE-04 avatar immutable manifest/body digest survives extraction without normalized target fields',async()=>{
  const owner=await member(),{api}=service(),{input,intent}=await prepare(owner,api),{key:_,...body}=input;
  assert.equal((await pool.query('SELECT request_digest FROM asset_upload_intents WHERE intent_id=$1',[intent.intentId])).rows[0].request_digest,digest(body));
  assert.deepEqual(await api.prepare(owner,input),intent);
  await assert.rejects(api.prepare(owner,{...input,targetWorkId:randomUUID()} as typeof input));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n,1);
});

test('ENGINE-05 server profile discriminator and caps cannot be mixed into an unsupported manifest',()=>{
  const base={purpose:'member.avatar',targetKind:'member.avatar',variant:'avatar',inputMaxBytes:2097152,outputMaxBytes:131072} as LifecycleProfile<LifecyclePrepare,unknown>;
  for(const override of [{purpose:'work.private-draft'},{targetKind:'work.private-result'},{variant:'draft'},{inputMaxBytes:8388608},{outputMaxBytes:262144}]){
    assert.throws(()=>createAssetLifecycle(pool,{store:new FakeObjectStore()},{...base,...override} as LifecycleProfile<LifecyclePrepare,unknown>),problem('asset_profile_invalid'));
  }
});
