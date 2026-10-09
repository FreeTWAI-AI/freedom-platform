import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {createApp,nodeRuntime} from '../../apps/platform-api/src/app.js';
import {workerRuntime,readWorkerConfig,type WorkerEnv} from '../../apps/platform-api/src/worker.js';

// No database or production binding: the site release flag is navigation only.
test('sharing flag defaults off in Node and site DTO; only explicit true enables it',async()=>{
  const pool={query:()=>{throw Error('Sharing site flag must not query private data');}} as unknown as Pool;
  for(const flag of [undefined,false,true]){
    assert.equal(nodeRuntime('local','http://127.0.0.1:4310',{unifiedSharingEnabled:flag}).unifiedSharingEnabled,flag===true);
    const app=createApp(pool,'http://127.0.0.1:4310','local',{unifiedSharingEnabled:flag});
    const response=await app.request('/api/v1/site');assert.equal(response.status,200);
    assert.equal((await response.json()).unified_sharing_enabled,flag===true);
  }
});
test('Worker sharing flag accepts only exact true, without activation by absence or truthy strings',()=>{
  for(const flag of [undefined,'false','TRUE','1','true']){
    const env={HYPERDRIVE:{connectionString:'postgres://synthetic@localhost/synthetic'},ASSETS:{fetch:async()=>new Response('fixture')},FREEDOM_ENV:'local',APP_ORIGIN:'http://127.0.0.1:8787',FREEDOM_UNIFIED_SHARING_ENABLED:flag} as WorkerEnv;
    assert.equal(workerRuntime(env,readWorkerConfig(env)).unifiedSharingEnabled,flag==='true');
  }
});
