import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubAppPublisher } from '../github-app-publisher.mjs';
const config = {repository:'owner/repo',repository_id:1,app_id:2,installation_id:3,check_name:'fixed-host'};
const accepted = current => ({format:'freedom.host-verifier-report/v1',status:'passed',binding:current,blockers:[],selected_suites:['runtime.full'],checks:[{suite_id:'runtime.full',status:'passed',evidence_sha256:'e'.repeat(64)}]});
const binding = {repository:'owner/repo',run_id:4,run_attempt:1,pull_request:5,base_commit:'a'.repeat(40),head_commit:'b'.repeat(40),candidate_commit:'b'.repeat(40),candidate_tree:'c'.repeat(40)};
function fixture(change = () => {}) {
  const posts = [], state = {head:binding.head_commit,attempt:binding.run_attempt};
  const ports = {
    appRequest: async (_, path) => path === '/app' ? {id:2} : {id:3,app_id:2,suspended_at:null,permissions:{checks:'write'}},
    installationRequest: async (method,path,body) => {
      if(method==='POST'){posts.push(body);return {id:6,app:{id:2},...body};}
      if(path.endsWith('/check-runs/6'))return {id:6,app:{id:2},...posts.at(-1)};
      if(path.endsWith('/actions/runs/4') || /\/actions\/runs\/4\/attempts\/[1-9][0-9]*$/.test(path))return {id:4,run_attempt:state.attempt,repository:{id:1},event:'pull_request',head_sha:binding.head_commit,pull_requests:[{number:5}]};
      if(path.endsWith('/pulls/5'))return {number:5,state:'open',merged:false,base:{repo:{id:1},sha:binding.base_commit},head:{sha:state.head}};
      if(path.includes('/git/commits/'))return {sha:binding.candidate_commit,tree:{sha:binding.candidate_tree}};
      return {id:1,full_name:'owner/repo'};
    },
    verify: async current => accepted(current)
  };
  change(ports,state);
  return {publisher:createGithubAppPublisher(config,ports),posts,ports,state};
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
  const requests=[]; let redirectReadback=false;
  const transport=createGithubAppTransport({repository:'owner/repo',repository_id:1,app_id:2,installation_id:3},privateKey,{fetchImpl:async(url,options)=>{
    requests.push({url,options});
    if(redirectReadback && url.endsWith('/check-runs/6'))return new Response(null,{status:302,headers:{location:'https://evil.example/token'}});
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
  await transport.installationRequest('GET','/repos/owner/repo/check-runs/6');
  assert.deepEqual(Object.keys(transport),['appRequest','installationRequest']);
  redirectReadback=true;
  await assert.rejects(transport.installationRequest('GET','/repos/owner/repo/check-runs/6'),/publisher_transport_unavailable/);
  await transport.installationRequest('GET','/repos/owner/repo/actions/runs/4/attempts/1');
  const count=requests.length;
  for(const route of ['actions/runs/4/attempts/0','actions/runs/4/attempts/1?exclude_pull_requests=true','actions/runs/4/attempts/1/logs','actions/runs/4/attempts/1/../2'])
    await assert.rejects(transport.installationRequest('GET','/repos/owner/repo/'+route),/publisher_endpoint_rejected/);
  await assert.rejects(transport.installationRequest('GET','https://evil.example/token'),/publisher_endpoint_rejected/);
  await assert.rejects(transport.installationRequest('POST','/repos/owner/repo/issues',{}),/publisher_endpoint_rejected/);
  await assert.rejects(transport.installationRequest('GET','/repos/owner/repo/check-runs/0'),/publisher_endpoint_rejected/);
  await assert.rejects(transport.installationRequest('GET','/repos/other/repo/check-runs/6'),/publisher_endpoint_rejected/);
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

test('check POST attempt identity and independent readback must both match',async()=>{
  for(const boundary of ['post-external','read-app','read-sha','read-external','read-id','read-name','read-status','read-conclusion']){
    const f=fixture(ports=>{const original=ports.installationRequest;let posted;
      ports.installationRequest=async(method,path,body)=>{
        if(method==='POST'){
          posted={id:6,app:{id:2},...body};
          return boundary==='post-external'?{...posted,external_id:'unrelated-attempt'}:posted;
        }
        if(path.endsWith('/check-runs/6')){
          const result=structuredClone(posted);
          if(boundary==='read-app')result.app.id=99;
          if(boundary==='read-sha')result.head_sha='d'.repeat(40);
          if(boundary==='read-external')result.external_id='unrelated-attempt';
          if(boundary==='read-id')result.id=7;
          if(boundary==='read-name')result.name='candidate';
          if(boundary==='read-status')result.status='in_progress';
          if(boundary==='read-conclusion')result.conclusion='failure';
          return result;
        }
        return original(method,path,body);
      };
    });
    assert.equal((await f.publisher.publish(binding)).status,'unavailable',boundary);
  }
});

test('publisher captures operator ports before their mutable registration object changes',async()=>{
  const f=fixture();
  f.ports.installationRequest=async()=>{throw new Error('changed registration');};
  f.ports.appRequest=async()=>({id:99});
  f.ports.verify=async()=>({status:'unavailable'});
  assert.equal((await f.publisher.publish(binding)).status,'published');
});

test('attempt is mandatory and stale authenticated attempt never posts',async()=>{
  for(const attempt of [undefined,0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1]){
    const f=fixture();const input={...binding,run_attempt:attempt};
    if(attempt===undefined)delete input.run_attempt;
    assert.equal((await f.publisher.publish(input)).code,'publisher_binding_invalid');assert.equal(f.posts.length,0);
  }
  const f=fixture(ports=>{const original=ports.installationRequest;ports.installationRequest=async(...args)=>{
    const value=await original(...args);if(args[1].includes('/attempts/'))value.run_attempt=2;return value;
  };});assert.equal((await f.publisher.publish(binding)).code,'publisher_run_attempt_mismatch');assert.equal(f.posts.length,0);
});

test('rerun during verification and stale verifier attempt fail before POST',async()=>{
  for(const boundary of ['rerun','stale-evidence']){
    const f=fixture((ports,state)=>{ports.verify=async current=>{
      if(boundary==='rerun')state.attempt=2;
      return accepted(boundary==='stale-evidence'?{...current,run_attempt:2}:current);
    };});const result=await f.publisher.publish(binding);
    assert.equal(result.code,boundary==='rerun'?'publisher_run_mismatch':'publisher_verified_decision_unavailable');assert.equal(f.posts.length,0);
  }
});

test('completed earlier attempt cannot authorize after post/readback rerun',async()=>{
  const f=fixture((ports,state)=>{const original=ports.installationRequest;ports.installationRequest=async(...args)=>{
    const value=await original(...args);if(args[1].endsWith('/check-runs/6'))state.attempt=2;return value;
  };});assert.equal((await f.publisher.publish(binding)).code,'publisher_run_mismatch');assert.equal(f.posts.length,1);
  assert.equal((await f.publisher.publish(binding)).code,'publisher_replay_unavailable');
});

test('unknown POST blocks identical attempt but a separately verified rerun has distinct identity',async()=>{
  let unknown=true;const f=fixture(ports=>{const original=ports.installationRequest;ports.installationRequest=async(...args)=>{
    if(args[0]==='POST'&&unknown){unknown=false;throw new Error('private acknowledgement');}
    return original(...args);
  };});
  assert.equal((await f.publisher.publish(binding)).code,'publisher_transport_unavailable');
  assert.equal((await f.publisher.publish(binding)).code,'publisher_replay_unavailable');
  f.state.attempt=2;
  assert.equal((await f.publisher.publish({...binding,run_attempt:2})).status,'published');
  assert.equal(f.posts[0].external_id,`freedom:1:4:2:${binding.candidate_commit}`);
});

test('exact attempt response independently binds run, repository, event, head and PR',async()=>{
  for(const field of ['id','repository','event','head_sha','pull_requests']){
    const f=fixture(ports=>{const original=ports.installationRequest;ports.installationRequest=async(...args)=>{
      const value=await original(...args);
      if(args[1].includes('/attempts/'))value[field]={id:99,repository:{id:99},event:'workflow_dispatch',head_sha:'d'.repeat(40),pull_requests:[{number:99}]}[field];
      return value;
    };});assert.equal((await f.publisher.publish(binding)).code,'publisher_run_attempt_mismatch',field);assert.equal(f.posts.length,0);
  }
});
