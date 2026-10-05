import assert from 'node:assert/strict';
import {test} from 'node:test';
import {classifyPrivateAiPath,installedPrivateAiResponse} from '../../apps/platform-api/src/private-ai-path.js';
test('one private AI namespace source preserves purpose ownership, unknown suffixes and installed-only boundary',async()=>{
 for(const [path,purpose,installed] of [['/api/v1/me/private-work','work',false],['/api/v1/me/execution-runs','prerequisites',false],
  ['/api/v1/me/model-steps','member-model',true],['/api/v1/me/credential-ingests','ingest',true],['/api/v1/me/model-settings','settings',true],
  ['/api/v1/me/agent-connections','bootstrap',true],['/execution-api/v1/bootstrap','bootstrap',true],['/execution-api/v1/model-steps','machine-model',true]] as const){
  for(const suffix of ['', '/unknown',':unknown']){const full=path+suffix,c=classifyPrivateAiPath(full);assert.equal(c?.purpose,purpose);assert.equal(c?.normalized,true);
   const response=await installedPrivateAiResponse(new Request('https://example.invalid'+full));assert.equal(response?.status??null,installed?503:null);}
 }
 assert.equal(classifyPrivateAiPath('/api/v1/me/model-steps-other'),undefined);
});
test('encoded private aliases terminate before either installation or legacy middleware, any method',async()=>{
 let calls=0;const child=async()=>{calls++;return new Response('unexpected');};
 for(const path of ['/api/v1/me/model%2dsteps','/api/v1/me/model%252dsteps','/execution-api/v1/model-steps/%61','/api/v1/me/private-work/%2f'])
  for(const method of ['GET','POST','HEAD','OPTIONS','DELETE']){assert.equal(classifyPrivateAiPath(path)?.normalized,false);assert.equal((await installedPrivateAiResponse(new Request('https://example.invalid'+path,{method}),child))?.status,403);}
 assert.equal(calls,0);
});
test('installer forwards original request once without interpreting credential/method/body or routing unknown public paths',async()=>{
 for(const method of ['POST','HEAD','DELETE']){const request=new Request('https://example.invalid/execution-api/v1/model-steps',{method});let calls=0;
  const response=await installedPrivateAiResponse(request,async actual=>{assert.equal(actual,request);calls++;return new Response(null,{status:405});});assert.equal(response?.status,405);assert.equal(calls,1);}
 assert.equal(installedPrivateAiResponse(new Request('https://example.invalid/api/v1/me/account')),null);
});
