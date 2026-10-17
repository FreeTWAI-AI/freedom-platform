import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';
import { Hono } from 'hono';
import { Problem } from '../../packages/shared/problem.js';

const origin = 'http://127.0.0.1:4310';
const app = createApp(new Pool(), origin);

function request(body: BodyInit, extra: Record<string, string> = {}) {
  return app.request(new Request(origin + '/api/v1/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra },
    body, duplex: 'half',
  } as RequestInit));
}

test('JSON media type tokens ignore case and permit SP or HTAB before parameters without bypassing body guards',async()=>{
  for(const contentType of ['Application/JSON','APPLICATION/JSON; charset=UTF-8','application/json ; charset=UTF-8','application/Json\t;\tcharset="UTF-8"']){
    const send=(body:BodyInit)=>app.request(new Request(origin+'/api/v1/auth/logout',{
      method:'POST',headers:{Origin:origin,'Content-Type':contentType},body,
    }));
    for(const [body,status,code] of [
      ['{}',401,'login_required'],['{',400,'invalid_json'],['"\\u0000"',422,'validation_failed'],['"\\ud800"',422,'validation_failed'],[' '.repeat(32769),413,'body_too_large'],
    ] as const){
      const response=await send(body);
      assert.equal(response.status,status,contentType);
      assert.equal((await response.json()).code,code,contentType);
    }
    const invalidUtf8=await send(Uint8Array.of(0x22,0xc3,0x28,0x22));
    assert.equal(invalidUtf8.status,400);assert.equal((await invalidUtf8.json()).code,'invalid_json');
  }
});

test('JSON media type recognition rejects prefix lookalikes, other types and non-HTTP whitespace',async()=>{
  for(const contentType of ['application/jsonp','application/json-seq','application/problem+json','text/plain','text/json','application/json\u00a0; charset=UTF-8']){
    const response=await request('{}',{'Content-Type':contentType});
    assert.equal(response.status,415,contentType);assert.equal((await response.json()).code,'json_required');
  }
});

test('oversized JSON without Content-Length is cancelled before draining the source', async () => {
  let pulled = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === 8) { controller.close(); return; }
      pulled++; controller.enqueue(new Uint8Array(8192).fill(32));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await request(body);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'body_too_large');
  assert.ok(pulled < 8, 'the remainder of the hostile stream must not be read');
  assert.equal(cancelled, true);
});

test('the byte boundary applies to streamed JSON including multi-byte UTF-8', async () => {
  for (const [size, expected] of [[32768, 400], [32769, 413]] as const) {
    // An incomplete JSON document distinguishes parser rejection from size rejection.
    const bytes = new TextEncoder().encode(' '.repeat(size - 4) + '"貓');
    assert.equal(bytes.byteLength, size);
    const response = await request(new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    }));
    assert.equal(response.status, expected);
    assert.equal((await response.json()).code, expected === 400 ? 'invalid_json' : 'body_too_large');
  }
});

test('declared oversized JSON is rejected without pulling its source', async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { pulled++; } }, { highWaterMark: 0 });
  const response = await request(body, { 'Content-Length': '32769' });
  assert.equal(response.status, 413);
  assert.equal(pulled, 0);
});

test('commerce preview accepts the 24,000-byte content string at its worst JSON escape expansion',async()=>{
  const body=JSON.stringify({content:'\u0001'.repeat(24000)});
  assert.equal(Buffer.byteLength(body),144014);
  for(const declared of [false,true]){
    const response=await app.request(origin+'/api/v1/commerce/preview',{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(declared?{'Content-Length':String(Buffer.byteLength(body))}:{})},
      body:new ReadableStream<Uint8Array>({start(controller){
        const bytes=new TextEncoder().encode(body);
        controller.enqueue(bytes.subarray(0,32768));controller.enqueue(bytes.subarray(32768));controller.close();
      }}),duplex:'half',
    } as RequestInit);
    assert.equal(response.status,401);
    assert.equal((await response.json()).code,'login_required');
  }
  const response=await app.request(origin+'/api/v1/commerce/preview',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:body+' ',
  });
  assert.equal(response.status,413);
  assert.equal((await response.json()).code,'body_too_large');
});

test('commerce preview rejects declared and streamed overflow without draining the source',async()=>{
  for(const declared of [false,true]){
    let pulled=0,cancelled=false;
    const response=await app.request(origin+'/api/v1/commerce/preview',{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(declared?{'Content-Length':'144015'}:{})},
      body:new ReadableStream<Uint8Array>({
        pull(controller){
          pulled++;
          controller.enqueue(new Uint8Array(8192).fill(32));
          if(pulled===32)controller.close();
        },
        cancel(){cancelled=true;},
      },{highWaterMark:0}),duplex:'half',
    } as RequestInit);
    assert.equal(response.status,413);
    assert.equal((await response.json()).code,'body_too_large');
    if(declared)assert.equal(pulled,0);
    else{assert.ok(pulled<32);assert.equal(cancelled,true);}
  }
});

test('the larger content envelope does not extend to other methods or neighboring commerce routes',async()=>{
  for(const [method,path] of [['PATCH','/api/v1/commerce/preview'],['POST','/api/v1/commerce/preview/extra'],['POST','/api/v1/commerce/import'],['POST','/api/v1/auth/logout']]){
    const response=await app.request(origin+path,{
      method,headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({content:'x'.repeat(32768)}),
    });
    assert.equal(response.status,413,`${method} ${path}`);
    assert.equal((await response.json()).code,'body_too_large');
  }
});

test('decoded JSON NUL keys and values fail before authentication, but escaped literal text and ordinary Unicode do not', async () => {
  for (const body of ['\0', {nested: ['safe', {text: 'a\0b'}]}, {nested: [{'bad\0key': null}]}]) {
    const response = await app.request(origin + '/api/v1/auth/logout', {
      method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'validation_failed');
  }
  for (const body of [{text: '\\u0000'}, {text: '繁中😀\n下一行'}, {nested: [null, false, 0]}]) {
    const response = await app.request(origin + '/api/v1/auth/logout', {
      method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    assert.equal(response.status, 401);
  }
  const malformed = await request('{"text":"\\u0000",');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'invalid_json');
});

test('malformed UTF-8 in JSON values and keys is rejected before authentication instead of replaced',async()=>{
  const encoder=new TextEncoder();
  for(const bad of [[0xc0,0xaf],[0xed,0xa0,0x80],[0xe2,0x82],[0x80]]) {
    for(const json of ['"MARK"','{"MARK":true}','{"nested":[{"text":"MARK"}]}']) {
      const at=json.indexOf('MARK'),prefix=encoder.encode(json.slice(0,at)),suffix=encoder.encode(json.slice(at+4));
      const bytes=new Uint8Array(prefix.length+bad.length+suffix.length);
      bytes.set(prefix);bytes.set(bad,prefix.length);bytes.set(suffix,prefix.length+bad.length);
      const response=await app.request(origin+'/api/v1/auth/logout',{
        method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:bytes,
      });
      assert.equal(response.status,400);assert.equal((await response.json()).code,'invalid_json');
    }
  }
});

test('valid UTF-8 split across chunks retains scalars and the exact JSON byte ceiling',async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify({text:'繁中😀�'}));
  for(const size of [32768,32769]) {
    const body=new ReadableStream<Uint8Array>({start(controller){
      for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));
      controller.enqueue(new Uint8Array(size-bytes.length).fill(32));controller.close();
    }});
    const response=await app.request(origin+'/api/v1/auth/logout',{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body,duplex:'half',
    } as RequestInit);
    assert.equal(response.status,size===32768?401:413);
    assert.equal((await response.json()).code,size===32768?'login_required':'body_too_large');
  }
});

test('decoded unpaired surrogates in JSON values and keys are rejected without rejecting scalar pairs or literal escapes',async()=>{
  for(const invalid of ['\uD800','\uDC00','\uD800x\uDC00']) {
    for(const body of [invalid,{nested:['safe',{text:invalid}]},{nested:[{['key'+invalid]:null}]}]) {
      const response=await app.request(origin+'/api/v1/auth/logout',{
        method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body),
      });
      assert.equal(response.status,422);assert.equal((await response.json()).code,'validation_failed');
    }
  }
  for(const body of ['繁中😀\uD800\uDC00\uDBFF\uDFFF\n下一行',{nested:['\\ud800\\udc00',{['鍵😀']:true}]},null,false,0]) {
    const response=await app.request(origin+'/api/v1/auth/logout',{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body),
    });
    assert.equal(response.status,401);assert.equal((await response.json()).code,'login_required');
  }
  const malformed=await request('{"text":"\\ud800",');
  assert.equal(malformed.status,400);assert.equal((await malformed.json()).code,'invalid_json');
});

test('bounded deeply nested JSON validates scalar strings without consuming the call stack',async()=>{
  for(const [value,status] of [['"\\ud800"',422],['"\\ud83d\\ude00"',401]] as const) {
    const response=await app.request(origin+'/api/v1/auth/logout',{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
      body:'['.repeat(12000)+value+']'.repeat(12000),
    });
    assert.equal(response.status,status);
    assert.equal((await response.json()).code,status===422?'validation_failed':'login_required');
  }
});

test('slow requests log once at the threshold using nested route patterns, without request content', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args); });
  const local = createApp(new Pool(), origin), child = new Hono(), nested = new Hono();
  nested.post('/items/:id', c => { now = 1000; return c.json({ ok: true }); });
  child.route('/nested', nested); local.route('/observability', child);
  // Worker mounts its wildcard static-asset middleware after platform routes.
  local.use('/*', async (_c, next) => { await next(); });
  const id = 'ebaf4467-a54c-4cbb-866c-179db5a19123';
  const response = await local.request(origin + '/observability/nested/items/' + id + '?private=private-query', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: 'private-cookie=private-value', Authorization: 'Bearer private-token' },
    body: JSON.stringify({ user_id: id, email: 'private@example.invalid' }),
  });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  assert.equal(logs.length, 1); assert.equal(logs[0].length, 1);
  assert.deepEqual(JSON.parse(String(logs[0][0])), { event: 'slow_request', method: 'POST', route: '/observability/nested/items/:id', status: 200, duration_ms: 1000 });
  assert.doesNotMatch(String(logs[0][0]), /ebaf4467|private|email|user_id|Bearer/);
});

test('handled errors retain the existing response and request_failed log, with one server_error entry', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const logs: unknown[][] = [], errors: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const local = createApp(new Pool(), origin), child = new Hono();
  child.get('/items/:id', () => { now = 1500; throw new Error('private database error'); });
  local.route('/observability', child);
  local.use('/*', async (_c, next) => { await next(); });
  const response = await local.request(origin + '/observability/items/ebaf4467-a54c-4cbb-866c-179db5a19123?private=secret');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { type: 'about:blank', title: 'Internal error', status: 500, code: 'internal_error', detail: '操作未完成，請重新整理並查看目前狀態。' });
  assert.deepEqual(errors, [['request_failed', 'Error']]);
  assert.deepEqual(logs, [[JSON.stringify({ event: 'server_error', method: 'GET', route: '/observability/items/:id', status: 500, duration_ms: 1500 })]]);
});

test('fast success, unmatched 404, explicit 4xx and Problem 4xx remain quiet', async t => {
  t.mock.method(performance, 'now', () => 0);
  const logs: unknown[][] = [];
  for (const method of ['warn', 'log', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  const local = createApp(new Pool(), origin);
  local.get('/observability/explicit', c => c.json({ code: 'denied' }, 403));
  local.get('/observability/problem', () => { throw new Problem(409, 'conflict', 'private conflict'); });
  for (const [path, status] of [['/api/v1/health', 200], ['/observability/missing', 404], ['/observability/explicit', 403], ['/observability/problem', 409]] as const) {
    const response = await local.request(origin + path);
    assert.equal(response.status, status);
    if (status === 409) assert.deepEqual(await response.json(), { type: 'about:blank', title: 'conflict', status: 409, code: 'conflict', detail: 'private conflict' });
  }
  assert.deepEqual(logs, []);
});

test('fast explicit 5xx logs and the slow-request boundary excludes 999 ms', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  const local = createApp(new Pool(), origin);
  local.get('/observability/below-threshold', c => { now += 999; return c.json({ ok: true }); });
  local.get('/observability/unavailable', c => c.json({ code: 'unavailable' }, 503));
  assert.equal((await local.request(origin + '/observability/below-threshold')).status, 200);
  assert.deepEqual(logs, []);
  assert.equal((await local.request(origin + '/observability/unavailable')).status, 503);
  assert.deepEqual(logs, [[JSON.stringify({ event: 'server_error', method: 'GET', route: '/observability/unavailable', status: 503, duration_ms: 0 })]]);
});

test('slow unmatched requests use a fixed pattern placeholder rather than the raw path', async t => {
  let calls = 0;
  t.mock.method(performance, 'now', () => calls++ === 0 ? 0 : 1000);
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  const local = createApp(new Pool(), origin);
  assert.equal((await local.request(origin + '/ebaf4467-a54c-4cbb-866c-179db5a19123?private=secret')).status, 404);
  assert.deepEqual(logs, [[JSON.stringify({ event: 'slow_request', method: 'GET', route: 'unmatched', status: 404, duration_ms: 1000 })]]);
});
