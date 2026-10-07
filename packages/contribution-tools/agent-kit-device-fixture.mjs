// Fixed host socket service. Synthetic protocol responses; no member/DB/TLS ACL claim.
import { createServer } from 'node:http';
import { chmod } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseJson } from './io.mjs';
export const DEVICE_CASES = Object.freeze(['authorized', 'authorized_other_config', 'denied', 'foreign_challenge',
  'exchange_unknown', 'refresh_unknown', 'revoked', 'cancelled', 'insecure_origin']);
const paths = { begin: '/execution-api/v1/auth/device-authorizations', token: '/execution-api/v1/auth/token',
  nonce: '/execution-api/v1/auth/nonce', status: '/execution-api/v1/bootstrap' };
const bytes = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => parseJson(JSON.stringify(value));
const same = (a,b) => isDeepStrictEqual(json(a), json(b));
const assert = value => { if (!value) throw Error('device_fixture_request_invalid'); };
function state(scenario) {
  const now = Date.now(), origin = scenario === 'authorized_other_config' ? 'https://other.example.invalid' : 'https://platform.example.invalid';
  return { scenario, origin, environment: scenario === 'authorized_other_config' ? 'next' : 'local', clientId: 'kit-' + randomBytes(8).toString('hex'),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300000).toISOString(), tokenExpiry: new Date(now + 120000).toISOString(),
    authorizationId: randomUUID(), deviceCode: bytes(), userCode: 'ABCDE-FGHJK', nonce: bytes(), requestDigest: bytes(),
    connectionId: randomUUID(), runtimeDeviceId: randomUUID(), familyId: randomUUID(), handles: [bytes(), bytes()],
    tokens: [bytes()+'.'+bytes()+'.'+bytes(), bytes()+'.'+bytes()+'.'+bytes()], trace: [], jtis: new Set(), step: 0,
    secrets: [], sealed: false };
}
function signed(state, raw, typ, expected, enrollment = false) {
  assert(typeof raw === 'string' && raw.length <= 8192);
  const parts = raw.split('.'); assert(parts.length === 3 && parts.every(value => /^[A-Za-z0-9_-]+$/.test(value)));
  const header = parseJson(Buffer.from(parts[0], 'base64url')), payloadBytes = Buffer.from(parts[1], 'base64url');
  assert(same(header, enrollment ? {alg:'ES256',typ} : {alg:'ES256',typ,jwk:state.jwk}));
  assert(verify('sha256', Buffer.from(parts[0]+'.'+parts[1]), {key:createPublicKey({key:state.jwk,format:'jwk'}),dsaEncoding:'ieee-p1363'}, Buffer.from(parts[2],'base64url')));
  state.secrets.push(raw);
  if (enrollment) { assert(payloadBytes.toString('utf8') === expected); return; }
  const payload = parseJson(payloadBytes);
  assert(typeof payload.jti === 'string' && /^[A-Za-z0-9_-]{32}$/.test(payload.jti) && !state.jtis.has(payload.jti));
  assert(Number.isInteger(payload.iat) && Math.abs(Date.now()/1000-payload.iat) < 30);
  state.jtis.add(payload.jti);
  assert(same(payload, {...expected,jti:payload.jti,iat:payload.iat}));
}
function nonce(s) { return {nonceId:randomUUID(),nonce:bytes(),connectionId:s.connectionId,issuedAt:new Date().toISOString(),
  expiresAt:new Date(Date.now()+30000).toISOString(),operational_authority:false}; }
function session(s, generation) { return {accessToken:s.tokens[generation-1],tokenType:'DPoP',expiresAt:s.tokenExpiry,
  connectionId:s.connectionId,runtimeDeviceId:s.runtimeDeviceId,refresh:{familyId:s.familyId,generation:String(generation),
    handle:s.handles[generation-1],expiresAt:s.expiresAt},operational_authority:false}; }
function dispatch(s, request, body) {
  const path = request.url, step = s.step++;
  assert(!request.headers.cookie && !request.headers.origin && !request.headers['x-csrf-token']);
  assert(request.headers.accept === 'application/json');
  assert(request.method === (step === 5 ? 'GET' : 'POST'));
  if (step !== 5) assert(request.headers['content-type'] === 'application/json');
  assert(step < 6);
  if (step < 4) assert(request.headers.authorization === undefined);
  const claims = (purpose, path) => ({purpose,client_id:s.clientId,environment:s.environment,htm:'POST',htu:s.origin+path});
  const dpop = request.headers.dpop;
  if (step === 0) {
    assert(path === paths.begin && same(body, {publicJwk:body.publicJwk,runtimeKind:'agent-kit'}));
    const jwk = body.publicJwk;
    assert(jwk && Object.keys(jwk).sort().join() === 'crv,kty,x,y' && jwk.kty === 'EC' && jwk.crv === 'P-256');
    s.jwk = jwk;
    signed(s,dpop,'freedom-device-pairing+jwt',{...claims('device_pairing_begin',path),runtime_kind:'agent-kit',scope:'bootstrap.status.read'});
    s.secrets.push(s.deviceCode,s.nonce,s.requestDigest,...s.handles,...s.tokens);
    return [201,{authorizationId:s.authorizationId,deviceCode:s.deviceCode,userCode:s.userCode,nonce:s.nonce,requestDigest:s.requestDigest,
      verificationUri:s.origin+'/device',issuedAt:s.issuedAt,expiresAt:s.expiresAt,expiresIn:300,interval:5,operational_authority:false}];
  }
  if (step === 1 || step === 2) {
    assert(path === paths.token && same(body,{grantType:'device_code',authorizationId:s.authorizationId,deviceCode:s.deviceCode,
      ...(step===2?{enrollmentProof:body.enrollmentProof}:{})}));
    signed(s,dpop,'freedom-device-pairing+jwt',{...claims('device_pairing_poll',path),runtime_kind:'agent-kit',scope:'bootstrap.status.read',
      authorization_id:s.authorizationId,nonce:s.nonce,request_digest:s.requestDigest,device_code_hash:hash(s.deviceCode)});
    if(step===1) {
      if(s.scenario==='cancelled') return [200,{status:'authorization_pending',interval:5,operational_authority:false}];
      if(s.scenario==='denied') return [200,{status:'access_denied',operational_authority:false}];
      s.challenge = {profile:'freedom.runtime-enrollment/v1',purpose:'runtime_enrollment',challenge_id:randomUUID(),owner_member_id:randomUUID(),
        owner_principal_id:randomUUID(),scope_id:randomUUID(),runtime_device_id:s.runtimeDeviceId,environment:s.environment,
        key_thumbprint:hash(JSON.stringify({crv:s.jwk.crv,kty:s.jwk.kty,x:s.jwk.x,y:s.jwk.y})),nonce:bytes(),
        issued_at:s.issuedAt,expires_at:s.expiresAt,operational_authority:false};
      const value = {...s.challenge,payload:JSON.stringify(s.challenge)}; s.pollTime=Date.now();
      if(s.scenario==='foreign_challenge') value.key_thumbprint=bytes();
      return [200,{status:'proof_required',challenge:value,interval:5,operational_authority:false}];
    }
    assert(Date.now()-s.pollTime>=4900);
    signed(s,body.enrollmentProof,'freedom-runtime-enrollment+jws',JSON.stringify(s.challenge),true);
    if(s.scenario==='exchange_unknown') return [0,null];
    return [200,{status:'issued',...session(s,1),nonce:nonce(s),refreshSupported:true}];
  }
  if(step===3) {
    assert(path===paths.token && same(body,{grantType:'refresh_token',familyId:s.familyId,refreshHandle:s.handles[0]}));
    signed(s,dpop,'freedom-bootstrap-refresh+jwt',{...claims('bootstrap_refresh',path),connection_id:s.connectionId,family_id:s.familyId,
      generation:'1',refresh_handle_hash:hash(s.handles[0])});
    if(s.scenario==='refresh_unknown') return [0,null];
    return [200,session(s,2)];
  }
  assert(request.headers.authorization==='DPoP '+s.tokens[1]);
  if(step===4) {
    assert(path===paths.nonce && same(body,{connectionId:s.connectionId}));
    signed(s,dpop,'freedom-bootstrap-nonce+jwt',{...claims('bootstrap_nonce',path),connection_id:s.connectionId,ath:hash(s.tokens[1])});
    if(s.scenario==='revoked') return [401,{error:'revoked'}];
    s.statusNonce=nonce(s); s.secrets.push(s.statusNonce.nonce); return [201,s.statusNonce];
  }
  assert(path===paths.status && body===undefined && request.headers['x-freedom-connection']===s.connectionId
    && request.headers['x-freedom-nonce']===s.statusNonce.nonceId);
  signed(s,dpop,'dpop+jwt',{htm:'GET',htu:s.origin+path,ath:hash(s.tokens[1]),nonce:s.statusNonce.nonce});
  return [200,{connectionId:s.connectionId,runtimeDeviceId:s.runtimeDeviceId,clientId:s.clientId,environment:s.environment,
    connectionVersion:'1',expiresAt:s.tokenExpiry,state:'active',operation:'bootstrap.status.read',operational_authority:false}];
}
export async function createAgentKitDeviceFixture({socketPath,onViolation}) {
  let active, fault=false, count=0;
  const violate=()=>{fault=true;onViolation();};
  const server=createServer({maxHeaderSize:16384,requestTimeout:2000,headersTimeout:2000},async(req,res)=>{
    try {
      assert(active&&!active.sealed&&!fault&&++count<=64&&!req.headers['transfer-encoding']);
      let size=0; const parts=[];
      for await(const part of req){assert((size+=part.length)<=16384);parts.push(part);}
      const raw=Buffer.concat(parts),body=raw.length?parseJson(raw):undefined;
      const [status,value]=dispatch(active,req,body);
      active.trace.push({method:req.method,path:req.url,status:status||'response_lost',proof_verified:true,request_sha256:digest(raw),
        response_sha256:value?digest(JSON.stringify(value)):null});
      if(!status){res.destroy();return;}
      const bytes=Buffer.from(JSON.stringify(value));res.writeHead(status,{'content-type':'application/json','content-length':bytes.length,connection:'close'});res.end(bytes);
    }catch{res.destroy();violate();}
  });
  server.maxConnections=8;server.maxRequestsPerSocket=1;server.keepAliveTimeout=1;
  server.on('clientError',(_error,socket)=>{socket.destroy();violate();});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});await chmod(socketPath,0o666);
  return {
    begin(scenario){assert(DEVICE_CASES.includes(scenario)&&!fault);active=state(scenario);
      return {args:[scenario==='insecure_origin'?'http://platform.example.invalid':active.origin,active.environment,active.clientId],cancel:scenario==='cancelled'};},
    async verify(response){
      const s=active,value=parseJson(Buffer.from(await response.arrayBuffer()),{maxBytes:65536,maxDepth:12,maxNodes:2048});
      const counts={authorized:6,authorized_other_config:6,denied:2,foreign_challenge:2,exchange_unknown:3,refresh_unknown:4,revoked:5,cancelled:1,insecure_origin:0};
      const errors={foreign_challenge:'response_invalid',exchange_unknown:'exchange_outcome_unknown',refresh_unknown:'refresh_outcome_unknown',
        revoked:'http_rejected',cancelled:'aborted',insecure_origin:'configuration_invalid'};
      let matched=!fault&&response.status===200&&value.signal===null&&value.stderr===''&&(s.scenario==='cancelled'?[1,2].includes(s.trace.length):s.trace.length===counts[s.scenario]);
      let lines=[];try{lines=value.output.trim().split('\n').map(line=>parseJson(line));}catch{matched=false;}
      const begun={stage:'member_approval_required',userCode:s.userCode,verificationUri:s.origin+'/device',expiresAt:s.expiresAt,operational_authority:false};
      let expected;
      if(s.scenario.startsWith('authorized')) expected=[begun,{stage:'bootstrap_status',connectionId:s.connectionId,runtimeDeviceId:s.runtimeDeviceId,
        state:'active',expiresAt:s.tokenExpiry,operation:'bootstrap.status.read',operational_authority:false}];
      else if(s.scenario==='denied') expected=[begun,{stage:'access_denied',operational_authority:false}];
      else expected=[...(s.scenario==='insecure_origin'?[]:[begun]),{error:errors[s.scenario],operational_authority:false}];
      matched&&=value.exit_code===(s.scenario.startsWith('authorized')?0:1)&&same(lines,expected)
        &&s.secrets.every(secret=>!value.output.includes(secret)&&!value.stderr.includes(secret));
      s.sealed=true;
      return {scenario:s.scenario,status:matched?'passed':'failed',expected_requests:s.scenario==='cancelled'?null:counts[s.scenario],
        allowed_request_counts:s.scenario==='cancelled'?[1,2]:[counts[s.scenario]],observed_requests:s.trace.length,
        response_matches_challenge:matched, output_matches_expected:same(lines,expected), exit_code:value.exit_code,
        stderr_bytes:Buffer.byteLength(value.stderr), secret_output_absent:s.secrets.every(secret=>!value.output.includes(secret)&&!value.stderr.includes(secret)),
        http_trace:s.trace,execution_authorized:false};
    },
    assertHealthy(){assert(!fault);},
    async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
  };
}
