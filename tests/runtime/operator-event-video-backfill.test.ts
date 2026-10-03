import {readFile} from 'node:fs/promises';
import {
  test,before,after
} from 'node:test';
import assert from 'node:assert/strict';
import {
  randomUUID,randomBytes,createHash
} from 'node:crypto';
import {
  Pool
} from 'pg';
import sharp from 'sharp';
import {
  Miniflare,convertV4MiniflareOptions
} from 'miniflare';
import {
  migrate
} from '../../scripts/database.js';
import {
  backfillLegacyScopeBatch
} from '../../packages/resource-scopes/index.js';
import {
  createOperatorMediaBackfill,createOperatorCoverBackfill,planOperatorBackfill,OperatorBackfillError
} from '../../packages/media-migration/operator-backfill.js';
import {
  runMediaBackfill
} from '../../scripts/media-backfill.js';
import {
  createR2ObjectStore,type AssetR2Binding
} from '../../packages/asset-storage/r2.js';
import type {
  ObjectStore
} from '../../packages/asset-storage/index.js';
const url=process.env.TEST_DATABASE_URL;
if(!url)throw Error('Explicit isolated TEST_DATABASE_URL required');
const role=`fp_media_migrator_${process.pid}_${Date.now()}`,schema=`fp_operator_video_${process.pid}_${Date.now()}`,password=randomBytes(24).toString('hex'),admin=new Pool({
  connectionString:url
}),owner=new Pool({
  connectionString:url,options:`-c search_path=${schema}`
});
let migrator:Pool,mf:Miniflare,store:ObjectStore,bytes:Buffer;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),safe=(e:unknown)=>e instanceof OperatorBackfillError&&e.message==='operator media backfill is unavailable';
const plan=()=>({
  target:{
    environment:'local' as const,database:new URL(url).pathname.slice(1),schema,role,releaseSha:'4'.repeat(40)
  },jobId:randomUUID(),logicalStore:'MEDIA' as const,storeBindingId:'synthetic-native-r2',migrationId:'synthetic-video-v1',purpose:'community.event-video' as const,maxRows:1,maxBytes:134217728,leaseSeconds:30
});
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await owner.query('SELECT 1');
  await migrate(owner);
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  const grants=await readFile(new URL('../../deploy/cloudflare/sql/40-media-backfill-operator-grants.psql',import.meta.url),'utf8');
  await owner.query('BEGIN');
  try{await owner.query("SELECT set_config('freedom.operator_role',$1,true),set_config('freedom.operator_schema',$2,true)",[role,schema]);await owner.query(grants.split('-- BEGIN CLOSED OPERATOR GRANTS')[1].split('-- END CLOSED OPERATOR GRANTS')[0]);await owner.query('COMMIT');}catch(error){await owner.query('ROLLBACK');throw error;}
  const connection=new URL(url);
  connection.username=role;
  connection.password=password;
  migrator=new Pool({
    connectionString:connection.toString()
  });
  mf=new Miniflare(convertV4MiniflareOptions({
    workers:[{
      name:'operator-native-r2',modules:true,script:'export default {fetch(){return new Response("synthetic");}}',compatibilityDate:'2026-09-21',r2Buckets:['MEDIA']
    }]
  }));
  await mf.ready;
  store=createR2ObjectStore(await mf.getR2Bucket('MEDIA') as unknown as AssetR2Binding);
  bytes=await sharp({
    create:{
      width:1200,height:675,channels:3,background:'green'
    }
  }).webp().toBuffer();
  await owner.query("UPDATE domain_media_storage_policy SET mode='bridge',policy_revision='synthetic-operator-v1',persistence_allowed=true,retained_byte_limit=134217728 WHERE purpose='community.event-video'");
});
after(async()=>{
  await mf?.dispose();
  await migrator?.end();
  await owner.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`DROP ROLE IF EXISTS ${role}`);
  await admin.end();
});
async function approval(raw:ReturnType<typeof plan>){
  const p=planOperatorBackfill(raw),t=p.target;
  await owner.query('INSERT INTO media_backfill_operator_policy(role_name,environment,database_name,schema_name,release_sha,logical_store,store_binding_id,migration_id,purpose,approved_plan_sha256,allowed,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,clock_timestamp()+interval \'1 hour\')',[t.role,t.environment,t.database,t.schema,t.releaseSha,p.logicalStore,p.storeBindingId,p.migrationId,p.purpose,p.planSha256]);
  return p;
}
function mp4(size=1048576){const value=Buffer.alloc(size,7);value.write('ftyp',4,'ascii');return value;}
function webm(size=1048576){const value=Buffer.alloc(size,9);Buffer.from([0x1a,0x45,0xdf,0xa3]).copy(value);return value;}
async function source(value=mp4(),mime:'video/mp4'|'video/webm'='video/mp4',mappingPasses=2){
 await owner.query('TRUNCATE communities CASCADE');const community=randomUUID(),user=randomUUID(),event=randomUUID();await owner.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic operator video']);await owner.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6)',[user,community,user+'@operator-video.local.test','Synthetic','not-a-password',randomUUID()]);
 await owner.query("INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind) VALUES($1,$2,$3,'Synthetic ended','Synthetic',clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day','online','Synthetic','published','open','other')",[event,community,user]);await owner.query('INSERT INTO community_event_videos(event_id,media_bytes,mime_type) VALUES($1,$2,$3)',[event,value,mime]);for(let i=0;i<mappingPasses;i++)await backfillLegacyScopeBatch(owner,500);return {event,user,community,value,mime};
}
const host=(s=store)=>createOperatorMediaBackfill(migrator,{
  store:s,logicalStore:'MEDIA',storeBindingId:'synthetic-native-r2'
});
test('real restricted operator migrates exact20MiB published/ended MP4 with genuine community scope and no member credentials',async()=>{const src=await source(mp4(20971520)),p=await approval(plan()),first=await host().run(p);assert.equal(first.linked,1);assert.equal(first.contentReadUpperBound,20971520*6);const row=(await owner.query('SELECT v.media_bytes,v.storage_source,e.aggregate_version,a.scope_kind,a.community_ref,o.content_sha256 FROM community_event_videos v JOIN community_events e USING(event_id) JOIN community_event_video_asset_targets t USING(event_id) JOIN assets a USING(asset_id) JOIN asset_objects o USING(asset_id) WHERE event_id=$1',[src.event])).rows[0];assert.deepEqual(row.media_bytes,src.value);assert.equal(row.storage_source,'asset');assert.equal(row.aggregate_version,'2');assert.equal(row.scope_kind,'community');assert.equal(row.community_ref,src.community);assert.equal(row.content_sha256,hash(src.value));assert.equal((await owner.query('SELECT count(*)::int n FROM sessions')).rows[0].n,0);const result=await host().run(p);assert.equal(result.status,'complete');assert.equal(result.allSourcesMigrated,true);assert.equal((await owner.query('SELECT count(*)::int n FROM assets')).rows[0].n,1);});
test('WebM exact native R2 representation retains original public video GET authority',async()=>{const src=await source(webm(),'video/webm'),p=await approval(plan());await host().run(p);const {eventVideoHttp}=await import('../../modules/community/events.js');const response=await eventVideoHttp(owner,src.event,{method:'GET'},store);assert.ok(response.body instanceof Uint8Array);assert.equal(hash(response.body),hash(src.value));await owner.query("UPDATE community_events SET state='cancelled',aggregate_version=aggregate_version+1 WHERE event_id=$1",[src.event]);await assert.rejects(eventVideoHttp(owner,src.event,{method:'HEAD'},store));});
test('unknown committed native PUT resumes same immutable asset under newer job and intent fences',async()=>{const src=await source(),raw={...plan(),leaseSeconds:1},p=await approval(raw),ambiguous={...store,putImmutable:async(...args:Parameters<ObjectStore['putImmutable']>)=>{await store.putImmutable(...args);throw Error('synthetic unknown outcome');},get:async()=>{throw Error('synthetic unavailable readback');}};await assert.rejects(host(ambiguous).run(p),safe);const item=(await owner.query('SELECT * FROM media_backfill_items WHERE job_id=$1',[p.jobId])).rows[0];await owner.query('UPDATE media_backfill_jobs SET lease_expires_at=clock_timestamp() WHERE job_id=$1',[p.jobId]);await owner.query('UPDATE asset_upload_intents SET lease_expires_at=clock_timestamp() WHERE intent_id=$1',[item.intent_id]);const resumed=await host().run(p);assert.equal(resumed.linked,1);const after=(await owner.query('SELECT intent_id,asset_id,fence FROM asset_upload_intents')).rows[0];assert.equal(after.intent_id,item.intent_id);assert.equal(after.asset_id,item.asset_id);assert.equal(after.fence,'2');assert.deepEqual((await owner.query('SELECT media_bytes FROM community_event_videos WHERE event_id=$1',[src.event])).rows[0].media_bytes,src.value);});
test('equal-size changed source during PUT is stale and delta plan later migrates only the current SHA',async()=>{const src=await source(),p=await approval(plan()),changed=mp4();changed[30]=22;let once=false;const mutate={...store,putImmutable:async(...args:Parameters<ObjectStore['putImmutable']>)=>{const result=await store.putImmutable(...args);if(!once){once=true;await owner.query('UPDATE community_event_videos SET media_bytes=$2 WHERE event_id=$1',[src.event,changed]);}return result;}};const result=await host(mutate).run(p);assert.equal(result.stale,1);assert.equal(result.allSourcesMigrated,false);assert.equal((await owner.query('SELECT storage_source FROM community_event_videos')).rows[0].storage_source,'legacy');const delta=await approval(plan());assert.equal((await host().run(delta)).linked,1);assert.equal((await owner.query("SELECT o.content_sha256 FROM asset_objects o JOIN assets a USING(asset_id) WHERE a.state='ready'")).rows[0].content_sha256,hash(changed));});
test('inactive organizer and disabled principal/community scope classify blocked without revival or false completion',async()=>{for(const kind of ['owner','principal','scope']){const src=await source();if(kind==='owner')await owner.query('UPDATE users SET active=false WHERE user_id=$1',[src.user]);if(kind==='principal')await owner.query("UPDATE principals SET status='disabled' WHERE user_ref=$1",[src.user]);if(kind==='scope')await owner.query("UPDATE resource_scopes SET status='disabled' WHERE community_ref=$1",[src.community]);const p=await approval(plan()),first=await host().run(p);assert.equal(first.status,'blocked');assert.equal(first.blocked,1);assert.equal(first.allSourcesMigrated,false);const final=await host().run(p);assert.equal(final.status,'blocked');assert.equal(final.allSourcesMigrated,false);assert.equal((await owner.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);assert.equal((await owner.query('SELECT storage_source FROM community_event_videos')).rows[0].storage_source,'legacy');}});
test('operator approval, consent, exact store/plan and video bounded limits cannot be guessed',async()=>{await source();await assert.rejects(host().run(plan()),safe);const p=await approval(plan());await assert.rejects(host().run({...p,storeBindingId:'wrong'}),safe);assert.throws(()=>planOperatorBackfill({...plan(),maxRows:2}),safe);assert.throws(()=>planOperatorBackfill({...plan(),maxBytes:8388608}),safe);assert.throws(()=>planOperatorBackfill({...plan(),maxBytes:134217729}),safe);await assert.rejects(createOperatorCoverBackfill(migrator,{store,logicalStore:'MEDIA',storeBindingId:p.storeBindingId}).run(p),safe);await owner.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='community.event-video'");await assert.rejects(host().run(p),safe);await owner.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='community.event-video'");});
test('actual operator installer prohibits source bytes/owner/consent/approval writes',async()=>{await source();for(const sql of ['UPDATE community_event_videos SET media_bytes=media_bytes','UPDATE community_events SET organizer_ref=organizer_ref','UPDATE users SET active=active','UPDATE domain_media_storage_policy SET persistence_allowed=true','UPDATE media_backfill_operator_policy SET allowed=true'])await assert.rejects(migrator.query('SET search_path TO '+schema+';'+sql),(e:any)=>e.code==='42501');});

test('oversized legacy anomaly is reported blocked without loading or moving source bytes',async()=>{const src=await source();await owner.query('ALTER TABLE community_event_videos DROP CONSTRAINT community_event_videos_media_bytes_check');try{await owner.query('UPDATE community_event_videos SET media_bytes=$2 WHERE event_id=$1',[src.event,mp4(20971521)]);const p=await approval(plan()),result=await host().run(p);assert.equal(result.status,'blocked');assert.equal(result.blocked,1);assert.equal(result.contentReadUpperBound,0);assert.equal(result.allSourcesMigrated,false);assert.equal((await owner.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);}finally{await owner.query('TRUNCATE communities CASCADE');await owner.query('ALTER TABLE community_event_videos ADD CONSTRAINT community_event_videos_media_bytes_check CHECK(octet_length(media_bytes) BETWEEN 1 AND 20971520)');}});
test('canonical storage prohibition after native PUT cannot publish or rewrite original video',async()=>{const src=await source(),p=await approval(plan()),mutate={...store,putImmutable:async(...args:Parameters<ObjectStore['putImmutable']>)=>{const result=await store.putImmutable(...args);await owner.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='community.event-video'");return result;}};try{await assert.rejects(host(mutate).run(p),safe);assert.equal((await owner.query('SELECT storage_source FROM community_event_videos WHERE event_id=$1',[src.event])).rows[0].storage_source,'legacy');assert.equal((await owner.query('SELECT state FROM assets')).rows[0].state,'pending');assert.equal((await owner.query('SELECT aggregate_version FROM community_events WHERE event_id=$1',[src.event])).rows[0].aggregate_version,'1');}finally{await owner.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='community.event-video'");}});

test('missing canonical principal/scope mappings remain blocked rather than synthesized by operator',async()=>{for(const passes of [0,1]){await source(mp4(),'video/mp4',passes);const p=await approval(plan()),result=await host().run(p);assert.equal(result.status,'blocked');assert.equal(result.blocked,1);assert.equal(result.allSourcesMigrated,false);assert.equal((await owner.query('SELECT count(*)::int n FROM principals')).rows[0].n,0);assert.equal((await owner.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);}});
test('CLI video plan remains dry without trusted installation and cover defaults remain separately closed',async()=>{const raw=plan(),t=raw.target,args=['--environment',t.environment,'--expected-database',t.database,'--schema',t.schema,'--expected-role',t.role,'--release-sha',t.releaseSha,'--job-id',raw.jobId,'--store-binding-id',raw.storeBindingId,'--migration-id',raw.migrationId,'--max-rows','1','--max-bytes',String(raw.maxBytes),'--lease-seconds','30','--purpose',raw.purpose];const dry=await runMediaBackfill(args,{TEST_DATABASE_URL:'synthetic-unavailable'});assert.equal(dry.exitCode,0);assert.equal((dry.report as any).execution,'not_run');assert.equal((dry.report as any).plan.purpose,'community.event-video');const absent=await runMediaBackfill([...args,'--execute'],{});assert.equal(absent.exitCode,2);assert.equal((absent.report as any).code,'trusted_backfill_host_not_installed');});

test('retained quota lowered after PUT blocks ready pointer publication without discarding historical bytes',async()=>{const src=await source(),p=await approval(plan()),mutate={...store,putImmutable:async(...args:Parameters<ObjectStore['putImmutable']>)=>{const result=await store.putImmutable(...args);await owner.query("UPDATE domain_media_storage_policy SET retained_byte_limit=1048576 WHERE purpose='community.event-video'");return result;}};try{await assert.rejects(host(mutate).run(p),safe);assert.equal((await owner.query('SELECT storage_source FROM community_event_videos WHERE event_id=$1',[src.event])).rows[0].storage_source,'legacy');assert.deepEqual((await owner.query('SELECT media_bytes FROM community_event_videos WHERE event_id=$1',[src.event])).rows[0].media_bytes,src.value);assert.equal((await owner.query('SELECT state FROM assets')).rows[0].state,'pending');}finally{await owner.query("UPDATE domain_media_storage_policy SET retained_byte_limit=134217728 WHERE purpose='community.event-video'");}});
