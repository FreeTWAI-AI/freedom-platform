import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {readCommerceSettings,readNodeCommerceSettings} from '../../modules/agent-commerce/operations/runtime-settings.js';
import {ReadinessError} from '../../apps/platform-api/src/readiness.js';
import {readWorkerConfig,workerRuntime,type WorkerEnv} from '../../apps/platform-api/src/worker.js';
import {nodeRuntime,createApp} from '../../apps/platform-api/src/app.js';
const env=():WorkerEnv=>({FREEDOM_ENV:'local',APP_ORIGIN:'http://127.0.0.1:4310',HYPERDRIVE:{connectionString:'postgres://unused'},ASSETS:{fetch:async()=>new Response()}} as WorkerEnv);
test('commerce settings default off and accept exact boolean strings',()=>{
  assert.deepEqual(readCommerceSettings({}),{consoleEnabled:false,checkoutEnabled:false,quarantine:false,providerProfiles:[],emailEnabled:false});
  for(const checkout of ['true','false'])for(const quarantine of ['true','false'])for(const email of ['true','false'])assert.deepEqual(readCommerceSettings({FREEDOM_COMMERCE_CHECKOUT_ENABLED:checkout,FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_COMMERCE_QUARANTINE:quarantine,FREEDOM_COMMERCE_EMAIL_ENABLED:email,FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true'}),{consoleEnabled:true,checkoutEnabled:checkout==='true',quarantine:quarantine==='true',providerProfiles:[],emailEnabled:email==='true'});
});
for(const flag of ['FREEDOM_COMMERCE_CHECKOUT_ENABLED','FREEDOM_COMMERCE_CONSOLE_ENABLED','FREEDOM_COMMERCE_QUARANTINE','FREEDOM_COMMERCE_EMAIL_ENABLED'])for(const value of ['TRUE','False','',' true','false ','synthetic-secret'])test(`invalid ${flag} ${JSON.stringify(value)} fails without echoing the value`,()=>{
  assert.throws(()=>readCommerceSettings({[flag]:value}),(error:unknown)=>error instanceof ReadinessError&&error.message==='Commerce flags must be true or false.');
});
test('console depends on the explicit launchpad flag',()=>{for(const dependency of [undefined,'false','TRUE'])assert.throws(()=>readCommerceSettings({FREEDOM_COMMERCE_CHECKOUT_ENABLED:'true',FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_GUILD_LAUNCHPAD_ENABLED:dependency}),ReadinessError);});
test('commerce email requires the Worker EMAIL and COMMERCE_JOURNAL bindings and is refused on Node',()=>{
  assert.equal(readNodeCommerceSettings({}).emailEnabled,false);
  assert.equal(readNodeCommerceSettings({FREEDOM_COMMERCE_EMAIL_ENABLED:'false'}).emailEnabled,false);
  assert.throws(()=>readNodeCommerceSettings({FREEDOM_COMMERCE_EMAIL_ENABLED:'true'}),{name:'ReadinessError',message:'commerce_email_requires_worker'});
  const EMAIL={send:async()=>{throw new Error('unexpected I/O');}};
  const COMMERCE_JOURNAL={put(){throw new Error('unexpected I/O');},get(){throw new Error('unexpected I/O');}};
  for(const badEmail of [undefined,{},{send:'not-a-fn'}])assert.throws(()=>readWorkerConfig({...env(),FREEDOM_COMMERCE_EMAIL_ENABLED:'true',EMAIL:badEmail as any,COMMERCE_JOURNAL}),{name:'ReadinessError',message:'commerce_email_binding_required'});
  for(const badJournal of [undefined,{},{put(){}},{get(){}}])assert.throws(()=>readWorkerConfig({...env(),FREEDOM_COMMERCE_EMAIL_ENABLED:'true',EMAIL,COMMERCE_JOURNAL:badJournal as any}),{name:'ReadinessError',message:'commerce_journal_binding_required'});
  assert.equal(readWorkerConfig({...env(),FREEDOM_COMMERCE_EMAIL_ENABLED:'true',EMAIL,COMMERCE_JOURNAL}).commerceSettings?.emailEnabled,true);
});
test('Node and Worker use the same parsed settings and site reports effective checkout admission',async()=>{
  for(const checkoutEnabled of [false,true])for(const quarantine of [false,true]) {
    const bindings={...env(),FREEDOM_COMMERCE_CHECKOUT_ENABLED:String(checkoutEnabled),FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_COMMERCE_QUARANTINE:String(quarantine),FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true'};
    const settings=readCommerceSettings(bindings),config=readWorkerConfig(bindings);
    assert.deepEqual(workerRuntime(bindings,config).commerceSettings,settings);assert.deepEqual(nodeRuntime('local',config.origin,{commerceSettings:settings}).commerceSettings,settings);
    const pool={query(){throw new Error('site must not query SQL');}} as unknown as Pool;
    const response=await createApp(pool,config.origin,'local',{commerceSettings:settings}).request(config.origin+'/api/v1/site');
    const site=await response.json();assert.equal(site.commerce_checkout_enabled,checkoutEnabled&&!quarantine);assert.equal('commerce_console_enabled' in site,false);
  }
  assert.throws(()=>readWorkerConfig({...env(),FREEDOM_COMMERCE_QUARANTINE:'invalid'}),ReadinessError);
});

test('checkout requires console even with launchpad enabled',()=>{
  for(const consoleEnabled of [undefined,'false'])assert.throws(()=>readCommerceSettings({FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true',FREEDOM_COMMERCE_CHECKOUT_ENABLED:'true',FREEDOM_COMMERCE_CONSOLE_ENABLED:consoleEnabled}),{name:'ReadinessError',message:'commerce_console_required'});
  assert.throws(()=>readCommerceSettings({FREEDOM_COMMERCE_CONSOLE_ENABLED:'true'}),{name:'ReadinessError',message:'commerce_launchpad_required'});
});
