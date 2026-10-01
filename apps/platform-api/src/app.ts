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
import type { PasswordEmailSender } from '../../../modules/identity-membership/password-recovery.js';
import type { EventEmailSender } from '../../../modules/community/events.js';

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
export function nodeRuntime(freedomEnv:FreedomEnv,origin:string,options:{adminVerifier?:AdminAccessVerifier;githubSocial?:GitHubSocialOptions;passwordEmailSender?:PasswordEmailSender;eventEmailSender?:EventEmailSender;maintainerWebhookSecret?:string;now?:()=>Date;linkPreviewFetch?:PlatformRuntime['linkPreviewFetch']}={}):PlatformRuntime {
  return {
    registrationCommunityId:()=>process.env.FREEDOM_REGISTRATION_COMMUNITY_ID,
    githubTokenKey:()=>options.githubSocial?.tokenKey??process.env.GITHUB_SOCIAL_TOKEN_KEY,
    githubMetricsToken:()=>options.githubSocial?.metricsToken??(process.env.GITHUB_METRICS_TOKEN||undefined),
    // An explicit option wins even when it is empty, so a test can force 503 while a developer env var is set.
    maintainerWebhookSecret:()=>Object.prototype.hasOwnProperty.call(options,'maintainerWebhookSecret')?(options.maintainerWebhookSecret||undefined):(process.env.GITHUB_MAINTAINER_WEBHOOK_SECRET||undefined),
    adminVerifier:options.adminVerifier??verifyAdminAccess,
    sourceNetwork:authNetwork,
    allowedHosts:allowedRequestHosts(freedomEnv,origin),
    publicOrigin:LIVE_PUBLIC_ORIGIN,
    passwordEmailSender:options.passwordEmailSender,
    eventEmailSender:options.eventEmailSender,
    now:options.now,
    linkPreviewFetch:options.linkPreviewFetch??((input,init)=>globalThis.fetch(input,init)),
  };
}

export function createApp(pool:Pool,origin='http://127.0.0.1:4310',freedomEnv:FreedomEnv='local',options:{adminVerifier?:AdminAccessVerifier;githubSocial?:GitHubSocialOptions;passwordEmailSender?:PasswordEmailSender;eventEmailSender?:EventEmailSender;maintainerWebhookSecret?:string;now?:()=>Date;linkPreviewFetch?:PlatformRuntime['linkPreviewFetch']}={}) {
  return createPlatformApp(pool,origin,freedomEnv,nodeRuntime(freedomEnv,origin,options),{githubSocial:options.githubSocial});
}
