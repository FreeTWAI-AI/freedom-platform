import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import sharp from 'sharp';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrate} from '../../scripts/database.js';
import {backfillLegacyScopeBatch} from '../../packages/resource-scopes/index.js';
import {createOperatorMediaBackfill,planOperatorBackfill,OperatorBackfillError} from '../../packages/media-migration/operator-backfill.js';
import {createR2ObjectStore,type AssetR2Binding} from '../../packages/asset-storage/r2.js';
import {objectKey,type ObjectStore} from '../../packages/asset-storage/index.js';
import {readAuthorizedAvatar,type AvatarReadSnapshot,avatarReadColumns,avatarReadJoins} from '../../modules/assets/avatar-read.js';
import {createAvatarAssetService} from '../../modules/assets/index.js';
import {resolveAvatarUploadPolicy} from '../../modules/assets/avatar-policy.js';
import {readAvatar} from '../../modules/identity-membership/avatars.js';
import {createAssetMaintenance} from '../../modules/assets/maintenance.js';
import {transferBackup,transferRestore} from '../../packages/media-migration/backup-transfer.js';
const url=process.env.TEST_DATABASE_URL;if(!url)throw Error('Explicit synthetic TEST_DATABASE_URL required');
const schema=`fp_operator_avatar_${process.pid}_${Date.now()}`,role=`fp_media_migrator_${process.pid}_${Date.now()}`,ownerRole=schema+'_owner',password=randomBytes(24).toString('hex');
const appRole=schema+'_app',appPassword=randomBytes(24).toString('hex');
const admin=new Pool({connectionString:url}),owner=new Pool({connectionString:url,options:`-c role=${ownerRole} -c search_path=${schema}`});
let app:Pool,migrator:Pool,mf:Miniflare,store:ObjectStore,restored:ObjectStore,bytes:Buffer;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),safe=(e:unknown)=>e instanceof OperatorBackfillError;
const plan=()=>({target:{environment:'local' as const,database:new URL(url).pathname.slice(1),schema,role,releaseSha:'a'.repeat(40)},jobId:randomUUID(),logicalStore:'MEDIA' as const,storeBindingId:'synthetic-avatar-r2',migrationId:'synthetic-avatar-v1',purpose:'member.avatar' as const,maxRows:1,maxBytes:8388608,leaseSeconds:30});
before(async()=>{
 await admin.query(`CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE SCHEMA ${schema} AUTHORIZATION ${ownerRole}`);await migrate(owner);
 await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
 const sql=(await readFile(new URL('../../deploy/cloudflare/sql/40-media-backfill-operator-grants.psql',import.meta.url),'utf8')).split('-- BEGIN CLOSED OPERATOR GRANTS')[1].split('-- END CLOSED OPERATOR GRANTS')[0];
 const q=await owner.connect();try{await q.query('BEGIN');await q.query("SELECT set_config('freedom.operator_role',$1,true),set_config('freedom.operator_schema',$2,true)",[role,schema]);await q.query(sql);await q.query('COMMIT');}finally{q.release();}
 await admin.query(`CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`);await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole};GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${appRole};REVOKE ALL ON media_backfill_operator_policy,media_backfill_jobs,media_backfill_items,media_backfill_audit FROM ${appRole}`);const appUrl=new URL(url);appUrl.username=appRole;appUrl.password=appPassword;app=new Pool({connectionString:appUrl.toString(),options:`-c search_path=${schema}`});
 const connection=new URL(url);connection.username=role;connection.password=password;migrator=new Pool({connectionString:connection.toString()});
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'avatar-operator-r2',modules:true,script:'export default {fetch(){return new Response("synthetic");}}',compatibilityDate:'2026-09-21',r2Buckets:['MEDIA','BACKUP','RESTORED']}]}));await mf.ready;
 store=createR2ObjectStore(await mf.getR2Bucket('MEDIA') as unknown as AssetR2Binding);restored=createR2ObjectStore(await mf.getR2Bucket('RESTORED') as unknown as AssetR2Binding);
 const webp=await sharp({create:{width:256,height:256,channels:3,background:'blue'}}).webp().toBuffer();bytes=Buffer.alloc(131072);webp.copy(bytes);bytes.write('JUNK',webp.length);bytes.writeUInt32LE(bytes.length-webp.length-8,webp.length+4);bytes.writeUInt32LE(bytes.length-8,4);
});
after(async()=>{await mf?.dispose();await app?.end();await migrator?.end();await owner.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE;DROP ROLE IF EXISTS ${role};DROP ROLE IF EXISTS ${ownerRole};DROP ROLE IF EXISTS ${appRole}`);await admin.end();});
async function source(){
 await owner.query('TRUNCATE communities CASCADE');await owner.query("UPDATE avatar_storage_policy SET mode='bridge',policy_revision='synthetic-avatar-policy',persistence_allowed=true,retained_byte_limit=4194304");
 const user=randomUUID(),community=randomUUID();await owner.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic avatar']);await owner.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6)',[user,community,user+'@avatar.local.test','Synthetic','not-a-login-hash',randomUUID()]);await owner.query('INSERT INTO member_avatars(user_id,community_id,image_bytes) VALUES($1,$2,$3)',[user,community,bytes]);await backfillLegacyScopeBatch(owner,500);await backfillLegacyScopeBatch(owner,500);return {user,community};
}
async function approval(){const p=planOperatorBackfill(plan()),t=p.target;await owner.query("INSERT INTO media_backfill_operator_policy(role_name,environment,database_name,schema_name,release_sha,logical_store,store_binding_id,migration_id,purpose,approved_plan_sha256,allowed,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,clock_timestamp()+interval '1 hour')",[t.role,t.environment,t.database,t.schema,t.releaseSha,p.logicalStore,p.storeBindingId,p.migrationId,p.purpose,p.planSha256]);return p;}
const host=(s=store)=>createOperatorMediaBackfill(migrator,{store:s,logicalStore:'MEDIA',storeBindingId:'synthetic-avatar-r2'});
const snapshot=async(user:string)=>(await owner.query<AvatarReadSnapshot>(`SELECT ${avatarReadColumns} FROM member_avatars a ${avatarReadJoins} WHERE a.user_id=$1`,[user])).rows[0];
test('native R2 preserves exact 128KiB avatar, owner/version pointer, original bytes, and no synthetic credentials',async()=>{
 const {user}=await source(),p=await approval(),result=await host().run(p);assert.equal(result.linked,1);const row=await snapshot(user);assert.equal(row.aggregate_version,'2');assert.equal(row.profile_id,'member.avatar');assert.deepEqual((await readAuthorizedAvatar(()=>snapshot(user),store,'2')).image_bytes,bytes);assert.deepEqual((await owner.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1',[user])).rows[0].image_bytes,bytes);assert.equal((await owner.query('SELECT count(*)::int n FROM sessions')).rows[0].n,0);assert.equal((await host().run(p)).status,'complete');assert.equal((await owner.query('SELECT count(*)::int n FROM assets')).rows[0].n,1);
 await assert.rejects(readAuthorizedAvatar(()=>snapshot(user)),(e:any)=>e.status===503);
});
test('intentional removed avatars are excluded, while disabled owners remain blocked without revival',async()=>{
 const {user}=await source();await owner.query('UPDATE member_avatars SET image_bytes=NULL WHERE user_id=$1',[user]);assert.equal((await host().run(await approval())).status,'complete');assert.equal((await owner.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);
 await source();await owner.query('UPDATE users SET active=false');const result=await host().run(await approval());assert.equal(result.blocked,1);assert.equal(result.remainingLegacy,true);assert.equal(result.linked,0);
});
test('equal-size source replacement and version replacement after PUT cannot publish',async()=>{
 for(const bump of [false,true]){const {user}=await source(),p=await approval();const wrapping:ObjectStore={...store,async putImmutable(k,v){const result=await store.putImmutable(k,v),changed=Buffer.from(bytes);changed[changed.length-1]^=1;await owner.query(`UPDATE member_avatars SET image_bytes=$2${bump?',aggregate_version=aggregate_version+1':''} WHERE user_id=$1`,[user,changed]);return result;}};const result=await host(wrapping).run(p);assert.equal(result.stale,1);assert.equal(result.linked,0);assert.equal((await owner.query('SELECT storage_source FROM member_avatars')).rows[0].storage_source,'legacy');}
});
test('consent revoked or revision changed during native PUT prevents publication',async()=>{
 for(const update of ["persistence_allowed=false","policy_revision='revoked-revision'","retained_byte_limit=131072"]){await source();const p=await approval(),wrapping:ObjectStore={...store,async putImmutable(k,v){const result=await store.putImmutable(k,v);await owner.query('UPDATE avatar_storage_policy SET '+update);return result;}};await assert.rejects(host(wrapping).run(p),safe);assert.equal((await owner.query('SELECT storage_source FROM member_avatars')).rows[0].storage_source,'legacy');}
});
test('operator cannot write owner, consent, approval, or retained source bytes',async()=>{
 await source();for(const sql of ["UPDATE users SET active=true","UPDATE avatar_storage_policy SET persistence_allowed=true","UPDATE media_backfill_operator_policy SET allowed=true","UPDATE member_avatars SET image_bytes=NULL","UPDATE member_avatars SET aggregate_version=aggregate_version+1"]){await assert.rejects(migrator.query(`SET search_path=${schema};${sql}`),(e:any)=>e.code==='42501');}
});
test('unknown committed native PUT resumes the SAME common Asset without claiming the unknown effect settled',async()=>{
 await source();const p=await approval();let failed=true;const wrapping:ObjectStore={...store,async putImmutable(k,v){await store.putImmutable(k,v);throw Error('Synthetic lost acknowledgement');},async get(k,r){if(failed)throw Error('Synthetic unavailable proof');return store.get(k,r);}};
 await assert.rejects(host(wrapping).run(p),safe);const before=(await owner.query('SELECT asset_id,intent_id FROM media_backfill_items')).rows[0];assert.equal((await owner.query('SELECT state FROM asset_object_write_effects')).rows[0].state,'unknown');failed=false;
 await owner.query("UPDATE asset_upload_intents SET lease_expires_at=LEAST(lease_expires_at,clock_timestamp()-interval '1 second') WHERE intent_id=$1",[before.intent_id]);await owner.query("UPDATE media_backfill_jobs SET lease_expires_at=LEAST(lease_expires_at,clock_timestamp()-interval '1 second') WHERE job_id=$1",[p.jobId]);
 assert.equal((await host().run(p)).linked,1);assert.deepEqual((await owner.query('SELECT asset_id,intent_id FROM media_backfill_items')).rows[0],before);assert.ok((await owner.query('SELECT state FROM asset_object_write_effects')).rows.some(r=>r.state==='unknown'));
});

async function maintenance(){await owner.query("UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-maintenance',orphan_retention_seconds=1,retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=30,pin_seconds=30,max_capture_objects=100");return createAssetMaintenance(owner,{store,enabled:true});}
test('actual DB-pinned backup and native R2 restore preserve historical avatar metadata and read bytes',async()=>{
 const {user}=await source();await host().run(await approval());const maintenancePort=await maintenance(),capture=await maintenancePort.beginCapture({sourceRelease:'a'.repeat(40),sourceSchema:schema});await maintenancePort.captureReferences(capture.captureId);
 const pinned=await maintenancePort.readReferences(capture.captureId),protection={renew:async()=>{await maintenancePort.renewProtection(capture.captureId);},assertCurrent:()=>maintenancePort.readReferences(capture.captureId)};
 // Separate native bucket is an object-copy/restore proof, not a database restore.
 const backup=createR2ObjectStore(await mf.getR2Bucket('BACKUP') as unknown as AssetR2Binding);const manifest=await transferBackup(pinned,store,backup,protection);assert.equal(manifest.objects[0].metadata.profileId,'member.avatar');
 const second=createR2ObjectStore(await mf.getR2Bucket('RESTORED') as unknown as AssetR2Binding);
 assert.equal((await transferRestore(manifest,backup,second,{assertAllowed:async entry=>{assert.equal(entry.metadata.sha256,hash(bytes));await maintenancePort.readReferences(capture.captureId);}})).byteCount,bytes.length);
 assert.deepEqual((await readAuthorizedAvatar(()=>snapshot(user),second,'2')).image_bytes,bytes);await maintenancePort.releaseProtection(capture.captureId,'release');
});
test('covered avatar stays ineligible for old avatar GC even after unlink, retention and effect fulfillment',async()=>{
 const {user}=await source();await host().run(await approval());const asset=(await owner.query('SELECT asset_id FROM assets')).rows[0].asset_id;
 const q=await owner.connect();try{await q.query('BEGIN');await q.query('UPDATE member_avatars SET aggregate_version=aggregate_version+1,image_bytes=NULL WHERE user_id=$1',[user]);await q.query('UPDATE member_avatar_asset_targets SET asset_id=NULL,linked_at_version=NULL WHERE user_id=$1',[user]);await q.query("UPDATE assets SET state='retired',retired_at=clock_timestamp()-interval '2 seconds' WHERE asset_id=$1",[asset]);await q.query('COMMIT');}catch(e){await q.query('ROLLBACK');throw e;}finally{q.release();}
 const maintenancePort=await maintenance();await assert.rejects(maintenancePort.claimDelete(asset),(e:any)=>e.code==='23514'&&e.message==='Operator avatar garbage collection is not installed');assert.equal((await owner.query('SELECT count(*)::int n FROM asset_deletion_tombstones')).rows[0].n,0);const row=(await owner.query('SELECT scope_id,representation_id FROM assets WHERE asset_id=$1',[asset])).rows[0];assert.ok(await store.head(objectKey({scopeId:row.scope_id,assetId:asset,representationId:row.representation_id})));
});

test('original private avatar ACL rechecks the real current session after native object I/O',async()=>{
 const {user}=await source();await host().run(await approval());const token=hash(randomBytes(32));await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-read',clock_timestamp()+interval '1 hour')",[token,user]);const actor={...(await owner.query('SELECT * FROM users WHERE user_id=$1',[user])).rows[0],session_hash:token,csrf_token:'synthetic-read'};
 assert.deepEqual((await readAvatar(owner,actor,user,'2',store)).image_bytes,bytes);
 const wrapping:ObjectStore={...store,async get(k,r){const object=await store.get(k,r);await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[token]);return object;}};
 await assert.rejects(readAvatar(owner,actor,user,'2',wrapping),(e:any)=>e.status===404);await assert.rejects(readAvatar(owner,actor,user,'2',store),(e:any)=>e.status===404);
});
test('incomplete onboarding, disabled principal/scope and community mismatch are blocked sources',async()=>{
 for(const update of ["UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL","UPDATE principals SET status='disabled'","UPDATE resource_scopes SET status='disabled' WHERE kind='personal'","UPDATE member_avatars SET community_id=(SELECT community_id FROM communities WHERE name='Other synthetic')"]){await source();const other=randomUUID();await owner.query('INSERT INTO communities VALUES($1,$2)',[other,'Other synthetic']);await owner.query(update);const result=await host().run(await approval());assert.equal(result.blocked,1);assert.equal(result.remainingLegacy,true);assert.equal(result.linked,0);assert.equal((await owner.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);}
});

test('ordinary avatar publisher retains NULL profile without operator EXECUTE; direct legacy-profile INSERT is denied',async()=>{
 const {user}=await source(),session=hash(randomBytes(32));await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-normal',clock_timestamp()+interval '1 hour')",[session,user]);const actor={...(await owner.query('SELECT * FROM users WHERE user_id=$1',[user])).rows[0],session_hash:session,csrf_token:'synthetic-normal'};
 for(const f of ['operator_avatar_intent_admitted(uuid)','lock_media_backfill_avatar_owner(text,uuid)','lock_media_backfill_avatar_consent(text)','publish_media_backfill_avatar(text,uuid,uuid,bigint,uuid)'])assert.equal((await owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[appRole,schema+'.'+f])).rows[0].allowed,false);
 const png=await sharp({create:{width:256,height:256,channels:3,background:'red'}}).png().toBuffer(),normalized=await sharp(png).webp().toBuffer(),api=createAvatarAssetService(app,{store,normalizeAvatar:async()=>normalized,resolvePolicy:resolveAvatarUploadPolicy});
 const intent=await api.prepare(actor,{key:randomUUID(),targetUserId:user,expectedVersion:'1',contentType:'image/png',byteSize:png.length,sha256:hash(png)}),lease=await api.claim(actor,{key:randomUUID(),intentId:intent.intentId}),input={intentId:intent.intentId,fence:lease.fence,leaseToken:lease.leaseToken};await api.write(actor,{key:randomUUID(),...input},new ReadableStream({start(c){c.enqueue(png);c.close();}}));await api.finalize(actor,{key:randomUUID(),...input});
 const row=(await owner.query('SELECT * FROM asset_objects WHERE asset_id=$1',[intent.assetId])).rows[0];assert.equal(row.profile_id,null);assert.equal(row.transform_version,'avatar.webp.v1');assert.deepEqual((await readAvatar(app,actor,user,'2',store)).image_bytes,normalized);assert.equal((await owner.query('SELECT write_effect_coverage FROM assets WHERE asset_id=$1',[intent.assetId])).rows[0].write_effect_coverage,false);
 await assert.rejects(app.query("INSERT INTO asset_objects(asset_id,scope_id,representation_id,variant,content_type,byte_size,content_sha256,transform_version,policy_revision,profile_id,purpose) VALUES($1,$2,$3,'avatar','image/webp',$4,$5,'member.avatar.legacy-bytes.v1',$6,'member.avatar','member.avatar')",[row.asset_id,row.scope_id,row.representation_id,row.byte_size,row.content_sha256,row.policy_revision]),(e:any)=>e.code==='42501'||e.code==='23514');
});
