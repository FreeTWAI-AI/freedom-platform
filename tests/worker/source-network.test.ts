import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {cloudflareSourceNetwork,cloudflareRateLimitNetwork} from '../../apps/platform-api/src/worker.js';

function request(address:string,cf=true) {
  const req=new Request('https://example.invalid/',{headers:{'CF-Connecting-IP':address}});
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
