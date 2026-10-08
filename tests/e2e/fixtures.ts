import { test as base } from '@playwright/test';
import { Pool } from 'pg';
import { LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { e2eSchema, resetE2eAuthState } from '../../packages/testing/e2e-auth-isolation.js';

export * from '@playwright/test';
export const test = base.extend<{ isolateAuth: void }, { e2eAuthPool: Pool }>({
  // Existing journeys explicitly exercise the Traditional Chinese interface.
  // A separately created context may override locale to test browser detection.
  locale: 'zh-TW',
  browser: [async ({browser},use)=>{
    const newContext=browser.newContext.bind(browser);
    const localized=new Proxy(browser,{get(target,key){
      if(key==='newContext')return (options:Parameters<typeof newContext>[0]={})=>newContext({locale:'zh-TW',...options});
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await use(localized);
  },{scope:'worker'}],
  e2eAuthPool: [async ({}, use, workerInfo) => {
    if (workerInfo.config.workers !== 1) throw Error('The shared E2E database requires one worker.');
    const schema = e2eSchema(process.env.FREEDOM_E2E_SCHEMA);
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL,
      options: `-c search_path=${schema}`, max: 1, connectionTimeoutMillis: 5000 });
    try { await use(pool); } finally { await pool.end(); }
  }, { scope: 'worker' }],
  isolateAuth: [async ({ e2eAuthPool }, use) => {
    await resetE2eAuthState(e2eAuthPool, e2eSchema(process.env.FREEDOM_E2E_SCHEMA));
    await use();
  }, { auto: true }],
});
