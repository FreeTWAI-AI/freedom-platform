import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';
import {AccountDeactivation,submitAccountDeactivation} from '../../apps/portal-web/src/modules/AccountDeactivation.js';

test('shared deactivation form requires the password and states retention before confirmation',()=>{
  const html=renderToStaticMarkup(createElement(AccountDeactivation,{client:new PortalClient(),version:1}));
  assert.match(html,/type="password"/);assert.match(html,/required=""/);assert.match(html,/這不是資料刪除/);
  assert.match(html,/確認停用帳號並登出所有裝置/);
});

test('lost deactivation acknowledgement then 401 retry clears current local authentication',async t=>{
  const client=new PortalClient();client.csrfToken='synthetic-csrf';let ended=0,attempts=0;
  client.onUnauthorized=()=>{ended++;};
  t.mock.method(globalThis,'fetch',async(_url:unknown,options?:RequestInit)=>{
    const headers=new Headers(options?.headers);
    assert.equal(headers.get('X-CSRF-Token'),'synthetic-csrf');assert.equal(headers.get('If-Match'),'"1"');
    assert.ok(headers.get('Idempotency-Key'));assert.deepEqual(JSON.parse(String(options?.body)),{password:'synthetic-password'});
    if(++attempts===1)throw new TypeError('Synthetic lost acknowledgement');
    return Response.json({code:'login_required',detail:'請重新登入。'},{status:401});
  });
  await assert.rejects(submitAccountDeactivation(client,'synthetic-password',1));
  assert.equal(client.csrfToken,'synthetic-csrf');assert.equal(ended,0);
  await assert.rejects(submitAccountDeactivation(client,'synthetic-password',1),error=>error instanceof ApiError&&error.status===401);
  assert.equal(client.csrfToken,null);assert.equal(ended,1);assert.equal(attempts,2);
});

test('incorrect-password response keeps the local session available',async t=>{
  const client=new PortalClient();client.csrfToken='synthetic-csrf';let ended=0;client.onUnauthorized=()=>{ended++;};
  t.mock.method(globalThis,'fetch',async()=>Response.json({code:'password_incorrect',detail:'密碼不正確。'},{status:422}));
  await assert.rejects(submitAccountDeactivation(client,'wrong',1),error=>error instanceof ApiError&&error.status===422);
  assert.equal(client.csrfToken,'synthetic-csrf');assert.equal(ended,0);
});
