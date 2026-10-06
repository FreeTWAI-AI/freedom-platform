// Fixed host-only synthetic transport, never a candidate-selected preload.
// Keep the real SDK's HTTPS validation and proof URI. This socket is not TLS.
import { request } from 'node:http';
const allowed = new Set(['https://platform.example.invalid', 'https://other.example.invalid']);
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  if (!allowed.has(parsed.origin) || parsed.href !== url || parsed.search || parsed.hash
    || !['/execution-api/v1/auth/device-authorizations','/execution-api/v1/auth/token','/execution-api/v1/auth/nonce','/execution-api/v1/bootstrap'].includes(parsed.pathname)
    || options.redirect !== 'error' || options.credentials !== 'omit' || options.cache !== 'no-store'
    || !(options.signal instanceof AbortSignal)) throw Error('fixture_transport_rejected');
  return new Promise((resolve, reject) => {
    const req = request({socketPath:'/fixture/http.sock',path:parsed.pathname,method:options.method,
      headers:{...options.headers,...(options.body?{'Content-Length':Buffer.byteLength(options.body)}:{})},signal:options.signal,timeout:2000},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{if((size+=chunk.length)>32768)req.destroy(Error('fixture_limit'));else chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('fixture_timeout')));req.end(options.body);
  });
};
