import { createServer, type ServerOptions, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readCredentialIngestBytes, type CredentialIngestHttp } from './ingest-http.js';
import type { CredentialIngestBodyLimits } from './ingest.js';

export interface CredentialIngestProcessOptions {origin:string;transport:CredentialIngestHttp;tls:Pick<ServerOptions,'key'|'cert'>}
/** Explicit HTTPS composition. No DNS/certificate/key defaults, public listener
 * installation or body draining on denial. The caller owns listen/close. */
export function createCredentialIngestProcessServer(options:CredentialIngestProcessOptions):Server {
  const origin=new URL(options.origin),transport=options.transport;
  if(origin.protocol!=='https:'||origin.origin!==options.origin||origin.username||origin.password||origin.hostname==='localhost'
    ||/^[0-9.]+$/.test(origin.hostname)||origin.hostname.startsWith('[')||!transport||typeof transport.fetch!=='function'||!options.tls?.key||!options.tls.cert)
    throw new Error('credential_ingest_unavailable');
  const fetch=transport.fetch.bind(transport),key=options.tls.key,cert=options.tls.cert;
  const server=createServer({key,cert,requestTimeout:6000,headersTimeout:5000,maxHeaderSize:8192},(incoming,outgoing)=>{void handle(incoming,outgoing);});
  server.maxRequestsPerSocket=128;
  // Node otherwise sends 100 Continue automatically before application guards.
  server.on('checkContinue',(incoming,outgoing)=>{void handle(incoming,outgoing);});
  async function handle(incoming:IncomingMessage,outgoing:ServerResponse){
    const abort=new AbortController();incoming.once('aborted',()=>abort.abort());incoming.once('error',()=>abort.abort());
    outgoing.once('close',()=>{if(!outgoing.writableFinished)abort.abort();});
    const finish=()=>{if(!incoming.complete)incoming.destroy();};outgoing.once('finish',finish);
    try{
      const headers=new Headers(),seen=new Set<string>();
      for(let i=0;i<incoming.rawHeaders.length;i+=2){const name=incoming.rawHeaders[i].toLowerCase();
        if(seen.has(name))throw new Error();seen.add(name);headers.set(name,incoming.rawHeaders[i+1]);}
      if(headers.get('Host')!==origin.host||!incoming.url||!incoming.url.startsWith('/')||incoming.url.startsWith('//'))throw new Error();
      const request=new Request(`${origin.origin}${incoming.url}`,{method:incoming.method,headers,signal:abort.signal});
      let used=false;
      const read=async(budget:CredentialIngestBodyLimits):Promise<Uint8Array>=>{
        if(used)throw new Error('credential_ingest_unavailable');used=true;
        // Construction is deferred until read is called by the authorized
        // boundary. HWM0 prevents stream prefetch before its explicit reader.
        const stream=new ReadableStream<Uint8Array>({
          async pull(controller){
            try{
              for(;;){
                const chunk=incoming.read() as Buffer|null;
                if(chunk){controller.enqueue(chunk);return;}
                if(incoming.readableEnded){controller.close();return;}
                if(incoming.destroyed||abort.signal.aborted)throw new Error('credential_ingest_unavailable');
                await new Promise<void>((resolve,reject)=>{
                  const clean=()=>{incoming.removeListener('readable',ready);incoming.removeListener('end',ready);
                    incoming.removeListener('error',failed);incoming.removeListener('aborted',failed);};
                  const ready=()=>{clean();resolve();},failed=()=>{clean();reject(new Error('credential_ingest_unavailable'));};
                  incoming.once('readable',ready);incoming.once('end',ready);incoming.once('error',failed);incoming.once('aborted',failed);
                });
              }
            }catch{controller.error(new Error('credential_ingest_unavailable'));}
          },
          cancel(){incoming.destroy();},
        },{highWaterMark:0});
        const raw=headers.get('Content-Length');return readCredentialIngestBytes(stream,abort.signal,raw===null?undefined:Number(raw),budget);
      };
      const response=await fetch(request,{read});outgoing.statusCode=response.status;
      for(const[name,value]of response.headers)if(name!=='set-cookie')outgoing.setHeader(name,value);
      const cookies=response.headers.getSetCookie();if(cookies.length)outgoing.setHeader('Set-Cookie',cookies);
      outgoing.setHeader('Connection','close');outgoing.end(Buffer.from(await response.arrayBuffer()));
    }catch{
      if(!outgoing.headersSent){outgoing.statusCode=503;outgoing.setHeader('Content-Type','application/json');outgoing.setHeader('Cache-Control','no-store');
        outgoing.setHeader('Connection','close');outgoing.end('{"code":"credential_ingest_unavailable","operational_authority":false}');}
      else outgoing.destroy();
    }
  }
  return server;
}
