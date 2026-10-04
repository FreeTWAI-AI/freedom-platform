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
const imageSource=readFileSync(fileURLToPath(new URL('../../../migrations/109_banner_social_operator_backfill.sql',import.meta.url)),'utf8');
test('reviewed109 banner/social ports require exact installed source and reject privileged additions',()=>{
 const name='109_banner_social_operator_backfill.sql',result=scan(name,imageSource);
 assert.equal(result.ok,true);assert.equal(result.reviewed_privileged[0].sha256,'6df762d6de5dac13c93b42e070fde5de0c2af2612258c1a89ff8d678b33610a7');
 for(const [file,sql] of [[name,imageSource+'\n-- changed source\n'],['109_unreviewed.sql',imageSource],[name,imageSource+'\nALTER SYSTEM SET work_mem=1;']]){
  const changed=scan(file,sql);assert.equal(changed.ok,false);assert(changed.privileged.length>0);
 }
});
for(const [name,digest] of [
 ['110_skill_highlight_operator_backfill.sql','30a7cfeb7488bede72c9da68e19689d555aee1e0ee4d7b9ab4cf151aee9cc46f'],
 ['111_operator_avatar_backfill.sql','695a8c84ac8f7e9c7d7f4ab4049c87b0b32a0e0061a3edebd00801e2ae071c1a'],
])test(`reviewed ${name} accepts exact source and refuses modified or renamed privileged SQL`,()=>{
 const sql=readFileSync(fileURLToPath(new URL('../../../migrations/'+name,import.meta.url)),'utf8');
 const result=scan(name,sql);assert.equal(result.ok,true);assert.equal(result.reviewed_privileged[0].sha256,digest);
 for(const [file,body] of [[name,sql+'\n-- changed source\n'],[name.slice(0,3)+'_unreviewed.sql',sql],[name,sql+'\nALTER SYSTEM SET work_mem=1;']]){
  const refused=scan(file,body);assert.equal(refused.ok,false);assert.equal(refused.reviewed_privileged.length,0);assert(refused.privileged.some(p=>p.statement.startsWith('SECURITY DEFINER')));
 }
});
