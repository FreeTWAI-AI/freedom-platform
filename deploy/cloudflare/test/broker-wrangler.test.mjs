import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {checkBrokerWranglerConfig} from '../lib/broker-wrangler.mjs';
import {loadManifest} from '../lib/manifest.mjs';
import {parseJsonc} from '../lib/wrangler.mjs';
const manifest=loadManifest(),candidate=parseJsonc(readFileSync(resolve('wrangler.broker.example.jsonc'),'utf8'));
function check(change=()=>{}){const directory=mkdtempSync(join(tmpdir(),'fp-broker-static-'));try{const config=structuredClone(candidate);change(config);const path=join(directory,'candidate.json');writeFileSync(path,JSON.stringify(config));return checkBrokerWranglerConfig(path,manifest);}finally{rmSync(directory,{recursive:true,force:true});}}
test('broker candidate maps canonical role/environment requirements without declaring placeholders or offline evidence cloud ready',()=>{
  const report=check();assert.equal(report.structural,true);assert.equal(report.deployment_ready,false);assert.equal(report.remote_cloud,'not_run');assert.equal(report.enabled_by_this_tool,false);
  assert.deepEqual(report.mapping['staging-next'].hyperdrives.map(item=>[item.binding,item.expected_database,item.expected_role,item.required_caching_disabled]),[['CIPHER_HYPERDRIVE','freedom_staging_next','freedom_staging_next_broker',true],['EXECUTOR_HYPERDRIVE','freedom_staging_next','freedom_staging_next_broker_executor',true]]);
  assert(report.blockers.some(message=>message.includes('placeholder')));
  const supplied=check(config=>{let index=0;for(const [environment,block] of Object.entries(config.env)){for(const item of block.hyperdrive)item.id=String(++index).repeat(32);block.r2_buckets[0].bucket_name=manifest.environments[environment].r2_buckets.find(bucket=>bucket.public===false).name;block.vars.FREEDOM_HYPERDRIVE_CACHE_DISABLED='true';}});assert.equal(supplied.structural,true);assert.equal(supplied.deployment_ready,false);assert.equal(supplied.mapping.next.hyperdrives[0].provider_cache_readback,'not_run');
});
test('broker candidate rejects cross-environment origin and shared real Hyperdrive identifiers',()=>{
  assert.equal(check(config=>{config.env['staging-next'].vars.APP_ORIGIN='https://freetwai.com';}).structural,false);
  assert.equal(check(config=>{for(const block of Object.values(config.env))for(const item of block.hyperdrive)item.id='a'.repeat(32);}).structural,false);
  assert.equal(check(config=>{config.env.next.hyperdrive[1].binding='CIPHER_HYPERDRIVE';}).structural,false);
});
test('broker candidate refuses public routes, plain KEKs and an alternate bucket truth',()=>{
  for(const change of [config=>{config.env.next.routes=[{pattern:'freetwai.com/*',zone_name:'freetwai.com'}];},config=>{config.env.next.vars.FREEDOM_BROKER_KEKS='SYNTHETIC_FORBIDDEN';},config=>{config.env.next.r2_buckets[0].bucket_name='another-private-store';},config=>{config.vars.FREEDOM_BROKER_ENABLED='true';}])assert.equal(check(change).structural,false);
});
