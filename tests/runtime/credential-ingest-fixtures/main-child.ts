// Independent fixture entry: imports only main composition and neutral helpers.
// No provider key literal, cipher role, KEK, vault or broker custody import.
import assert from 'node:assert/strict';
import {createServer as httpServer,type Server} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {Readable} from 'node:stream';
import {Pool} from 'pg';
import {importJWK} from 'jose';
import {profile,fileStore,listen,closeServer} from './shared.js';

let config:any,mainServer:Server|undefined,executionServer:Server|undefined,pool:Pool|undefined;
let executionOrigin='',issuerDeadline=Infinity,requests:any[]=[];
const received:{path:string;method:string;secretReaderInstalled:boolean}[]=[];
process.on('message',async(message:any)=>{try{let value:any=null;
 if(message.kind==='init'){
  config=message.value;
  for(const denied of ['secret','kekBytes','cipherUrl','providerOrigin','responsePrivateJwk'])assert(!(denied in config));
  pool=new Pool({connectionString:config.appUrl,options:`-c search_path=${config.schema} -c statement_timeout=10000`,max:12});
  const {createSignedRecoverySource}=await import('../../../apps/credential-broker/src/recovery.js');
  const verifiedRecover=createSignedRecoverySource({authority:'synthetic-external-recovery',environment:'local',pinnedKeys:[{keyId:'recovery-1',key:await importJWK(config.recoveryPublicJwk,'EdDSA') as CryptoKey}],readSignedState:async()=>{const r=await fetch(config.recoveryOrigin+'/signed');if(!r.ok)throw Error('unavailable');return (await r.json() as any).signed;},readMonotonicFloor:async()=>{const r=await fetch(config.recoveryOrigin+'/floor');if(!r.ok)throw Error('unavailable');return await r.json();}}).recover;
  const recover=async()=>{const actual=await verifiedRecover();return {...actual,expiresAt:new Date(Math.min(Date.parse(actual.expiresAt),issuerDeadline)).toISOString()};};
  const authorityModule='../../../modules/agent-control/credential-ingest-authorizations.js';
  const {createCredentialIngestAuthorizations}=await import(authorityModule);
  const authorizations=createCredentialIngestAuthorizations(pool,{...profile,setupOrigin:config.setupOrigin,recover});
  const clientModule='../../../apps/platform-api/src/credential-ingest-client.js';
  const {createCredentialIngestClient}=await import(clientModule);
  const ingest=await createCredentialIngestClient(pool,{origin:config.mainOrigin,...profile,setupOrigin:config.setupOrigin,keyId:'main-ingest-1',signingKey:await importJWK(config.ingestPrivateJwk,'EdDSA') as CryptoKey,authorizations});
  const routeModule='../../../apps/platform-api/src/routes/member-credential-ingest-http.js';
  const {createMemberCredentialIngestHttpTransport}=await import(routeModule);
  const transport=await createMemberCredentialIngestHttpTransport(pool,{origin:config.mainOrigin,environment:'local',clientId:profile.clientId,ingest});
  mainServer=httpsServer(config.tls,async(req,res)=>{try{
   received.push({path:req.url??'',method:req.method??'',secretReaderInstalled:false});
   if(req.method==='GET'&&req.url==='/__fixture_blank'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end('<!doctype html><title>Independent member transport fixture</title>');return;}
   const headers=new Headers();for(const [key,val]of Object.entries(req.headers))if(val!==undefined)headers.set(key,Array.isArray(val)?val.join(','):val);
   const request=new Request(config.mainOrigin+req.url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method!)?{}:{body:Readable.toWeb(req),duplex:'half'})} as RequestInit);
   const response=await transport.fetch(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('{}');}});
  await new Promise<void>(r=>mainServer!.listen(Number(new URL(config.mainOrigin).port),'127.0.0.1',r));
  // Existing original model execution uses its real, separately installed local
  // HTTP origin. TLS browser requests are never rewritten to this origin.
  let executionFetch:(r:Request)=>Promise<Response>;
  executionServer=httpServer(async(req,res)=>{try{const headers=new Headers();for(const [key,val]of Object.entries(req.headers))if(val!==undefined)headers.set(key,Array.isArray(val)?val.join(','):val);const request=new Request(executionOrigin+req.url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method!)?{}:{body:Readable.toWeb(req),duplex:'half'})} as RequestInit);const response=await executionFetch(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end('{}');}});
  executionOrigin=await listen(executionServer);
  const {createModelBrokerClient}=await import('../../../apps/platform-api/src/model-broker-client.js');
  const broker=await createModelBrokerClient(pool,{origin:executionOrigin,...profile,requestKid:'main-exec-1',requestKey:await importJWK(config.executionPrivateJwk,'EdDSA') as CryptoKey,responseKeys:new Map([['broker-1',await importJWK(config.responsePublicJwk,'EdDSA') as CryptoKey]]),brokerIdentity:'synthetic-broker',responseAudience:'synthetic-main',recover:verifiedRecover,exchange:async request=>{requests.push(request);const r=await fetch(config.brokerInternalOrigin+'/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});if(!r.ok)throw Error('Broker unavailable');return await r.json() as any;}});
  const {createPrivateAiProductTransport,bindPrivateAiProductTransport}=await import('../../../apps/platform-api/src/private-ai-product.js');
  const product=await createPrivateAiProductTransport(pool,{origin:executionOrigin,environment:'local',clientId:profile.clientId,broker,store:fileStore(config.directory)});
  executionFetch=bindPrivateAiProductTransport(product,pool,executionOrigin,'local');
  value={pid:process.pid,executionOrigin};
 }else if(message.kind==='snapshot')value={pid:process.pid,configKeys:Object.keys(config).sort(),envKeys:Object.keys(process.env).sort(),received,requests};
 else if(message.kind==='issuerDeadline'){issuerDeadline=message.value;value=true;}
 else if(message.kind==='executionOrigin')value=executionOrigin;
 else if(message.kind==='close'){if(mainServer)await closeServer(mainServer);if(executionServer)await closeServer(executionServer);await pool?.end();value=true;}
 else throw Error('Unknown fixture message');
 process.send!({id:message.id,value});
 }catch(error){process.send!({id:message.id,error:error instanceof Error?error.message:'Fixture failure'});}});
