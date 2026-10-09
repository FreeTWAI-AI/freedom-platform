import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono, type Context } from 'hono';
import { wireVersionResponses } from '../../apps/platform-api/src/platform-app.js';
import { Problem } from '../../packages/shared/problem.js';
import { Pool } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';

function app(){
  const app=new Hono();
  app.onError((err,c)=>{if(err instanceof Problem)return c.json({type:'about:blank',title:err.code,status:err.status,code:err.code,detail:err.message},err.status as 500);throw err;});
  app.use('*',wireVersionResponses);return app;
}
const value={aggregate_version:'9007199254740991',version:'2',access_synced_version:'3',nested:[{aggregate_version:'0'},[{aggregate_version:' 2 '}]],date:new Date('2026-10-09T00:00:00Z')};
const expected={...value,aggregate_version:9007199254740991,nested:[{aggregate_version:0},[{aggregate_version:2}]],date:'2026-10-09T00:00:00.000Z'};

test('the actual platform health c.json response never re-parses its body',async(t)=>{
  const pool=new Pool({connectionString:'postgresql://freedom_local@127.0.0.1:1/freedom_local'});
  t.after(()=>pool.end());
  t.mock.method(Response.prototype,'json',async()=>{throw new Error('response must not be re-parsed');});
  const response=await createApp(pool).request('http://127.0.0.1:4310/api/v1/health');
  assert.equal(response.status,200);assert.equal(JSON.parse(await response.text()).status,'ok');assert.equal(response.headers.get('cache-control'),'no-store');
});

test('c.json serializes nested versions once, including mounted routes sharing the parent Context',async(t)=>{
  const api=app(),child=new Hono();let parent:Context|undefined,reads=0;
  t.mock.method(Response.prototype,'json',async()=>{reads++;throw new Error('response must not be re-parsed');});
  api.use('*',async(c,next)=>{parent=c;void c.res;await next();c.header('X-After','preserved');});
  child.get('/versions',c=>{assert.equal(c,parent);return c.json(value,201,{ETag:'"7"','X-Route':'preserved'});});
  api.route('/api/v1',child);
  const response=await api.request('/api/v1/versions');
  assert.equal(response.status,201);assert.equal(reads,0);assert.equal(response.headers.get('content-type'),'application/json');assert.equal(response.headers.get('etag'),'"7"');assert.equal(response.headers.get('x-route'),'preserved');assert.equal(response.headers.get('x-after'),'preserved');
  assert.deepEqual(JSON.parse(await response.text()),expected);assert.equal(value.aggregate_version,'9007199254740991');
});

test('c.json supports ResponseInit status and headers without response body reads',async(t)=>{
  const api=app();let reads=0;
  t.mock.method(Response.prototype,'json',async()=>{reads++;throw new Error('response must not be re-parsed');});
  api.get('/client-api/versions',c=>{c.status(202);c.header('X-Prepared','yes');return c.json({aggregate_version:'4'},{status:201,headers:{ETag:'"4"','X-Init':'yes'}});});
  const response=await api.request('/client-api/versions');assert.equal(response.status,201);assert.equal(reads,0);assert.equal(response.headers.get('etag'),'"4"');assert.equal(response.headers.get('x-init'),'yes');assert.equal(response.headers.get('x-prepared'),'yes');assert.equal(response.headers.get('content-type'),'application/json');assert.deepEqual(JSON.parse(await response.text()),{aggregate_version:4});
});

test('manually constructed JSON responses retain the conversion fallback, status and headers',async()=>{
  const api=app();let reads=0;
  api.get('/agent-api/versions',()=>{const response=new Response(JSON.stringify(value),{status:202,headers:{'Content-Type':'application/json; charset=utf-8',ETag:'"7"'}});const json=response.json.bind(response);response.json=()=>{reads++;return json();};return response;});
  const response=await api.request('/agent-api/versions');assert.equal(reads,1);assert.equal(response.status,202);assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');assert.equal(response.headers.get('etag'),'"7"');assert.deepEqual(await response.json(),expected);
});

for(const manual of [false,true])test(`unsafe/negative/invalid string versions retain version_overflow errors (${manual?'fallback':'c.json'})`,async()=>{
  for(const version of ['9007199254740992','-1','1.5','invalid']){
    const api=app();api.get('/admin/api/versions',c=>manual?new Response(JSON.stringify({nested:[{aggregate_version:version}]}),{headers:{'Content-Type':'application/json',ETag:'"overflow"'}}):c.json({nested:[{aggregate_version:version}]},201,{ETag:'"overflow"'}));
    const response=await api.request('/admin/api/versions');assert.equal(response.status,500);assert.equal(response.headers.get('etag'),'"overflow"');assert.deepEqual(await response.json(),{type:'about:blank',title:'version_overflow',status:500,code:'version_overflow',detail:'版本超出此 API 可表示範圍。'});
  }
});

test('non-string versions and responses outside the existing API prefixes are untouched',async()=>{
  const api=app();api.get('/api/versions',c=>c.json({aggregate_version:1,nested:{aggregate_version:null},other:'9007199254740992'}));api.get('/shop-api/versions',c=>c.json(value));
  assert.deepEqual(await(await api.request('/api/versions')).json(),{aggregate_version:1,nested:{aggregate_version:null},other:'9007199254740992'});assert.deepEqual(await(await api.request('/shop-api/versions')).json(),JSON.parse(JSON.stringify(value)));
});
