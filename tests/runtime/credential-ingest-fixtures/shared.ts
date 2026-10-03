import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {readFile,writeFile,link,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {assertObjectKey,validateRange,type ObjectStore,type ObjectMetadata} from '../../../packages/asset-storage/index.js';
export const profile={environment:'local' as const,clientId:'independent-direct-ingest',issuer:'synthetic-main',audience:'synthetic-broker'};
/** Immutable actual filesystem bytes, shared by path across the two children. */
export function fileStore(directory: string): ObjectStore {
  const file=(key:Parameters<ObjectStore['head']>[0])=>{assertObjectKey(key);return join(directory,key.replaceAll('/','_'));};
  const read=async(key:Parameters<ObjectStore['head']>[0])=>{try{return JSON.parse(await readFile(file(key),'utf8')) as {metadata:ObjectMetadata;bytes:string};}catch(error){if((error as {code?:string}).code==='ENOENT')return null;throw error;}};
  return {putImmutable:async(key,value)=>{const pending=join(directory,'pending-'+randomUUID());await writeFile(pending,JSON.stringify({metadata:value.metadata,bytes:Buffer.from(value.bytes).toString('base64')}),{flag:'wx'});try{await link(pending,file(key));return 'created';}catch(error){if((error as {code?:string}).code==='EEXIST')return 'exists';throw error;}finally{await rm(pending,{force:true});}},head:async key=>{const v=await read(key);return v?{metadata:v.metadata}:null;},get:async(key,range)=>{const v=await read(key);if(!v)return null;let bytes=new Uint8Array(Buffer.from(v.bytes,'base64'));if(range){validateRange(range,bytes.byteLength);bytes=bytes.slice(range.offset,range.offset+range.length);}return {metadata:v.metadata,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};},delete:async key=>{if(!await read(key))return 'missing';await rm(file(key));return 'deleted';}};
}
export async function listen(server:Server) { await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address==='object');return `http://127.0.0.1:${address.port}`; }
export async function closeServer(server:Server) { server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r())); }
