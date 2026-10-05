// Separate broker process: only this child imports AES vault and ciphertext pool.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import {Pool} from 'pg';
import {importJWK} from 'jose';
import {profile,fileStore,listen,closeServer} from './shared.js';
let config:any,internalServer:Server|undefined,setupServer:Server|undefined,origin='',captureReady=true,captureHook='',signHook='';
const pools:Pool[]=[],sqlErrors:any[]=[],requests:any[]=[],reads:{path:string;cleared:boolean}[]=[];
const buffers:Uint8Array[]=[],surfaceChecks:any[]=[];let transport:any,service:any,storePuts=0;
function pool(url:string){const p=new Pool({connectionString:url,options:`-c search_path=${config.schema} -c statement_timeout=10000`,max:12});p.on('connect',client=>{const original=client.query;client.query=((...args:any[])=>{const result=Reflect.apply(original,client,args);if(result&&typeof result.catch==='function')return result.catch((error:any)=>{sqlErrors.push({code:error.code,message:error.message,statement:typeof args[0]==='string'?args[0].trim().split('\n')[0]:''});throw error;});return result;}) as typeof client.query;});pools.push(p);return p;}
process.on('message',async(message:any)=>{try{let value:any=null;
 if(message.kind==='init'){
  config=message.value;assert(!('secret'in config));
  const cipher=pool(config.cipherUrl),executor=pool(config.executorUrl);
  const {createSignedRecoverySource}=await import('../../../apps/credential-broker/src/recovery.js');
  const recover=createSignedRecoverySource({authority:'synthetic-external-recovery',environment:profile.environment,pinnedKeys:[{keyId:'recovery-1',key:await importJWK(config.recoveryPublicJwk,'EdDSA') as CryptoKey}],readSignedState:async()=>{const r=await fetch(config.recoveryOrigin+'/signed');if(!r.ok)throw Error('unavailable');return(await r.json() as any).signed;},readMonotonicFloor:async()=>{const r=await fetch(config.recoveryOrigin+'/floor');if(!r.ok)throw Error('unavailable');return await r.json();}}).recover;
  const {createCredentialVault}=await import('../../../apps/credential-broker/src/vault.js');
  const raw=Buffer.from(config.kekBytes,'base64'),key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);raw.fill(0);
  const vault=createCredentialVault({kek:{current:async()=>({keyId:'child-ingest-kek',key}),readById:async id=>id==='child-ingest-kek'?key:null},recover});
  const authorityModule='../../../modules/agent-control/credential-ingest-authorizations.js';const {createCredentialIngestAuthorizations}=await import(authorityModule);
  const authorizations=createCredentialIngestAuthorizations(cipher,{...profile,setupOrigin:config.setupOrigin,recover});
  const responseSigningKey=await importJWK(config.responsePrivateJwk,'EdDSA') as CryptoKey;
  const originalSign=crypto.subtle.sign.bind(crypto.subtle);crypto.subtle.sign=(async(...args:Parameters<typeof crypto.subtle.sign>)=>{const signed=await originalSign(...args);if(args[1]===responseSigningKey&&signHook){const response=await fetch(signHook,{method:'POST'});if(!response.ok)throw Error('Synthetic response signing gate unavailable');}return signed;}) as typeof crypto.subtle.sign;
  const ingestModule='../../../apps/credential-broker/src/ingest.js';const {createCredentialIngestService}=await import(ingestModule);
  service=await createCredentialIngestService({cipherPool:cipher,environment:profile.environment,clientId:profile.clientId,issuer:profile.issuer,mainOrigin:config.mainOrigin,setupOrigin:config.setupOrigin,vault,recover,authorizations,requestAudience:profile.audience,requestKeys:new Map([['main-ingest-1',await importJWK(config.ingestPublicJwk,'EdDSA') as CryptoKey]]),responseSigningKey,responseKeyId:'broker-1',responseIssuer:'synthetic-broker',responseAudience:'synthetic-main',assertProtectedSurface:async(input:any)=>{surfaceChecks.push(input);if(!captureReady)throw Error('Synthetic application capture configuration unavailable');if(captureHook){const r=await fetch(captureHook,{method:'POST'});if(!r.ok)throw Error('Synthetic application capture callback unavailable');}}});
  const httpModule='../../../apps/credential-broker/src/ingest-http.js';const {createCredentialIngestHttp}=await import(httpModule);
  const uiModule='../../../apps/credential-broker/src/setup-ui.js';const ui=await import(uiModule);
  const actualTransport=createCredentialIngestHttp({service,mainOrigin:config.mainOrigin,setupOrigin:config.setupOrigin,renderProtectedSetup:ui.renderProtectedCredentialSetup,protectedAssets:{javascript:ui.protectedCredentialSetupScript,stylesheet:ui.protectedCredentialSetupStyles,brand:new Uint8Array(await readFile(new URL('../../../apps/portal-web/public/brand/freedom-workshop.webp',import.meta.url)))}});
  transport={fetch:async(request:Request,bodyPort:any)=>{
   const entry={path:new URL(request.url).pathname,method:request.method,cookie:request.headers.get('Cookie'),origin:request.headers.get('Origin'),mode:request.headers.get('Sec-Fetch-Mode'),site:request.headers.get('Sec-Fetch-Site'),dest:request.headers.get('Sec-Fetch-Dest'),type:request.headers.get('Content-Type'),length:request.headers.get('Content-Length'),status:0,settled:false,readCalls:0};requests.push(entry);
   const wrapped=bodyPort?{read:async(limits:any)=>{entry.readCalls++;const bytes=await bodyPort.read(limits);if(new URL(request.url).pathname==='/credential-setup/secret'){buffers.push(bytes);reads.push({path:'/credential-setup/secret',cleared:false});}return bytes;}}:undefined;
   try{const response=await actualTransport.fetch(request,wrapped);entry.status=response.status;return response;}finally{entry.settled=true;}
  }};
  const processModule='../../../apps/credential-broker/src/ingest-process.js';const {createCredentialIngestProcessServer}=await import(processModule);
  if(config.listenSetup!==false){setupServer=createCredentialIngestProcessServer({origin:config.setupOrigin,transport,tls:config.tls});await new Promise<void>(r=>setupServer!.listen(Number(new URL(config.setupOrigin).port),'127.0.0.1',r));}
  origin=config.setupOrigin;value={pid:process.pid};
 }else if(message.kind==='origin')value=origin;
 else if(message.kind==='sqlErrors')value=sqlErrors;
 else if(message.kind==='signHook'){signHook=message.value;value=true;}
 else if(message.kind==='captureHook'){captureHook=message.value;value=true;}
 else if(message.kind==='captureReady'){captureReady=message.value;value=true;}
 else if(message.kind==='snapshot')value={pid:process.pid,configKeys:Object.keys(config).sort(),requests,surfaceChecks,reads:reads.map((r,i)=>({...r,cleared:buffers[i].every(v=>v===0)})),storePuts};
 else if(message.kind==='direct'){
  const input=message.value;let pulls=0;const bytes=new Uint8Array(input.bytes??[]);
  let observedClaim:any=null;
  const response=await transport.fetch(new Request(config.setupOrigin+input.path,{method:input.method??'POST',headers:input.headers}),{read:async()=>{pulls++;if(input.authorizationRef)observedClaim=(await pools[0].query('SELECT submission_claimed_at,committed_at FROM credential_ingest_authorizations WHERE authorization_id=$1',[input.authorizationRef])).rows[0];if(input.delayMs)await new Promise(r=>setTimeout(r,input.delayMs));buffers.push(bytes);reads.push({path:input.path,cleared:false});return bytes;}});
  value={status:response.status,body:await response.text(),headers:Object.fromEntries(response.headers),pulls,submissionAlreadyCommitted:!!observedClaim?.submission_claimed_at,cleared:bytes.every(v=>v===0)};
 }else if(message.kind==='close'){if(setupServer)await closeServer(setupServer);if(internalServer)await closeServer(internalServer);await Promise.all(pools.map(p=>p.end()));value=true;}
 else throw Error('Unknown fixture message');process.send!({id:message.id,value});
 }catch(error){process.send!({id:message.id,error:error instanceof Error?error.message:'Fixture failure'});}});
