import {createBootstrapTokenIssuer} from '../../../modules/agent-control/bootstrap-issuer.js';
export default {async fetch(){
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',keys.publicKey),now=Date.now();
  const host={environment:'local',clientId:'synthetic-worker-key',issuer:'https://issuer.test/',audience:'https://platform.test/',bootstrapUri:'https://platform.test/execution-api/v1/bootstrap',keys:[{kid:'issuer',purpose:'bootstrap_access',environment:'local',publicJwk:{kty,crv,x,y},notBeforeMs:now-10000,notAfterMs:now+60000,revoked:false}]};
  Object.defineProperty(keys.privateKey,'extractable',{value:false,enumerable:true,configurable:true,writable:false});
  let rejected=false;try{await createBootstrapTokenIssuer({host:host as never,kid:'issuer',signingKey:keys.privateKey});}catch{rejected=true;}
  return Response.json({rejected});
}};
