import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkMigrations} from '../lib/migrations.mjs';

const source=readFileSync(fileURLToPath(new URL('../../../migrations/105_operator_service_cover_backfill.sql',import.meta.url)),'utf8');
function scan(name,sql){const dir=mkdtempSync(join(tmpdir(),'fp-reviewed-migration-'));try{writeFileSync(join(dir,name),sql);return checkMigrations(dir,{first:Number(name.slice(0,3)),last:Number(name.slice(0,3)),known_gaps:[]});}finally{rmSync(dir,{recursive:true});}}
test('only exact reviewed105 bytes report a separate SECURITY DEFINER source exception',()=>{
 const result=scan('105_operator_service_cover_backfill.sql',source);
 assert.equal(result.ok,true);assert.deepEqual(result.privileged,[]);assert.equal(result.reviewed_privileged.length,1);
 assert.equal(result.reviewed_privileged[0].sha256,'e27f74e859485c264cadfd48d5841f0a35e32df3e47e53d115c260a49370814e');
});
test('changed reviewed SQL, renamed SQL and an unlisted definer remain refused',()=>{
 for(const [name,sql] of [['105_operator_service_cover_backfill.sql',source+'\n-- changed source\n'],['105_unreviewed.sql',source],['105_unreviewed.sql','CREATE FUNCTION unsafe() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;']]){
  const result=scan(name,sql);assert.equal(result.ok,false);assert.equal(result.reviewed_privileged.length,0);assert(result.privileged.some(p=>p.statement.startsWith('SECURITY DEFINER')));
 }
});
test('an added privileged category is still rejected on the previously reviewed filename',()=>{
 const result=scan('105_operator_service_cover_backfill.sql',source+'\nALTER SYSTEM SET work_mem=1;');
 assert.equal(result.ok,false);assert(result.privileged.some(p=>p.statement.startsWith('ALTER SYSTEM')));assert.equal(result.reviewed_privileged.length,0);
});

const videoSource=readFileSync(fileURLToPath(new URL('../../../migrations/107_operator_event_video_backfill.sql',import.meta.url)),'utf8');
test('reviewed107 exact bytes preserve the exception while changed or renamed video ports are refused',()=>{
 const result=scan('107_operator_event_video_backfill.sql',videoSource);
 assert.equal(result.ok,true);assert.equal(result.reviewed_privileged[0].sha256,'7afd5fa17f62d1827337ef3ee833fa42ec8d750aa622868b5c22a091f9bbdd11');
 for(const [name,sql] of [['107_operator_event_video_backfill.sql',videoSource+'\n-- changed source\n'],['107_unreviewed.sql',videoSource],['107_operator_event_video_backfill.sql',videoSource+'\nALTER SYSTEM SET work_mem=1;']]){
  const bad=scan(name,sql);assert.equal(bad.ok,false);assert.equal(bad.reviewed_privileged.length,0);assert(bad.privileged.some(p=>p.statement.startsWith('SECURITY DEFINER')));
 }
});
