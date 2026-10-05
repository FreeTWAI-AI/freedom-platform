import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createAgentKitDeviceFixture } from '../agent-kit-device-fixture.mjs';
const hash=value=>createHash('sha256').update(value).digest('base64url');
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function setup(t){
 const directory=await mkdtemp(join(tmpdir(),'fp-device-fixture-')),socketPath=join(directory,'http.sock');let violations=0;
 const fixture=await createAgentKitDeviceFixture({socketPath,onViolation:()=>violations++});
 t.after(async()=>{await fixture.close();await rm(directory,{recursive:true,force:true});});
 const {args:[origin,environment,clientId]}=fixture.begin('authorized');
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'});
 const proof=(purpose,path,extra={},jti=randomBytes(24).toString('base64url'),key=keys.privateKey)=>{
  const data=encode({alg:'ES256',typ:'freedom-device-pairing+jwt',jwk})+'.'+encode({purpose,client_id:clientId,environment,
   jti,iat:Math.floor(Date.now()/1000),htm:'POST',htu:origin+path,runtime_kind:'agent-kit',scope:'bootstrap.status.read',...extra});
  return data+'.'+sign('sha256',Buffer.from(data),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
 };
 const send=(path,body,dpop,headers={})=>new Promise((resolve,reject)=>{
  const bytes=Buffer.from(JSON.stringify(body));const req=request({socketPath,path,method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',
   'Content-Length':bytes.length,DPoP:dpop,...headers}},res=>{const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts))}));});
  req.on('error',reject);req.end(bytes);
 });
 return {fixture,violations:()=>violations,proof,send,jwk};
}
const begin='/execution-api/v1/auth/device-authorizations',token='/execution-api/v1/auth/token';
for(const kind of ['foreign_key','wrong_environment','member_cookie'])test('host independently rejects '+kind+' rather than trusting CLI success',async t=>{
 const f=await setup(t);const foreign=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const p=f.proof('device_pairing_begin',begin,kind==='wrong_environment'?{environment:'next'}:{},undefined,
  kind==='foreign_key'?foreign.privateKey:undefined);
 await assert.rejects(f.send(begin,{publicJwk:f.jwk,runtimeKind:'agent-kit'},p,kind==='member_cookie'?{Cookie:'synthetic-member-session'}:{}));
 assert.equal(f.violations(),1);assert.throws(()=>f.fixture.assertHealthy());
});
test('a cryptographically valid reused jti cannot perform a second protocol operation',async t=>{
 const f=await setup(t),jti=randomBytes(24).toString('base64url');
 const response=await f.send(begin,{publicJwk:f.jwk,runtimeKind:'agent-kit'},f.proof('device_pairing_begin',begin,{},jti));
 assert.equal(response.status,201);
 const b=response.body;
 await assert.rejects(f.send(token,{grantType:'device_code',authorizationId:b.authorizationId,deviceCode:b.deviceCode},
  f.proof('device_pairing_poll',token,{authorization_id:b.authorizationId,nonce:b.nonce,request_digest:b.requestDigest,device_code_hash:hash(b.deviceCode)},jti)));
 assert.equal(f.violations(),1);
});
