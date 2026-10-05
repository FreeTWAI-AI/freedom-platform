import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium,errors} from '@playwright/test';
import {observeIngestBrowserPage} from '../runtime/credential-ingest-helpers.js';
// @ts-expect-error Canonical tooling is JavaScript without a declaration file.
import {createIngestBrowserDiagnostic} from '../../packages/contribution-tools/test-failure-diagnostic.mjs';

test('controlled Chromium secret abort records request failure and preserves actual ACK TimeoutError without secret data',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const context=await browser.newContext(),page=await context.newPage(),origin='https://synthetic-broker.invalid';
  const diagnostic=createIngestBrowserDiagnostic(),detach=observeIngestBrowserPage(page,origin,diagnostic);
  await context.route('**/*',async route=>{
   if(route.request().url()===origin+'/credential-setup/prepare')await route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*'},body:'{}'});
   else await route.abort('timedout');
  });
  await page.setContent('<div id="credential-status"></div>');
  await page.evaluate(async origin=>{await fetch(origin+'/credential-setup/prepare',{method:'POST'});try{await fetch(origin+'/credential-setup/secret',{method:'POST',body:'PRIVATE_SYNTHETIC_KEY'});}catch{}},origin);
  diagnostic.phase('ack_wait');let caught:unknown;
  try{await page.locator('#credential-status').filter({hasText:'已收到設定服務回覆'}).waitFor({timeout:100});}catch(error){caught=error;assert.equal(diagnostic.annotate(error),error);}
  assert(caught instanceof errors.TimeoutError);const value=(caught as Error&{freedom_ingest:unknown}).freedom_ingest;
  assert.deepEqual(value,{phase:'ack_wait',prepare_state:'response',prepare_status:200,secret_state:'failed',secret_status:null,custody:'not_checked'});
  assert(!JSON.stringify(value).includes('PRIVATE'));assert(!JSON.stringify(value).includes(origin));detach();await context.close();
 }finally{await browser.close();}
});
