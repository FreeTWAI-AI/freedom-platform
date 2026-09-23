import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';

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

test('malformed 401 responses still clear the current session and preserve unauthorized status',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('<html>expired session</html>',{status:401}));
  const client=new PortalClient();client.csrfToken='synthetic';let expired=0;client.onUnauthorized=()=>{expired++;};
  await assert.rejects(client.get('/session'),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.unauthorized,true);assert.equal(cause.status,401);assert.equal(cause.network,false);return true;});
  assert.equal(client.csrfToken,null);assert.equal(expired,1);
});

test('upstream errors expose only a sanitized Cloudflare request identifier',async t=>{
  for(const [ray,expected] of [['8c1234567890abcd-TPE','8c1234567890abcd-TPE'],['<html>unexpected header</html>',undefined]]){
    const fetcher=t.mock.method(globalThis,'fetch',async()=>new Response('<html>origin failed</html>',{status:522,headers:{'cf-ray':ray!,'x-freedom-request-id':expected?'d58b4bd0-43bb-4736-992e-c2b21bf5f68a':'not-an-id'}}));
    const client=new PortalClient();client.csrfToken='synthetic';
    await assert.rejects(client.post('/example',{}),(cause:unknown)=>{assert.ok(cause instanceof ApiError);assert.equal(cause.cfRay,expected);assert.equal(cause.requestId,expected?'d58b4bd0-43bb-4736-992e-c2b21bf5f68a':undefined);return true;});fetcher.mock.restore();
  }
});
