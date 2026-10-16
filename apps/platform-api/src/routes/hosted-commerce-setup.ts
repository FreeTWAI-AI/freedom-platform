import {createLogisticsService,changeLogisticsServiceState} from '../../../../modules/agent-commerce/payments/logistics-services.js';
import {LogisticsServiceKeySchema} from '../../../../contracts/guild-launchpad/v1/hosted-shipping.js';
import {issueActivationHandoff,type PaymentAttemptOptions} from '../../../../modules/agent-commerce/payments/attempts.js';
import {requireCondition} from '../../../../packages/shared/problem.js';
import {flushControlEventsBestEffort,type EffectJournalPort} from '../../../../modules/agent-commerce/operations/journal/journal.js';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {createProviderAccount,listProviderAccounts,putProviderService,changeProviderServiceState,createPaymentServiceActivation,type ProviderAccountOptions} from '../../../../modules/agent-commerce/payments/accounts.js';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/common/v1/identity.js';
import {CommerceSetupEmptyInputSchema,StoreReleaseSchema} from '../../../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {readStoreRelease,upgradeStoreRelease} from '../../../../modules/agent-commerce/hosted/release-upgrade.js';
import type {PlatformEnv} from '../module-context.js';
import {commandHeaders,etag,privateCache,singleQuery} from './tenant-http.js';
export function createHostedCommerceSetupRoutes(pool:Pool,options:ProviderAccountOptions & {journal?:EffectJournalPort;activation?:PaymentAttemptOptions}){
  const app=new Hono<PlatformEnv>();
  app.use('*',async(c,next)=>{try{await next();if(c.req.method!=='GET'&&c.res.status<400&&!c.req.path.endsWith('/services/payment/activation-payments'))await flushControlEventsBestEffort(pool,options.journal);}finally{privateCache(c);}});
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
  app.post(accounts+'/:account_id/logistics-services',async c=>{wire.CommerceSetupEmptyInputSchema.parse(singleQuery(c));const h=commandHeaders(c,true),[t,i]=ids(c);const view=wire.ProviderAccountViewSchema.parse(await createLogisticsService(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('account_id')),await c.req.json(),h.key,h.expected!));etag(c,view.version);return c.json(view,201);});
  for(const action of ['suspend','resume','retire'] as const)app.post(accounts+'/:account_id/logistics-services/:service_key/'+action,async c=>{wire.CommerceSetupEmptyInputSchema.parse(singleQuery(c));const h=commandHeaders(c,true),[t,i]=ids(c);const view=wire.ProviderAccountViewSchema.parse(await changeLogisticsServiceState(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('account_id')),LogisticsServiceKeySchema.parse(c.req.param('service_key')),action,await c.req.json(),h.key,h.expected!));etag(c,view.version);return c.json(view);});
  app.post(accounts+'/:account_id/services/payment/activation-payments',async c=>{
    const h=commandHeaders(c,true),[t,i]=ids(c);
    requireCondition(options.activation,409,'provider_service_state','供應商服務狀態不允許這個操作。');
    const receipt=await createPaymentServiceActivation(pool,c.get('actor'),t,i,OpaqueId.parse(c.req.param('account_id')),await c.req.json(),h.key,h.expected!,options.activation);
    const handoff=await issueActivationHandoff(pool,receipt.attempt_ref,options.activation);
    return c.json(wire.ProviderActivationPaymentResponseSchema.parse(handoff),201);
  });
  return app;
}
