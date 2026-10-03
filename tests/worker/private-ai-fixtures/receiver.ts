import { createBrokerBridge } from '../../../apps/credential-broker/src/bridge.js';
import { createBrokerServiceBindingReceiver } from '../../../apps/credential-broker/src/service-binding.js';
import { Problem } from '../../../packages/shared/problem.js';
export default {async fetch(request:Request,env:any){
  const requestKey=await crypto.subtle.importKey('jwk',JSON.parse(env.REQUEST_PUBLIC),{name:'Ed25519'},false,['verify']);
  const responseKey=await crypto.subtle.importKey('jwk',JSON.parse(env.RESPONSE_PRIVATE),{name:'Ed25519'},false,['sign']);
  const bridge=await createBrokerBridge({environment:'staging-next',clientId:'worker-binding-test',issuer:'main-staging',requestAudience:'broker-staging',
    brokerId:'broker-staging',responseAudience:'main-staging',requestKeys:new Map([['main-request',requestKey]]),responseSigningKey:responseKey,responseKeyId:'broker-response',
    // Transport-only fixture: no member SQL authority or provider execution exists.
    authorizations:{async claim(){throw new Problem(503,'model_broker_registry_unavailable','Unavailable.');}} as never,
    execution:{async run(){throw new Error('Provider must never execute in transport tests');}} as never});
  return createBrokerServiceBindingReceiver(bridge).fetch(request);
}};
