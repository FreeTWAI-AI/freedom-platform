import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';

test('signed-out mailbox confirmation reaches the public endpoint without a session CSRF token',async t=>{
  const requests:{url:unknown;options?:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async(url:unknown,options?:RequestInit)=>{
    requests.push({url,options});
    return Response.json({confirmed:true});
  });
  const client=new PortalClient();
  const token='A'.repeat(43);
  const path='/auth/email-verification/confirm';
  assert.equal(client.csrfToken,null);
  assert.deepEqual(await client.post(path,{token},{skipAuthHandler:true}),{confirmed:true});
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'/api/v1'+path);
  assert.equal(new Headers(requests[0].options?.headers).has('X-CSRF-Token'),false);
  assert.deepEqual(JSON.parse(String(requests[0].options?.body)),{token});
  assert.equal(requests[0].options?.credentials,'same-origin');
});

test('mailbox exception does not relax the authenticated account request boundary',async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({}));
  const client=new PortalClient();
  for(const path of ['/me/account','/me/account/email-change/request','/me/account/email-verification/request']){
    await assert.rejects(client.post(path,{}),error=>error instanceof ApiError&&error.status===400);
  }
  assert.equal(fetch.mock.callCount(),0);
});
