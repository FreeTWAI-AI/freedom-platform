import { AdapterFault } from './adapters/common.js';
import type { ByokObservation } from './adapters/byok.js';

/** Main Worker cannot dispatch providers or resolve their keys. */
export async function exchange(_url:URL,_method:'GET'|'POST',_headers:Record<string,string>,_body?:Uint8Array):Promise<ByokObservation> {
  throw new AdapterFault('execution_authority_unavailable');
}
