import {ReadinessError} from '../../../apps/platform-api/src/readiness.js';

export interface CommerceSettings {checkoutEnabled:boolean;quarantine:boolean;providerProfiles:readonly string[];emailEnabled?:boolean}
export interface CommerceEnvironment {
  FREEDOM_COMMERCE_CHECKOUT_ENABLED?:string;
  FREEDOM_COMMERCE_EMAIL_ENABLED?:string;
  FREEDOM_COMMERCE_QUARANTINE?:string;
  FREEDOM_GUILD_LAUNCHPAD_ENABLED?:string;
  FREEDOM_COMMERCE_PROVIDER_PROFILES?:string;
}
export const IMPLEMENTED_PROVIDER_PROFILES=Object.freeze(['ecpay.aio.credit.v1']);
export function readProviderProfiles(raw:string|undefined):readonly string[]{
  if(raw===undefined||raw==='')return Object.freeze([]);
  if(typeof raw!=='string'||/\s/.test(raw))throw new ReadinessError('commerce_provider_profiles_invalid');
  const profiles=raw.split(',');
  if(new Set(profiles).size!==profiles.length||profiles.some(p=>!IMPLEMENTED_PROVIDER_PROFILES.includes(p)))throw new ReadinessError('commerce_provider_profiles_invalid');
  return Object.freeze(profiles);
}
/** The socket-based Node host has no installed external-effect journal. */
export function readNodeCommerceSettings(env:CommerceEnvironment):CommerceSettings{
  const settings=readCommerceSettings(env);
  if(settings.providerProfiles.length)throw new ReadinessError('commerce_profiles_require_journal');
  if(settings.emailEnabled)throw new ReadinessError('commerce_email_requires_worker');
  return settings;
}
export function readCommerceSettings(env:CommerceEnvironment):CommerceSettings {
  for(const flag of [env.FREEDOM_COMMERCE_CHECKOUT_ENABLED,env.FREEDOM_COMMERCE_QUARANTINE,env.FREEDOM_COMMERCE_EMAIL_ENABLED]) {
    if(flag!==undefined&&flag!=='true'&&flag!=='false')throw new ReadinessError('Commerce flags must be true or false.');
  }
  // M1 dependency: the commerce console flag replaces launchpad when it exists.
  if(env.FREEDOM_COMMERCE_CHECKOUT_ENABLED==='true'&&env.FREEDOM_GUILD_LAUNCHPAD_ENABLED!=='true')throw new ReadinessError('Commerce checkout requires guild launchpad.');
  return {checkoutEnabled:env.FREEDOM_COMMERCE_CHECKOUT_ENABLED==='true',quarantine:env.FREEDOM_COMMERCE_QUARANTINE==='true',providerProfiles:readProviderProfiles(env.FREEDOM_COMMERCE_PROVIDER_PROFILES),emailEnabled:env.FREEDOM_COMMERCE_EMAIL_ENABLED==='true'};
}
