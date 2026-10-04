import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';
import {subscribeGameConsole} from '../../apps/portal-web/src/game-console-core.js';

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
