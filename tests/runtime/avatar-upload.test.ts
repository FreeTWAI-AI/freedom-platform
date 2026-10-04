import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import sharp from 'sharp';
import { migrate } from '../../scripts/database.js';
import { createPool, digest, type Command } from '../../packages/db/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { readAvatar, saveAvatar } from '../../modules/identity-membership/avatars.js';
import { createAvatarUploadFacade, type AvatarUploadPorts } from '../../modules/assets/avatar-upload.js';
import { createAvatarAssetService } from '../../modules/assets/index.js';
import { resolveAvatarUploadPolicy } from '../../modules/assets/avatar-policy.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256 } from '../../packages/asset-storage/index.js';
import { normalizeImage } from '../../packages/shared/image-runtime.js';
import { Problem } from '../../packages/shared/problem.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const connectionString=process.env.TEST_DATABASE_URL;
if(!connectionString)throw new Error('Avatar upload tests require explicit isolated TEST_DATABASE_URL');
const schema=`fp_avatar_upload_${process.pid}_${Date.now()}`;
const admin=createPool(connectionString),pool=new Pool({connectionString,options:`-c search_path=${schema} -c statement_timeout=10000`,max:12});
const community=randomUUID(),origin='http://127.0.0.1:4310';
let initialized=false,png:Buffer;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);initialized=true;await migrate(pool);png=await sharp({create:{width:40,height:35,channels:3,background:'blue'}}).png().toBuffer();});
after(async()=>{await pool.end();if(initialized)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
  await pool.query('DROP FUNCTION IF EXISTS fail_avatar_commit() CASCADE');
  await pool.query('DROP FUNCTION IF EXISTS fail_object_record() CASCADE');
  await pool.query('TRUNCATE communities,avatar_storage_policy,auth_rate_limits CASCADE');await pool.query('INSERT INTO avatar_storage_policy DEFAULT VALUES');
  await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic upload facade']);
});
type Member=Actor&{token:string};
async function member():Promise<Member>{
  const id=randomUUID(),token=randomBytes(32).toString('base64url'),hash=tokenHash(token);
  const row=(await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [id,community,id+'@upload.local.test','Synthetic member','not-a-login-hash',randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[hash,id]);
  return {...row,session_hash:hash,csrf_token:'synthetic',token};
}
const command=(actor:Actor,expected='1',key=randomUUID()):Command=>({actor,expected,key,operation:'POST /api/v1/me/avatar',body:null});
const problem=(code:string)=>(error:unknown)=>error instanceof Problem&&error.code===code;
const sqlCode=(code:string)=>(error:unknown)=>(error as {code?:string})?.code===code;
const latch=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve};};
async function configure(limit='1048576',mode='bridge'){
  await pool.query('UPDATE avatar_storage_policy SET mode=$1,policy_revision=$2,persistence_allowed=true,retained_byte_limit=$3',[mode,'synthetic-v1',limit]);
}
function facade(store=new FakeObjectStore(),overrides:Partial<AvatarUploadPorts>={}){
  return {store,upload:createAvatarUploadFacade(pool,{store,legacySave:(input,value)=>saveAvatar(pool,input,value),...overrides})};
}
const binary=()=>({bytes:png,mime:'image/png'});
async function counts(){return(await pool.query(`SELECT (SELECT count(*)::int FROM assets) AS assets,
  (SELECT count(*)::int FROM asset_upload_intents) AS intents,(SELECT count(*)::int FROM asset_objects) AS objects,
  (SELECT count(*)::int FROM command_receipts WHERE operation='POST /api/v1/me/avatar') AS receipts,
  (SELECT count(*)::int FROM scoped_transition_journal WHERE operation='member.avatar.replace') AS facts`)).rows[0];}

test('UPLOAD-01 unconfigured default remains legacy with the original receipt/body hash and no Asset',async()=>{
  const owner=await member(),input=command(owner),{upload}=facade();const result=await upload(input,binary());
  assert.deepEqual(result,{avatar_url:`/api/v1/members/${owner.user_id}/avatar?v=2`,aggregate_version:'2'});
  assert.deepEqual(await counts(),{assets:0,intents:0,objects:0,receipts:1,facts:0});
  const receipt=(await pool.query('SELECT request_sha256 FROM command_receipts')).rows[0];
  assert.equal(receipt.request_sha256,digest({body:{content_type:'image/png',sha256:createHash('sha256').update(png).digest('hex')},expected:'1'}));
});

test('UPLOAD-02 bridge HTTP POST preserves DTO/ETag/idempotency while atomically publishing asset and scoped facts',async()=>{
  const owner=await member(),{store}=facade();await configure();const app=createApp(pool,origin,'local',{avatarAssetStore:store}),key=randomUUID();
  const post=()=>app.request(origin+'/api/v1/me/avatar',{method:'POST',headers:{Origin:origin,Cookie:`freedom_local_session=${owner.token}`,'X-CSRF-Token':'synthetic','Content-Type':'image/png','If-Match':'"1"','Idempotency-Key':key},body:new Uint8Array(png)});
  const response=await post();assert.equal(response.status,200);assert.equal(response.headers.get('etag'),'"2"');
  const result=await response.json();assert.deepEqual(result,{avatar_url:`/api/v1/members/${owner.user_id}/avatar?v=2`,aggregate_version:2});
  assert.deepEqual(await(await post()).json(),result);
  assert.deepEqual(await counts(),{assets:1,intents:1,objects:1,receipts:1,facts:1});
  const row=(await pool.query('SELECT image_bytes,storage_source FROM member_avatars')).rows[0];assert.equal(row.image_bytes,null);assert.equal(row.storage_source,'asset');
  const receipt=(await pool.query('SELECT request_sha256 FROM command_receipts')).rows[0];
  assert.equal(receipt.request_sha256,digest({body:{content_type:'image/png',sha256:await sha256(png)},expected:'1'}));
  assert.equal((await readAvatar(pool,owner,owner.user_id,'2',store)).aggregate_version,'2');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM transition_journal')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n,0);
});

test('UPLOAD-03 bridge/r2_only without complete server policy or port fails before decode/PUT',async()=>{
  const owner=await member(),store=new FakeObjectStore();let puts=0,decodes=0;store.putImmutable=async()=>{puts++;throw new Error('must not PUT')};
  const {upload}=facade(store,{normalizeAvatar:async()=>{decodes++;throw new Error('must not decode')}});
  await pool.query("UPDATE avatar_storage_policy SET mode='bridge'");
  await assert.rejects(upload(command(owner),binary()),problem('avatar_upload_unavailable'));
  await configure('1048576','r2_only');
  const absent=facade(store,{store:undefined});await assert.rejects(absent.upload(command(owner),binary()),problem('avatar_upload_unavailable'));
  await pool.query('UPDATE avatar_storage_policy SET persistence_allowed=false');
  await assert.rejects(upload(command(owner),binary()),problem('avatar_upload_unavailable'));
  assert.equal(puts,0);assert.equal(decodes,0);assert.deepEqual(await counts(),{assets:0,intents:0,objects:0,receipts:0,facts:0});
});

test('UPLOAD-04 old successful receipt can replay without storage/decoder after removal but still checks current scope',async()=>{
  const owner=await member(),input=command(owner),{upload}=facade();const saved=await upload(input,binary());
  await saveAvatar(pool,{...command(owner,'2'),operation:'POST /api/v1/me/avatar/remove',body:{}},null);await configure();
  const unavailable=facade(undefined,{store:undefined,normalizeAvatar:async()=>{throw new Error('must not decode')}});
  assert.deepEqual(await unavailable.upload(input,binary()),saved);
  assert.equal((await pool.query('SELECT image_bytes FROM member_avatars')).rows[0].image_bytes,null);
  await pool.query("UPDATE resource_scopes SET status='disabled' WHERE owner_principal_id=(SELECT principal_id FROM principals WHERE user_ref=$1)",[owner.user_id]);
  await assert.rejects(unavailable.upload(input,binary()),(error:unknown)=>error instanceof Problem&&error.status===403);
});

for(const table of ['member_avatar_asset_targets','scoped_transition_journal','scoped_outbox','command_receipts']){
  test(`UPLOAD-05 ${table} failure rolls back final pointer/facts/receipt; same POST retries same object`,async()=>{
    const owner=await member(),input=command(owner),{store,upload}=facade();await configure();let puts=0;const original=store.putImmutable.bind(store);
    store.putImmutable=async(...args)=>{puts++;return original(...args)};
    await pool.query("CREATE FUNCTION fail_avatar_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$");
    const event=table==='member_avatar_asset_targets'?'UPDATE':'INSERT';
    const when=table==='scoped_transition_journal'?"WHEN (NEW.operation='member.avatar.replace')":'';
    await pool.query(`CREATE TRIGGER fail_avatar_commit BEFORE ${event} ON ${table} FOR EACH ROW ${when} EXECUTE FUNCTION fail_avatar_commit()`);
    await assert.rejects(upload(input,binary()),sqlCode('P0001'));
    assert.deepEqual(await counts(),{assets:1,intents:1,objects:1,receipts:0,facts:0});
    assert.equal((await pool.query('SELECT aggregate_version FROM member_avatars')).rows[0].aggregate_version,'1');
    assert.equal((await pool.query('SELECT asset_id FROM member_avatar_asset_targets')).rows[0].asset_id,null);
    await pool.query(`DROP TRIGGER fail_avatar_commit ON ${table}`);await pool.query('DROP FUNCTION fail_avatar_commit()');
    const saved=await upload(input,binary());assert.equal(saved.aggregate_version,'2');assert.equal(puts,1);
    assert.deepEqual(await counts(),{assets:1,intents:1,objects:1,receipts:1,facts:1});
  });
}

test('UPLOAD-06 ambiguous object effect without SQL metadata keeps a maximum reservation and is recoverable',async()=>{
  const owner=await member(),input=command(owner),{upload}=facade();await configure('131072');
  await pool.query("CREATE FUNCTION fail_object_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic metadata rollback'; END $$");
  await pool.query('CREATE TRIGGER fail_object_record BEFORE INSERT ON asset_objects FOR EACH ROW EXECUTE FUNCTION fail_object_record()');
  await assert.rejects(upload(input,binary()),sqlCode('P0001'));
  await assert.rejects(upload(command(owner),binary()),problem('asset_retained_quota'));
  assert.deepEqual(await counts(),{assets:1,intents:1,objects:0,receipts:0,facts:0});
  await pool.query('DROP TRIGGER fail_object_record ON asset_objects');await pool.query('DROP FUNCTION fail_object_record()');
  assert.equal((await upload(input,binary())).aggregate_version,'2');assert.equal((await counts()).assets,1);
});

test('UPLOAD-07 actual stored bytes, retained legacy bytes and retired objects all count against retained quota',async()=>{
  const owner=await member(),{upload}=facade();await saveAvatar(pool,command(owner),binary());await configure('131072');
  await assert.rejects(upload(command(owner,'2'),binary()),problem('asset_retained_quota'));
  await pool.query('UPDATE avatar_storage_policy SET retained_byte_limit=1048576');await upload(command(owner,'2'),binary());
  const first=(await pool.query('SELECT byte_size FROM asset_objects')).rows[0].byte_size as number;
  await saveAvatar(pool,{...command(owner,'3'),operation:'POST /api/v1/me/avatar/remove',body:{}},null);
  assert.equal((await pool.query('SELECT state FROM assets')).rows[0].state,'retired');
  await pool.query('UPDATE avatar_storage_policy SET retained_byte_limit=$1',[131072+first-1]);
  await assert.rejects(upload(command(owner,'4'),binary()),problem('asset_retained_quota'));
  await pool.query('UPDATE avatar_storage_policy SET retained_byte_limit=$1',[131072+first]);
  assert.equal((await upload(command(owner,'4'),binary())).aggregate_version,'5');
});

test('UPLOAD-08 expired unresolved intent still consumes its maximum reservation',async()=>{
  const owner=await member();await configure('131072');const store=new FakeObjectStore();
  const api=createAvatarAssetService(pool,{store,normalizeAvatar:(bytes,spec)=>normalizeImage(Buffer.from(bytes),spec),resolvePolicy:resolveAvatarUploadPolicy,intentTtlSeconds:1});
  const input={key:randomUUID(),targetUserId:owner.user_id,expectedVersion:'1',contentType:'image/png' as const,byteSize:png.length,sha256:await sha256(png)};
  const prepared=await api.prepare(owner,input);
  while(!(await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM asset_upload_intents WHERE intent_id=$1',[prepared.intentId])).rows[0].expired)await delay(20);
  await assert.rejects(api.prepare(owner,{...input,key:randomUUID()}),problem('asset_retained_quota'));
  assert.equal((await counts()).assets,1);
});

test('UPLOAD-09 different concurrent keys serialize per-owner capacity; same-key retry never double reserves',async()=>{
  const owner=await member();await configure('131072');const started=latch(),release=latch(),store=new FakeObjectStore();
  const {upload}=facade(store,{normalizeAvatar:async(bytes,spec)=>{started.resolve();await release.promise;return normalizeImage(Buffer.from(bytes),spec)}});
  const input=command(owner),pending=upload(input,binary());await started.promise;
  try{await assert.rejects(upload(command(owner),binary()),problem('asset_retained_quota'));assert.equal((await counts()).assets,1);}finally{release.resolve();}
  const saved=await pending;assert.deepEqual(await upload(input,binary()),saved);assert.equal((await counts()).assets,1);
});

for(const revoke of ['session','policy','revision','mode'] as const){
  test(`UPLOAD-10 ${revoke} change during unlocked normalization prevents final visibility`,async()=>{
    const owner=await member();await configure();const started=latch(),release=latch();
    const {upload}=facade(undefined,{normalizeAvatar:async(bytes,spec)=>{started.resolve();await release.promise;return normalizeImage(Buffer.from(bytes),spec)}});
    const pending=upload(command(owner),binary()),rejected=assert.rejects(pending,(error:unknown)=>error instanceof Problem);await started.promise;
    try{
      if(revoke==='session')await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[owner.session_hash]);
      if(revoke==='policy')await pool.query('UPDATE avatar_storage_policy SET persistence_allowed=false');
      if(revoke==='revision')await pool.query("UPDATE avatar_storage_policy SET policy_revision='synthetic-v2'");
      if(revoke==='mode')await pool.query('UPDATE avatar_storage_policy SET persistence_allowed=false,retained_byte_limit=NULL,policy_revision=NULL');
    }finally{release.resolve();}
    await rejected;assert.equal((await counts()).receipts,0);assert.equal((await counts()).facts,0);
    assert.equal((await pool.query('SELECT asset_id FROM member_avatar_asset_targets')).rows[0].asset_id,null);
  });
}

test('UPLOAD-11 changed content under the same original key conflicts even before a final receipt exists',async()=>{
  const owner=await member();await configure();const input=command(owner),{upload}=facade(undefined,{normalizeAvatar:async()=>{throw new Error('synthetic decode failure')}});
  await assert.rejects(upload(input,binary()),problem('invalid_avatar'));
  const changed=await sharp(png).negate().png().toBuffer();
  await assert.rejects(upload(input,{bytes:changed,mime:'image/png'}),problem('idempotency_conflict'));
  assert.equal((await counts()).assets,1);
});

test('UPLOAD-12 lease expiry retry takes a monotonic fence without allocating another intent',async()=>{
  const owner=await member();await configure();const input=command(owner),store=new FakeObjectStore();let fail=true;
  const {upload}=facade(store,{normalizeAvatar:async(bytes,spec)=>{if(fail)throw new Error('synthetic early decode failure');return normalizeImage(Buffer.from(bytes),spec)}});
  await assert.rejects(upload(input,binary()),problem('invalid_avatar'));
  await pool.query("UPDATE asset_upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second'");fail=false;
  assert.equal((await upload(input,binary())).aggregate_version,'2');
  assert.equal((await pool.query('SELECT fence FROM asset_upload_intents')).rows[0].fence,'2');assert.equal((await counts()).assets,1);
});

test('UPLOAD-13 missing or malformed trusted retained quota fails closed for direct lifecycle callers',async()=>{
  const owner=await member(),store=new FakeObjectStore();
  for(const limit of [undefined,'0','131072\n','9223372036854775808']){
    const api=createAvatarAssetService(pool,{store,normalizeAvatar:async()=>{throw new Error('must not decode')},resolvePolicy:async()=>({revision:'synthetic-v1',platformPersistenceAllowed:true,retainedByteLimit:limit!})});
    await assert.rejects(api.prepare(owner,{key:randomUUID(),targetUserId:owner.user_id,expectedVersion:'1',contentType:'image/png',byteSize:png.length,sha256:await sha256(png)}),problem('avatar_upload_unavailable'));
  }
  assert.equal((await counts()).assets,0);
});

test('UPLOAD-14 truly overlapping same-key effects return the committed receipt once another request finalized',async()=>{
  const owner=await member();await configure();const firstEntered=latch(),secondEntered=latch(),releaseFirst=latch(),releaseSecond=latch();let decodes=0;
  const {upload}=facade(undefined,{normalizeAvatar:async(bytes,spec)=>{
    if(++decodes===1){firstEntered.resolve();await releaseFirst.promise;}else{secondEntered.resolve();await releaseSecond.promise;}
    return normalizeImage(Buffer.from(bytes),spec);
  }});
  const input=command(owner),first=upload(input,binary());await firstEntered.promise;
  const second=upload(input,binary());await secondEntered.promise;
  releaseFirst.resolve();let saved;
  try{saved=await first;}finally{releaseSecond.resolve();}
  assert.deepEqual(await second,saved);assert.equal(decodes,2);
  assert.deepEqual(await counts(),{assets:1,intents:1,objects:1,receipts:1,facts:1});
});

test('UPLOAD-15 response loss after actual COMMIT reconciles by a receipt-only probe, not another effect',async()=>{
  const owner=await member();await configure();let injected=false;
  const ambiguous=new Proxy(pool,{get(target,property){
    if(property==='connect')return async()=>{
      const client=await target.connect();let receipt=false;
      return new Proxy(client,{get(q,key){
        if(key==='query')return async(...args:Parameters<typeof q.query>)=>{
          const sql=String(args[0]),result=await (q.query as (...values:unknown[])=>Promise<unknown>)(...args);
          if(sql.startsWith('INSERT INTO command_receipts'))receipt=true;
          if(sql==='COMMIT'&&receipt&&!injected){injected=true;throw new Error('synthetic lost COMMIT response');}
          return result;
        };
        const value=Reflect.get(q,key);return typeof value==='function'?value.bind(q):value;
      }});
    };
    const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});
  const store=new FakeObjectStore();let puts=0;const original=store.putImmutable.bind(store);store.putImmutable=async(...args)=>{puts++;return original(...args)};
  const upload=createAvatarUploadFacade(ambiguous,{store,legacySave:(input,value)=>saveAvatar(pool,input,value)});
  assert.equal((await upload(command(owner),binary())).aggregate_version,'2');assert.ok(injected);assert.equal(puts,1);
  assert.deepEqual(await counts(),{assets:1,intents:1,objects:1,receipts:1,facts:1});
});

test('UPLOAD-16 old asset success receipt after replacement returns historical DTO without reattaching',async()=>{
  const owner=await member();await configure();const {upload}=facade(),first=command(owner);
  const saved=await upload(first,binary());const replacement=await upload(command(owner,'2'),binary());
  assert.deepEqual(await upload(first,binary()),saved);assert.equal(replacement.aggregate_version,'3');
  assert.equal((await pool.query('SELECT linked_at_version FROM member_avatar_asset_targets')).rows[0].linked_at_version,'3');
  assert.deepEqual(await counts(),{assets:2,intents:2,objects:2,receipts:2,facts:2});
});

for(const revoke of ['scope','onboarding'] as const){
  test(`UPLOAD-17 receipt-only error recovery cannot bypass ${revoke} revocation`,async()=>{
    const owner=await member();await configure();const firstEntered=latch(),secondEntered=latch(),releaseFirst=latch(),releaseSecond=latch();let decodes=0;
    const {upload}=facade(undefined,{normalizeAvatar:async(bytes,spec)=>{
      if(++decodes===1){firstEntered.resolve();await releaseFirst.promise;}else{secondEntered.resolve();await releaseSecond.promise;}
      return normalizeImage(Buffer.from(bytes),spec);
    }});
    const input=command(owner),first=upload(input,binary());await firstEntered.promise;
    const second=upload(input,binary()),rejected=assert.rejects(second,(error:unknown)=>error instanceof Problem&&error.status===403);await secondEntered.promise;
    releaseFirst.resolve();
    try{
      await first;
      if(revoke==='scope')await pool.query("UPDATE resource_scopes SET status='disabled' WHERE owner_principal_id=(SELECT principal_id FROM principals WHERE user_ref=$1)",[owner.user_id]);
      else await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[owner.user_id]);
    }finally{releaseSecond.resolve();}
    await rejected;assert.equal((await counts()).receipts,1);assert.equal((await counts()).facts,1);
  });
}
