import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { HTTPRangeError, planObjectHttpRequest } from '../../packages/asset-storage/http-range.js';
import { eventVideoResponse } from '../../apps/platform-api/src/routes/community-events.js';

const base={method:'GET' as const,byteSize:100,contentType:'video/mp4',etag:'immutable-1'};
test('HTTP media single ranges preserve exact closed/open/suffix boundaries and immutable headers',()=>{
  for(const [header,offset,length] of [['bytes=0-0',0,1],['bytes=10-19',10,10],['bytes=90-',90,10],
    ['bytes=-10',90,10],['bytes=-100',0,100],['bytes=99-999999999999999999999',99,1],['BYTES=00001-00009',1,9]] as const){
    const result=planObjectHttpRequest({...base,rangeHeader:header});
    assert.equal(result.status,206);assert.deepEqual(result.range,{offset,length});assert.equal(result.sendBody,true);
    assert.equal(result.headers['content-range'],`bytes ${offset}-${offset+length-1}/100`);
    assert.equal(result.headers['content-length'],String(length));assert.equal(result.headers.etag,'"immutable-1"');
    assert(Object.isFrozen(result)&&Object.isFrozen(result.headers)&&Object.isFrozen(result.range));
  }
});
test('HTTP media unsatisfiable ranges have zero body and size-only416; malformed/multiple requests use full200',()=>{
  for(const rangeHeader of ['bytes=-0','bytes=100-','bytes=100-150','bytes=12-11','bytes=99999999999999999999-']){
    const result=planObjectHttpRequest({...base,rangeHeader});assert.equal(result.status,416);assert.equal(result.sendBody,false);
    assert.equal(result.headers['content-range'],'bytes */100');assert.equal(result.headers['content-length'],'0');
  }
  for(const rangeHeader of ['items=0-1','bytes=0-1,3-4','bytes=100-wrong','bytes=+2-','bytes=--2','bytes=',`bytes=${'0'.repeat(5000)}1-`]){
    const result=planObjectHttpRequest({...base,rangeHeader});assert.equal(result.status,200);assert.equal(result.range,undefined);
    assert.equal(result.headers['content-length'],'100');assert.equal(result.headers['content-range'],undefined);
  }
});
test('HTTP media If-Range uses only the current strong ETag; HEAD ignores range and never sends body',()=>{
  for(const ifRangeHeader of ['"other"','W/"immutable-1"','Wed, 01 Jan 2025 00:00:00 GMT',''])
    assert.equal(planObjectHttpRequest({...base,rangeHeader:'bytes=0-9',ifRangeHeader}).status,200);
  assert.equal(planObjectHttpRequest({...base,rangeHeader:'bytes=0-9',ifRangeHeader:'"immutable-1"'}).status,206);
  const head=planObjectHttpRequest({...base,method:'HEAD',rangeHeader:'bytes=999-',ifRangeHeader:'"immutable-1"'});
  assert.equal(head.status,200);assert.equal(head.sendBody,false);assert.equal(head.headers['content-length'],'100');
});
test('HTTP media invalid trusted metadata cannot create injection or unbounded output',()=>{
  for(const patch of [{byteSize:0},{byteSize:20*1024*1024+1},{byteSize:1.5},{contentType:'video/quicktime'},
    {etag:'RAW_PRIVATE\r\nInjected: true'},{method:'POST'},{etag:4},{rangeHeader:4}]){
    assert.throws(()=>planObjectHttpRequest({...base,...patch} as typeof base),error=>error instanceof HTTPRangeError&&error.message==='HTTP_RANGE_INPUT');
  }
});
test('Canonical event-video HTTP response uses suffix/If-Range/HEAD and preserves member/public cache boundaries',async()=>{
  const bytes=Buffer.from('abcdefghijklmnop');const app=new Hono();
  // The response helper takes already authorized bytes, never authorizes them.
  app.use('*',async(c,next)=>{if(c.req.header('X-Synthetic-Authorized')!=='yes')return c.body(null,404);await next();});
  app.get('/member',c=>eventVideoResponse(c,{bytes,mime:'video/mp4'}));
  app.get('/public',c=>eventVideoResponse(c,{bytes,mime:'video/mp4'},true));
  const request=(path:string,headers:Record<string,string>={},method='GET')=>app.request(path,{method,headers:{'X-Synthetic-Authorized':'yes',...headers}});
  const partial=await request('/member',{Range:'bytes=-4'});assert.equal(partial.status,206);assert.equal(await partial.text(),'mnop');
  assert.equal(partial.headers.get('content-range'),'bytes 12-15/16');assert.equal(partial.headers.get('cache-control'),'private, no-store');
  const match=await request('/member',{Range:'bytes=1-3','If-Range':partial.headers.get('etag')!});assert.equal(match.status,206);assert.equal(await match.text(),'bcd');
  const mismatch=await request('/member',{Range:'bytes=1-3','If-Range':'"old"'});assert.equal(mismatch.status,200);assert.equal(await mismatch.text(),bytes.toString());
  const head=await request('/member',{Range:'bytes=-4'},'HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-length'),'16');
  assert.equal((await request('/public')).headers.get('cache-control'),'public, max-age=300');
  assert.equal((await app.request('/member',{headers:{Range:'bytes=1-2'}})).status,404);
});
