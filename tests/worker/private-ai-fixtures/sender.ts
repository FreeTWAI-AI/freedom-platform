import { createModelBrokerServiceBindingExchange } from '../../../apps/platform-api/src/model-broker-service-binding.js';
export default {async fetch(request:Request,env:{MODEL_BROKER:{fetch(request:Request):Promise<Response>}}){
  try{return Response.json(await createModelBrokerServiceBindingExchange(env.MODEL_BROKER)(await request.json()));}
  catch{return Response.json({code:'model_broker_unavailable'},{status:503});}
}};
