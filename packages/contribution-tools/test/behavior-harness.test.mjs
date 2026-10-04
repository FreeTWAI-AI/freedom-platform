import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runMemberRouteBehavior, installedBehaviorHarnessDigest, behaviorFixtureIdentity } from '../behavior-harness.mjs';
import { MEMBER_BEHAVIOR as manifest, MEMBER_BEHAVIOR_CASES as cases } from '../behavior-manifest.mjs';
import { VerificationError } from '../errors.mjs';

async function fixture() {
  const input = { binding: { repository:'fixture/repository', pull_request:1, run_id:'synthetic-run',
    base_commit:'1'.repeat(40),head_commit:'2'.repeat(40),candidate_commit:'3'.repeat(40),candidate_tree:'4'.repeat(40),
    source_commit:'5'.repeat(40),release_set_sha256:'6'.repeat(64),policy_revision:'fixture-1',policy_sha256:'7'.repeat(64),
    verifier_commit:'8'.repeat(40),verifier_sha256:'9'.repeat(64) },
    workflow:{identity:'fixture/verify',commit:'a'.repeat(40),publisher:'synthetic'},
    expectedHarnessSha256:await installedBehaviorHarnessDigest(), fixture:{instance_id:randomUUID(),work_id:randomUUID(),
      owner:{id:randomUUID(),cookie:'freedom_local_session=owner_synthetic_cookie',csrf:'owner_csrf'},
      outsider:{id:randomUUID(),cookie:'freedom_local_session=outsider_synthetic_cookie',csrf:'outsider_csrf'},
      revoked:{cookie:'freedom_local_session=revoked_synthetic_cookie',csrf:'revoked_csrf'}} };
  const observed = {binding:structuredClone(input.binding),workflow:structuredClone(input.workflow),
    harness_sha256:input.expectedHarnessSha256,fixture:behaviorFixtureIdentity(input.fixture)};
  let index=0; const requests=[];
  const work = {work_item_id:input.fixture.work_id,title:manifest.title,objective:manifest.objective,state:'draft',aggregate_version:1,created_at:'2026-10-02T00:00:00Z'};
  const ports={observeTarget:async()=>structuredClone(observed),request:async request=>{
    requests.push(request); const item=cases[index++]; let body;
    if(item.shape==='head') body=null;
    else if(item.shape==='avatar') body='RIFF0000WEBPsynthetic';
    else body=JSON.stringify(item.shape==='problem'?{code:'synthetic_denial'}:item.shape==='metadata'?{aggregate_version:1,avatar_url:`/api/v1/members/${input.fixture.owner.id}/avatar?v=1`}:
      item.shape==='empty-list'?{items:[],total:0,limit:20,offset:0}:item.shape==='list'?{items:[work],total:1,limit:20,offset:0}:work);
    return new Response(body,{status:item.status,headers:{'Cache-Control':'private, no-store','Content-Type':item.shape==='avatar'?'image/webp':'application/json'}});
  }};
  return {input,ports,observed,requests};
}
test('fixed six-route profile emits all cases, safe observations and never authorizes execution/publication',async()=>{
  const f=await fixture(), result=await runMemberRouteBehavior(f.input,f.ports);
  assert.equal(result.check.status,'passed'); assert.equal(result.observation.tests,27); assert.equal(result.status,'unavailable');
  assert.equal(result.execution_authorized,false); assert.equal(result.merge_authorized,false); assert.equal(result.publisher_trust,'unverified');
  assert.equal(f.requests.length,cases.length); assert.equal(new Set(cases.map(c=>c.operation)).size,6);
  for(const request of f.requests.filter(r=>r.method==='POST'))
    assert(!request.headers.has('If-Match') || !request.headers.has('X-CSRF-Token') || !request.headers.has('Idempotency-Key'));
  const serialized=JSON.stringify(result);
  for(const secret of [manifest.title,manifest.objective,...['owner','outsider','revoked'].flatMap(k=>[f.input.fixture[k].cookie,f.input.fixture[k].csrf])]) assert(!serialized.includes(secret));
  const changed=structuredClone(f.input.fixture); changed.owner.cookie+='changed'; changed.owner.csrf+='changed';
  assert.deepEqual(behaviorFixtureIdentity(changed),behaviorFixtureIdentity(f.input.fixture));
});
test('absent host ports or unapproved installed harness stay unavailable without requests',async()=>{
  const f=await fixture(); assert.equal((await runMemberRouteBehavior(f.input)).check.status,'not_run');
  f.input.expectedHarnessSha256='0'.repeat(64); assert.equal((await runMemberRouteBehavior(f.input,f.ports)).check.status,'not_run'); assert.equal(f.requests.length,0);
});
test('candidate overrides cannot supply executable paths, reports, workflow pass or test lists',async()=>{
  for(const key of ['executable','report','passed','tests','authority']) {
    const f=await fixture(); await assert.rejects(runMemberRouteBehavior({...f.input,[key]:true},f.ports),{code:'invalid_behavior_input'});
  }
});
test('every binding field and host workflow identity is checked before any request',async()=>{
  for(const section of ['binding','workflow']) for(const key of Object.keys((await fixture()).observed[section])) {
    const f=await fixture(); const old=f.observed[section][key]; f.observed[section][key]=typeof old==='number'?old+1:old==='a'.repeat(40)?'b'.repeat(40):old.replace(/^./,old[0]==='a'?'b':'a');
    const r=await runMemberRouteBehavior(f.input,f.ports); assert.equal(r.status,'failed'); assert.equal(r.observation,null); assert.equal(f.requests.length,0);
  }
});
test('post-run target replacement invalidates otherwise successful observations',async()=>{
  const f=await fixture(); let observations=0; const original=f.ports.observeTarget;
  f.ports.observeTarget=async()=>{const value=await original(); if(++observations===2)value.binding.candidate_tree='b'.repeat(40); return value;};
  const r=await runMemberRouteBehavior(f.input,f.ports); assert.equal(r.status,'failed'); assert.equal(r.observation,null); assert.equal(f.requests.length,27);
});
test('transport exceptions cannot inject secrets through VerificationError codes',async()=>{
  for(const port of ['request','observeTarget']) {const f=await fixture(); f.ports[port]=async()=>{throw new VerificationError('SECRET_COOKIE_PRIVATE_BODY');};
    const r=await runMemberRouteBehavior(f.input,f.ports); assert.equal(r.status,'failed'); assert(!JSON.stringify(r).includes('SECRET'));}
});
test('status-only always-deny and always-success transports fail the fixed positive/negative cases',async()=>{
  for(const status of [200,401,404]) {const f=await fixture(); f.ports.request=async()=>new Response('{"code":"fake"}',{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    assert.equal((await runMemberRouteBehavior(f.input,f.ports)).check.status,'failed');}
});
test('missing body, duplicate JSON, oversized or infinite empty chunks never produce observations',async()=>{
  for(const body of [null,'{"code":"one","code":"two"}','x'.repeat(manifest.limits.response_bytes+1),new ReadableStream({pull(c){c.enqueue(new Uint8Array());}})]) {
    const f=await fixture(); f.ports.request=async()=>new Response(body,{status:401,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    assert.equal((await runMemberRouteBehavior(f.input,f.ports)).observation,null);
  }
});
test('input identities and host functions are snapshotted before asynchronous installation hashing',async()=>{
  const f=await fixture(); const pending=runMemberRouteBehavior(f.input,f.ports);
  f.input.expectedHarnessSha256='0'.repeat(64); f.input.binding.candidate_tree='0'.repeat(40);
  f.ports.request=async()=>{throw Error('replaced');};
  assert.equal((await pending).check.status,'passed');
});
test('JSON-like but invalid media types cannot satisfy response assertions',async()=>{
  const f=await fixture(),request=f.ports.request;
  f.ports.request=async input=>{const response=await request(input); if(response.headers.get('content-type')==='application/json') response.headers.set('content-type','application/json-pretend');return response;};
  assert.equal((await runMemberRouteBehavior(f.input,f.ports)).check.status,'failed');
});
