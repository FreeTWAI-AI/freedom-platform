import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {migrate} from '../../scripts/database.js';
import {runMediaInventory} from '../../scripts/media-inventory.js';
import {inventoryMedia,validateInventoryTarget,MEDIA_SOURCES,MediaInventoryError,type InventoryTarget,type MediaInventoryReport} from '../../packages/media-migration/inventory.js';

// Actual PostgreSQL aggregate fixtures only. No production data, object bytes,
// row identifiers or URLs are returned by inventory; no migration readiness claim.
const source=process.env.TEST_DATABASE_URL;
if(!source||!/^\/fp_[a-z0-9_]+$/.test(new URL(source).pathname))throw Error('Explicit owned fp_* TEST_DATABASE_URL required');
const database=new URL(source).pathname.slice(1);
const releaseSha='a'.repeat(40);
const errorCode=(wanted:string)=>(e:unknown)=>e instanceof MediaInventoryError&&e.code===wanted&&!/RAW_PRIVATE|password|postgresql:\/\//.test(e.message);
const zero={rowCount:'0',nullCount:'0',emptyCount:'0',presentCount:'0',totalBytes:'0',maxBytes:'0',oversizeCount:'0'};
async function fixture(full=false){
  const stem='fp_inv_'+randomUUID().replaceAll('-',''),schema=stem,role=stem+'_reader';
  const admin=new Pool({connectionString:source,max:1});const owner=new Pool({connectionString:source,options:`-c search_path=${schema}`,max:1});
  const url=new URL(source!);url.username=role;url.password='';const reader=new Pool({connectionString:url.toString(),max:1});
  await admin.query(`CREATE SCHEMA ${schema};CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
  const target:InventoryTarget={environment:'local',database,schema,role,releaseSha};
  async function grants(){await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);}
  async function minimal(){
    // Deliberately unconstrained synthetic tables make historical anomaly
    // classification executable without weakening any actual migration.
    for(const spec of MEDIA_SOURCES){
      const columns=[...spec.keyColumns.map(column=>`${column} ${column==='variant'?'text':'uuid'}`),`${spec.byteColumn} bytea`,...(spec.mime.provenance==='mime_column'?[`${spec.mime.column} text`]:[])];
      await admin.query(`CREATE TABLE ${schema}.${spec.table} (${columns.join(',')})`);
    }
    await admin.query(`CREATE TABLE ${schema}.community_event_highlights(media_id uuid,kind text,state text)`);await grants();
  }
  if(full){await migrate(owner);await grants();}else await minimal();
  return {schema,role,target,admin,owner,reader,grants,async close(){await reader.end();await owner.end();await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP ROLE ${role}`);await admin.end();}};
}
function profile(report:MediaInventoryReport,id:string){const result=report.profiles.find(p=>p.profileId===id);assert(result);return result;}
function noAuthority(report:MediaInventoryReport){assert.equal(report.migrationReadiness,'not_evaluated');assert.equal(report.contentDigests,'not_run');assert.equal(report.dataMoved,false);assert.equal(report.restore,'not_run');assert.equal(report.releaseBinding,'operator_declared_not_runtime_verified');}
function tracked(pool:Pool,tweak:(sql:string)=>string=sql=>sql){
  const sql:string[]=[],returned:unknown[]=[];let releases=0;
  const port={async connect(){const client=await pool.connect();return {async query(text:string,params?:unknown[]){sql.push(text);const result=await client.query(tweak(text),params);returned.push(...result.rows);return result;},release(destroy?:boolean){releases++;client.release(destroy);}};}} as unknown as Pool;
  return {port,sql,returned,releases:()=>releases};
}

test('MEDIA-INV-01 full actual migration ledger is compatible with low-privilege aggregate-only inventory',async()=>{
  const f=await fixture(true);try{
    const identity=(await f.reader.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(identity.current_user,f.role);assert.equal(identity.rolsuper,false);assert.equal(identity.rolbypassrls,false);
    const ledger=(await f.owner.query('SELECT count(*)::text AS count,max(name) AS last FROM schema_migrations')).rows[0];assert.equal(ledger.count,String((await readdir(new URL('../../migrations',import.meta.url))).filter(name=>name.endsWith('.sql')).length));assert.match(ledger.last,/^097_/);
    const seen=tracked(f.reader),report=await inventoryMedia(seen.port,f.target);assert.equal(report.completeness,'aggregate_inventory_complete');assert.equal(report.profiles.length,7);noAuthority(report);
    for(const value of report.profiles){assert.equal(value.status,'inventoried');assert.deepEqual(value.counts,zero);assert.equal(value.reason,null);}
    assert.equal(profile(report,'community.event-highlight').highlightDetails!.incompleteActivePairCount,'0');
    assert.equal(seen.sql[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.match(seen.sql[1],/statement_timeout = '30000'/);assert.match(seen.sql[2],/lock_timeout = '3000'/);assert.equal(seen.sql.at(-1),'COMMIT');assert.equal(seen.releases(),1);
    assert(Object.isFrozen(report)&&Object.isFrozen(report.target)&&Object.isFrozen(report.profiles));assert.equal((await f.reader.query("SELECT current_setting('transaction_read_only') AS readonly")).rows[0].readonly,'off');
  }finally{await f.close();}
});

test('MEDIA-INV-02 all seven sources classify null/empty/present/oversize and20MiB using real SQL only',async()=>{
  const f=await fixture();try{
    for(const spec of MEDIA_SOURCES.filter(s=>s.profileId!=='community.event-highlight')){
      const mime=spec.mime.provenance==='mime_column';const mimeColumn=mime?',mime_type':'';
      const sizes=[null,0,1,spec.maxBytes,spec.maxBytes+1];
      for(let i=0;i<sizes.length;i++){const size=sizes[i];await f.admin.query(`INSERT INTO ${f.schema}.${spec.table} (${spec.keyColumns[0]},${spec.byteColumn}${mimeColumn}) VALUES($1,CASE WHEN $2::int IS NULL THEN NULL ELSE decode(repeat('61',$2::int),'hex') END${mime?',$3':''})`,[randomUUID(),size,...(mime?[i===3?'video/mp4':i===4?null:'video/webm']:[])]);}
      if(mime)await f.admin.query(`INSERT INTO ${f.schema}.${spec.table}(event_id,media_bytes,mime_type) VALUES($1,decode('61','hex'),'RAW_PRIVATE_UNKNOWN_MIME')`,[randomUUID()]);
    }
    const seen=tracked(f.reader),report=await inventoryMedia(seen.port,f.target);noAuthority(report);assert.equal(report.completeness,'aggregate_inventory_complete');
    for(const spec of MEDIA_SOURCES.filter(s=>s.profileId!=='community.event-highlight')){
      const value=profile(report,spec.profileId),video=spec.profileId==='community.event-video';
      assert.deepEqual(value.counts,{rowCount:video?'6':'5',nullCount:'1',emptyCount:'1',presentCount:video?'4':'3',totalBytes:String(2*spec.maxBytes+(video?3:2)),maxBytes:String(spec.maxBytes+1),oversizeCount:'1'});
      assert.equal(value.unknownMimeCount,video?'2':null);assert.equal(value.mimeEvidence,video?'mime_column_aggregated_not_content_verified':'legacy_writer_fixed_not_content_verified');
    }
    const serialized=JSON.stringify(report);assert(!serialized.includes('RAW_PRIVATE_UNKNOWN_MIME'));assert(!serialized.includes('616161'));assert(!serialized.includes('postgresql://'));
    for(const row of seen.returned){for(const value of Object.values(row as Record<string,unknown>))assert(!Buffer.isBuffer(value),'inventory query returns no original bytea');}
    const aggregates=seen.sql.filter(sql=>sql.includes('octet_length'));assert(aggregates.length>=7);for(const sql of aggregates){assert(!/SELECT\s+(?:t\.)?(?:image_bytes|media_bytes|bytes)\s+(?:FROM|,)/i.test(sql));assert(sql.includes('count('));assert(sql.includes('"'+f.schema+'".'));}
  }finally{await f.close();}
});

test('MEDIA-INV-03 highlight variants classify thumbnail200KiB, partial/duplicate/missing pairs, removed and orphan records',async()=>{
  const f=await fixture();try{
    const pair=randomUUID(),partial=randomUUID(),missing=randomUUID(),duplicate=randomUUID(),removed=randomUUID(),link=randomUUID(),orphan=randomUUID();
    for(const [id,kind,state]of [[pair,'photo','active'],[partial,'poster','active'],[missing,'photo','active'],[duplicate,'photo','active'],[removed,'photo','removed'],[link,'link','active']])await f.admin.query(`INSERT INTO ${f.schema}.community_event_highlights VALUES($1,$2,$3)`,[id,kind,state]);
    const rows:[string,string|null,number|null][]=[[pair,'image',10],[pair,'thumb',204800],[partial,'image',1],[duplicate,'image',1],[duplicate,'image',1],[duplicate,'thumb',1],[removed,'image',1],[removed,'thumb',204801],[orphan,'image',1],[orphan,'unexpected',0],[link,null,null]];
    for(const [id,variant,size]of rows)await f.admin.query(`INSERT INTO ${f.schema}.community_event_highlight_images VALUES($1,$2,CASE WHEN $3::int IS NULL THEN NULL ELSE decode(repeat('61',$3::int),'hex') END)`,[id,variant,size]);
    const report=await inventoryMedia(f.reader,f.target),result=profile(report,'community.event-highlight'),details=result.highlightDetails!;noAuthority(report);
    assert.deepEqual(result.counts,{rowCount:'11',nullCount:'1',emptyCount:'1',presentCount:'9',totalBytes:'409617',maxBytes:'204801',oversizeCount:'0'});
    assert.equal(details.image.counts.rowCount,'6');assert.equal(details.thumb.counts.rowCount,'3');assert.equal(details.thumb.counts.oversizeCount,'1');assert.equal(details.thumb.writerMaxBytes,204800);assert.equal(details.thumb.sqlMaxBytes,1048576);
    assert.equal(details.unknownVariantCount,'2');assert.equal(details.orphanCount,'2');assert.equal(details.removedParentCount,'2');assert.equal(details.incompleteActivePairCount,'3');
    const json=JSON.stringify(report);for(const id of [pair,partial,missing,duplicate,removed,link,orphan])assert(!json.includes(id));assert(!json.includes('unexpected'));
  }finally{await f.close();}
});

test('MEDIA-INV-04 missing table/column/parent returns incomplete null counts rather than invented zeros',async()=>{
  const f=await fixture();try{
    await f.admin.query(`DROP TABLE ${f.schema}.member_service_covers;ALTER TABLE ${f.schema}.skill_submissions DROP COLUMN image_bytes;ALTER TABLE ${f.schema}.community_event_highlights DROP COLUMN state`);
    const report=await inventoryMedia(f.reader,f.target);assert.equal(report.completeness,'incomplete');noAuthority(report);
    for(const id of ['member.service-cover','skill.submission-image','community.event-highlight']){const value=profile(report,id);assert.equal(value.status,'source_unavailable');assert.equal(value.counts,null);assert.equal(value.unknownMimeCount,null);assert.equal(value.highlightDetails,null);assert.equal(value.reason,'required_source_shape_unavailable');}
    assert.deepEqual(profile(report,'community.event-video').counts,zero);
  }finally{await f.close();}
});

test('MEDIA-INV-05 permission-denied source aborts all output and rolls back the actual SQL session',async()=>{
  const f=await fixture();try{
    await f.admin.query(`REVOKE SELECT ON ${f.schema}.member_service_covers FROM ${f.role}`);const seen=tracked(f.reader);
    await assert.rejects(inventoryMedia(seen.port,f.target),errorCode('inventory_unavailable'));assert.equal(seen.sql.at(-1),'ROLLBACK');assert.equal(seen.releases(),1);
    assert.equal((await f.reader.query("SELECT current_setting('transaction_read_only') AS readonly")).rows[0].readonly,'off');
    await f.grants();assert.equal((await inventoryMedia(f.reader,f.target)).completeness,'aggregate_inventory_complete');
  }finally{await f.close();}
});

test('MEDIA-INV-06 exact database/role/schema and superuser/bypass identity guards reject before media SQL',async()=>{
  const f=await fixture();try{
    for(const changed of [{...f.target,database:'fp_wrong_database'},{...f.target,role:'fp_wrong_role'},{...f.target,schema:'fp_absent_schema'}]){
      const seen=tracked(f.reader);await assert.rejects(inventoryMedia(seen.port,changed),errorCode('invalid_target'));assert.equal(seen.sql.at(-1),'ROLLBACK');assert(!seen.sql.some(sql=>sql.includes('octet_length')));assert.equal(seen.releases(),1);
    }
    for(const flag of ['SUPERUSER','BYPASSRLS']){
      await f.admin.query(`ALTER ROLE ${f.role} ${flag}`);const seen=tracked(f.reader);await assert.rejects(inventoryMedia(seen.port,f.target),errorCode('invalid_target'));assert.equal(seen.sql.at(-1),'ROLLBACK');assert(!seen.sql.some(sql=>sql.includes('octet_length')));
      await f.admin.query(`ALTER ROLE ${f.role} NOSUPERUSER NOBYPASSRLS`);
    }
  }finally{await f.admin.query(`ALTER ROLE ${f.role} NOSUPERUSER NOBYPASSRLS`);await f.close();}
});

test('MEDIA-INV-07 actual non-readonly transaction tripwire rejects and rolls back before source SQL',async()=>{
  const f=await fixture();try{
    // Fault injection changes only BEGIN; the identity/current_setting query is
    // actual PostgreSQL, exercising the library's independent read-only guard.
    const seen=tracked(f.reader,sql=>sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'?'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE':sql);
    await assert.rejects(inventoryMedia(seen.port,f.target),errorCode('inventory_unavailable'));assert.equal(seen.sql.at(-1),'ROLLBACK');assert(!seen.sql.some(sql=>sql.includes('octet_length')));
    assert.equal((await f.reader.query("SELECT current_setting('transaction_read_only') AS readonly")).rows[0].readonly,'off');
  }finally{await f.close();}
});

test('MEDIA-INV-08 unsupported view/function and RLS sources cannot masquerade as complete ordinary-table inventory',async()=>{
  const f=await fixture();try{
    await f.admin.query(`DROP TABLE ${f.schema}.member_service_covers;CREATE FUNCTION ${f.schema}.unsafe_bytes() RETURNS bytea LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'RAW_PRIVATE_VIEW_FUNCTION_MUST_NOT_RUN'; END $$;CREATE VIEW ${f.schema}.member_service_covers AS SELECT gen_random_uuid() AS service_id,${f.schema}.unsafe_bytes() AS image_bytes;ALTER TABLE ${f.schema}.skill_submissions ENABLE ROW LEVEL SECURITY`);await f.grants();
    const report=await inventoryMedia(f.reader,f.target);assert.equal(report.completeness,'incomplete');for(const id of ['member.service-cover','skill.submission-image'])assert.equal(profile(report,id).counts,null);
    assert(!JSON.stringify(report).includes('RAW_PRIVATE'));noAuthority(report);
  }finally{await f.close();}
});

test('MEDIA-INV-09 strict target and frozen registry validation never connects on malformed input',async()=>{
  let connects=0;const pool={async connect(){connects++;throw Error('RAW_PRIVATE_MUST_NOT_CONNECT');}} as unknown as Pool;
  const target={environment:'local',database:'fp_synthetic',schema:'fp_synthetic',role:'fp_reader',releaseSha};let getters=0;
  const invalid=[{...target,extra:true},{...target,database:'postgres'},{...target,schema:'pg_catalog'},{...target,schema:'fp_x;DROP TABLE users'},{...target,role:'UPPER'},{...target,releaseSha:releaseSha+'\n'},{...target,environment:'production'},{...target,get role(){getters++;return 'fp_reader';}}];
  for(const value of invalid){assert.throws(()=>validateInventoryTarget(value),errorCode('invalid_target'));await assert.rejects(inventoryMedia(pool,value as any),errorCode('invalid_target'));}
  assert.equal(connects,0);assert.equal(getters,0);assert(Object.isFrozen(MEDIA_SOURCES));assert.equal(MEDIA_SOURCES.length,7);
  for(const source of MEDIA_SOURCES){assert(Object.isFrozen(source));assert(Object.isFrozen(source.keyColumns));assert(Object.isFrozen(source.schemaSources));assert(Object.isFrozen(source.variants));}
});


function cliArgs(target:InventoryTarget){return ['--environment',target.environment,'--expected-database',target.database,'--schema',target.schema,'--expected-role',target.role,'--release-sha',target.releaseSha];}
test('MEDIA-INV-CLI-01 default plan never reads connection secret; flags and URL target validation fail closed without secret echo',async()=>{
  let secrets=0;const env=Object.defineProperty({},'FREEDOM_MEDIA_DATABASE_URL',{get(){secrets++;throw Error('RAW_PRIVATE_SECRET_MUST_NOT_READ');}});
  const target:InventoryTarget={environment:'local',database:'fp_synthetic',schema:'fp_synthetic',role:'fp_reader',releaseSha};
  const plan=await runMediaInventory(cliArgs(target),env);assert.equal(plan.exitCode,0);assert.equal(secrets,0);const report=plan.report as any;assert.equal(report.dry_run,true);assert.equal(report.execution,'not_run');assert.equal(report.dataMoved,false);assert.equal(report.migrationReadiness,'not_evaluated');
  for(const args of [[],['--unknown'],cliArgs(target).slice(0,-2),[...cliArgs(target),'--schema','fp_other'],[...cliArgs(target),'--execute-readonly','--execute-readonly']]){const result=await runMediaInventory(args,env);assert.equal(result.exitCode,2);assert.equal((result.report as any).code,'invalid_arguments');}assert.equal(secrets,0);
  const missing=await runMediaInventory([...cliArgs(target),'--execute-readonly'],{});assert.equal((missing.report as any).code,'database_configuration_required');
  const urls=['postgresql://fp_reader:RAW_PRIVATE_PASSWORD@external.invalid/fp_synthetic','postgresql://fp_other:RAW_PRIVATE_PASSWORD@localhost/fp_synthetic','postgresql://fp_reader:RAW_PRIVATE_PASSWORD@localhost/fp_other','postgresql://fp_reader:RAW_PRIVATE_PASSWORD@localhost/fp_synthetic?host=/tmp/a&host=/tmp/b','postgresql://fp_reader:RAW_PRIVATE_PASSWORD@localhost/fp_synthetic?host=/tmp/../escape','postgresql://fp_reader:RAW_PRIVATE_PASSWORD@localhost/fp_synthetic?sslmode=disable'];
  for(const url of urls){const result=await runMediaInventory([...cliArgs(target),'--execute-readonly'],{FREEDOM_MEDIA_DATABASE_URL:url});assert.equal(result.exitCode,2);assert.equal((result.report as any).code,'database_target_mismatch');assert(!JSON.stringify(result).includes('RAW_PRIVATE'));assert(!JSON.stringify(result).includes(url));}
  const remote={...target,environment:'staging' as const};for(const mode of ['disable','require','verify-ca']){const result=await runMediaInventory([...cliArgs(remote),'--execute-readonly'],{FREEDOM_MEDIA_DATABASE_URL:'postgresql://fp_reader:RAW_PRIVATE_PASSWORD@external.invalid/fp_synthetic?sslmode='+mode});assert.equal((result.report as any).code,'database_target_mismatch');}
});

test('MEDIA-INV-CLI-02 explicit readonly execution inventories actual PostgreSQL with low-privilege role and incomplete exit status',async()=>{
  const f=await fixture();try{
    const url=new URL(source!);url.username=f.role;url.password='';
    const result=await runMediaInventory([...cliArgs(f.target),'--execute-readonly'],{FREEDOM_MEDIA_DATABASE_URL:url.toString()});assert.equal(result.exitCode,0);const report=result.report as any;
    assert.equal(report.dry_run,false);assert.equal(report.readOnly,true);noAuthority(report.inventory);assert.equal(report.inventory.profiles.length,7);
    assert(!JSON.stringify(result).includes(url.toString()));assert(!JSON.stringify(result).includes('image_bytes'));
    await f.admin.query(`DROP TABLE ${f.schema}.member_service_covers`);
    const incomplete=await runMediaInventory([...cliArgs(f.target),'--execute-readonly'],{FREEDOM_MEDIA_DATABASE_URL:url.toString()});assert.equal(incomplete.exitCode,2);assert.equal((incomplete.report as any).inventory.completeness,'incomplete');
  }finally{await f.close();}
});

test('MEDIA-INV-10 actual SQL scalar fixtures preserve decimals beyond2^53 and reject noncanonical aggregate counts',async()=>{
  const f=await fixture();try{
    // Explicit synthetic scalar substitution exercises report serialization;
    // these weighted values are not asserted to be real source byte totals.
    const expression='COALESCE(sum(octet_length(t."image_bytes")::bigint), 0)::text AS total_bytes';
    const huge=tracked(f.reader,sql=>sql.replace(expression,'9007199254740993::bigint::text AS total_bytes'));
    const report=await inventoryMedia(huge.port,f.target);assert.equal(profile(report,'member.avatar').counts!.totalBytes,'9007199254740993');assert(JSON.stringify(report).includes('"9007199254740993"'));noAuthority(report);
    for(const invalid of ['-1','01','1e3']){const malformed=tracked(f.reader,sql=>sql.replace(expression,`'${invalid}'::text AS total_bytes`));await assert.rejects(inventoryMedia(malformed.port,f.target),errorCode('inventory_unavailable'));assert.equal(malformed.sql.at(-1),'ROLLBACK');}
  }finally{await f.close();}
});
