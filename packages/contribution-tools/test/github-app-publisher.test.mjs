import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubAppPublisher } from '../github-app-publisher.mjs';
const config = {repository:'owner/repo',repository_id:1,app_id:2,installation_id:3,check_name:'fixed-host'};
const accepted = current => ({format:'freedom.host-verifier-report/v1',status:'passed',binding:current,blockers:[],selected_suites:['runtime.full'],checks:[{suite_id:'runtime.full',status:'passed',evidence_sha256:'e'.repeat(64)}]});
const binding = {repository:'owner/repo',run_id:4,pull_request:5,base_commit:'a'.repeat(40),head_commit:'b'.repeat(40),candidate_commit:'b'.repeat(40),candidate_tree:'c'.repeat(40)};
function fixture(change = () => {}) {
  const posts = [], state = {head:binding.head_commit};
  const ports = {
    appRequest: async (_, path) => path === '/app' ? {id:2} : {id:3,app_id:2,suspended_at:null,permissions:{checks:'write'}},
    installationRequest: async (method,path,body) => {
      if(method==='POST'){posts.push(body);return {id:6,app:{id:2},...body};}
      if(path.endsWith('/actions/runs/4'))return {id:4,repository:{id:1},event:'pull_request',head_sha:binding.head_commit,pull_requests:[{number:5}]};
      if(path.endsWith('/pulls/5'))return {number:5,state:'open',merged:false,base:{repo:{id:1},sha:binding.base_commit},head:{sha:state.head}};
      if(path.includes('/git/commits/'))return {sha:binding.candidate_commit,tree:{sha:binding.candidate_tree}};
      return {id:1,full_name:'owner/repo'};
    },
    verify: async current => accepted(current)
  };
  change(ports,state);
  return {publisher:createGithubAppPublisher(config,ports),posts};
}
test('exact verified SHA, fixed payload and bounded replay',async()=>{
  const f=fixture(); const result=await f.publisher.publish(binding);
  assert.equal(result.status,'published');assert.equal(result.gate_enforced,false);assert.equal(result.merge_authorized,false);
  assert.equal(f.posts[0].head_sha,binding.candidate_commit);assert.equal(f.posts[0].conclusion,'success');
  assert.equal((await f.publisher.publish(binding)).code,'publisher_replay_unavailable');assert.equal(f.posts.length,1);
});
test('candidate artifact cannot choose verdict, token or integration identity',async()=>{
  for(const extra of [{conclusion:'success'},{token:'candidate'},{report:{status:'passed'}}]){
    const f=fixture();assert.equal((await f.publisher.publish({...binding,...extra})).status,'unavailable');assert.equal(f.posts.length,0);
  }
  const f=fixture();assert.equal((await f.publisher.publish({...binding,candidate_commit:'d'.repeat(40)})).code,'publisher_integration_candidate_unavailable');
});
test('wrong App, installation, repository, run and tree reject before POST',async()=>{
  for(const target of ['app','installation','repository','run','tree']){
    const f=fixture(ports=>{
      const original=target==='app'||target==='installation'?ports.appRequest:ports.installationRequest;
      const field=target==='app'||target==='installation'?'appRequest':'installationRequest';
      ports[field]=async(...args)=>{const value=await original(...args),path=args[1];
        if(target==='app'&&path==='/app')value.id=99;
        if(target==='installation'&&path.endsWith('/installation'))value.app_id=99;
        if(target==='repository'&&path==='/repos/owner/repo')value.id=99;
        if(target==='run'&&path.includes('/actions/runs/'))value.head_sha='d'.repeat(40);
        if(target==='tree'&&path.includes('/git/commits/'))value.tree.sha='d'.repeat(40);
        return value;};
    });assert.equal((await f.publisher.publish(binding)).status,'unavailable');assert.equal(f.posts.length,0,target);
  }
});
test('supersession during verifier and unverified decision cannot publish',async()=>{
  for(const verdict of ['revoked','unavailable','wrong-binding']){
    const f=fixture((ports,state)=>{ports.verify=async current=>{
      if(verdict==='revoked')state.head='d'.repeat(40);
      return {...accepted(current),status:verdict==='unavailable'?'unavailable':'passed',binding:verdict==='wrong-binding'?{...current,candidate_tree:'d'.repeat(40)}:current};
    };});assert.equal((await f.publisher.publish(binding)).status,'unavailable');assert.equal(f.posts.length,0);
  }
});
test('unknown acknowledgement is sanitized and cannot retry POST',async()=>{
  const f=fixture(ports=>{const original=ports.installationRequest;ports.installationRequest=async(...args)=>{
    if(args[0]==='POST')throw new Error('secret https://private/token');return original(...args);
  };});assert.equal((await f.publisher.publish(binding)).code,'publisher_transport_unavailable');
  assert.equal((await f.publisher.publish(binding)).code,'publisher_replay_unavailable');
});

test('native transport signs bounded App JWT and restricts installation token to pinned repository',async()=>{
  const {generateKeyPairSync,verify}=await import('node:crypto');
  const {createGithubAppTransport}=await import('../github-app-publisher.mjs');
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const requests=[];
  const transport=createGithubAppTransport({repository:'owner/repo',repository_id:1,app_id:2,installation_id:3},privateKey,{fetchImpl:async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/access_tokens'))return Response.json({token:'mock-installation',expires_at:new Date(Date.now()+3600000).toISOString(),repositories:[{id:1,full_name:'owner/repo'}],permissions:{checks:'write',contents:'read',actions:'read',pull_requests:'read',metadata:'read'}},{status:201});
    return Response.json({id:2});
  }});
  await transport.appRequest('GET','/app');
  const jwt=requests[0].options.headers.authorization.slice(7).split('.');
  assert.equal(verify('RSA-SHA256',Buffer.from(jwt.slice(0,2).join('.')),publicKey,Buffer.from(jwt[2],'base64url')),true);
  const payload=JSON.parse(Buffer.from(jwt[1],'base64url'));assert.equal(payload.iss,'2');assert.ok(payload.exp-payload.iat<=600);
  await transport.installationRequest('GET','/repos/owner/repo');
  assert.deepEqual(JSON.parse(requests[1].options.body).repository_ids,[1]);
  assert.equal(requests[2].options.headers.authorization,'Bearer mock-installation');
  assert.equal(requests[2].options.redirect,'error');assert.ok(requests[2].options.signal);
  assert.deepEqual(Object.keys(transport),['appRequest','installationRequest']);
  const count=requests.length;
  await assert.rejects(transport.installationRequest('GET','https://evil.example/token'),/publisher_endpoint_rejected/);
  await assert.rejects(transport.installationRequest('POST','/repos/owner/repo/issues',{}),/publisher_endpoint_rejected/);
  assert.equal(requests.length,count);
});

test('native transport rejects redirect, oversized response and overbroad token without disclosure',async()=>{
  const {generateKeyPairSync}=await import('node:crypto');
  const {createGithubAppTransport}=await import('../github-app-publisher.mjs');
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const cfg={repository:'owner/repo',repository_id:1,app_id:2,installation_id:3};
  for(const response of [()=>new Response('secret',{status:302}),()=>new Response('x'.repeat(1048577)),()=>Response.json({token:'secret',expires_at:new Date(Date.now()+3600000).toISOString(),repositories:[{id:99}],permissions:{checks:'write'}} ,{status:201})]){
    const transport=createGithubAppTransport(cfg,privateKey,{fetchImpl:async()=>response()});
    await assert.rejects(transport.installationRequest('GET','/repos/owner/repo'),error=>error.message.startsWith('publisher_')&&!error.message.includes('secret'));
  }
});

test('bare artifact-shaped verdict and missing/duplicate suite evidence remain unavailable',async()=>{
  for(const mutate of [()=>({status:'passed',binding}),r=>({...r,checks:[]}),r=>({...r,blockers:['pending']}),r=>({...r,selected_suites:['runtime.full','runtime.full']})]){
    const f=fixture(ports=>{ports.verify=async current=>mutate(accepted(current));});
    assert.equal((await f.publisher.publish(binding)).code,'publisher_verified_decision_unavailable');assert.equal(f.posts.length,0);
  }
});
