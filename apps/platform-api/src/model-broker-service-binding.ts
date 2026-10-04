import { z } from 'zod';
import { ModelBrokerRequestSchema, ModelBrokerResponseEnvelopeSchema, type ModelBrokerRequest } from '../../../contracts/execution/v2/model-broker-bridge.js';
import { readBoundedHttpJson } from '../../../packages/execution-state/http-body.js';
import { snapshotInput } from '../../../packages/execution-state/decode.js';
import { Problem } from '../../../packages/shared/problem.js';

/** Native private Worker service binding, never a URL/fetch supplied by a browser. */
export interface PrivateAiServiceBinding { fetch(request:Request):Promise<Response> }
export const MODEL_BROKER_BINDING_URI='https://freedom-private-ai.internal/internal/model-execution';
const unavailable=()=>new Problem(503,'model_broker_unavailable','Broker service binding is unavailable.');
/** Bounded JSON over native fetch. No redirect, cookie, owner or secret proxy. */
export function bindPrivateAiJsonService(binding:PrivateAiServiceBinding) {
  if(!binding||typeof binding.fetch!=='function')throw unavailable();
  const fetch=binding.fetch.bind(binding);
  return async function read<T>(uri:string,schema:z.ZodType<T>,body?:unknown):Promise<T> {
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const request=new Request(uri,{method:body===undefined?'GET':'POST',redirect:'manual',signal:controller.signal,
        headers:body===undefined?{Accept:'application/json'}:{Accept:'application/json','Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      const response=await Promise.race([fetch(request),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},40_000);})]);
      if(response.status!==200||response.redirected||response.headers.has('Location')||response.headers.has('Set-Cookie')
        ||response.headers.has('Content-Encoding'))throw unavailable();
      const raw=new Request(uri,{method:'POST',headers:response.headers,body:response.body,signal:controller.signal,duplex:'half'} as RequestInit);
      return schema.parse(await readBoundedHttpJson(raw));
    }catch{throw unavailable();}finally{if(timer)clearTimeout(timer);controller.abort();}
  };
}
/** Existing signed purpose/SQL-bound protocol authenticates both directions.
 * This adapter cannot mint claims or deserialize Actor/opaque execution handles. */
export function createModelBrokerServiceBindingExchange(binding:PrivateAiServiceBinding) {
  const send=bindPrivateAiJsonService(binding);
  return async(raw:ModelBrokerRequest)=>send(MODEL_BROKER_BINDING_URI,ModelBrokerResponseEnvelopeSchema,
    ModelBrokerRequestSchema.parse(snapshotInput(raw)));
}
