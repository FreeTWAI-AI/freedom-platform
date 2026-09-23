import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createAdminAccessVerifier,verifyAdminAccess} from '../../modules/platform-admin/access.js';

const issuer='https://test-team.cloudflareaccess.com',audience='admin-audience';
const pair=await generateKeyPair('RS256'),other=await generateKeyPair('RS256');
const jwk=await exportJWK(pair.publicKey);
const verify=createAdminAccessVerifier({issuer,audience,csrfSecret:'private-test-key-for-csrf-binding-123456',keySet:createLocalJWKSet({keys:[{...jwk,kid:'test-key',alg:'RS256'}]})});
async function token(overrides:Record<string,unknown>={},key=pair.privateKey){
 const now=Math.floor(Date.now()/1000);
 return new SignJWT({type:'app',email:'Admin@example.invalid',sub:'human-id',iss:issuer,aud:[audience],iat:now,nbf:now,exp:now+300,...overrides})
   .setProtectedHeader({alg:'RS256',kid:'test-key'}).sign(key);
}
const req=(token?:string,extra:Record<string,string>={})=>new Request('https://example.invalid/admin/api/bootstrap',{headers:{...(token?{'Cf-Access-Jwt-Assertion':token}:{}),...extra}});
const rejected=(code:string)=>(error:any)=>error.code===code;

test('admin identity requires verified human Access signature and exact issuer/audience/time claims',async()=>{
 const good=await token(),identity=await verify(req(good));
 assert.equal(identity.email,'admin@example.invalid');assert.equal(identity.subject,'human-id');assert.equal(identity.csrfToken.length,43);
 assert.equal((await verify(req(good))).csrfToken,identity.csrfToken);
 assert.notEqual((await verify(req(await token({sub:'second-human'})))).csrfToken,identity.csrfToken);
 for(const overrides of [{iss:'https://attacker.cloudflareaccess.com'},{aud:['staging-audience']},{exp:1},{nbf:Math.floor(Date.now()/1000)+60},{iat:Math.floor(Date.now()/1000)+60},{email:undefined},{sub:''},{type:'service'},{common_name:'service-token'},{service_token_id:'service'},{exp:undefined},{nbf:undefined},{iat:undefined}])
   await assert.rejects(()=>token(overrides).then(t=>verify(req(t))),rejected('admin_identity_rejected'));
 await assert.rejects(()=>token({},other.privateKey).then(t=>verify(req(t))),rejected('admin_identity_rejected'));
 const chunks=good.split('.');chunks[1]=Buffer.from(JSON.stringify({email:'forged@example.invalid'})).toString('base64url');
 await assert.rejects(()=>verify(req(chunks.join('.'))),rejected('admin_identity_rejected'));
});

test('unverified email header, signup cookie, malformed JWT and missing configuration never authorize administrators',async()=>{
 await assert.rejects(()=>verify(req(undefined,{'Cf-Access-Authenticated-User-Email':'Admin@example.invalid',Cookie:'freedom_local_session=claimed-admin'})),rejected('admin_identity_required'));
 await assert.rejects(()=>verify(req('a'.repeat(17000))),rejected('admin_identity_required'));
 await assert.rejects(()=>verify(req('not.a.jwt')),rejected('admin_identity_rejected'));
 assert.throws(()=>createAdminAccessVerifier({issuer:'https://example.invalid',audience,csrfSecret:'x'.repeat(32)}));
 assert.throws(()=>createAdminAccessVerifier({issuer,audience,csrfSecret:'short'}));
 const names=['FREEDOM_ADMIN_ACCESS_ISSUER','FREEDOM_ADMIN_ACCESS_AUD','FREEDOM_ADMIN_CSRF_SECRET'];
 const previous=names.map(n=>process.env[n]);
 try {for(const n of names)delete process.env[n];await assert.rejects(async()=>verifyAdminAccess(req(await token())),rejected('admin_not_configured'));}
 finally {names.forEach((n,i)=>{if(previous[i]===undefined)delete process.env[n];else process.env[n]=previous[i];});}
});
