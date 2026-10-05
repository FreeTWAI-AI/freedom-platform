import {test} from 'node:test';
import {createServer,type Socket} from 'node:net';
import assert from 'node:assert/strict';
import {readIngestCustodyDiagnostic} from '../runtime/credential-ingest-helpers.js';

test('failure custody observation bounds a stalled PostgreSQL connection without shared pool checkout',async()=>{
 const sockets=new Set<Socket>(),server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
 try{const start=performance.now();const value=await readIngestCustodyDiagnostic(`postgres://synthetic:synthetic@127.0.0.1:${address.port}/fp_synthetic`,'fp_ingest_synthetic','00000000-0000-4000-8000-000000000001');
  assert.equal(value,'unavailable');assert(performance.now()-start<4000);
 }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
