import { MODEL_BROKER_BINDING_URI } from '../../platform-api/src/model-broker-service-binding.js';
import { readBoundedHttpJson } from '../../../packages/execution-state/http-body.js';
import { assertGenuineBrokerBridge,type BrokerBridge } from './bridge.js';
const headers={'Cache-Control':'private, no-store','Content-Type':'application/json; charset=utf-8','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
/** Receiver adapter for a separately composed broker Worker. A genuine bridge
 * verifies Ed25519 purpose/environment/client and current original-session SQL.
 * No public routes, signing defaults or broker DB/KEK ports are installed here. */
export function createBrokerServiceBindingReceiver(bridge:BrokerBridge) {
  assertGenuineBrokerBridge(bridge);
  const handle=bridge.handle.bind(bridge);
  return Object.freeze({async fetch(request:Request):Promise<Response> {
    try {
      if(request.url!==MODEL_BROKER_BINDING_URI||request.method!=='POST'
        ||['Authorization','DPoP','Cookie','Origin','Sec-Fetch-Site','Content-Encoding','X-Freedom-Connection','X-Freedom-Nonce']
          .some(name=>request.headers.has(name)))return Response.json({code:'model_broker_authorization_invalid'},{status:403,headers});
      return Response.json(await handle(await readBoundedHttpJson(request)),{headers});
    }catch{return Response.json({code:'model_broker_unavailable'},{status:503,headers});}
  }});
}
