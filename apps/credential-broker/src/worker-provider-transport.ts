import {AdapterFault} from '../../../modules/agent-execution/adapters/common.js';
import type {ByokObservation} from '../../../modules/agent-execution/adapters/byok.js';

/** Broker-only native HTTPS. Host selects the fixed provider URL; no RPC endpoint. */
export async function exchange(url:URL,method:'GET'|'POST',headers:Record<string,string>,body?:Uint8Array):Promise<ByokObservation>{
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new AdapterFault('invalid_input');
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    return await Promise.race([(async()=>{
      const response=await fetch(url,{method,headers:{Accept:'application/json','Accept-Encoding':'identity',...headers},body:body?.slice() as BodyInit|undefined,redirect:'manual',signal:abort.signal});
      if(response.status!==200)throw new AdapterFault(response.status===401||response.status===403?'authentication_unavailable':'outcome_unknown');
      const allowed:Record<string,string>={};for(const name of ['content-type','content-length','content-encoding','location']){const value=response.headers.get(name);if(value!==null)allowed[name]=value;}
      if(response.redirected||allowed.location||allowed['content-encoding']&&allowed['content-encoding']!=='identity'
        ||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(allowed['content-type']??''))throw new AdapterFault('invalid_response');
      reader=response.body?.getReader();const parts:Uint8Array[]=[];let size=0,chunks=0;
      if(reader)while(true){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;if(size>32768||++chunks>256)throw new AdapterFault('response_limit');parts.push(row.value.slice());}
      if(allowed['content-length']!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(allowed['content-length'])||BigInt(allowed['content-length'])!==BigInt(size)))throw new AdapterFault('invalid_response');
      const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
      return {status:200,headers:allowed,body:bytes};
    })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new AdapterFault('outcome_unknown'));},30000);})]);
  }catch(error){if(error instanceof AdapterFault)throw error;throw new AdapterFault('outcome_unknown');}
  finally{if(timer)clearTimeout(timer);abort.abort();void reader?.cancel().catch(()=>{/* Closed native stream. */});}
}
