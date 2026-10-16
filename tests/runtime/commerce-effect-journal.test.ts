import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {readCommerceSettings,readNodeCommerceSettings} from '../../modules/agent-commerce/operations/runtime-settings.js';
import {readWorkerConfig,type WorkerEnv} from '../../apps/platform-api/src/worker.js';
import {ReadinessError} from '../../apps/platform-api/src/readiness.js';
const profile='ecpay.aio.credit.v1';
const workerBindings=():WorkerEnv=>({FREEDOM_ENV:'local',APP_ORIGIN:'http://127.0.0.1:4310',HYPERDRIVE:{connectionString:'postgres://unused'},ASSETS:{fetch:async()=>new Response()}});
const randomRing=()=>`test:${randomBytes(32).toString('base64')}`;
for(const value of [undefined,''])test(`empty provider profiles (${String(value)}) leave payment ports uninstalled`,()=>{
  assert.deepEqual(readCommerceSettings({FREEDOM_COMMERCE_PROVIDER_PROFILES:value}).providerProfiles,[]);
  assert.deepEqual(readNodeCommerceSettings({FREEDOM_COMMERCE_PROVIDER_PROFILES:value}).providerProfiles,[]);
  assert.deepEqual(readWorkerConfig({...workerBindings(),FREEDOM_COMMERCE_PROVIDER_PROFILES:value}).commerceSettings?.providerProfiles,[]);
});
for(const raw of [' ',`,${profile}`,`${profile},`,`${profile},${profile}`,`${profile},,${profile}`,` ${profile}`,`${profile}\n`,`${profile},other`,'other',profile.toUpperCase()])test(`provider profiles reject malformed or unimplemented list ${JSON.stringify(raw)}`,()=>{
  for(const read of [()=>readCommerceSettings({FREEDOM_COMMERCE_PROVIDER_PROFILES:raw}),()=>readNodeCommerceSettings({FREEDOM_COMMERCE_PROVIDER_PROFILES:raw}),()=>readWorkerConfig({...workerBindings(),FREEDOM_COMMERCE_PROVIDER_PROFILES:raw})])
    assert.throws(read,(e:unknown)=>e instanceof ReadinessError&&e.message==='commerce_provider_profiles_invalid');
});
test('Worker provider profiles require a usable keyring and journal methods; neither is used during readiness',()=>{
  for(const keyring of [undefined,'','synthetic-invalid'])assert.throws(()=>readWorkerConfig({...workerBindings(),FREEDOM_COMMERCE_PROVIDER_PROFILES:profile,COMMERCE_CREDENTIAL_KEYS:keyring}),{name:'ReadinessError',message:'commerce_profiles_require_keyring'});
  const env={...workerBindings(),FREEDOM_COMMERCE_PROVIDER_PROFILES:profile,COMMERCE_CREDENTIAL_KEYS:randomRing()};
  assert.throws(()=>readWorkerConfig(env),{name:'ReadinessError',message:'commerce_profiles_require_journal'});
  for(const binding of [{},{get(){}},{put(){}}])assert.throws(()=>readWorkerConfig({...env,COMMERCE_JOURNAL:binding} as WorkerEnv),{name:'ReadinessError',message:'commerce_profiles_require_journal'});
  const COMMERCE_JOURNAL={put(){throw Error('unexpected I/O');},get(){throw Error('unexpected I/O');}};
  assert.deepEqual(readWorkerConfig({...env,COMMERCE_JOURNAL}).commerceSettings?.providerProfiles,[profile]);
});
test('Node startup settings refuse every non-empty implemented provider list without a journal',()=>{
  assert.throws(()=>readNodeCommerceSettings({FREEDOM_COMMERCE_PROVIDER_PROFILES:profile}),{name:'ReadinessError',message:'commerce_profiles_require_journal'});
  const parsed=readCommerceSettings({FREEDOM_COMMERCE_PROVIDER_PROFILES:profile});assert.deepEqual(parsed.providerProfiles,[profile]);assert(Object.isFrozen(parsed.providerProfiles));
});
