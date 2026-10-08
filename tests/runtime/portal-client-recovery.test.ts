import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';
import {subscribeGameConsole} from '../../apps/portal-web/src/game-console-core.js';
import {requestActivity} from '../../apps/portal-web/src/request-activity.js';

test('opted-in overlapping GETs share one transport, with no retained response cache', async t=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=t.mock.method(globalThis,'fetch',async()=>{await gate;return Response.json({value:7});});
  const client=new PortalClient(); client.csrfToken='synthetic-a';
  const reads=Array.from({length:5},()=>client.get('/me/identical',{coalesce:true}));
  assert.equal(fetcher.mock.callCount(),1);
  release(); assert.deepEqual(await Promise.all(reads),Array.from({length:5},()=>({value:7})));
  await client.get('/me/identical',{coalesce:true});assert.equal(fetcher.mock.callCount(),2,'a settled read is not cached');
});

test('overlapping reads preserve distinct auth epochs, paths and handler options', async t=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=t.mock.method(globalThis,'fetch',async()=>{await gate;return Response.json({ok:true});});
  const client=new PortalClient(); client.csrfToken='synthetic-a';
  const pending=[client.get('/me/a',{coalesce:true}),client.get('/me/b',{coalesce:true}),client.get('/me/a',{coalesce:true,background:true}),client.get('/me/a',{coalesce:true,skipAuthHandler:true})];
  client.csrfToken='synthetic-b';pending.push(client.get('/me/a',{coalesce:true}));
  const other=new PortalClient(); other.csrfToken='synthetic-b';pending.push(other.get('/me/a',{coalesce:true}));
  assert.equal(fetcher.mock.callCount(),6);release();await Promise.all(pending);
});

test('shared transport responses give each consumer an independent mutable JSON view',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({items:[{name:'original'}]}));
  const client=new PortalClient();
  const [a,b]=await Promise.all([client.get<{items:{name:string}[]}>('/same',{coalesce:true}),client.get<{items:{name:string}[]}>('/same',{coalesce:true})]);
  a.items[0].name='edited';a.items.push({name:'added'});
  assert.deepEqual(b,{items:[{name:'original'}]});
});

test('explicit receipt keys and CAS options keep independent GET transport semantics',async t=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=t.mock.method(globalThis,'fetch',async()=>{await gate;return Response.json({ok:true});});
  const client=new PortalClient();
  const pending=[
    client.get('/same',{coalesce:true,idempotencyKey:'first-receipt'}),
    client.get('/same',{coalesce:true,idempotencyKey:'second-receipt'}),
    client.get('/same',{coalesce:true,ifMatch:'7'}),
    client.get('/same',{coalesce:true,ifMatch:'8'}),
    client.get('/same',{coalesce:true,preferenceVersion:'1'}),
    client.get('/same',{coalesce:true,preferenceVersion:'2'}),
  ];
  assert.equal(fetcher.mock.callCount(),6);release();await Promise.all(pending);
});

test('failed shared reads release their slot and never auto-retry; mutations are not coalesced',async t=>{
  const fetcher=t.mock.method(globalThis,'fetch',async()=>{throw new Error('controlled offline');});
  const client=new PortalClient();client.csrfToken='synthetic';
  const failed=await Promise.allSettled([client.get('/same',{coalesce:true}),client.get('/same',{coalesce:true})]);
  assert(failed.every(value=>value.status==='rejected'));assert.equal(fetcher.mock.callCount(),1);
  await assert.rejects(client.get('/same',{coalesce:true}));assert.equal(fetcher.mock.callCount(),2);
  await Promise.allSettled([client.post('/same',{}, {idempotencyKey:'same-key'}),client.post('/same',{}, {idempotencyKey:'same-key'})]);
  assert.equal(fetcher.mock.callCount(),4,'writes remain independent and are never automatically resent');
});

test('a caller-owned abort cannot cancel another overlapping read',async t=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=t.mock.method(globalThis,'fetch',async(_url:unknown,options?:RequestInit)=>{
    await Promise.race([gate,new Promise<never>((_,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))]);
    return Response.json({kept:true});
  });
  const client=new PortalClient(),controller=new AbortController();
  const separate=client.get('/same',{coalesce:true,signal:controller.signal}),shared=client.get('/same',{coalesce:true});
  const canceled=assert.rejects(separate,(error:unknown)=>error instanceof ApiError&&error.code==='aborted');
  controller.abort();await canceled;release();assert.deepEqual(await shared,{kept:true});assert.equal(fetcher.mock.callCount(),2);
});

test('fresh reads remain independent by default and an explicit opt-out bypasses shared reads',async t=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=t.mock.method(globalThis,'fetch',async()=>{await gate;return Response.json({ok:true});});
  const client=new PortalClient();
  const pending=[client.get('/same',{coalesce:true}),client.get('/same',{coalesce:true}),client.get('/same'),client.get('/same'),client.get('/same',{coalesce:false})];
  assert.equal(fetcher.mock.callCount(),4);release();await Promise.all(pending);
});

test('POST, DELETE and PATCH separate shared read snapshots before, during and after the write',async t=>{
  for(const method of ['post','delete','patch'] as const){
    let version=0,finishWrite!:()=>void;
    const replies:{version:number;resolve:(response:Response)=>void}[]=[];
    const fetcher=t.mock.method(globalThis,'fetch',async(_url:unknown,options?:RequestInit)=>{
      if(options?.method==='GET')return new Promise<Response>(resolve=>replies.push({version,resolve}));
      return new Promise<Response>(resolve=>{finishWrite=()=>{version++;resolve(Response.json({saved:true}));};});
    });
    const client=new PortalClient();client.csrfToken='synthetic';
    const before=client.get('/same',{coalesce:true}),beforePeer=client.get('/same',{coalesce:true});
    const write=client[method]('/same',{});
    const during=client.get('/same',{coalesce:true});
    finishWrite();await write;
    const after=client.get('/same',{coalesce:true});
    assert.equal(replies.length,3,method+' reads cannot reuse a pre-write snapshot');
    replies[0].resolve(Response.json({version:replies[0].version}));replies[1].resolve(Response.json({version:replies[1].version}));
    assert.deepEqual(await before,{version:0});assert.deepEqual(await beforePeer,{version:0});assert.deepEqual(await during,{version:0});
    const afterPeer=client.get('/same',{coalesce:true});
    assert.equal(replies.length,3,'late older reads cannot remove the current shared slot');
    replies[2].resolve(Response.json({version:replies[2].version}));
    assert.deepEqual(await after,{version:1});assert.deepEqual(await afterPeer,{version:1});
    assert.equal(fetcher.mock.callCount(),4);fetcher.mock.restore();
  }
});

test('foreground activity starts before a slow body ACK and always clears on success or failure',async t=>{
  let close!:()=>void;
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"ok":true}'));close=()=>controller.close();}});
  t.mock.method(globalThis,'fetch',async()=>new Response(body,{headers:{'content-type':'application/json'}}));
  const client=new PortalClient();client.csrfToken='synthetic';
  const observed:{pending:number;mutations:number}[]=[];const unsubscribe=requestActivity.subscribe(()=>observed.push(requestActivity.snapshot()));
  try{
    const write=client.post('/same',{});assert.deepEqual(requestActivity.snapshot(),{pending:1,mutations:1});
    close();assert.deepEqual(await write,{ok:true});assert.deepEqual(requestActivity.snapshot(),{pending:0,mutations:0});
    const offline=t.mock.method(globalThis,'fetch',async()=>{throw new Error('offline');});
    await assert.rejects(client.get('/failure'));assert.deepEqual(requestActivity.snapshot(),{pending:0,mutations:0});offline.mock.restore();
    assert(observed.some(value=>value.mutations===1));
  }finally{unsubscribe();}
});

test('background reads do not create foreground feedback and stale same-token auth errors stay scoped',async t=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  t.mock.method(globalThis,'fetch',async()=>{await gate;return Response.json({code:'unauthorized'},{status:401});});
  const client=new PortalClient();client.csrfToken='synthetic-a';let expired=0;client.onUnauthorized=()=>{expired++;};
  const read=client.get('/session',{background:true});assert.equal(requestActivity.snapshot().pending,0);
  client.csrfToken=null;client.csrfToken='synthetic-a';release();await assert.rejects(read,ApiError);
  assert.equal(expired,0);assert.equal(client.csrfToken,'synthetic-a');
});

test('background feed failures stay out of the visible console while direct failures remain visible',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({code:'github_unavailable'},{status:503}));
  const messages:string[]=[];const unsubscribe=subscribeGameConsole(event=>messages.push(event.message));
  try{
    const client=new PortalClient();
    await assert.rejects(client.get('/pages/github-events',{background:true}),ApiError);
    assert.deepEqual(messages,[]);
    await assert.rejects(client.get('/pages/github-events'),ApiError);
    assert.equal(messages.length,1);
  }finally{unsubscribe()}
});

test('only co-creation activity reads turn known GitHub limits into task-specific copy',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({code:'github_rate_limited',detail:'untrusted upstream detail'},{status:503}));
  const client=new PortalClient();
  await assert.rejects(client.get('/co-creation/projects/workshop-video-autopilot/activity'),(cause:unknown)=>{
    assert.ok(cause instanceof ApiError);assert.match(cause.message,/GitHub 暫時限制查詢/);assert.match(cause.message,/查看 Issue/);assert.doesNotMatch(cause.message,/untrusted/);return true;
  });
  await assert.rejects(client.get('/pages/github-events'),(cause:unknown)=>{
    assert.ok(cause instanceof ApiError);assert.equal(cause.code,'github_rate_limited');assert.match(cause.message,/GitHub 暫時限制查詢/);assert.doesNotMatch(cause.message,/服務暫時無法回應|Issue|untrusted/);assert.equal(cause.detail,undefined);return true;
  });
});

for(const status of [502,503,504,520,521,522,523,524]){
  test(`portal client reports HTTP ${status} in Chinese for both HTML and JSON upstream errors`,async t=>{
    for(const json of [false,true]){
      const raw='Cloudflare Error: origin connection timed out';
      const fetcher=t.mock.method(globalThis,'fetch',async()=>json?Response.json({title:raw,detail:'<html>proxy diagnostics</html>',code:'conflict'},{status}):new Response(`<html><title>${raw}</title></html>`,{status,headers:{'content-type':'text/html'}}));
      const client=new PortalClient();client.csrfToken='synthetic-csrf';
      await assert.rejects(client.post('/me/onboarding/answers',{occupation:'私人草稿'},{idempotencyKey:'exact-key',ifMatch:2}),(cause:unknown)=>{
        assert.ok(cause instanceof ApiError);assert.equal(cause.status,status);assert.equal(cause.network,true);assert.match(cause.message,/服務暫時無法回應/);assert.match(cause.message,/尚未確認結果/);assert.doesNotMatch(cause.message,/Cloudflare|html|origin/);assert.equal(cause.title,undefined);assert.equal(cause.detail,undefined);assert.equal(cause.conflict,false);return true;
      });
      assert.equal(fetcher.mock.callCount(),1,'no automatic POST retry');
      await assert.rejects(client.get('/members'),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.status,status);assert.equal(cause.network,false);assert.equal(cause.message,`服務暫時無法回應（${status}）。請稍後重試。`);return true;});
      assert.equal(fetcher.mock.callCount(),2);fetcher.mock.restore();
    }
  });
}

test('client timeout bounds pending response headers and aborts without an automatic retry',async t=>{
  let signal:AbortSignal|null|undefined;
  const fetcher=t.mock.method(globalThis,'fetch',async(_input:unknown,options?:RequestInit)=>{signal=options?.signal;return new Promise<Response>(()=>{});});
  const client=new PortalClient({timeoutMs:25});client.csrfToken='synthetic';
  await assert.rejects(client.post('/me/onboarding/answers',{}),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.timedOut,true);assert.equal(cause.network,true);assert.equal(cause.status,0);return true;});
  assert.equal(signal?.aborted,true);assert.equal(fetcher.mock.callCount(),1);
});

test('client timeout also bounds an unfinished body after headers were received',async t=>{
  const fetcher=t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"draft":'));}}),{status:200,headers:{'content-type':'application/json'}}));
  const client=new PortalClient({timeoutMs:25});client.csrfToken='synthetic';
  await assert.rejects(client.post('/me/onboarding/answers',{}),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.timedOut,true);assert.equal(cause.status,200);assert.equal(cause.network,true);return true;});
  assert.equal(fetcher.mock.callCount(),1);
});

test('malformed successful responses remain unknown but known business conflicts preserve their status',async t=>{
  const responses=[new Response('<html>invalid success</html>',{status:200}),Response.json({title:'版本已變更',detail:'請重新讀取',code:'conflict'},{status:412}),Response.json({title:{unexpected:true},detail:['invalid']},{status:400}),new Response(null,{status:204})];
  t.mock.method(globalThis,'fetch',async()=>responses.shift()!);
  const client=new PortalClient();client.csrfToken='synthetic';
  await assert.rejects(client.post('/example',{}),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.network,true);assert.equal(cause.status,200);assert.doesNotMatch(cause.message,/html/);return true;});
  await assert.rejects(client.post('/example',{}),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.conflict,true);assert.equal(cause.network,false);assert.equal(cause.status,412);assert.match(cause.message,/版本已變更/);return true;});
  await assert.rejects(client.post('/example',{}),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.status,400);assert.match(cause.message,/請求未完成/);return true;});
  assert.equal(await client.post('/example',{}),null);
});

test('machine-code problem titles are hidden from members while ApiError keeps the code for recovery',async t=>{
  const responses=[
    Response.json({type:'about:blank',title:'skill_maintainer_required',detail:'此操作限目前 AI 公會的技能書維護者。',code:'skill_maintainer_required'},{status:403}),
    Response.json({title:'guild_membership_missing',detail:'請先加入公會。',code:'forbidden'},{status:403}),
    Response.json({title:'skill_maintainer_required',code:'skill_maintainer_required'},{status:403}),
    Response.json({title:'invalid_payload'},{status:422}),
    Response.json({title:'版本已變更',detail:'版本已變更',code:'conflict'},{status:409}),
    Response.json({title:'版本已變更',detail:'請重新讀取後再送出。',code:'conflict'},{status:412}),
    Response.json({title:'internal_error',detail:'stack trace at db.query',code:'internal_error'},{status:500}),
  ];
  t.mock.method(globalThis,'fetch',async()=>responses.shift()!);
  const client=new PortalClient();client.csrfToken='synthetic';
  const reject=async()=>{try{await client.post('/example',{});}catch(cause){assert.ok(cause instanceof ApiError);return cause;}assert.fail('expected rejection');};
  let cause=await reject();
  assert.equal(cause.message,'此操作限目前 AI 公會的技能書維護者。');assert.equal(cause.code,'skill_maintainer_required');assert.equal(cause.title,'skill_maintainer_required');assert.equal(cause.type,'about:blank');assert.equal(cause.status,403);
  cause=await reject();
  assert.equal(cause.message,'請先加入公會。');assert.equal(cause.code,'forbidden');
  cause=await reject();
  assert.equal(cause.message,'目前無法執行此操作，請重新確認登入狀態。');assert.equal(cause.code,'skill_maintainer_required');
  cause=await reject();
  assert.equal(cause.message,'請求未完成（422），請稍後重試。');
  cause=await reject();
  assert.equal(cause.message,'版本已變更');assert.equal(cause.conflict,true);
  cause=await reject();
  assert.equal(cause.message,'版本已變更：請重新讀取後再送出。');
  cause=await reject();
  assert.equal(cause.message,'服務暫時無法回應（500）。尚未確認結果，請稍後重試。');assert.equal(cause.code,undefined);assert.equal(cause.detail,undefined);assert.equal(cause.network,true);
});

test('known GitHub publish failures keep the problem code and are reported instead of network_error',async t=>{
  let reported='';
  const seen=new Promise<void>(resolve=>{
    t.mock.method(globalThis,'fetch',async(input:unknown,init?:RequestInit)=>{
      const url=String(input);
      if(url.includes('/me/client-errors')){reported=String(init?.body??'');resolve();return Response.json({recorded:true},{status:201});}
      return Response.json({code:'github_rate_limited',detail:'untrusted upstream detail'},{status:503,headers:{'retry-after':'30'}});
    });
  });
  const previous=(globalThis as {window?:unknown}).window;
  (globalThis as {window?:unknown}).window=globalThis;
  try{
    const client=new PortalClient();client.csrfToken='synthetic-csrf';
    await assert.rejects(client.post('/me/skill-submissions/11111111-1111-4111-8111-111111111111/publish',{consent_to_share:true}),(cause:unknown)=>{
      assert.ok(cause instanceof ApiError);
      assert.equal(cause.code,'github_rate_limited');
      assert.equal(cause.network,false);
      assert.equal(cause.detail,undefined);
      assert.match(cause.message,/草稿已保留/);
      assert.match(cause.message,/發佈/);
      assert.match(cause.message,/30/);
      assert.doesNotMatch(cause.message,/untrusted|服務暫時無法回應/);
      return true;
    });
    await seen;
  }finally{(globalThis as {window?:unknown}).window=previous;}
  const body=JSON.parse(reported) as {error_code:string;action:string};
  assert.equal(body.error_code,'github_rate_limited');
  assert.match(body.action,/POST \/me\/skill-submissions\/:id\/publish/);
  assert.equal(reported.includes('network_error'),false);
});

test('malformed 401 responses still clear the current session and preserve unauthorized status',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('<html>expired session</html>',{status:401}));
  const client=new PortalClient();client.csrfToken='synthetic';let expired=0;client.onUnauthorized=()=>{expired++;};
  await assert.rejects(client.get('/session'),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.unauthorized,true);assert.equal(cause.status,401);assert.equal(cause.network,false);return true;});
  assert.equal(client.csrfToken,null);assert.equal(expired,1);
});

for (const accessExpired of [false, true]) {
  test(`a delayed ${accessExpired ? 'Access denial' : 'member 401'} cannot sign out a newer session`, async t => {
    let respond!: (response: Response) => void;
    t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
    const client = new PortalClient(); client.csrfToken = 'old-session';
    let expired = 0; client.onUnauthorized = () => { expired++; };
    const pending = client.get('/me/notifications');
    client.csrfToken = 'new-session';
    respond(accessExpired
      ? new Response('<html>Access expired</html>', { status: 403, headers: { 'content-type': 'text/html' } })
      : Response.json({ code: 'unauthorized' }, { status: 401 }));
    await assert.rejects(pending, ApiError);
    assert.equal(client.csrfToken, 'new-session');
    assert.equal(client.accessExpired, false);
    assert.equal(expired, 0);
  });
}

test('an expired request cannot later invalidate the session after its deadline', async t => {
  let respond!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  const client = new PortalClient({ timeoutMs: 25 }); client.csrfToken = 'current-session';
  let expired = 0; client.onUnauthorized = () => { expired++; };
  await assert.rejects(client.get('/me/notifications'), (cause: unknown) => cause instanceof ApiError && cause.timedOut);
  respond(Response.json({ code: 'unauthorized' }, { status: 401 }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(client.csrfToken, 'current-session');
  assert.equal(expired, 0);
});

test('a delayed successful response from an old session cannot clear the current Access expiry', async t => {
  let respond!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  const client = new PortalClient(); client.csrfToken = 'old-session';
  const pending = client.get('/me/notifications');
  client.csrfToken = 'new-session'; client.accessExpired = true;
  respond(Response.json({ items: [] }));
  await pending;
  assert.equal(client.accessExpired, true);
});

test('upstream errors expose only a sanitized Cloudflare request identifier',async t=>{
  for(const [ray,expected] of [['8c1234567890abcd-TPE','8c1234567890abcd-TPE'],['<html>unexpected header</html>',undefined]]){
    const fetcher=t.mock.method(globalThis,'fetch',async()=>new Response('<html>origin failed</html>',{status:522,headers:{'cf-ray':ray!,'x-freedom-request-id':expected?'d58b4bd0-43bb-4736-992e-c2b21bf5f68a':'not-an-id'}}));
    const client=new PortalClient();client.csrfToken='synthetic';
    await assert.rejects(client.post('/example',{}),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.cfRay,expected);assert.equal(cause.requestId,expected?'d58b4bd0-43bb-4736-992e-c2b21bf5f68a':undefined);return true;});fetcher.mock.restore();
  }
});

test('portal client preserves signed bigint string CAS and stable keys across member-initiated replay', async t => {
  const requests: { version: string | null; key: string | null; body: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ version: headers.get('If-Match'), key: headers.get('Idempotency-Key'), body: String(init?.body) });
    return requests.length === 1 ? Response.json({ code: 'internal_error' }, { status: 503 }) : Response.json({ aggregateVersion: '9223372036854775807' });
  });
  const client = new PortalClient(); client.csrfToken = 'synthetic';
  const options = { idempotencyKey: 'same-member-request', ifMatch: '9223372036854775807', suppressConsole: true };
  await assert.rejects(client.post('/me/model-steps/11111111-1111-4111-8111-111111111111:execute', {}, options), ApiError);
  assert.equal(requests.length, 1, 'an uncertain response never retries automatically');
  await client.post('/me/model-steps/11111111-1111-4111-8111-111111111111:execute', {}, options);
  assert.deepEqual(requests, [
    { version: '"9223372036854775807"', key: 'same-member-request', body: '{}' },
    { version: '"9223372036854775807"', key: 'same-member-request', body: '{}' },
  ]);
});
