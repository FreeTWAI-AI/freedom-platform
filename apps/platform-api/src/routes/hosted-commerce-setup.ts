import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {createProviderAccount,listProviderAccounts,putProviderService,changeProviderServiceState,type ProviderAccountOptions} from '../../../../modules/agent-commerce/payments/accounts.js';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/common/v1/identity.js';
import {CommerceSetupEmptyInputSchema,StoreReleaseSchema} from '../../../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {readStoreRelease,upgradeStoreRelease} from '../../../../modules/agent-commerce/hosted/release-upgrade.js';
import type {PlatformEnv} from '../module-context.js';
import {commandHeaders,etag,privateCache,singleQuery} from './tenant-http.js';
export function createHostedCommerceSetupRoutes(pool:Pool,options:ProviderAccountOptions){
  const app=new Hono<PlatformEnv>();
  app.use('*',async(c,next)=>{try{await next();}finally{privateCache(c);}});
  const root='/tenants/:tenant_id/storefronts/:instance_id';
  app.get(root+'/release',async c=>{
    CommerceSetupEmptyInputSchema.parse(singleQuery(c));
    const view=StoreReleaseSchema.parse(await readStoreRelease(pool,c.get('actor'),OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))));
    etag(c,view.version);return c.json(view);
  });
  app.post(root+'/upgrade',async c=>{
    const h=commandHeaders(c,true);
    const view=StoreReleaseSchema.parse(await upgradeStoreRelease(pool,c.get('actor'),OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id')),await c.req.json(),h.key,h.expected!));
    etag(c,view.version);return c.json(view);
  });
  const accounts=root+'/provider-accounts';
  const ids=(c:Parameters<typeof singleQuery>[0])=>[OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))] as const;
  app.get(accounts,async c=>{CommerceSetupEmptyInputSchema.parse(singleQuery(c));const [t,i]=ids(c);return c.json(wire.ProviderAccountPageSchema.parse(await listProviderAccounts(pool,c.get('actor'),t,i)));});
  app.post(accounts,async c=>{const h=commandHeaders(c,false),[t,i]=ids(c);const view=wire.ProviderAccountViewSchema.parse(await createProviderAccount(pool,c.get('actor'),t,i,await c.req.json(),h.key,options));etag(c,view.version);return c.json(view,201);});
  app.put(accounts+'/:account_id/services/:purpose',async c=>{const h=commandHeaders(c,true),[t,i]=ids(c);const view=wire.ProviderAccountViewSchema.parse(await putProviderService(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('account_id')),wire.ProviderPurposeSchema.parse(c.req.param('purpose')),await c.req.json(),h.key,h.expected!,options));etag(c,view.version);return c.json(view);});
  for(const action of ['suspend','resume','retire'] as const)app.post(accounts+'/:account_id/services/:purpose/'+action,async c=>{const h=commandHeaders(c,true),[t,i]=ids(c);const view=wire.ProviderAccountViewSchema.parse(await changeProviderServiceState(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('account_id')),wire.ProviderPurposeSchema.parse(c.req.param('purpose')),action,await c.req.json(),h.key,h.expected!,options));etag(c,view.version);return c.json(view);});
  return app;
}
