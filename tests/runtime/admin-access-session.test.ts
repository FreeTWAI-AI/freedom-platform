import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MEMBER_ACCESS_EXPIRED_MESSAGE} from '../../apps/portal-web/src/access-fetch.js';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';
import {ADMIN_ACCESS_EXPIRED_MESSAGE,AdminClient,AdminRequestError} from '../../apps/portal-web/src/modules/admin-client.js';
import {uploadMemberAvatar} from '../../apps/portal-web/src/modules/avatar-client.js';

const NETWORK_MESSAGE='目前無法連線。操作不會自動重送，請重新載入確認結果。';

function opaqueRedirect():Response{
  return {type:'opaqueredirect',status:0,ok:false,headers:new Headers(),clone(){return opaqueRedirect();},text:async()=>'',json:async()=>{throw new SyntaxError('no body');}} as unknown as Response;
}
function header(init:RequestInit|undefined,name:string){return new Headers(init?.headers).get(name);}
function assertManualXhr(init?:RequestInit){
  assert.equal(init?.redirect,'manual');
  assert.equal(header(init,'X-Requested-With'),'XMLHttpRequest');
  assert.equal(init?.credentials,'same-origin');
}

test('admin client treats an opaque redirect as an expired administrator session',async t=>{
  let init:RequestInit|undefined;
  const fetcher=t.mock.method(globalThis,'fetch',async(input:unknown,options?:RequestInit)=>{init=options;assert.equal(input,'/admin/api/bootstrap');return opaqueRedirect();});
  const client=new AdminClient();client.csrf='keep';let expired=0;client.onAccessExpired=()=>{expired++;};
  await assert.rejects(client.request('/bootstrap'),(cause:unknown)=>{
    assert.ok(cause instanceof AdminRequestError);assert.equal(cause.accessExpired,true);assert.equal(cause.status,0);assert.equal(cause.message,ADMIN_ACCESS_EXPIRED_MESSAGE);assert.doesNotMatch(cause.message,/管理入口沒有回傳完整資料|目前無法連線/);return true;
  });
  assertManualXhr(init);assert.equal(init?.cache,'no-store');assert.equal(header(init,'Accept'),'application/json');
  assert.equal(client.csrf,'keep','an opaque redirect is not a 401 or 403');assert.equal(expired,1);assert.equal(fetcher.mock.callCount(),1);
});

test('admin client treats an HTML 401 or 403 as an expired administrator session and still clears the local CSRF token',async t=>{
  for(const status of [401,403]){
    let init:RequestInit|undefined;
    const fetcher=t.mock.method(globalThis,'fetch',async(_input:unknown,options?:RequestInit)=>{init=options;return new Response('<html>cloudflare access</html>',{status,headers:{'content-type':'text/html'}});});
    const client=new AdminClient();client.csrf='keep';
    await assert.rejects(client.request('/bootstrap'),(cause:unknown)=>{
      assert.ok(cause instanceof AdminRequestError);assert.equal(cause.accessExpired,true);assert.equal(cause.status,status);assert.equal(cause.message,ADMIN_ACCESS_EXPIRED_MESSAGE);assert.doesNotMatch(cause.message,/管理入口沒有回傳完整資料/);return true;
    });
    assertManualXhr(init);assert.equal(client.csrf,null);fetcher.mock.restore();
  }
});

test('admin client keeps a JSON 401 detail and still clears the local CSRF token',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({detail:'請先通過管理員信箱驗證。'},{status:401}));
  const client=new AdminClient();client.csrf='keep';let expired=0;client.onAccessExpired=()=>{expired++;};
  await assert.rejects(client.request('/bootstrap'),(cause:unknown)=>{
    assert.ok(cause instanceof AdminRequestError);assert.equal(cause.accessExpired,false);assert.equal(cause.status,401);assert.equal(cause.message,'請先通過管理員信箱驗證。');return true;
  });
  assert.equal(client.csrf,null);assert.equal(expired,0);
});

test('admin client keeps a JSON 500 detail',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({detail:'服務暫時無法完成這項操作。'},{status:500}));
  const client=new AdminClient();client.csrf='keep';
  await assert.rejects(client.request('/bootstrap'),(cause:unknown)=>{
    assert.ok(cause instanceof AdminRequestError);assert.equal(cause.accessExpired,false);assert.equal(cause.status,500);assert.equal(cause.message,'服務暫時無法完成這項操作。');return true;
  });
  assert.equal(client.csrf,'keep');
});

test('admin client keeps the network message when fetch itself throws',async t=>{
  const fetcher=t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('Failed to fetch');});
  const client=new AdminClient();
  await assert.rejects(client.request('/bootstrap'),(cause:unknown)=>{
    assert.ok(cause instanceof AdminRequestError);assert.equal(cause.accessExpired,false);assert.equal(cause.status,0);assert.equal(cause.message,NETWORK_MESSAGE);return true;
  });
  assert.equal(fetcher.mock.callCount(),1);
});

test('admin client sends a manual XHR GET and returns the JSON body',async t=>{
  let init:RequestInit|undefined;
  t.mock.method(globalThis,'fetch',async(input:unknown,options?:RequestInit)=>{init=options;assert.equal(input,'/admin/api/bootstrap');assert.equal(options?.method,'GET');return Response.json({ok:true});});
  const client=new AdminClient();client.csrf='keep';
  assert.deepEqual(await client.request('/bootstrap'),{ok:true});
  assertManualXhr(init);assert.equal(init?.cache,'no-store');assert.equal(init?.body,undefined);
  assert.equal(header(init,'Accept'),'application/json');assert.equal(header(init,'Content-Type'),null);assert.equal(header(init,'X-Admin-CSRF'),null);assert.equal(header(init,'Idempotency-Key'),null);assert.equal(header(init,'If-Match'),null);
  assert.equal(client.csrf,'keep');
});

test('admin client sends CSRF and the idempotency key on a successful POST',async t=>{
  let init:RequestInit|undefined;
  t.mock.method(globalThis,'fetch',async(input:unknown,options?:RequestInit)=>{init=options;assert.equal(input,'/admin/api/members/1/status');assert.equal(options?.method,'POST');return Response.json({saved:true});});
  const client=new AdminClient();client.csrf='csrf-token';
  assert.deepEqual(await client.request('/members/1/status',{active:false,reason:'測試'},{key:'idem-1',version:7}),{saved:true});
  assertManualXhr(init);assert.equal(init?.cache,'no-store');
  assert.equal(header(init,'X-Admin-CSRF'),'csrf-token');assert.equal(header(init,'Idempotency-Key'),'idem-1');assert.equal(header(init,'If-Match'),'"7"');
  assert.equal(header(init,'Content-Type'),'application/json');assert.equal(header(init,'Accept'),'application/json');
  assert.deepEqual(JSON.parse(String(init?.body)),{active:false,reason:'測試'});
});

test('an older admin success does not clear a newer expired session',async t=>{
  let release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1){await gate;return Response.json({ok:true});}return new Response('<html>cloudflare access</html>',{status:401,headers:{'content-type':'text/html'}});});
  const client=new AdminClient();client.csrf='keep';let expired=0,recovered=0;
  client.onAccessExpired=()=>{expired++;};client.onAccessRecovered=()=>{recovered++;};
  const older=client.request('/bootstrap');
  await assert.rejects(client.request('/members'),(cause:unknown)=>{assert.ok(cause instanceof AdminRequestError);assert.equal(cause.accessExpired,true);assert.equal(cause.message,ADMIN_ACCESS_EXPIRED_MESSAGE);return true;});
  assert.equal(expired,1);assert.equal(client.csrf,null);
  release();
  assert.deepEqual(await older,{ok:true});
  assert.equal(recovered,0);assert.equal(expired,1);
});

test('portal client treats an opaque redirect as an expired site session instead of a network failure',async t=>{
  let init:RequestInit|undefined;
  t.mock.method(globalThis,'fetch',async(_input:unknown,options?:RequestInit)=>{init=options;return opaqueRedirect();});
  const client=new PortalClient();client.csrfToken='keep';let unauthorized=0;client.onUnauthorized=()=>{unauthorized++;};
  await assert.rejects(client.get('/members'),(cause:unknown)=>{
    assert.ok(cause instanceof ApiError);assert.equal(cause.accessExpired,true);assert.equal(cause.network,false);assert.equal(cause.unauthorized,false);assert.equal(cause.status,0);assert.equal(cause.message,MEMBER_ACCESS_EXPIRED_MESSAGE);assert.doesNotMatch(cause.message,/無法連線到伺服器/);return true;
  });
  assertManualXhr(init);assert.equal(client.csrfToken,'keep');assert.equal(unauthorized,1,'the shell is notified so every screen can offer a full reload');assert.equal(client.accessExpired,true);
});

test('portal client treats an HTML 401 or 403 as an expired site session',async t=>{
  for(const status of [401,403]){
    let init:RequestInit|undefined;
    const fetcher=t.mock.method(globalThis,'fetch',async(_input:unknown,options?:RequestInit)=>{init=options;return new Response('<html>expired session</html>',{status,headers:{'content-type':'text/html'}});});
    const client=new PortalClient();client.csrfToken='synthetic';let unauthorized=0;client.onUnauthorized=()=>{unauthorized++;};
    await assert.rejects(client.get('/session'),(cause:unknown)=>{
      assert.ok(cause instanceof ApiError);assert.equal(cause.accessExpired,true);assert.equal(cause.unauthorized,status===401);assert.equal(cause.status,status);assert.equal(cause.network,false);assert.equal(cause.message,MEMBER_ACCESS_EXPIRED_MESSAGE);return true;
    });
    assertManualXhr(init);assert.equal(client.csrfToken,null);assert.equal(unauthorized,1);fetcher.mock.restore();
  }
});

test('portal client keeps a JSON 401 detail and still invokes the member session handler',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({detail:'帳號或密碼不正確。'},{status:401}));
  const client=new PortalClient();client.csrfToken='synthetic';let unauthorized=0;client.onUnauthorized=()=>{unauthorized++;};
  await assert.rejects(client.post('/auth/login',{email:'a@example.test',password:'secret'},{skipAuthHandler:true}),(cause:unknown)=>{
    assert.ok(cause instanceof ApiError);assert.equal(cause.accessExpired,false);assert.equal(cause.message,'帳號或密碼不正確。');assert.equal(cause.unauthorized,true);return true;
  });
  assert.equal(unauthorized,0,'login does not treat an application 401 as a dropped session');assert.equal(client.csrfToken,'synthetic');
  await assert.rejects(client.get('/members'),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.accessExpired,false);assert.equal(cause.message,'帳號或密碼不正確。');return true;});
  assert.equal(client.csrfToken,null);assert.equal(unauthorized,1);
});

test('avatar upload treats an HTML 401 as an expired site session and keeps the save headers',async t=>{
  let init:RequestInit|undefined;
  const fetcher=t.mock.method(globalThis,'fetch',async(input:unknown,options?:RequestInit)=>{init=options;assert.equal(input,'/api/v1/me/avatar');return new Response('<html>cloudflare access</html>',{status:401,headers:{'content-type':'text/html'}});});
  const client=new PortalClient();client.csrfToken='avatar-csrf';let unauthorized=0;client.onUnauthorized=()=>{unauthorized++;};
  const file=new File([new Uint8Array([1,2,3])],'portrait.png',{type:'image/png'});
  await assert.rejects(uploadMemberAvatar(client,file,4,'avatar-key'),(cause:unknown)=>{
    assert.ok(cause instanceof ApiError);assert.equal(cause.accessExpired,true);assert.equal(cause.network,false);assert.equal(cause.status,401);assert.equal(cause.message,MEMBER_ACCESS_EXPIRED_MESSAGE);assert.doesNotMatch(cause.message,/回應未完整收到|連線中斷/);return true;
  });
  assertManualXhr(init);assert.equal(init?.method,'POST');assert.equal(init?.body,file);
  assert.equal(header(init,'X-CSRF-Token'),'avatar-csrf');assert.equal(header(init,'Idempotency-Key'),'avatar-key');assert.equal(header(init,'If-Match'),'"4"');assert.equal(header(init,'Content-Type'),'image/png');
  assert.equal(client.csrfToken,null);assert.equal(unauthorized,1);assert.equal(fetcher.mock.callCount(),1);
});

test('avatar upload treats an opaque redirect as an expired site session and keeps the save headers',async t=>{
  let init:RequestInit|undefined;
  t.mock.method(globalThis,'fetch',async(input:unknown,options?:RequestInit)=>{init=options;assert.equal(input,'/api/v1/me/avatar');return opaqueRedirect();});
  const client=new PortalClient();client.csrfToken='avatar-csrf';let unauthorized=0;client.onUnauthorized=()=>{unauthorized++;};
  const file=new File([new Uint8Array([1,2,3])],'portrait.png',{type:'image/png'});
  await assert.rejects(uploadMemberAvatar(client,file,4,'avatar-key'),(cause:unknown)=>{
    assert.ok(cause instanceof ApiError);assert.equal(cause.accessExpired,true);assert.equal(cause.network,false);assert.equal(cause.unauthorized,false);assert.equal(cause.status,0);assert.equal(cause.message,MEMBER_ACCESS_EXPIRED_MESSAGE);return true;
  });
  assertManualXhr(init);assert.equal(init?.method,'POST');assert.equal(init?.body,file);
  assert.equal(header(init,'X-CSRF-Token'),'avatar-csrf');assert.equal(header(init,'Idempotency-Key'),'avatar-key');assert.equal(header(init,'If-Match'),'"4"');
  assert.equal(client.csrfToken,'avatar-csrf','an opaque redirect is not a 401 or 403');assert.equal(unauthorized,1);
});
