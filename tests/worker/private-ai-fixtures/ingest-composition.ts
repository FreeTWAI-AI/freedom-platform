import type {Pool} from 'pg';
import {workerPrivateAiPorts,type WorkerPrivateAiBindings} from '../../../apps/platform-api/src/worker-private-ai.js';

/** Synthetic, no SQL/provider capabilities: exercises actual workerd composition. */
export default {async fetch(request:Request,env:WorkerPrivateAiBindings){
  let calls=0;
  const forbidden=()=>{calls++;throw new Error('Unexpected I/O');};
  const binding=()=>({fetch:async()=>forbidden()});
  const pool={query:forbidden,connect:forbidden} as unknown as Pool;
  const ports=await workerPrivateAiPorts(pool,{...env,MODEL_BROKER:binding(),CREDENTIAL_RECOVERY_STATE:binding(),
    CREDENTIAL_RECOVERY_FLOOR:binding(),MEDIA:{put:forbidden,get:forbidden,head:forbidden,delete:forbidden} as never},
    {origin:'https://platform.test',freedomEnv:'staging'});
  if(!ports)return Response.json({installed:false,calls});
  // A GET on the create endpoint must reach its original 405 before SQL/body.
  // Missing ingest instead returns 503, proving which child was installed.
  const response=await ports.privateAiProduct(new Request('https://platform.test/api/v1/me/credential-ingests'));
  return Response.json({installed:true,setupOrigin:ports.privateAiSetupOrigin()??null,status:response.status,
    body:await response.json(),calls});
}};
