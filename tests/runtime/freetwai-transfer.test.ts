import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_COMMUNITY, DEMO_USERS} from '../../packages/testing/seed.js';
import {PageGitHubReader} from '../../modules/development/page-github.js';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw Error('Explicit isolated TEST_DATABASE_URL required');
const schema=`fp_transfer_${process.pid}_${Date.now()}`;
const admin=createPool(url),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const sql=await readFile(new URL('../../migrations/166_freetwai_repository_transfer.sql',import.meta.url),'utf8');
const old='freetwai-ai/freedom-platform',current='freetwai/freedom-platform';
async function transfer(){const q=await pool.connect();try{await q.query('BEGIN');await q.query(sql);await q.query('COMMIT');}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}}
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,github_sync_repositories,github_repository_metrics,skill_star_support,canonical_repositories,github_repository_events CASCADE');await seedLocal(pool);});
async function repository(key:string){await pool.query(`INSERT INTO github_sync_repositories(repository_key,repository,access_status,backfilled,last_error,last_synced_at)
  VALUES($1,$1,'unreadable',true,'github_moved','2026-10-12')`,[key]);}
async function item(key:string,number:number,title:string,date:string){await pool.query(`INSERT INTO github_items(repository_key,number,kind,title,state,created_at,updated_at,synced_at,page_ids,labels,assignees,body_excerpt)
  VALUES($1,$2,'issue',$3,'open','2026-09-01',$4,$4,ARRAY['community'],ARRAY['page:community'],ARRAY['maker'],'retained body')`,[key,number,title,date]);}
async function snapshot(){const result:Record<string,unknown>={};for(const table of ['github_sync_repositories','github_items','github_repository_metrics','skill_star_support','canonical_repositories','catalog_repo_observations','development_grants','github_history_cache','oss_projects','oss_project_versions'])result[table]=(await pool.query(`SELECT row_to_json(r) AS row FROM ${table} r ORDER BY row_to_json(r)::text`)).rows;return result;}

test('upgrade unions history, resolves collisions by freshness, resumes backfill and is idempotent',async()=>{
  await repository(old);await repository(current);
  await item(old,1,'old-only','2026-10-01');await item(current,2,'new-only','2026-10-02');
  await item(old,3,'newer-old-content','2026-10-03');await item(current,3,'stale-new-content','2026-10-01');
  await item(old,4,'stale-old-content','2026-10-01');await item(current,4,'newer-new-content','2026-10-04');
  await item(old,5,'equal-old-content','2026-10-05');await item(current,5,'equal-new-content','2026-10-05');
  await transfer();
  assert.deepEqual((await pool.query('SELECT repository_key,number,title,page_ids,body_excerpt FROM github_items ORDER BY number')).rows,
    ['old-only','new-only','newer-old-content','newer-new-content','equal-new-content'].map((title,i)=>({repository_key:current,number:i+1,title,page_ids:['community'],body_excerpt:'retained body'})));
  const row=(await pool.query('SELECT * FROM github_sync_repositories')).rows[0];
  assert.equal(row.repository_key,current);assert.equal(row.access_status,'pending');assert.equal(row.last_error,null);
  assert.equal(row.since,null);assert.equal(row.etag,null);assert.equal(row.backfilled,false);
  assert.equal(row.last_synced_at.toISOString(),'2026-10-12T00:00:00.000Z');
  assert.equal((await new PageGitHubReader(pool).read()).items.length,5);
  const first=await snapshot();await transfer();assert.deepEqual(await snapshot(),first);
});

test('metrics and confirmed support retain latest observations without double counting',async()=>{
  await pool.query(`INSERT INTO github_repository_metrics(repository_key,snapshot,checked_at) VALUES
    ($1,'{"stars":3}','2026-10-03'),($2,'{"stars":1}','2026-10-01'),
    ('freetwai-ai/freedom-storefront',NULL,'2026-10-05'),('freetwai/freedom-storefront','{"stars":5}','2026-10-01')`,[old,current]);
  await pool.query(`INSERT INTO skill_star_support VALUES
    ('42',$1,'2026-09-01',false,'2026-10-03'),('42',$2,'2026-09-05',true,'2026-10-01'),
    ('43',$1,'2026-09-02',true,'2026-10-02')`,[old,current]);
  await transfer();
  assert.deepEqual((await pool.query('SELECT repository_key,snapshot FROM github_repository_metrics ORDER BY repository_key')).rows,
    [{repository_key:current,snapshot:{stars:3}},{repository_key:'freetwai/freedom-storefront',snapshot:{stars:5}}]);
  const support=(await pool.query('SELECT * FROM skill_star_support ORDER BY github_user_id')).rows;
  assert.equal(support.length,2);assert.equal(support[0].active,false);assert.equal(support[0].repository_key,current);
  assert.equal(support[0].first_confirmed_at.toISOString(),'2026-09-01T00:00:00.000Z');
  const first=await snapshot();await transfer();assert.deepEqual(await snapshot(),first);
});

test('only ID-matched live coordinates change; authority, expiry, revocation and historical bytes survive',async()=>{
  const id=randomUUID();
  await pool.query(`INSERT INTO canonical_repositories(repo_id,provider,provider_repo_id,full_name,current_url)
    VALUES($1,'github','1378081342','FreeTWAI-AI/freedom-platform','https://github.com/FreeTWAI-AI/freedom-platform'),
    ($2,'github','9999','FreeTWAI-AI/freedom-platform','https://github.com/FreeTWAI-AI/freedom-platform')`,[id,randomUUID()]);
  await pool.query(`INSERT INTO catalog_repo_observations(book_id,provider,provider_repo_id,requested_full_name,full_name,current_url,needs_recheck)
    VALUES('synthetic','github','1378081342','FreeTWAI-AI/freedom-platform','FreeTWAI-AI/freedom-platform','https://github.com/FreeTWAI-AI/freedom-platform',true)`);
  const grant=randomUUID();
  await pool.query(`INSERT INTO development_grants(grant_id,community_id,user_id,capability,target_key,target_repository,target_repository_id,
    working_repository,working_repository_id,github_user_id,installation_id,app_id,guild_sources,policy_version,expires_at,revoked_at)
    VALUES($1,$2,$3,'platform','platform','FreeTWAI-AI/freedom-platform','1378081342','maker/freedom-platform','777','42','10','9',ARRAY['guild_platform_engineering'],'unchanged','2026-10-20','2026-10-01')`,[grant,DEMO_COMMUNITY,DEMO_USERS[0].user_id]);
  await pool.query(`INSERT INTO github_history_cache(cache_key,snapshot) VALUES('freetwai-ai/freedom-platform:issue:1','{"historical":"FreeTWAI-AI"}')`);
  const project=randomUUID(),version=randomUUID();
  await pool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship)
    VALUES($1,$2,$3,'Transferred project','Fixture','Fixture','1378081342','FreeTWAI-AI/freedom-platform','https://github.com/FreeTWAI-AI/freedom-platform','curator')`,[project,DEMO_COMMUNITY,DEMO_USERS[0].user_id]);
  await pool.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,repository_full_name,repository_url,readme_url,license_spdx,is_fork,archived,source_snapshot,source_sha256,facts_sha256,inspected_at)
    VALUES($1,$2,'1378081342',$3,'main','FreeTWAI-AI/freedom-platform','https://github.com/FreeTWAI-AI/freedom-platform','https://github.com/FreeTWAI-AI/freedom-platform/blob/main/README.md','NOASSERTION',false,false,'{"historical":"FreeTWAI-AI"}',$4,$5,'2026-10-12')`,[version,project,'a'.repeat(40),'b'.repeat(64),'c'.repeat(64)]);
  const projectBefore=(await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[project])).rows[0];
  const versionBefore=(await pool.query('SELECT * FROM oss_project_versions WHERE version_id=$1',[version])).rows[0];
  const before=(await pool.query('SELECT * FROM development_grants WHERE grant_id=$1',[grant])).rows[0];
  await transfer();
  const after=(await pool.query('SELECT * FROM development_grants WHERE grant_id=$1',[grant])).rows[0];
  assert.deepEqual(after,{...before,target_repository:'FreeTWAI/freedom-platform'});
  assert.deepEqual((await pool.query('SELECT * FROM oss_projects WHERE project_id=$1',[project])).rows[0],
    {...projectBefore,repository_full_name:'FreeTWAI/freedom-platform',repository_url:'https://github.com/FreeTWAI/freedom-platform'});
  assert.deepEqual((await pool.query('SELECT * FROM oss_project_versions WHERE version_id=$1',[version])).rows[0],versionBefore);
  const repos=(await pool.query('SELECT provider_repo_id,full_name FROM canonical_repositories ORDER BY provider_repo_id')).rows;
  assert.deepEqual(repos,[{provider_repo_id:'1378081342',full_name:'FreeTWAI/freedom-platform'},{provider_repo_id:'9999',full_name:'FreeTWAI-AI/freedom-platform'}]);
  const observation=(await pool.query('SELECT * FROM catalog_repo_observations WHERE book_id=\'synthetic\'')).rows[0];
  assert.equal(observation.requested_full_name,'FreeTWAI/freedom-platform');assert.equal(observation.needs_recheck,true);
  assert.deepEqual((await pool.query('SELECT cache_key,snapshot FROM github_history_cache')).rows,[{cache_key:'freetwai-ai/freedom-platform:issue:1',snapshot:{historical:'FreeTWAI-AI'}}]);
  const first=await snapshot();await transfer();assert.deepEqual(await snapshot(),first);
});

test('renamed Pages key moves while unrelated owners and untransferred names remain untouched',async()=>{
  for(const key of ['freetwai-ai/freetwai-ai.github.io','freetwai-ai/untransferred','freetwai-ai-legacy/freedom-platform','fork/freedom-platform']){
    await repository(key);await item(key,1,key,'2026-10-01');
  }
  await transfer();
  assert.deepEqual((await pool.query('SELECT repository_key FROM github_items ORDER BY repository_key')).rows.map(r=>r.repository_key),
    ['fork/freedom-platform','freetwai-ai-legacy/freedom-platform','freetwai-ai/untransferred','freetwai/freetwai.github.io']);
});
