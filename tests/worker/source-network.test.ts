import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import {cloudflareSourceNetwork,cloudflareRateLimitNetwork,workerRuntime,type WorkerEnv} from '../../apps/platform-api/src/worker.js';
import {createPlatformApp} from '../../apps/platform-api/src/platform-app.js';
import {registerPublicPromotion} from '../../apps/platform-api/src/routes/promotion.js';
import type {PlatformRuntime} from '../../apps/platform-api/src/runtime.js';
import type {PlatformEnv} from '../../apps/platform-api/src/module-context.js';
import {tokenHash} from '../../modules/identity-membership/service.js';

function request(address:string,cf=true,path='/') {
  const req=new Request(`https://example.invalid${path}`,{method:path==='/'?'GET':'POST',headers:{'CF-Connecting-IP':address,'User-Agent':'Mozilla/5.0 OrdinaryBrowser/1.0','Content-Type':'application/json'},...(path==='/'?{}:{body:JSON.stringify({code:'abcdefghij'})})});
  if(cf)Object.defineProperty(req,'cf',{value:{colo:'TEST'}});
  return req;
}
test('Worker keeps full source identities while grouping only IPv6 budgets',async()=>{
  const app=new Hono(),source=cloudflareSourceNetwork(true),budget=cloudflareRateLimitNetwork(true);
  app.get('/',c=>c.json({source:source(c),budget:budget(c)}));
  for(const [address,key] of [
    ['2001:db8::1','2001:db8:0:0::/64'],['2001:db8::2','2001:db8:0:0::/64'],
    ['2001:db8:0:1::1','2001:db8:0:1::/64'],['::ffff:192.0.2.10','192.0.2.10'],
    ['::FFFF:c000:20a','192.0.2.10'],['192.0.2.10','192.0.2.10'],
  ])assert.deepEqual(await (await app.fetch(request(address))).json(),{source:address,budget:key});
});
test('both Worker ports keep the shared fallback for missing trust, edge metadata or valid IP',async()=>{
  for(const trust of [false,true]){
    const app=new Hono(),source=cloudflareSourceNetwork(trust),budget=cloudflareRateLimitNetwork(trust);
    app.get('/',c=>c.json({source:source(c),budget:budget(c)}));
    for(const [address,cf] of [['2001:db8::1',false],['not-an-ip',true],['',true],...(!trust?[['2001:db8::1',true]]:[])] as [string,boolean][])
      assert.deepEqual(await (await app.fetch(request(address,cf))).json(),{source:'shared-server',budget:'shared-server'});
  }
});

// Query-recording storage checks real route/scoring behavior, not PostgreSQL locking.
function fixture(grouped:boolean){
  const rows:unknown[][]=[],buckets:string[]=[];
  const q={async query(sql:string,args:unknown[]=[]):Promise<{rows:any[];rowCount:number}>{
    if(sql.includes('FROM promotion_links'))return {rows:[{link_id:'link',community_id:'community',user_id:'owner',kind:'platform',target_key:'workshop',code:'abcdefghij',revoked_at:null,owner_active:true}],rowCount:1};
    if(sql.startsWith('SELECT salt'))return {rows:[{salt:Buffer.alloc(32,1)}],rowCount:1};
    if(sql.startsWith('INSERT INTO auth_rate_limits'))buckets.push(args[0] as string);
    if(sql.startsWith('SELECT * FROM auth_rate_limits'))return {rows:[{attempts:0,window_start:new Date()}],rowCount:1};
    if(sql.startsWith('SELECT count'))return {rows:[{n:rows.filter(r=>r[1]===args[0]&&r[sql.includes('visitor_key')?2:3]===args[1]).length}],rowCount:1};
    if(sql.startsWith('INSERT INTO promotion_clicks(')&&!rows.some(r=>r[0]===args[0]&&r[1]===args[1]&&r[2]===args[2]))rows.push(args);
    return {rows:[],rowCount:0};
  },release(){}};
  const pool={query:q.query,connect:async()=>q} as unknown as Pool;
  const runtime={sourceNetwork:cloudflareSourceNetwork(true),...(grouped?{rateLimitNetwork:cloudflareRateLimitNetwork(true)}:{}),now:()=>new Date('2026-10-08T00:00:00Z')} as PlatformRuntime;
  const app=new Hono<PlatformEnv>();registerPublicPromotion(app,pool,runtime,'https://example.invalid');
  return {app,rows,buckets,pool};
}
test('two IPv6 guests share an hourly budget but retain separate promotion credits',async()=>{
  const f=fixture(true);
  for(const address of ['2001:db8::1','2001:db8::2','2001:db8::1']){
    const response=await f.app.fetch(request(address,true,'/api/v1/promotion/clicks'));
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
  }
  assert.equal(f.rows.length,2,'same browser on distinct addresses remains two visitors; exact repeat remains one');
  assert.notEqual(f.rows[0][2],f.rows[1][2]);assert.notEqual(f.rows[0][3],f.rows[1][3]);
  assert.deepEqual(f.buckets,Array(3).fill(tokenHash('promotion-click-network/2001:db8:0:0::/64')));
});
test('adapters without the optional budget port preserve existing source-address limits',async()=>{
  const f=fixture(false);
  for(const address of ['2001:db8::1','2001:db8::2'])assert.equal((await f.app.fetch(request(address,true,'/api/v1/promotion/clicks'))).status,200);
  assert.equal(f.rows.length,2);
  assert.deepEqual(f.buckets,['2001:db8::1','2001:db8::2'].map(address=>tokenHash(`promotion-click-network/${address}`)));
});
test('Worker login uses the grouped source budget and leaves the global budget unchanged',async()=>{
  const f=fixture(true),origin='https://example.invalid';
  const runtime=workerRuntime({} as WorkerEnv,{freedomEnv:'staging',origin,release:'a'.repeat(40),trustConnectingIp:true});
  const app=createPlatformApp(f.pool,origin,'staging',runtime);
  for(const address of ['2001:db8::1','2001:db8::2']){
    const req=new Request(`${origin}/api/v1/auth/login`,{method:'POST',headers:{Origin:origin,'CF-Connecting-IP':address,'Content-Type':'application/json'},body:'{}'});
    Object.defineProperty(req,'cf',{value:{colo:'TEST'}});
    // Invalid form ends after the two budget charges, before password or account I/O.
    assert.equal((await app.fetch(req)).status,422);
  }
  assert.deepEqual(f.buckets,Array(2).fill([tokenHash('login-network/2001:db8:0:0::/64'),tokenHash('login-global/global')]).flat());
});
