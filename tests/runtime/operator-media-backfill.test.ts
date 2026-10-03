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
  createOperatorCoverBackfill,planOperatorBackfill,OperatorBackfillError
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
const role=`fp_media_migrator_${process.pid}_${Date.now()}`,schema=`fp_operator_${process.pid}_${Date.now()}`,password=randomBytes(24).toString('hex'),admin=new Pool({
  connectionString:url
}),owner=new Pool({
  connectionString:url,options:`-c search_path=${schema}`
});
let migrator:Pool,mf:Miniflare,store:ObjectStore,bytes:Buffer;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),safe=(e:unknown)=>e instanceof OperatorBackfillError&&e.message==='operator media backfill is unavailable';
const plan=()=>({
  target:{
    environment:'local' as const,database:new URL(url).pathname.slice(1),schema,role,releaseSha:'4'.repeat(40)
  },jobId:randomUUID(),logicalStore:'MEDIA' as const,storeBindingId:'synthetic-native-r2',migrationId:'synthetic-cover-v1',purpose:'member.service-cover' as const,maxRows:1,maxBytes:8388608,leaseSeconds:30
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
  await owner.query("UPDATE domain_media_storage_policy SET mode='bridge',policy_revision='synthetic-operator-v1',persistence_allowed=true,retained_byte_limit=10485760 WHERE purpose='member.service-cover'");
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
async function source(){
  await owner.query('TRUNCATE communities CASCADE');
  const community=randomUUID(),user=randomUUID(),service=randomUUID();
  await owner.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic operator']);
  await owner.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6)',[user,community,user+'@operator.local.test','Synthetic','not-a-password',randomUUID()]);
  await owner.query("INSERT INTO member_services(service_id,community_id,owner_user_id,title,category,summary,service_mode,contacts,state) VALUES($1,$2,$3,'Synthetic','other','Synthetic','online','[{}]','active')",[service,community,user]);
  await owner.query('INSERT INTO member_service_covers(service_id,image_bytes) VALUES($1,$2)',[service,bytes]);
  await backfillLegacyScopeBatch(owner,500);
  await backfillLegacyScopeBatch(owner,500);
  return {
    service,user
  };
}
const host=(s=store)=>createOperatorCoverBackfill(migrator,{
  store:s,logicalStore:'MEDIA',storeBindingId:'synthetic-native-r2'
});
test('real low-privilege operator preserves exact legacy bytes, uses common objects and resumes durable cursor without member credentials',async()=>{
  const s=await source(),p=await approval(plan()),first=await host().run(p);
  assert.equal(first.status,'partial');
  assert.equal(first.linked,1);
  const row=(await owner.query('SELECT c.image_bytes,c.storage_source,s.aggregate_version,t.asset_id,o.content_sha256 FROM member_services s JOIN member_service_covers c USING(service_id) JOIN member_service_cover_asset_targets t USING(service_id) JOIN asset_objects o USING(asset_id) WHERE service_id=$1',[s.service])).rows[0];
  assert.deepEqual(row.image_bytes,bytes);
  assert.equal(row.storage_source,'asset');
  assert.equal(row.aggregate_version,'2');
  assert.equal(row.content_sha256,hash(bytes));
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,0);
  const resumed=await host().run(p);
  assert.equal(resumed.status,'complete');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM assets')).rows[0].n,1);
  assert.ok((await owner.query("SELECT event FROM media_backfill_audit WHERE job_id=$1",[p.jobId])).rows.some(r=>r.event==='linked'));
});
test('missing approval, wrong binding, changed plan and app-policy write permissions fail closed',async()=>{
  await source();
  await assert.rejects(host().run(plan()),safe);
  const raw=plan(),p=await approval(raw);
  await assert.rejects(createOperatorCoverBackfill(migrator,{
    store,logicalStore:'MEDIA',storeBindingId:'foreign-binding'
  }).run(p),safe);
  await assert.rejects(host().run({
    ...raw,maxRows:2
  }),safe);
  await assert.rejects(migrator.query(`UPDATE ${schema}.media_backfill_operator_policy SET allowed=true`),(e:any)=>e.code==='42501');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM assets')).rows[0].n,0);
});
test('fresh transaction detects equal-size source change during native PUT, leaves pending common asset and never publishes',async()=>{
  const s=await source(),p=await approval(plan()),wrapped:ObjectStore={
    ...store,putImmutable:async(k,v)=>{
      const result=await store.putImmutable(k,v);
      const edited=Buffer.from(bytes);
      edited[edited.length-1]^=1;
      await owner.query('UPDATE member_service_covers SET image_bytes=$2 WHERE service_id=$1',[s.service,edited]);
      return result;
    }
  };
  const result=await host(wrapped).run(p);
  assert.equal(result.stale,1);
  assert.equal(result.linked,0);
  assert.equal((await owner.query('SELECT storage_source FROM member_service_covers WHERE service_id=$1',[s.service])).rows[0].storage_source,'legacy');
  assert.equal((await owner.query('SELECT state FROM assets')).rows[0].state,'pending');
});
test('owner disabled during object IO cannot revive original ACL or publish',async()=>{
  const s=await source(),p=await approval(plan()),wrapped:ObjectStore={
    ...store,putImmutable:async(k,v)=>{
      const result=await store.putImmutable(k,v);
      await owner.query('UPDATE users SET active=false WHERE user_id=$1',[s.user]);
      return result;
    }
  };
  const result=await host(wrapped).run(p);
  assert.equal(result.stale,1);
  assert.equal((await owner.query('SELECT aggregate_version FROM member_services WHERE service_id=$1',[s.service])).rows[0].aggregate_version,'1');
});
test('RLS and superuser role reject before storage; CLI dry plan reads no environment and has no implicit store',async()=>{
  await source();
  const raw=plan(),p=await approval(raw);
  await owner.query('ALTER TABLE member_service_covers ENABLE ROW LEVEL SECURITY');
  try{
    await assert.rejects(host().run(p),safe);
  }finally{
    await owner.query('ALTER TABLE member_service_covers DISABLE ROW LEVEL SECURITY');
  }const args=['--environment','local','--expected-database',raw.target.database,'--schema',schema,'--expected-role',role,'--release-sha',raw.target.releaseSha,'--job-id',raw.jobId,'--store-binding-id',raw.storeBindingId,'--migration-id',raw.migrationId,'--max-rows','1','--max-bytes','8388608','--lease-seconds','30'];
  const env=new Proxy({
  },{
    get(){
      throw Error('PRIVATE_SECRET');
    }
  });
  const dry=await runMediaBackfill(args,env);
  assert.equal(dry.exitCode,0);
  assert.equal((dry.report as any).execution,'not_run');
  const absent=await runMediaBackfill([...args,'--execute'],env);
  assert.equal(absent.exitCode,2);
  assert.equal((absent.report as any).code,'trusted_backfill_host_not_installed');
  assert.ok(!JSON.stringify(absent).includes('PRIVATE_SECRET'));
  await assert.rejects(createOperatorCoverBackfill(owner,{
    store,logicalStore:'MEDIA',storeBindingId:raw.storeBindingId
  }).run(p),safe);
});
test('unknown committed native PUT is durably captured and resumes same common intent under new job and intent fences',async()=>{
  const s=await source(),p=await approval(plan()),ambiguous:ObjectStore={
    ...store,putImmutable:async(k,v)=>{
      await store.putImmutable(k,v);
      throw Error('PRIVATE_PUT_DIAGNOSTIC');
    },get:async()=>{
      throw Error('PRIVATE_GET_DIAGNOSTIC');
    }
  };
  await assert.rejects(host(ambiguous).run(p),safe);
  const before=(await owner.query('SELECT m.intent_id,m.asset_id,i.fence FROM media_backfill_items m JOIN asset_upload_intents i USING(intent_id) WHERE job_id=$1',[p.jobId])).rows[0];
  assert.ok(before);
  assert.equal((await owner.query('SELECT storage_source FROM member_service_covers WHERE service_id=$1',[s.service])).rows[0].storage_source,'legacy');
  assert.ok((await owner.query('SELECT event FROM media_backfill_audit WHERE job_id=$1',[p.jobId])).rows.some(r=>r.event==='object_outcome_unknown'));
  await owner.query('UPDATE media_backfill_jobs SET lease_expires_at=clock_timestamp() WHERE job_id=$1',[p.jobId]);
  await owner.query('UPDATE asset_upload_intents SET lease_expires_at=clock_timestamp() WHERE intent_id=$1',[before.intent_id]);
  const resumed=await host().run(p);
  assert.equal(resumed.linked,1);
  const after=(await owner.query('SELECT m.intent_id,m.asset_id,i.fence,j.fence AS job_fence FROM media_backfill_items m JOIN asset_upload_intents i USING(intent_id) JOIN media_backfill_jobs j USING(job_id) WHERE job_id=$1',[p.jobId])).rows[0];
  assert.equal(after.intent_id,before.intent_id);
  assert.equal(after.asset_id,before.asset_id);
  assert.equal(after.fence,'2');
  assert.equal(after.job_fence,'2');
  assert.deepEqual((await owner.query('SELECT image_bytes FROM member_service_covers WHERE service_id=$1',[s.service])).rows[0].image_bytes,bytes);
});
test('dedicated operator cannot change consent, owner activation, approval or immutable source/audit identity',async()=>{
  await source();
  for(const table of ['media_backfill_operator_policy','domain_media_storage_policy','users','principals','resource_scopes']){
    const col=table==='users'?'active=active':table==='principals'||table==='resource_scopes'?'status=status':table==='domain_media_storage_policy'?'mode=mode':'allowed=allowed';
    await assert.rejects(migrator.query(`UPDATE ${schema}.${table} SET ${col}`),(e:any)=>e.code==='42501');
  }const p=await approval(plan());
  await host().run(p);
  await assert.rejects(owner.query('UPDATE media_backfill_items SET source_sha256=$2 WHERE job_id=$1',[p.jobId,'0'.repeat(64)]),(e:any)=>e.code==='23514');
  await assert.rejects(owner.query('DELETE FROM media_backfill_audit WHERE job_id=$1',[p.jobId]),(e:any)=>e.code==='23514');
  const publicRole=`fp_operator_app_${process.pid}`;
  await admin.query(`CREATE ROLE ${publicRole} LOGIN NOSUPERUSER NOBYPASSRLS`);
  try{
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${publicRole}`);
    const q=await admin.connect();
    try{
      await q.query(`SET ROLE ${publicRole}`);
      await assert.rejects(q.query(`UPDATE ${schema}.media_backfill_operator_policy SET allowed=true`),(e:any)=>e.code==='42501');
      await assert.rejects(q.query(`SELECT * FROM ${schema}.lock_media_backfill_operator_approval($1)`,[p.planSha256]),(e:any)=>e.code==='42501');
    }finally{
      await q.query('RESET ROLE');
      q.release();
    }
  }finally{
    await owner.query(`REVOKE USAGE ON SCHEMA ${schema} FROM ${publicRole}`);
    await admin.query(`DROP ROLE ${publicRole}`);
  }
});
test('late immutable PUT after invocation deadline stays fenced and same-plan resume reconciles its bytes',async()=>{
 const s=await source(),p=await approval({...plan(),leaseSeconds:1});let release!:()=>void,entered=false;
 const late:ObjectStore={...store,putImmutable:async(k,v)=>{entered=true;await new Promise<void>(r=>{release=r;});return store.putImmutable(k,v);}};
 const started=Date.now();await assert.rejects(host(late).run(p),safe);assert.ok(entered);assert.ok(Date.now()-started<3000);
 assert.equal((await owner.query('SELECT storage_source FROM member_service_covers WHERE service_id=$1',[s.service])).rows[0].storage_source,'legacy');
 release();await new Promise<void>(r=>setImmediate(r));
 const resumed=await host().run(p);assert.equal(resumed.linked,1);assert.equal((await owner.query('SELECT count(*)::int AS n FROM assets')).rows[0].n,1);
});
test('tampered actual R2 content is never linked and canonical storage consent revocation after IO blocks publication',async()=>{
 const s=await source(),p=await approval(plan());const tamper:ObjectStore={...store,get:async(k)=>{const actual=await store.get(k);if(!actual)return null;await actual.body.cancel();const bad=Buffer.from(bytes);bad[bad.length-1]^=1;return {...actual,body:new ReadableStream({start(c){c.enqueue(bad);c.close();}})};}};
 await assert.rejects(host(tamper).run(p),safe);assert.equal((await owner.query('SELECT storage_source FROM member_service_covers WHERE service_id=$1',[s.service])).rows[0].storage_source,'legacy');
 const other=await source(),approved=await approval(plan());const revoked:ObjectStore={...store,putImmutable:async(k,v)=>{const result=await store.putImmutable(k,v);await owner.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='member.service-cover'");return result;}};
 try{await assert.rejects(host(revoked).run(approved),safe);assert.equal((await owner.query('SELECT aggregate_version FROM member_services WHERE service_id=$1',[other.service])).rows[0].aggregate_version,'1');}finally{await owner.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='member.service-cover'");}
});
test('actual final-audit PostgreSQL lock crossing lease expiry rolls back the complete publication phase',async()=>{
 const s=await source(),p=await approval({...plan(),leaseSeconds:1}),blocker=await owner.connect();
 const lock=String(BigInt(process.pid)*1000000n+12345n);let timer:ReturnType<typeof setTimeout>|undefined,reached=false;
 await owner.query(`CREATE FUNCTION synthetic_hold_final_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.event='linked' THEN PERFORM pg_advisory_xact_lock(${lock});END IF;RETURN NEW;END$$`);
 await owner.query('CREATE TRIGGER synthetic_hold_final_audit BEFORE INSERT ON media_backfill_audit FOR EACH ROW EXECUTE FUNCTION synthetic_hold_final_audit()');
 const isolated=new Pool({connectionString:(migrator as any).options.connectionString}),connect=isolated.connect.bind(isolated),wrapped=new WeakSet<object>();
 (isolated as any).connect=async()=>{const q=await connect();if(wrapped.has(q))return q;wrapped.add(q);const query=q.query.bind(q);(q as any).query=async(sql:any,params?:any)=>{if(typeof sql==='string'&&sql.startsWith('INSERT INTO media_backfill_audit')&&params?.[2]==='linked'){reached=true;timer=setTimeout(()=>{void blocker.query('ROLLBACK');},1300);}return query(sql,params);};return q;};
 try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)',[lock]);await assert.rejects(createOperatorCoverBackfill(isolated,{store,logicalStore:'MEDIA',storeBindingId:p.storeBindingId}).run(p),safe);assert.ok(reached,'test must reach the last audit after publication SQL');assert.equal((await owner.query('SELECT aggregate_version FROM member_services WHERE service_id=$1',[s.service])).rows[0].aggregate_version,'1');assert.equal((await owner.query('SELECT storage_source FROM member_service_covers WHERE service_id=$1',[s.service])).rows[0].storage_source,'legacy');assert.equal((await owner.query('SELECT count(*)::int AS n FROM asset_objects')).rows[0].n,0);assert.equal((await owner.query('SELECT state FROM assets')).rows[0].state,'pending');assert.equal((await owner.query("SELECT count(*)::int AS n FROM media_backfill_audit WHERE job_id=$1 AND event='linked'",[p.jobId])).rows[0].n,0);}finally{clearTimeout(timer);await blocker.query('ROLLBACK');blocker.release();await isolated.end();await owner.query('DROP TRIGGER synthetic_hold_final_audit ON media_backfill_audit');await owner.query('DROP FUNCTION synthetic_hold_final_audit()');}
});
test('operator grant installer rejects PUBLIC authority writes and leaves the original installation unchanged after rollback',async()=>{
 const grants=(await readFile(new URL('../../deploy/cloudflare/sql/40-media-backfill-operator-grants.psql',import.meta.url),'utf8')).split('-- BEGIN CLOSED OPERATOR GRANTS')[1].split('-- END CLOSED OPERATOR GRANTS')[0];
 await owner.query('BEGIN');try{await owner.query(`GRANT UPDATE ON media_backfill_operator_policy TO PUBLIC`);await owner.query("SELECT set_config('freedom.operator_role',$1,true),set_config('freedom.operator_schema',$2,true)",[role,schema]);await assert.rejects(owner.query(grants),(e:any)=>e.message==='Unsafe operator authority privileges');}finally{await owner.query('ROLLBACK');}
 await assert.rejects(migrator.query(`UPDATE ${schema}.media_backfill_operator_policy SET allowed=true`),(e:any)=>e.code==='42501');
});
