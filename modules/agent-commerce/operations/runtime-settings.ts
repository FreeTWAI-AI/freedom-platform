import {ReadinessError} from '../../../apps/platform-api/src/readiness.js';

export interface CommerceSettings {checkoutEnabled:boolean;quarantine:boolean}
export interface CommerceEnvironment {
  FREEDOM_COMMERCE_CHECKOUT_ENABLED?:string;
  FREEDOM_COMMERCE_QUARANTINE?:string;
  FREEDOM_GUILD_LAUNCHPAD_ENABLED?:string;
}
export function readCommerceSettings(env:CommerceEnvironment):CommerceSettings {
  for(const flag of [env.FREEDOM_COMMERCE_CHECKOUT_ENABLED,env.FREEDOM_COMMERCE_QUARANTINE]) {
    if(flag!==undefined&&flag!=='true'&&flag!=='false')throw new ReadinessError('Commerce flags must be true or false.');
  }
  // M1 dependency: the commerce console flag replaces launchpad when it exists.
  if(env.FREEDOM_COMMERCE_CHECKOUT_ENABLED==='true'&&env.FREEDOM_GUILD_LAUNCHPAD_ENABLED!=='true')throw new ReadinessError('Commerce checkout requires guild launchpad.');
  return {checkoutEnabled:env.FREEDOM_COMMERCE_CHECKOUT_ENABLED==='true',quarantine:env.FREEDOM_COMMERCE_QUARANTINE==='true'};
}
