import { createHmac } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { Problem } from '../../packages/shared/problem.js';

export type VerifiedAdminAccess = {email:string;subject:string;csrfToken:string};
export type AdminAccessVerifier = (request:Request)=>Promise<VerifiedAdminAccess>;
type Config = {issuer:string;audience:string;csrfSecret:string;keySet?:JWTVerifyGetKey};

/** The key endpoint is pinned to configuration, never to a token's iss/jku fields. */
export function createAdminAccessVerifier(config:Config):AdminAccessVerifier {
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.issuer)||!config.audience||config.csrfSecret.length<32)
    throw new Error('Invalid admin Access configuration.');
  const keys=config.keySet??createRemoteJWKSet(new URL('/cdn-cgi/access/certs',config.issuer),{
    timeoutDuration:5000,cooldownDuration:30000,cacheMaxAge:600000});
  return async request=>{
    const token=request.headers.get('Cf-Access-Jwt-Assertion');
    if(!token||token.length>16384)throw new Problem(401,'admin_identity_required','請先通過平台管理員的信箱驗證。');
    try {
      const {payload}=await jwtVerify(token,keys,{issuer:config.issuer,audience:config.audience,
        algorithms:['RS256'],requiredClaims:['sub','email','exp','iat','nbf'],clockTolerance:5});
      // Service-token identities do not represent any nominated human administrator.
      if(payload.type!=='app'||typeof payload.sub!=='string'||!payload.sub||payload.sub.length>256
        ||typeof payload.iat!=='number'||payload.iat>Date.now()/1000+5
        ||payload.common_name!==undefined||payload.service_token_id!==undefined)throw new Error('Invalid human identity.');
      const email=z.email().max(200).parse(payload.email).trim().toLowerCase();
      return {email,subject:payload.sub,csrfToken:createHmac('sha256',config.csrfSecret).update(token).digest('base64url')};
    } catch {
      // Never expose a token, claimed identity, key material, or provider errors.
      throw new Problem(401,'admin_identity_rejected','管理員驗證已失效，請重新登入管理介面。');
    }
  };
}

let cached:{signature:string;verify:AdminAccessVerifier}|undefined;
export async function verifyAdminAccess(request:Request):Promise<VerifiedAdminAccess> {
  const issuer=process.env.FREEDOM_ADMIN_ACCESS_ISSUER??'';
  const audience=process.env.FREEDOM_ADMIN_ACCESS_AUD??'';
  const csrfSecret=process.env.FREEDOM_ADMIN_CSRF_SECRET??'';
  if(!issuer||!audience||csrfSecret.length<32)
    throw new Problem(503,'admin_not_configured','管理員登入尚未設定完成。');
  const signature=JSON.stringify([issuer,audience,csrfSecret]);
  if(cached?.signature!==signature)cached={signature,verify:createAdminAccessVerifier({issuer,audience,csrfSecret})};
  return cached.verify(request);
}
