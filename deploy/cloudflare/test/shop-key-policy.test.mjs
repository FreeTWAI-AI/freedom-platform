import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {checkWranglerConfig,parseJsonc} from '../lib/wrangler.mjs';
import {loadManifest} from '../lib/manifest.mjs';
const manifest=loadManifest(),candidate=parseJsonc(readFileSync(resolve('wrangler.jsonc'),'utf8'));
function check(policy){
 const directory=mkdtempSync(join(tmpdir(),'fp-shop-static-'));
 try{const config=structuredClone(candidate);for(const block of Object.values(config.env)){
  delete block.vars.FREEDOM_SHOP_KEY_POLICY;
  if(policy!==undefined)block.vars.FREEDOM_SHOP_KEY_POLICY=policy;
 }
 const path=join(directory,'candidate.json');writeFileSync(path,JSON.stringify(config));return checkWranglerConfig(path,manifest);
 }finally{rmSync(directory,{recursive:true,force:true});}
}
test('shop upgrade requires explicit policy injection; missing config is not deployment-ready',()=>{
 const report=check();assert.equal(report.structural,'valid');assert.equal(report.deployment_ready,false);
 assert.equal(report.required_injections.filter(x=>x.includes('FREEDOM_SHOP_KEY_POLICY')).length,2);
});
test('both reviewed transition choices pass static shape without proving installed policy',()=>{
 for(const policy of ['legacy-compatible','purpose-bound-only']){
  const report=check(policy);assert.equal(report.structural,'valid');assert.equal(report.deployment_ready,false);
  assert.equal(report.required_injections.filter(x=>x.includes('FREEDOM_SHOP_KEY_POLICY')).length,0);
 }
 assert.equal(check('implicit').structural,'invalid');
});
