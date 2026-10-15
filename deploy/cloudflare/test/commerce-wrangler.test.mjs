import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkCommerceWranglerConfig} from '../lib/commerce-wrangler.mjs';
function check(config,setup) {
  const dir=mkdtempSync(join(tmpdir(),'commerce-wrangler-')),path=join(dir,'wrangler.jsonc');
  try{writeFileSync(path,JSON.stringify(config));return checkCommerceWranglerConfig(setup?.(dir,path)??path);}finally{rmSync(dir,{recursive:true,force:true});}
}
test('commerce declarations default off in every environment',()=>{assert.equal(check({env:{next:{},'staging-next':{vars:{FREEDOM_COMMERCE_QUARANTINE:'false'}}}}).structural,true);});
for(const flag of ['FREEDOM_COMMERCE_CHECKOUT_ENABLED','FREEDOM_COMMERCE_QUARANTINE'])for(const value of [true,false,'TRUE',' true','false ',1,null]) {
  test(`${flag} rejects invalid flag type/value ${JSON.stringify(value)}`,()=>{
    const result=check({env:{next:{vars:{[flag]:value}}}});assert.equal(result.structural,false);assert(result.errors.includes('commerce_flag_invalid'));
  });
}
test('checkout requires launchpad in the same environment, not an inherited declaration',()=>{
  assert.equal(check({vars:{FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true'},env:{next:{vars:{FREEDOM_COMMERCE_CHECKOUT_ENABLED:'true'}}}}).structural,false);
  assert.equal(check({env:{next:{vars:{FREEDOM_COMMERCE_CHECKOUT_ENABLED:'true',FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true'}}}}).structural,true);
});
test('unknown commerce variables and unsafe declarations fail without copying names or values',()=>{
  const secret='synthetic-secret';const result=check({vars:{FREEDOM_COMMERCE_secret:secret}});assert.equal(result.structural,false);assert(!JSON.stringify(result).includes(secret));assert(!JSON.stringify(result).includes('FREEDOM_COMMERCE_secret'));
  for(const config of [null,[],{env:[]},{env:{next:null}},{vars:[]},{vars:null}])assert.equal(check(config).structural,false);
  assert.equal(check({},(dir,path)=>{const link=join(dir,'link');symlinkSync(path,link);return link;}).structural,false);
  assert.equal(check({},(dir,path)=>{linkSync(path,join(dir,'hard'));return path;}).structural,false);
  assert.equal(checkCommerceWranglerConfig('/does-not-exist').structural,false);
});
