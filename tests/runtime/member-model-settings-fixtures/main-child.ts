// Main child loads genuine parent app/portal, never provider-key parent or vault.
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:https';
import type {ServerResponse} from 'node:http';
import {getRequestListener} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import {Pool} from 'pg';
import {importJWK} from 'jose';
import {profile,fileStore,closeServer} from './shared.js';
let config:any,pool:Pool|undefined,server:Server|undefined,app:any,product:any;
let dropNext='',issuerDeadline=Infinity;const requests:{path:string;method:string;bodyPulls?:number;status?:number}[]=[];
process.on('message',async(message:any)=>{try{let value:any=null;
 if(message.kind==='init'){
  config=message.value;for(const denied of ['secret','kekBytes','cipherUrl','providerOrigin','responsePrivateJwk'])assert(!(denied in config));
  pool=new Pool({connectionString:config.appUrl,options:`-c search_path=${config.schema} -c statement_timeout=10000`,max:12});
  const {createSignedRecoverySource}=await import('../../../apps/credential-broker/src/recovery.js');
  const fullRecover=createSignedRecoverySource({authority:'synthetic-external-recovery',environment:profile.environment,pinnedKeys:[{keyId:'recovery-1',key:await importJWK(config.recoveryPublicJwk,'EdDSA') as CryptoKey}],readSignedState:async()=>{const r=await fetch(config.recoveryOrigin+'/signed');if(!r.ok)throw Error('unavailable');return(await r.json() as any).signed;},readMonotonicFloor:async()=>{const r=await fetch(config.recoveryOrigin+'/floor');if(!r.ok)throw Error('unavailable');return await r.json();}}).recover;
  const recover=async()=>{const observed=await fullRecover();return {...observed,expiresAt:new Date(Math.min(Date.parse(observed.expiresAt),issuerDeadline)).toISOString()};};
  const {createCredentialIngestAuthorizations}=await import('../../../modules/agent-control/credential-ingest-authorizations.js');
  const authorizations=createCredentialIngestAuthorizations(pool,{...profile,setupOrigin:config.setupOrigin,recover});
  const {createCredentialIngestClient}=await import('../../../apps/platform-api/src/credential-ingest-client.js');
  const ingest=await createCredentialIngestClient(pool,{origin:config.mainOrigin,...profile,setupOrigin:config.setupOrigin,keyId:'main-ingest-1',signingKey:await importJWK(config.ingestPrivateJwk,'EdDSA') as CryptoKey,authorizations});
  const {createUnavailableModelStepHost}=await import('../../../modules/agent-execution/model-step-host.js');
  const {createPrivateAiProductTransport}=await import('../../../apps/platform-api/src/private-ai-product.js');
  const factoryOptions:any={origin:config.mainOrigin,environment:profile.environment,clientId:profile.clientId,host:createUnavailableModelStepHost(),store:fileStore(config.directory),settingsSelections:config.catalog?[config.selection]:[]};
  if(config.installed)factoryOptions.ingest=ingest;
  product=await createPrivateAiProductTransport(pool,factoryOptions);
  const {createApp}=await import('../../../apps/platform-api/src/app.js');
  app=createApp(pool,config.mainOrigin,'staging',config.product?{privateAiProduct:product}:{});
  // Exactly the production Node server dist middleware/fallback; all requests
  // first pass the actual parent middleware and its installed-port-derived CSP.
  app.use('/*',serveStatic({root:'./apps/portal-web/dist'}));
  app.get('*',serveStatic({path:'./apps/portal-web/dist/index.html'}));
  server=createServer(config.tls,getRequestListener(async(request,bindings)=>{
   const entry={path:new URL(request.url).pathname,method:request.method,status:0};requests.push(entry);
   const response=await app.fetch(request,bindings);entry.status=response.status;
   if(dropNext&&entry.path===dropNext&&request.method==='POST'){dropNext='';const outgoing=bindings.outgoing as ServerResponse;outgoing.writeHead(200,{'Content-Type':'application/json','Content-Length':'4096'});await new Promise<void>(resolve=>outgoing.write('{\"unknown\":',()=>{outgoing.destroy();resolve();}));}
   return response;
  }));await new Promise<void>(r=>server!.listen(Number(new URL(config.mainOrigin).port),'127.0.0.1',r));value={pid:process.pid};
 }else if(message.kind==='policyProbe'){
  const {bindPrivateAiProductBrowserPolicy}=await import('../../../apps/platform-api/src/private-ai-product.js');const {createApp}=await import('../../../apps/platform-api/src/app.js');
  const attempts=[{port:{...product},p:pool!,origin:config.mainOrigin,env:'staging'},{port:product,p:new Pool({connectionString:config.appUrl}),origin:config.mainOrigin,env:'staging'},{port:product,p:pool!,origin:config.mainOrigin+'/wrong',env:'staging'},{port:product,p:pool!,origin:config.mainOrigin,env:'public'}];
  const denied=[];for(const entry of attempts){try{bindPrivateAiProductBrowserPolicy(entry.port as any,entry.p,entry.origin,entry.env as any);denied.push(false);}catch{denied.push(true);}if(entry.p!==pool)await entry.p.end();}
  let forgedInstall=false;try{createApp(pool!,config.mainOrigin,'staging',{privateAiProduct:{...product} as any});}catch{forgedInstall=true;}value={denied,forgedInstall,pinned:bindPrivateAiProductBrowserPolicy(product,pool!,config.mainOrigin,'staging')()};
 }else if(message.kind==='snapshot')value={pid:process.pid,configKeys:Object.keys(config).sort(),envKeys:Object.keys(process.env).sort(),requests};
 else if(message.kind==='dropNext'){dropNext=message.value;value=true;}
 else if(message.kind==='issuerDeadline'){issuerDeadline=message.value;value=true;}
 else if(message.kind==='direct'){
  const input=message.value;let pulls=0;const request=new Request(config.mainOrigin+input.path,{method:input.method??'GET',headers:input.headers,...(input.body!==undefined?{body:new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new TextEncoder().encode(input.body));controller.close();}},{highWaterMark:0}),duplex:'half'}:{})} as RequestInit);
  const response=await app.fetch(request);value={status:response.status,body:await response.text(),headers:Object.fromEntries(response.headers),pulls};
 }else if(message.kind==='close'){if(server)await closeServer(server);await pool?.end();value=true;}
 else throw Error('Unknown settings fixture message');process.send!({id:message.id,value});
 }catch(error){process.send!({id:message.id,error:error instanceof Error?error.message:'Fixture failure'});}});
