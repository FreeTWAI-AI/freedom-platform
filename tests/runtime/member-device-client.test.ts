import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';
import {createMemberDeviceClient} from '../../apps/portal-web/src/modules/member-device-client.js';
import {subscribeGameConsole} from '../../apps/portal-web/src/game-console-core.js';
const id='11111111-1111-4111-8111-111111111111',runtime='22222222-2222-4222-8222-222222222222';
const digest='A'.repeat(43),key='original-key-01';
const command={userCode:'12345-6789A',authorizationId:id,requestDigest:digest,decision:'approve' as const};
const review={authorizationId:id,requestDigest:digest,clientId:'synthetic-client',clientDisplayName:'Synthetic device',environment:'local',runtimeKind:'agent-kit',keyThumbprint:digest,scope:'bootstrap.status.read',expiresAt:'2000-01-01T00:00:00.000Z',state:'pending',operational_authority:false};
const decision={authorizationId:id,requestDigest:digest,state:'approved',operational_authority:false};
const connection={connectionId:id,runtimeDeviceId:runtime,environment:'local',clientId:'synthetic-client',state:'active',aggregateVersion:'7',issuedAt:'2000-01-01T00:00:00.000Z',expiresAt:'2000-01-02T00:00:00.000Z',operational_authority:false};
function setup(t:any,responder:(input:unknown,init:RequestInit)=>Promise<Response>|Response) {
  const fetcher=t.mock.method(globalThis,'fetch',async(input:unknown,init?:RequestInit)=>responder(input,init!));
  const portal=new PortalClient();portal.csrfToken='synthetic-csrf';
  return {fetcher,portal,client:createMemberDeviceClient(portal)};
}
test('inspect only posts the typed code with member CSRF; never decides or calls machine endpoints',async t=>{
  const calls:any[]=[];const f=setup(t,(path,init)=>{calls.push([path,init]);return Response.json(review);});
  const result=await f.client.inspect(command.userCode);
  assert.deepEqual(result,review);assert(Object.isFrozen(result));assert.equal(calls.length,1);
  assert.equal(calls[0][0],'/api/v1/me/device-authorizations/inspect');
  assert.equal(calls[0][1].method,'POST');assert.equal(calls[0][1].credentials,'same-origin');
  assert.deepEqual(JSON.parse(calls[0][1].body),{userCode:command.userCode});
  const headers=new Headers(calls[0][1].headers);assert.equal(headers.get('X-CSRF-Token'),'synthetic-csrf');assert.equal(headers.get('If-Match'),null);
});
test('explicit same-original decision replay preserves exact body and key after unknown outcome, without retry or read',async t=>{
  const calls:any[]=[];const f=setup(t,(path,init)=>{calls.push([path,init]);if(calls.length===1)throw new Error('synthetic lost response');return Response.json(decision);});
  await assert.rejects(f.client.decide(command,key),(e:any)=>e instanceof ApiError&&e.network);
  assert.equal(calls.length,1);
  assert.deepEqual(await f.client.decide({...command},key),decision);assert.equal(calls.length,2);
  assert.equal(calls[0][1].body,calls[1][1].body);assert.deepEqual(JSON.parse(calls[1][1].body),command);
  assert.equal(calls[1][0],'/api/v1/me/device-authorizations/decide');
  for(const [,init]of calls){const headers=new Headers(init.headers);assert.equal(headers.get('Idempotency-Key'),key);assert.equal(headers.get('If-Match'),null);}
  await assert.rejects(f.client.decide({...command,decision:'deny'},key),(e:any)=>e instanceof ApiError&&e.conflict);
  assert.equal(calls.length,2);
});
test('revoke replay preserves exact original quoted CAS and rejects changed version or cross-command key reuse',async t=>{
  const calls:any[]=[];const f=setup(t,(path,init)=>{calls.push([path,init]);if(calls.length===1)throw Error('lost');return Response.json({...connection,state:'revoked',aggregateVersion:'8'});});
  await assert.rejects(f.client.revoke(id,'7',key),(e:any)=>e.network===true);assert.equal(calls.length,1);
  const result=await f.client.revoke(id,'7',key);assert.equal(result.state,'revoked');
  for(const [path,init]of calls){assert.equal(path,'/api/v1/me/agent-connections/'+id+':revoke');assert.equal(init.body,'{}');const headers=new Headers(init.headers);assert.equal(headers.get('If-Match'),'"7"');assert.equal(headers.get('Idempotency-Key'),key);}
  await assert.rejects(f.client.revoke(id,'8',key),(e:any)=>e.conflict);await assert.rejects(f.client.decide(command,key),(e:any)=>e.conflict);assert.equal(calls.length,2);
});
test('command body is snapshotted before async transport and cannot bind a changed review',async t=>{
  let release!:(value:Response)=>void;let init!:RequestInit;
  const f=setup(t,(_path,options)=>{init=options;return new Promise<Response>(r=>release=r);});
  const mutable={...command};const pending=f.client.decide(mutable,key);mutable.authorizationId=runtime;mutable.decision='deny' as any;
  release(Response.json(decision));await pending;assert.deepEqual(JSON.parse(init.body as string),command);
});
test('all invalid code/id/version/key/decision inputs reject before any transport',async t=>{
  const f=setup(t,()=>Response.json(connection));
  const bad=[()=>f.client.inspect(' abc '),()=>f.client.read(id.toUpperCase()),()=>f.client.read(id+'?x=1'),()=>f.client.revoke(id,'0',key),()=>f.client.revoke(id,'9223372036854775808',key),()=>f.client.revoke(id,'7\n',key),()=>f.client.revoke(id,'7','bad key'),()=>f.client.decide({...command,extra:true} as any,key),()=>f.client.decide({...command,requestDigest:'bad'},key),()=>f.client.decide(command,'x')];
  // Use a UUID containing letters to exercise canonical lowercase validation.
  bad[1]=()=>f.client.read('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA');
  for(const call of bad)await assert.rejects(call(),(e:any)=>e instanceof ApiError&&e.status===400);
  assert.equal(f.fetcher.mock.callCount(),0);
});
for(const mutation of [(v:any)=>({...v,extra:'untrusted'}),(v:any)=>({...v,operational_authority:true}),(v:any)=>({...v,runtimeDeviceId:undefined}),(v:any)=>({...v,expiresAt:'not-a-date'}),(v:any)=>({...v,connectionId:runtime}),(v:any)=>({...v,aggregateVersion:'9223372036854775808'})]) {
  test('strict connection response rejects unknown keys, false authority, missing runtime/date or foreign binding',async t=>{
    const f=setup(t,()=>Response.json(mutation(connection)));
    await assert.rejects(f.client.read(id),ApiError);assert.equal(f.fetcher.mock.callCount(),1);
  });
}
test('list preserves revoked and expired metadata, is bounded and performs fresh background reads',async t=>{
  let payload:any={items:[connection,{...connection,connectionId:runtime,state:'revoked'}],operational_authority:false};
  const f=setup(t,()=>Response.json(payload));const result=await f.client.list();assert.equal(result.items.length,2);assert.equal(result.items[1].state,'revoked');assert.equal(result.items[0].expiresAt,connection.expiresAt);assert(Object.isFrozen(result.items));
  payload={items:[],operational_authority:false};assert.deepEqual((await f.client.list()).items,[]);assert.equal(f.fetcher.mock.callCount(),2);
  for(const value of [{items:Array(33).fill(connection),operational_authority:false},{items:[],operational_authority:true},{items:[],operational_authority:false,extra:true}]){payload=value;await assert.rejects(f.client.list(),ApiError);}
});
test('malformed or wrong-bound successful write results remain outcome unknown and never cause hidden reads',async t=>{
  let payload:any={...decision,operational_authority:true};const f=setup(t,()=>Response.json(payload));
  for(const value of [payload,{...decision,requestDigest:'B'.repeat(43)},{...decision,state:'denied'},{...decision,extra:true}]) {payload=value;await assert.rejects(f.client.decide(command,key),(e:any)=>e instanceof ApiError&&e.network&&!e.conflict);}
  payload={...connection,state:'active'};await assert.rejects(f.client.revoke(id,'7','revoke-key-02'),(e:any)=>e.network===true);
  assert.equal(f.fetcher.mock.callCount(),5);
});
for(const status of [401,403,412])test(`actual PortalClient owner HTTP${status} propagates auth/conflict without further requests`,async t=>{
  const f=setup(t,()=>Response.json({code:status===412?'conflict':'forbidden'},{status}));let unauth=0;f.portal.onUnauthorized=()=>unauth++;
  await assert.rejects(f.client.decide(command,key),(e:any)=>e instanceof ApiError&&e.status===status&&!e.network);
  assert.equal(f.fetcher.mock.callCount(),1);assert.equal(unauth,status===401?1:0);if(status===401)assert.equal(f.portal.csrfToken,null);
});
test('Access expiration remains an Access error and invokes the shell handler once',async t=>{
  const f=setup(t,()=>new Response('<html>Sign in</html>',{status:403,headers:{'content-type':'text/html','cf-access-expired':'1'}}));
  let called=0;f.portal.onUnauthorized=()=>called++;
  await assert.rejects(f.client.list(),(e:any)=>e instanceof ApiError&&e.accessExpired&&e.status===403);
  assert.equal(f.fetcher.mock.callCount(),1);assert.equal(called,1);assert.equal(f.portal.accessExpired,true);assert.equal(f.portal.csrfToken,null);
});
test('background reads and suppressed writes do not emit private device details to console or use browser storage',async t=>{
  let storageCalls=0;const throwing={getItem(){storageCalls++;throw Error('storage');},setItem(){storageCalls++;throw Error('storage');}};
  for(const name of ['localStorage','sessionStorage']) {
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{configurable:true,value:throwing});
    t.after(()=>{if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);});
  }
  const messages:any[]=[];const unsubscribe=subscribeGameConsole(event=>messages.push(event));
  try {const f=setup(t,()=>Response.json({code:'forbidden'},{status:403}));await assert.rejects(f.client.read(id),ApiError);await assert.rejects(f.client.inspect(command.userCode),ApiError);await assert.rejects(f.client.decide(command,key),ApiError);assert.deepEqual(messages,[]);assert.equal(storageCalls,0);}finally{unsubscribe();}
});

test('inspect rejects open or machine-authority review DTOs rather than treating inspection as approval',async t=>{
  let payload:any;const f=setup(t,()=>Response.json(payload));
  for(const value of [{...review,scope:'execution.run'},{...review,operational_authority:true},{...review,proof:'untrusted-machine-proof'},{...review,state:'expired'},{...review,expiresAt:'bad'}]) {
    payload=value;await assert.rejects(f.client.inspect(command.userCode),(e:any)=>e instanceof ApiError&&!e.network);
  }
  assert.equal(f.fetcher.mock.callCount(),5);
  for(const call of f.fetcher.mock.calls)assert.equal(call.arguments[0],'/api/v1/me/device-authorizations/inspect');
});

test('maximum signed bigint CAS stays an exact quoted string through real transport',async t=>{
  let headers!:Headers;const f=setup(t,(_path,init)=>{headers=new Headers(init.headers);return Response.json({...connection,state:'revoked',aggregateVersion:'9223372036854775807'});});
  await f.client.revoke(id,'9223372036854775807',key);
  assert.equal(headers.get('If-Match'),'"9223372036854775807"');assert.equal(f.fetcher.mock.callCount(),1);
});
