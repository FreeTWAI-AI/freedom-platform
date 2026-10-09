import {TENANT_CURSOR_TEST_KEY} from '../runtime/tenant-cursor-fixture.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createRegistryHarness,type Session,type Reply} from '../runtime/module-registry-harness.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {createStorefrontProductPhotoLifecycle} from '../../modules/assets/storefront-product-photo.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';

export const photoSourcePng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
export class ObservedPhotoStore extends FakeObjectStore {
  puts=0;gets=0;afterGet:(()=>Promise<void>)|undefined;
  override async putImmutable(...args:Parameters<FakeObjectStore['putImmutable']>){this.puts++;return super.putImmutable(...args);}
  override async get(...args:Parameters<FakeObjectStore['get']>){this.gets++;const result=await super.get(...args);await this.afterGet?.();return result;}
}
/** Disposable restricted-role fixture. Calling this requires the separately scheduled PG slot. */
export async function createHostedStorePhotoHarness(){
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url&&/^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname),'Explicit disposable TEST_DATABASE_URL is required');
  const h=await createRegistryHarness('fp_storephoto'),role=`photo_runtime_${process.pid}_${Date.now()}`;
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role};
    REVOKE INSERT,UPDATE,DELETE ON ${h.schema}.module_definitions,${h.schema}.application_definitions,${h.schema}.guild_application_offerings,${h.schema}.tenant_capacity_policies,${h.schema}.tenant_authority_policies,${h.schema}.domain_media_storage_policy FROM ${role};
    GRANT UPDATE(policy_lock) ON ${h.schema}.tenant_capacity_policies,${h.schema}.tenant_authority_policies,${h.schema}.domain_media_storage_policy TO ${role}`);
  const runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password='';
  const runtime=new Pool({connectionString:runtimeUrl.toString(),options:`-c search_path=${h.schema} -c statement_timeout=20000`,max:12});
  const store=new ObservedPhotoStore(),assets=createStorefrontProductPhotoLifecycle(runtime,{store});
  const application=(uploads=true)=>createApp(runtime,h.origin,'local',{guildLaunchpadEnabled:true,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY,storePhotoAssetStore:store,storePhotoAssets:assets,storePhotoUploadsEnabled:uploads});
  const app=application();
  const ok=(reply:Reply,status=200)=>{assert.equal(reply.status,status,JSON.stringify(reply.data));return reply.data;};
  const call=(method:string,path:string,session?:Session,body?:unknown,headers:Record<string,string>={})=>h.call(method,path,session,body,headers,app);
  const post=(path:string,session:Session,body:unknown,version?:string,key=randomUUID())=>call('POST',path,session,body,{'Idempotency-Key':key,...(version?{'If-Match':`"${version}"`}:{})});
  async function reset(){
    await h.reset();store.puts=0;store.gets=0;store.afterGet=undefined;
    await h.pool.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='storefront.product-photo'");
    await h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
      VALUES($1,$2,'guild_commerce_sales','hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),DEMO_COMMUNITY]);
  }
  async function openStore(owner?:Session){
    owner??=(await h.person('合成商品照片會員')).session;await h.fullMember(owner.user.user_id,'guild_commerce_sales');
    const made=ok(await post('/tenants',owner,{display_name:'合成照片商店',workspace_name:'照片櫃檯'}),201);
    const tenantId=made.tenant.tenant_id as string,workspaceId=made.workspace.workspace_id as string;
    const planned=await post(`/tenants/${tenantId}/application-launch-plans`,owner,h.planBody('guild_commerce_sales',workspaceId,'hosted-store','hosted-store@1.0.0'));ok(planned,201);
    const launched=await post(`/tenants/${tenantId}/application-installations`,owner,{plan_id:planned.data.plan_id,expected_plan_version:planned.data.version,configuration_digest:planned.data.configuration_digest});
    assert.ok([200,202].includes(launched.status),JSON.stringify(launched.data));assert.equal(launched.data.state,'succeeded');
    const instanceId=(await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'",[tenantId])).rows[0].instance_id as string;
    const root=`/tenants/${tenantId}/storefronts/${instanceId}`,slug='photo-'+randomUUID().slice(0,8);
    ok(await post(root+'/setup',owner,{name:'合成照片商店',slug,currency:'TWD'}),201);
    const product=ok(await post(root+'/products',owner,{title:'合成商品',description:'合成測試照片',price_minor:1234,stock:10}),201);
    const actor=await authenticate(runtime,owner.cookie.split('=')[1]);
    return {owner,actor,tenantId,workspaceId,instanceId,root,slug,productId:product.product_id as string,version:product.version as string};
  }
  async function stop(){await runtime.end();await h.stop();const admin=new Pool({connectionString:url});try{await admin.query(`DROP ROLE ${role}`);}finally{await admin.end();}}
  return {h,runtime,role,app,application,store,assets,call,post,ok,reset,openStore,stop};
}
export type HostedStorePhotoHarness=Awaited<ReturnType<typeof createHostedStorePhotoHarness>>;
