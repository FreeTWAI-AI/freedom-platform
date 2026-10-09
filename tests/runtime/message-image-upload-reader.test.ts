import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedImageUpload} from '../../apps/platform-api/src/routes/member-communications.js';
import {MESSAGE_IMAGE_INPUT_BYTES} from '../../modules/assets/message-image.js';
import {Problem} from '../../packages/shared/problem.js';
const request=(body:ReadableStream<Uint8Array>)=>new Request('http://localhost/image',{method:'POST',body,duplex:'half'} as RequestInit);
test('image reader preserves tiny chunk bytes in bounded accumulation',async()=>{
  let n=0;const stream=new ReadableStream<Uint8Array>({pull(c){if(n===16384)c.close();else c.enqueue(Uint8Array.of(n++%251));}});
  const bytes=await boundedImageUpload(request(stream));assert.equal(bytes.length,16384);
  for(let i=0;i<bytes.length;i++)assert.equal(bytes[i],i%251);
});
test('image reader cancels overflow and rejects empty or interrupted bodies',async()=>{
  let cancelled=false,n=0;
  const stream=new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(n++?1:MESSAGE_IMAGE_INPUT_BYTES));},cancel(){cancelled=true;}});
  await assert.rejects(boundedImageUpload(request(stream)),(e:unknown)=>e instanceof Problem&&e.status===413);assert.equal(cancelled,true);
  await assert.rejects(boundedImageUpload(request(new ReadableStream({start(c){c.close();}}))),(e:unknown)=>e instanceof Problem&&e.status===422);
  await assert.rejects(boundedImageUpload(request(new ReadableStream({pull(){throw Error('untrusted input');}}))),(e:unknown)=>e instanceof Problem&&e.status===422&&!e.message.includes('untrusted'));
});
