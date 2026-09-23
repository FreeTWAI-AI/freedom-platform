import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {onboardingDiagnostics,type OnboardingDiagnostic} from '../../apps/platform-api/src/onboarding-diagnostics.js';

test('onboarding diagnostics correlate a response without recording sensitive input or arbitrary headers',async()=>{
  const entries:OnboardingDiagnostic[]=[],app=new Hono();
  app.use('*',onboardingDiagnostics(entry=>entries.push(entry)));
  app.post('/api/v1/me/onboarding/answers',c=>c.json({saved:true}));
  const response=await app.request('/api/v1/me/onboarding/answers?private=private-query',{method:'POST',headers:{'Content-Type':'application/json','CF-Ray':'a3fb856cf879daac-SEA','Cookie':'private-cookie','Authorization':'Bearer private-token','X-Freedom-Request-ID':'untrusted-id'},body:JSON.stringify({occupation:'private-occupation',answers:{note:'private-answer'}})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{saved:true});assert.equal(entries.length,1);
  const entry=entries[0];assert.deepEqual(Object.keys(entry).sort(),['cf_ray','elapsed_ms','event','request_id','stage','status']);
  assert.match(entry.request_id,/^[a-f0-9-]{36}$/);assert.equal(response.headers.get('X-Freedom-Request-ID'),entry.request_id);assert.equal(entry.cf_ray,'a3fb856cf879daac-SEA');assert.equal(entry.stage,'answers');assert.equal(entry.status,200);assert.ok(Number.isInteger(entry.elapsed_ms)&&entry.elapsed_ms>=0);
  assert.doesNotMatch(JSON.stringify(entry),/private-|untrusted-id/);
});

test('diagnostics capture handled failures, drop untrusted Ray values and ignore unrelated requests',async()=>{
  const entries:OnboardingDiagnostic[]=[],app=new Hono();
  app.onError((_,c)=>c.json({error:'safe error'},412));app.use('*',onboardingDiagnostics(entry=>entries.push(entry)));
  app.post('/api/v1/me/onboarding/evaluate',()=>{throw new Error('private database error');});app.get('/api/v1/me/onboarding/answers',c=>c.json({read:true}));app.post('/api/v1/me/account',c=>c.json({saved:true}));
  const response=await app.request('/api/v1/me/onboarding/evaluate',{method:'POST',headers:{'CF-Ray':'private-email@example.invalid'}});assert.equal(response.status,412);assert.equal(entries.length,1);assert.equal(entries[0].status,412);assert.equal(entries[0].cf_ray,null);assert.doesNotMatch(JSON.stringify(entries),/private/);
  await app.request('/api/v1/me/onboarding/answers');await app.request('/api/v1/me/account',{method:'POST'});assert.equal(entries.length,1);
});

test('log failures never change a successful command response',async()=>{
  const app=new Hono();app.use('*',onboardingDiagnostics(()=>{throw new Error('log failure');}));app.post('/api/v1/me/onboarding/complete',c=>c.json({completed:true}));
  const response=await app.request('/api/v1/me/onboarding/complete',{method:'POST'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{completed:true});
});
