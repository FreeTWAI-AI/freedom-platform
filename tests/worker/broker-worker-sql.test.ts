import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {CompactSign,compactVerify} from 'jose';
import {ModelStepMetadataSchema} from '../../contracts/execution/v2/model-step.js';
import {createR2ObjectStore,type AssetR2Binding} from '../../packages/asset-storage/r2.js';
import {createPrivateResultService} from '../../modules/autopilot-work/results.js';
import {resolvePrivateWorkPersistencePolicy} from '../../modules/autopilot-work/policy.js';
import {nativeBrokerSqlFixture,secret,output} from './private-ai-fixtures/native-broker-sql.js';

test('actual broker Worker separate SQL roles open the vault, execute one native provider POST and finalize private Result',{timeout:60000},async()=>{
  const fixture=await nativeBrokerSqlFixture();
  const {activated,post,owner,mf,app,executor,member,requests,roles,broker,responseKeys,requestKeys,cipher}=fixture;
  try{
    const f=await activated();assert.equal(f.step.state,'reserved');
    const response=await post(f,'/api/v1/me/model-steps/'+f.step.stepId+':execute',{});
    assert.equal(response.status,200,await response.clone().text());const final=ModelStepMetadataSchema.parse(await response.json());assert.equal(final.state,'succeeded');assert.equal((await owner.query('SELECT count(*)::int n FROM private_model_work_results')).rows[0].n,1);
    const counts=await(await(await mf.getWorker('synthetic-provider')).fetch('https://api.openai.com/counts')).json() as {posts:number;gets:number};assert.equal(counts.posts,1);assert(counts.gets>=1);
    await assert.rejects(app.query('SELECT envelope FROM broker_credential_vault'),error=>(error as {code:string}).code==='42501');await assert.rejects(executor.query('SELECT envelope FROM broker_credential_vault'),error=>(error as {code:string}).code==='42501');
    const bucket=await mf.getR2Bucket('MEDIA','broker');
    const results=createPrivateResultService(app,{store:createR2ObjectStore(bucket as unknown as AssetR2Binding),resolvePolicy:resolvePrivateWorkPersistencePolicy});
    const result=await results.readCurrent(f.actor,{workId:f.work.workId});assert(result);assert.equal(result.text,output);assert.equal(result.provenance,'model');const foreign=await member();await assert.rejects(results.readCurrent(foreign.actor,{workId:f.work.workId}));
    const original=requests.at(-1)!;
    for(const workerName of ['foreign-profile','swapped-roles'])assert.equal((await(await mf.getWorker(workerName)).fetch('https://freedom-private-ai.internal/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(original)})).status,503);
    await owner.query(`GRANT SELECT(envelope) ON broker_credential_vault TO ${roles.executor}`);assert.equal((await broker.fetch('https://freedom-private-ai.internal/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(original)})).status,503);await owner.query(`REVOKE SELECT(envelope) ON broker_credential_vault FROM ${roles.executor}`);
    const retry=await broker.fetch('https://freedom-private-ai.internal/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(original)});assert.equal(retry.status,200);
    const replay=(await retry.json() as {response:string}).response;const replayClaims=JSON.parse(new TextDecoder().decode((await compactVerify(replay,responseKeys.publicKey)).payload));assert.equal(replayClaims.outcome.kind,'metadata');assert.equal(replayClaims.outcome.step.state,'succeeded');
    const assertion=JSON.parse(Buffer.from(original.assertion.split('.')[1],'base64url').toString());
    for(const change of [{environment:'next'},{clientId:'foreign-client'},{purpose:'model-broker.activate'},{audience:'foreign-broker'}]){const wrong=await new CompactSign(new TextEncoder().encode(JSON.stringify({...assertion,...change}))).setProtectedHeader({alg:'EdDSA',typ:'freedom-model-broker-assertion+jws',kid:'request'}).sign(requestKeys.privateKey);assert.equal((await broker.fetch('https://freedom-private-ai.internal/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...original,assertion:wrong})})).status,503);}
    await(await mf.getWorker('recovery-floor')).fetch('https://freedom-private-ai.internal/invalidate');
    const recoveryBlocked=await broker.fetch('https://freedom-private-ai.internal/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(original)});assert.equal(recoveryBlocked.status,200);const recoveryClaims=JSON.parse(new TextDecoder().decode((await compactVerify((await recoveryBlocked.json() as {response:string}).response,responseKeys.publicKey)).payload));assert.equal(recoveryClaims.outcome.kind,'problem');
    await(await mf.getWorker('recovery-floor')).fetch('https://freedom-private-ai.internal/reset');
    await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[createHash('sha256').update(f.token).digest('hex')]);
    const stale=await broker.fetch('https://freedom-private-ai.internal/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(original)});assert.equal(stale.status,200);const staleClaims=JSON.parse(new TextDecoder().decode((await compactVerify((await stale.json() as {response:string}).response,responseKeys.publicKey)).payload));assert.equal(staleClaims.outcome.kind,'problem');
    assert.equal((await(await(await mf.getWorker('synthetic-provider')).fetch('https://api.openai.com/counts')).json() as {posts:number}).posts,1);
    assert(!JSON.stringify((await cipher.query('SELECT envelope FROM broker_credential_vault')).rows[0]).includes(secret));
    const objects=await bucket.list();assert.equal(objects.objects.length,1);const object=await bucket.get(objects.objects[0].key);assert(object);assert.equal(await object.text(),output);
  }finally{await fixture.cleanup();}
});
