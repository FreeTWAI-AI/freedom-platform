import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPool,LOCAL_DATABASE_URL } from '../packages/db/index.js';
import { createApp } from '../apps/platform-api/src/app.js';
import { migrate } from './database.js';
import { seedLocal } from '../packages/testing/seed.js';
import { collaborationGitHubFixture } from '../packages/testing/github-collaboration.js';
import { syncGitHubRepositories } from '../modules/community/github-sync.js';
import { e2eSchema } from '../packages/testing/e2e-auth-isolation.js';
import { e2eOrigin, e2ePort } from '../packages/testing/e2e-origin.js';
import { e2eAuthorClaimAdminVerifier } from '../packages/testing/e2e-admin.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { FakeObjectStore } from '../packages/asset-storage/fake-store.js';

if(process.env.NODE_ENV==='production'||(process.env.FREEDOM_ENV&&process.env.FREEDOM_ENV!=='local'))throw Error('Browser test server is local-only.');
if(process.env.FREEDOM_E2E_GITHUB_FIXTURES==='1')globalThis.fetch=async input=>collaborationGitHubFixture(input);
// Link previews never use the network. A few fixture URLs return deterministic HTML and a 1×1 PNG.
const previewPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const linkPreviewFetch=(input:string)=>{
  const url=String(input);
  if(url.startsWith('https://www.youtube.com/oembed'))return Promise.resolve(new Response(JSON.stringify({title:'E2E 示範影片'}),{status:200,headers:{'content-type':'application/json'}}));
  if(url==='https://i.ytimg.com/vi/e2eDemo0001/hqdefault.jpg'||url==='https://www.instagram.com/e2e-thumb.png')return Promise.resolve(new Response(previewPng,{status:200,headers:{'content-type':'image/png'}}));
  if(url.startsWith('https://www.instagram.com/p/E2E0001'))return Promise.resolve(new Response('<!doctype html><title>ignored</title><meta property="og:title" content="E2E 限時動態"><meta property="og:image" content="https://www.instagram.com/e2e-thumb.png">',{status:200,headers:{'content-type':'text/html; charset=utf-8'}}));
  return Promise.resolve(new Response('missing',{status:404,headers:{'content-type':'text/plain'}}));
};

// Dedicated schema; browser tests never reset the user's local demo records.
const schema=e2eSchema(process.env.FREEDOM_E2E_SCHEMA);
const port=e2ePort(),origin=e2eOrigin();
const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const admin=createPool(url);admin.on('error',()=>{});await admin.query(`CREATE SCHEMA ${schema}`);
// application_name is this run only, so a stuck backend can be cancelled without touching anyone else's.
const pool=new Pool({connectionString:url,options:`-c search_path=${schema} -c application_name=${schema}`});
pool.on('error',()=>{});
let server:ReturnType<typeof serve>|undefined,stopping=false;
let productPool:Pool|undefined,productRole:string|undefined;
let productRoleCreated=false;
let privateAiFixture:Awaited<ReturnType<typeof import('../packages/testing/private-ai-product-fixture.js')['createPrivateAiBrowserFixture']>>|undefined;
let avatarAssetFixture:Awaited<ReturnType<typeof import('../packages/testing/e2e-avatar-asset-fixture.js')['createAvatarAssetBrowserFixture']>>|undefined;
// Installed before migrate. Playwright's graceful SIGTERM must drop the schema even if startup is still running.
// npx/tsx dies on the group SIGTERM and SIGKILLs this process at its first await, so the
// async DROP never runs. Release the schema and the avatar bucket before yielding.
let released=false;
function releaseOwnedResources(){
  if(released)return;released=true;
  if(process.env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE==='1'){
    try{rmSync(join(tmpdir(),`fp-e2e-avatar-r2-${schema}`),{recursive:true,force:true});}catch{/* close() retries */ }
  }
  if(url.includes(':54339/')||url.endsWith(':54339'))return;
  const child=spawn(process.execPath,['--input-type=module','-e',`import pg from 'pg';
const schema=process.env.FREEDOM_E2E_SCHEMA??'';
const connectionString=process.env.TEST_DATABASE_URL;
if(!/^fp_e2e_[a-f0-9]{32}$/.test(schema)||!connectionString)process.exit(1);
const client=new pg.Client({connectionString});
await client.connect();
await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()',[schema]);
await client.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
await client.query("DO $body$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='"+schema+"_app') THEN EXECUTE 'DROP ROLE "+schema+"_app'; END IF; END $body$");
await client.end();`],{detached:true,stdio:'ignore',env:{...process.env,FREEDOM_E2E_SCHEMA:schema,TEST_DATABASE_URL:url}});
  child.unref();
}
async function stop(code=0){
  if(stopping)return;stopping=true;
  releaseOwnedResources();
  let exitCode=code;
  if(server)await Promise.race([new Promise<void>(resolve=>server!.close(()=>resolve())),new Promise<void>(resolve=>setTimeout(resolve,2000))]);
  if(avatarAssetFixture){try{await avatarAssetFixture.close();}catch{console.error('avatar_asset_fixture_cleanup_failed');if(exitCode===0)exitCode=1;}}
  if(privateAiFixture) {
    await privateAiFixture.close();
  }
  if(productPool)await Promise.race([productPool.end().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,2000))]);
  // End idle clients first. Terminating them while the pool still owns them emits an error that kills the process before DROP.
  await Promise.race([pool.end().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,2000))]);
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()',[schema]).catch(()=>{});
  try{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);if(productRoleCreated&&productRole)await admin.query(`DROP ROLE ${productRole}`);}
  finally{
    await admin.end().catch(()=>{});
    // Optional evidence must never prevent mandatory owned-resource cleanup.
    if(privateAiFixture)try{
      await mkdir('.freedom/reports',{recursive:true,mode:0o700});
      await writeFile('.freedom/reports/member-model-e2e-fixture-observation.json',JSON.stringify(privateAiFixture.evidence(),null,2)+'\n');
    }catch{console.error('private_ai_fixture_evidence_unavailable');}
    process.exit(exitCode);
  }
}
process.on('SIGTERM',()=>{releaseOwnedResources();void stop();});process.on('SIGINT',()=>{releaseOwnedResources();void stop();});
process.on('SIGHUP',()=>{releaseOwnedResources();void stop();});
try{
  if(process.env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE==='1'&&process.env.FREEDOM_E2E_PRIVATE_AI_FIXTURE==='1')throw Error('Avatar asset and private AI browser fixtures are mutually exclusive.');
  await migrate(pool);
  await seedLocal(pool);
  // Synthetic local capacity only. Production does not seed a policy row.
  await pool.query(`INSERT INTO tenant_capacity_policies(
      policy_id, revision, tenant_id, plan_ref,
      max_active_instances, max_instances_per_module, max_concurrent_provisions,
      max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
    SELECT gen_random_uuid(), 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1',
      10, 3, 2, 1000, 104857600, 4, NULL, 'active'
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`);
  // Synthetic authority policy for this local harness only. Production seeds none.
  await pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
    SELECT 1,'active',600,86400,86400,1
    WHERE NOT EXISTS (SELECT 1 FROM tenant_authority_policies WHERE status='active')`);
  // One fixture sync fills github_items before the browser opens. No timer.
  // Events run before repositories. 200 leaves every tracked repository inside one fixture pass.
  if(process.env.FREEDOM_E2E_GITHUB_FIXTURES==='1') await syncGitHubRepositories(pool,{fetcher:input=>Promise.resolve(collaborationGitHubFixture(input)),budget:200,token:undefined});
  if(process.env.FREEDOM_E2E_PRIVATE_AI_FIXTURE==='1') {
    productRole=`${schema}_app`;
    await admin.query(`CREATE ROLE ${productRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      GRANT USAGE ON SCHEMA ${schema} TO ${productRole}`);
    productRoleCreated=true;
    const template=await readFile(new URL('../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
    const prefix=template.slice(template.indexOf('BEGIN;'),template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
      .replaceAll('SCHEMA public',`SCHEMA ${schema}`).replaceAll(':"runtime"',`"${productRole}"`);
    const grants=template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
      .replaceAll(":'runtime'",`'${productRole}'`).replace("n.nspname='public'",`n.nspname='${schema}'`);
    const q=await pool.connect();
    try{await q.query(prefix);const rows=await q.query(grants);if(rows.rowCount!==2)throw Error('Expected both operator policy grants.');
      for(const row of rows.rows)await q.query(Object.values(row)[0] as string);await q.query('COMMIT');}
    catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
    const runtimeUrl=new URL(url);runtimeUrl.username=productRole;runtimeUrl.password='';
    productPool=new Pool({connectionString:runtimeUrl.toString(),options:`-c search_path=${schema} -c application_name=${schema}`});
    productPool.on('error',()=>{});
    const {createPrivateAiBrowserFixture}=await import('../packages/testing/private-ai-product-fixture.js');
    privateAiFixture=await createPrivateAiBrowserFixture(pool,productPool,origin);
  }
  if(process.env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE==='1'){
    const {createAvatarAssetBrowserFixture}=await import('../packages/testing/e2e-avatar-asset-fixture.js');
    avatarAssetFixture=await createAvatarAssetBrowserFixture(pool,origin);
  }
}catch(error){console.error(error);await stop(1);}
// Explicit local-only fixtures; per-pack production activation is separate.
const publicGuideAssets=process.env.FREEDOM_E2E_GUIDE_FIXTURE==='1'
  ?await (await import('../packages/public-guide-assets/node.js')).createLocalGuideCatalog('local'):undefined;
// Explicit installed shop-key policy for this local harness; absence would close shop-key operations.
const app=createApp(productPool??pool,origin,'local',{shopKeyPolicy:'purpose-bound-only',adminVerifier:e2eAuthorClaimAdminVerifier,linkPreviewFetch,publicGuideAssets,guildLaunchpadEnabled:true,memberBlockingEnabled:process.env.FREEDOM_MEMBER_BLOCKING_ENABLED==='true',tenantWorkAssetStore:new FakeObjectStore(),
  communityDiscoveryEnabled:process.env.FREEDOM_COMMUNITY_DISCOVERY_ENABLED==='true',
  // Explicit browser-harness option; product server/Worker release flags remain default OFF.
  communitySearchEnabled:process.env.FREEDOM_E2E_COMMUNITY_SEARCH==='1',
  ...(privateAiFixture?{privateAiProduct:privateAiFixture.transport}:{}),
  ...(avatarAssetFixture?{avatarAssetStore:avatarAssetFixture.store}:{})});
app.use('/*',serveStatic({root:'./apps/portal-web/dist'}));
app.get('*',serveStatic({path:'./apps/portal-web/dist/index.html'}));
server=serve({fetch:app.fetch,hostname:'127.0.0.1',port});
