import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import sharp from 'sharp';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
// @ts-expect-error Host-only JavaScript module; intentionally not a candidate application dependency.
import { runMemberRouteBehavior, installedBehaviorHarnessDigest, behaviorFixtureIdentity } from '../../packages/contribution-tools/behavior-harness.mjs';
// @ts-expect-error Host installation constants, no candidate descriptor selectors.
import { MEMBER_BEHAVIOR as manifest } from '../../packages/contribution-tools/behavior-manifest.mjs';
// @ts-expect-error Shared clean subprocess environment.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

const connectionString=process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Behavior smoke requires explicit disposable fp_* TEST_DATABASE_URL.');
const schema=`fp_fixed_behavior_${process.pid}_${Date.now()}`, admin=createPool(connectionString);
const pool=new Pool({connectionString,options:`-c search_path=${schema} -c statement_timeout=10000`,max:8});
let created=false;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await migrate(pool);});
after(async()=>{await pool.end();try {if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);} finally {await admin.end();}});

async function member(community:string,revoked=false) {
  const id=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomBytes(16).toString('base64url');
  const row=(await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic behavior fixture','not-a-login',$4) RETURNING *`,[id,community,id+'@example.invalid',randomUUID()])).rows[0];
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,revoked_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',CASE WHEN $4 THEN clock_timestamp() ELSE NULL END)`,[tokenHash(token),id,csrf,revoked]);
  return {actor:{...row,session_hash:tokenHash(token),csrf_token:csrf} as Actor,fixture:{id,cookie:'freedom_local_session='+token,csrf}};
}
test('fixed host profile exercises actual six createApp routes without mutating avatar/private facts',async()=>{
  const community=randomUUID(),other=randomUUID();
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic owner'),($2,'Synthetic outsider')",[community,other]);
  const owner=await member(community),outsider=await member(other),revoked=await member(community,true),workId=randomUUID();
  await withMemberScope(pool,{actor:owner.actor,scope:'personal'},async()=>{},async(q,context)=>{
    await q.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
      VALUES($1,'personal_execution',$2,$3,$4,$5,$6,'draft',NULL)`,[workId,context.scope.scope_id,context.subject_principal.principal_id,owner.actor.user_id,manifest.title,manifest.objective]);
  });
  const image=await sharp({create:{width:8,height:8,channels:3,background:'#337799'}}).webp().toBuffer();
  await pool.query('INSERT INTO member_avatars(user_id,community_id,image_bytes) VALUES($1,$2,$3)',[owner.actor.user_id,community,image]);
  const fixture={instance_id:randomUUID(),owner:owner.fixture,outsider:outsider.fixture,revoked:{cookie:revoked.fixture.cookie,csrf:revoked.fixture.csrf},work_id:workId};
  const git=(ref:string)=>execFileSync('git',['rev-parse',ref],{cwd:process.cwd(),env:verificationEnvironment(),stdio:['ignore','pipe','pipe']}).toString().trim();
  const commit=git('HEAD'),tree=git('HEAD^{tree}');
  // Exact local Git target identity; source/policy/workflow are explicitly
  // synthetic assertions, NOT approval/authenticated workflow publication.
  const binding={repository:'fixture/platform',pull_request:1,run_id:'local-app-smoke',base_commit:commit,head_commit:commit,candidate_commit:commit,candidate_tree:tree,
    source_commit:'1'.repeat(40),release_set_sha256:'2'.repeat(64),policy_revision:'synthetic-1',policy_sha256:'3'.repeat(64),verifier_commit:commit,verifier_sha256:'4'.repeat(64)};
  const workflow={identity:'fixture/local-app-smoke',commit,publisher:'synthetic-unverified'};
  const expectedHarnessSha256=await installedBehaviorHarnessDigest(),app=createApp(pool,manifest.origin);
  const facts=async()=> (await pool.query(`SELECT
    (SELECT count(*)::int FROM command_receipts) legacy_receipts,
    (SELECT count(*)::int FROM scoped_command_receipts) scoped_receipts,
    (SELECT count(*)::int FROM transition_journal) legacy_journal,
    (SELECT count(*)::int FROM scoped_transition_journal) scoped_journal,
    (SELECT aggregate_version::text FROM member_avatars WHERE user_id=$1) avatar_version,
    (SELECT aggregate_version::text FROM work_items WHERE work_item_id=$2) work_version`,[owner.actor.user_id,workId])).rows[0];
  const before=await facts(); let requests=0;
  const result=await runMemberRouteBehavior({binding,workflow,fixture,expectedHarnessSha256},{
    observeTarget:async()=>({binding,workflow,harness_sha256:expectedHarnessSha256,fixture:behaviorFixtureIdentity(fixture)}),
    request:async(request:Request)=>{requests++;return app.request(request);},
  });
  assert.equal(result.check.status,'passed',JSON.stringify(result));assert.equal(requests,27);
  assert.equal(result.observation.tests,27);assert.equal(result.status,'unavailable');assert.equal(result.merge_authorized,false);assert.equal(result.execution_authorized,false);
  assert.deepEqual(await facts(),before);
  assert.deepEqual((await pool.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1',[owner.actor.user_id])).rows[0].image_bytes,image);
  for(const secret of [fixture.owner.cookie,fixture.owner.csrf,fixture.outsider.cookie,fixture.revoked.cookie,manifest.title,manifest.objective]) assert(!JSON.stringify(result).includes(secret));
});
