import {Hono} from 'hono';
import type {Pool} from 'pg';
import {z} from 'zod';
import {OpaqueId} from '../../../../contracts/guild-launchpad/v1/primitives.js';
import * as wire from '../../../../contracts/guild-launchpad/v1/hosted-offline-payment.js';
import {OfflineSettingsProblem,readOfflinePaymentSettings,saveOfflinePaymentSettings} from '../../../../modules/agent-commerce/payments/offline/settings.js';
import type {PlatformEnv} from '../module-context.js';
import {commandHeaders,etag,privateCache,singleQuery} from './tenant-http.js';
const emptyQuery=z.object({}).strict();
export function createHostedOfflinePaymentRoutes(pool:Pool,{profiles}:{profiles:readonly string[]}){
  const app=new Hono<PlatformEnv>();
  const root='/tenants/:tenant_id/storefronts/:instance_id';
  app.use(root+'/offline-payment-settings',async(c,next)=>{try{emptyQuery.parse(singleQuery(c));await next();}finally{privateCache(c);}});
  app.onError((error,c)=>{
    if(!(error instanceof OfflineSettingsProblem))throw error;
    privateCache(c);return c.json(wire.OfflineSettingsErrorSchema.parse({type:'about:blank',title:error.code,status:error.status,code:error.code,detail:error.message,fields:error.fields}),error.status as 422);
  });
  const ids=(c:Parameters<typeof singleQuery>[0])=>[OpaqueId.parse(c.req.param('tenant_id')),OpaqueId.parse(c.req.param('instance_id'))] as const;
  app.get(root+'/offline-payment-settings',async c=>{const [t,i]=ids(c),view=wire.OfflinePaymentSettingsViewSchema.parse(await readOfflinePaymentSettings(pool,c.get('actor'),t,i,profiles));if(view.version)etag(c,view.version);return c.json(view);});
  app.put(root+'/offline-payment-settings',async c=>{const h=commandHeaders(c,c.req.header('If-Match')!==undefined),[t,i]=ids(c),view=wire.OfflinePaymentSettingsViewSchema.parse(await saveOfflinePaymentSettings(pool,c.get('actor'),t,i,await c.req.json(),h.key,h.expected,profiles));if(view.version)etag(c,view.version);return c.json(view,view.version==='1'?201:200);});
  return app;
}
