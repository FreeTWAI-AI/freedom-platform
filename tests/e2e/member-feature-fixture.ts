import {serve} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import {test as base} from './fixtures.js';
import {ownedSchema} from './hosted-order-fixture.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {TENANT_CURSOR_TEST_KEY} from '../runtime/tenant-cursor-fixture.js';

export * from './fixtures.js';
type Features=Pick<NonNullable<Parameters<typeof createApp>[3]>,
  'personalContentEnabled'|'firstParticipationEnabled'|'notificationPreferencesEnabled'|'eventParticipationEnabled'>;

/** Real per-test Node host on the existing owned schema. Both ON/OFF cases run in
 * the ordinary browser pass; feature coverage does not depend on a new CI pin. */
export const test=base.extend<{memberFeatures:Features}>({
  memberFeatures:[{},{option:true}],
  baseURL:async({e2eAuthPool,memberFeatures},use)=>{
    await ownedSchema(e2eAuthPool);
    let app:ReturnType<typeof createApp>|undefined;
    const server=serve({hostname:'127.0.0.1',port:0,fetch:request=>app?app.fetch(request):new Response(null,{status:503})});
    try{
      if(!server.listening)await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      const address=server.address();if(!address||typeof address==='string')throw Error('Owned feature listener unavailable.');
      const origin=`http://127.0.0.1:${address.port}`;
      app=createApp(e2eAuthPool,origin,'local',{...memberFeatures,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
      app.use('/*',serveStatic({root:'./apps/portal-web/dist'}));
      app.get('*',serveStatic({path:'./apps/portal-web/dist/index.html'}));
      await use(origin);
    }finally{
      if('closeAllConnections' in server)server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  },
});
