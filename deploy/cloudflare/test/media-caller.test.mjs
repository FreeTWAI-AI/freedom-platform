import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadManifest} from '../lib/manifest.mjs';
import {planMediaOperatorCaller} from '../lib/media-caller.mjs';
const foundation=JSON.parse(readFileSync(new URL('../candidate/foundation-request.example.json',import.meta.url)));
const input=()=>({schema:'freedom.media-operator-caller-request/v1',foundation:structuredClone(foundation),callerName:'fp-base-candidate-unit-caller',storeBindingId:'synthetic-store'});
test('caller addon preserves two-Worker foundation and installs only private named capability default off',()=>{
 const request=input(),report=planMediaOperatorCaller(request,loadManifest());assert.equal(report.structural,true);assert.equal(report.status,'unavailable');
 assert.deepEqual(Object.keys(request.foundation.workers),['main','operator']);
 assert.deepEqual(report.config.services,[{binding:'MEDIA_OPERATOR',service:foundation.workers.operator,entrypoint:'MediaOperator'}]);
 assert.equal(report.config.vars.FREEDOM_MEDIA_CALLER_ENABLED,'false');assert.deepEqual(report.config.triggers.crons,[]);assert.deepEqual(report.config.routes,[]);
 for(const key of ['hyperdrive','r2_buckets','secrets','assets'])assert.equal(report.config[key],undefined);
 assert.equal(report.execution_authority,false);assert.equal(report.deployment_authority,false);assert.ok(report.remaining_checks.every(c=>c.status==='not_run'));
});
test('caller admission rejects public ingress, activation, arbitrary service/keys, wrong environment/full profile',()=>{
 for(const change of [r=>r.routes=['/*'],r=>r.enabled=true,r=>r.secrets={token:'PRIVATE'},r=>r.service='arbitrary',r=>r.foundation.environment='next',r=>r.foundation.features.private_ai='true',r=>r.callerName='freedom-platform',r=>r.foundation.schema='freedom.isolated-candidate-request/v1']){
  const request=input();change(request);const report=planMediaOperatorCaller(request,loadManifest());assert.equal(report.structural,false);assert.equal(report.config,undefined);assert.equal(JSON.stringify(report).includes('PRIVATE'),false);
 }
});
