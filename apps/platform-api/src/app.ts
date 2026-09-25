import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { verifyAdminAccess, type AdminAccessVerifier } from '../../../modules/platform-admin/access.js';
import { allowedRequestHosts, type FreedomEnv } from './env.js';
import { createPlatformApp } from './platform-app.js';
import { LIVE_PUBLIC_ORIGIN } from './routes/published-skills.js';
import type { GitHubSocialOptions } from './routes/github-social.js';
import { SHARED_NETWORK_KEY, type PlatformRuntime } from './runtime.js';

// Node host adapter. The Worker bundle never imports this module, so the
// socket-based address below is only ever read from a real Node server.
function authNetwork(c:Context) {
  let address='';try {address=getConnInfo(c).remote.address??'';} catch { /* direct in-process tests have no socket */ }
  const loopback=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
  const forwarded=c.req.header('CF-Connecting-IP')??'';
  if(process.env.FREEDOM_TRUST_CF==='true'&&loopback&&isIP(forwarded))return forwarded;
  return address&&isIP(address)?address:SHARED_NETWORK_KEY;
}

/** Node runtime: settings are read from process configuration when used, as before. */
export function nodeRuntime(freedomEnv:FreedomEnv,origin:string,options:{adminVerifier?:AdminAccessVerifier;githubSocial?:GitHubSocialOptions}={}):PlatformRuntime {
  return {
    registrationCommunityId:()=>process.env.FREEDOM_REGISTRATION_COMMUNITY_ID,
    githubTokenKey:()=>options.githubSocial?.tokenKey??process.env.GITHUB_SOCIAL_TOKEN_KEY,
    githubMetricsToken:()=>options.githubSocial?.metricsToken??(process.env.GITHUB_METRICS_TOKEN||undefined),
    adminVerifier:options.adminVerifier??verifyAdminAccess,
    sourceNetwork:authNetwork,
    allowedHosts:allowedRequestHosts(freedomEnv,origin),
    publicOrigin:LIVE_PUBLIC_ORIGIN,
  };
}

export function createApp(pool:Pool,origin='http://127.0.0.1:4310',freedomEnv:FreedomEnv='local',options:{adminVerifier?:AdminAccessVerifier;githubSocial?:GitHubSocialOptions}={}) {
  return createPlatformApp(pool,origin,freedomEnv,nodeRuntime(freedomEnv,origin,options),{githubSocial:options.githubSocial});
}
