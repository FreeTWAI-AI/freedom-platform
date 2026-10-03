import { parseBoundedJson } from '../../../packages/execution-state/decode.js';
import { Problem } from '../../../packages/shared/problem.js';
import { CredentialIngestLimits as limits } from '../../../contracts/execution/v2/model-credential-ingest.js';
import { credentialIngestOrigins, type CredentialIngestBodyLimits, type CredentialIngestBodyPort,
  type CredentialIngestService, type ProtectedCredentialSetupDto } from './ingest.js';

const cookieName='__Host-fp_broker_setup';
const rejected=(code='credential_ingest_authorization_invalid',status=403):never=>{throw new Problem(status,code,'Credential setup is unavailable.');};
const zero=(bytes:Uint8Array)=>Uint8Array.prototype.fill.call(bytes,0);
const lengthGetter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!;
const set=Uint8Array.prototype.set;
/** Owns the transport-delivered chunks. Even a late read after cancellation
 * must erase its value. No decoding/string allocation is used for secrets. */
export async function readCredentialIngestBytes(stream:ReadableStream<Uint8Array>,signal:AbortSignal,length:number|undefined,
  budget:CredentialIngestBodyLimits):Promise<Uint8Array> {
  const expiry=Date.parse(budget.expiresAt),end=Math.min(budget.monotonicDeadline,performance.now()+budget.timeoutMs);
  const live=()=>{if(signal.aborted||Date.now()>=expiry||performance.now()>=end)rejected('credential_ingest_unavailable',503);};
  live();const reader=stream.getReader(),buffer=new Uint8Array(budget.maxBytes);let size=0,chunks=0,done=false,cancelled=false;
  let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
  const stop=new Promise<never>((_,reject)=>{const fail=()=>{cancelled=true;reject(new Problem(503,'credential_ingest_unavailable','Credential setup is unavailable.'));};
    timer=setTimeout(fail,Math.max(0,end-performance.now()));abort=fail;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)fail();});
  try{
    for(;;){
      live();const nextPromise=reader.read().then(next=>{if(cancelled||Date.now()>=expiry||performance.now()>=end||signal.aborted){
        if(next.value instanceof Uint8Array)zero(next.value);rejected('credential_ingest_unavailable',503);}return next;});
      const next=await Promise.race([nextPromise,stop]);
      try{live();}catch(error){if(next.value instanceof Uint8Array)zero(next.value);throw error;}
      if(next.done){done=true;break;}const value=next.value;
      if(!(value instanceof Uint8Array))rejected('credential_ingest_unavailable',400);
      try{const n=lengthGetter.call(value) as number;
        if(++chunks>budget.maxChunks||n>budget.maxBytes-size)rejected('credential_ingest_unavailable',413);
        set.call(buffer,value,size);size+=n;
      }finally{zero(value);}
    }
    if(size<1||(length!==undefined&&length!==size))rejected('credential_ingest_unavailable',400);
    live();return buffer.slice(0,size);
  }finally{
    cancelled=true;zero(buffer);if(timer)clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);
    if(!done)void reader.cancel().catch(()=>{});
    try{reader.releaseLock();}catch{/* Pending late read retains its zeroizer. */}
  }
}
export interface CredentialIngestHttpOptions {service:CredentialIngestService;mainOrigin:string;setupOrigin:string;
  renderProtectedSetup:(dto:ProtectedCredentialSetupDto)=>{html:string;contentSecurityPolicy:string}|Promise<{html:string;contentSecurityPolicy:string}>;
  protectedAssets:{javascript:string;stylesheet:string;brand:Uint8Array}}
const security={'Cache-Control':'private, no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'X-Robots-Tag':'noindex, nofollow','Cross-Origin-Resource-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=(), display-capture=()'};
const requiredCsp="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const allowedHeaders=new Set(['host','content-type','content-length','origin','cookie','x-fp-broker-csrf','sec-fetch-site','sec-fetch-mode','sec-fetch-dest',
  'sec-fetch-user','user-agent','accept','accept-language','accept-encoding','connection','referer','priority','sec-ch-ua','sec-ch-ua-mobile',
  'sec-ch-ua-platform','upgrade-insecure-requests','cache-control','pragma','dnt','sec-gpc']);
function cookie(header:string|null):string|undefined {
  if(header===null)return undefined;let result:string|undefined;
  for(const field of header.split(';')){const part=field.trim(),match=/^([^=\s]+)=([A-Za-z0-9_-]{43})$(?![\s\S])/.exec(part);
    if(!match||match[1]!==cookieName||result!==undefined)rejected();result=match![2];}
  return result;
}
export function createCredentialIngestHttp(options:CredentialIngestHttpOptions) {
  const {service,mainOrigin,setupOrigin}=options;credentialIngestOrigins(mainOrigin,setupOrigin);
  const render=options.renderProtectedSetup,assets=options.protectedAssets;
  if(!service||typeof service.bootstrap!=='function'||typeof service.assertSetupCurrent!=='function'||typeof service.prepare!=='function'||typeof service.submit!=='function'
    ||typeof render!=='function'||!assets||typeof assets.javascript!=='string'||typeof assets.stylesheet!=='string'
    ||!(assets.brand instanceof Uint8Array)||assets.brand.length<1||assets.brand.length>1048576)rejected('credential_ingest_unavailable',503);
  const bootstrap=service.bootstrap.bind(service),current=service.assertSetupCurrent.bind(service),prepare=service.prepare.bind(service),submit=service.submit.bind(service);
  const javascript=assets.javascript,stylesheet=assets.stylesheet,brand=new Uint8Array(assets.brand),host=new URL(setupOrigin).host;
  return Object.freeze({async fetch(request:Request,bodyPort?:CredentialIngestBodyPort):Promise<Response>{
    let headers=new Headers(security);
    try{
      const url=new URL(request.url),h=request.headers;
      for(const name of h.keys())if(!allowedHeaders.has(name.toLowerCase()))rejected();
      if(url.origin!==setupOrigin||url.href!==request.url||/[?#%\\\x00-\x20\x7f-\uffff]/.test(request.url)
        ||(h.has('Host')&&h.get('Host')!==host))rejected();
      if(['Authorization','DPoP','X-Freedom-Connection','X-Freedom-Nonce','Content-Encoding','Expect','Transfer-Encoding',
        'If-Match','If-None-Match','If-Modified-Since','If-Unmodified-Since','If-Range','Range','Idempotency-Key'].some(k=>h.has(k)))rejected();
      const path=url.pathname;
      if((path==='/credential-setup.js'||path==='/credential-setup.css'||path==='/credential-setup-brand.webp')&&request.method==='GET'){
        if(h.has('Content-Length')||request.body!==null)rejected();
        if(path.endsWith('.webp')){headers.set('Content-Type','image/webp');return new Response(new Uint8Array(brand),{headers});}
        headers.set('Content-Type',path.endsWith('.js')?'application/javascript; charset=utf-8':'text/css; charset=utf-8');
        return new Response(path.endsWith('.js')?javascript:stylesheet,{headers});
      }
      if(request.method!=='POST'||!['/credential-setup','/credential-setup/prepare','/credential-setup/secret'].includes(path))rejected();
      const bootstrapRoute=path==='/credential-setup',sentOrigin=h.get('Origin');
      if(sentOrigin!==(bootstrapRoute?mainOrigin:setupOrigin))rejected();
      const fetchSite=h.get('Sec-Fetch-Site'),fetchMode=h.get('Sec-Fetch-Mode'),fetchDest=h.get('Sec-Fetch-Dest');
      if(bootstrapRoute){if(fetchSite!==null&&!['cross-site','same-site'].includes(fetchSite)||fetchMode!==null&&fetchMode!=='navigate'||fetchDest!==null&&fetchDest!=='document')rejected();}
      else if(fetchSite!==null&&fetchSite!=='same-origin'||fetchMode!==null&&!['cors','same-origin'].includes(fetchMode)||fetchDest!==null&&fetchDest!=='empty')rejected();
      const token=cookie(h.get('Cookie'));const csrf=h.get('X-FP-Broker-CSRF');
      const user=h.get('Sec-Fetch-User');if(user!==null&&(!bootstrapRoute||user!=='?1'))rejected();
      if(bootstrapRoute){if(csrf!==null)rejected();}else if(!token||!csrf||!/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(csrf))rejected();
      const rawLength=h.get('Content-Length'),maxBytes=bootstrapRoute?limits.compactBytes+10:path.endsWith('/prepare')?128:limits.secretBytes;
      if(rawLength!==null&&(!/^[1-9][0-9]*$(?![\s\S])/.test(rawLength)||Number(rawLength)>maxBytes))rejected('credential_ingest_unavailable',413);
      if(path.endsWith('/secret')&&rawLength===null)rejected('credential_ingest_unavailable',400);
      const type=h.get('Content-Type');
      if(type!==(bootstrapRoute?'application/x-www-form-urlencoded':path.endsWith('/prepare')?'application/json':'application/octet-stream'))rejected('credential_ingest_unavailable',415);
      const length=rawLength===null?undefined:Number(rawLength);
      const read=async(budget:CredentialIngestBodyLimits)=>{
        if(bodyPort)return bodyPort.read(budget);
        if(!request.body)rejected('credential_ingest_unavailable',400);
        return readCredentialIngestBytes(request.body!,request.signal,length,budget);
      };
      if(path.endsWith('/secret')){
        const response=await submit(token!,csrf!,{read,signal:request.signal});headers.set('Content-Type','application/json; charset=utf-8');
        headers.append('Set-Cookie',`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
        return new Response(JSON.stringify(response),{headers});
      }
      const started=performance.now(),bytes=await read({maxBytes,maxChunks:limits.chunks,timeoutMs:limits.bodyMs,
        expiresAt:new Date(Date.now()+limits.bodyMs).toISOString(),monotonicDeadline:started+limits.bodyMs});let value:string;
      try{value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}finally{zero(bytes);}
      if(path.endsWith('/prepare')){
        const input=parseBoundedJson(value);if(!input||typeof input!=='object'||Object.keys(input).length!==1||(input as {consent?:unknown}).consent!==true)rejected();
        const dto=await prepare(token!,csrf!,request.signal);headers.set('Content-Type','application/json; charset=utf-8');return new Response(JSON.stringify(dto),{headers});
      }
      // Compact JWS uses only form-unreserved characters. Requiring this exact
      // encoding rejects duplicate/extra fields and noncanonical percent forms.
      const match=/^assertion=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$(?![\s\S])/.exec(value);if(!match)rejected();
      const setup=await bootstrap(match![1],request.signal);let renderTimer:ReturnType<typeof setTimeout>|undefined;
      const renderDeadline=Math.min(Date.parse(setup.setup.expiresAt)-Date.now(),1000),renderEnd=performance.now()+renderDeadline;
      let document:{html:string;contentSecurityPolicy:string};
      try{document=await Promise.race([Promise.resolve().then(()=>render(setup.setup)),new Promise<never>((_,reject)=>{
        renderTimer=setTimeout(()=>reject(new Problem(503,'credential_ingest_unavailable','Credential setup is unavailable.')),Math.max(0,renderDeadline));})]);
        if(performance.now()>=renderEnd)rejected('credential_ingest_unavailable',503);
      }finally{if(renderTimer)clearTimeout(renderTimer);}
      if(!document||typeof document.html!=='string'||document.html.length>131072||document.contentSecurityPolicy!==requiredCsp)rejected('credential_ingest_unavailable',503);
      await current(setup.cookieToken);const remaining=Math.floor((Date.parse(setup.setup.expiresAt)-Date.now())/1000);if(remaining<1)rejected();
      headers.set('Content-Type','text/html; charset=utf-8');headers.set('Content-Security-Policy',document.contentSecurityPolicy);
      headers.append('Set-Cookie',`${cookieName}=${setup.cookieToken}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${remaining}`);
      return new Response(document.html,{headers});
    }catch(error){
      const code=(error as {code?:unknown})?.code;
      const safe=typeof code==='string'&&['credential_ingest_unavailable','credential_ingest_authorization_invalid','credential_ingest_registry_unavailable',
        'credential_ingest_outcome_unknown','credential_ingest_submission_consumed'].includes(code)?code:'credential_ingest_unavailable';
      const status=error instanceof Problem&&[400,403,409,413,415,503].includes(error.status)?error.status:503;
      headers.set('Content-Type','application/json; charset=utf-8');return new Response(JSON.stringify({code:safe,operational_authority:false}),{status,headers});
    }
  }});
}
export type CredentialIngestHttp=ReturnType<typeof createCredentialIngestHttp>;
