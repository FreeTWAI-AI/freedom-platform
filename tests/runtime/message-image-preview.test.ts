import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {paintMessageImagePreview} from '../../apps/portal-web/src/modules/MessageImagePreview.js';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';
import {uploadMessageImage} from '../../apps/portal-web/src/modules/message-image-client.js';

function decoder(t:TestContext,decode:(file:File)=>Promise<ImageBitmap>){
  const original=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');
  Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,value:decode});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'createImageBitmap',original);else Reflect.deleteProperty(globalThis,'createImageBitmap');});
}
function canvas(){
  const drawn:unknown[][]=[],cleared:number[][]=[];
  const context={clearRect:(...args:number[])=>cleared.push(args),drawImage:(...args:unknown[])=>drawn.push(args)};
  return {node:{width:128,height:128,getContext:()=>context} as unknown as HTMLCanvasElement,context,drawn,cleared};
}
function bitmap(width=20,height=10){
  const state={closed:0};return {state,value:{width,height,close:()=>{state.closed++;}} as ImageBitmap};
}
const file=new File([new Uint8Array([1,2,3])],'original.png',{type:'image/png'});
const settled=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('a late old decode cannot replace a new selection and both bitmaps close exactly once',async t=>{
  const pending:((value:ImageBitmap)=>void)[]=[];
  decoder(t,()=>new Promise(resolve=>pending.push(resolve)));
  const view=canvas(),old=bitmap(),current=bitmap(10,20);let errors=0;
  const cancelOld=paintMessageImagePreview(view.node,file,()=>{errors++;});
  cancelOld();
  const cancelCurrent=paintMessageImagePreview(view.node,new File(['new'],'new.png',{type:'image/png'}),()=>{errors++;});
  pending[1](current.value);await settled();
  assert.deepEqual(view.drawn,[[current.value,32,0,64,128]],'contain fit, no stretching');
  pending[0](old.value);await settled();
  assert.equal(view.drawn.length,1);assert.equal(errors,0);
  assert.equal(old.state.closed,1);assert.equal(current.state.closed,1);
  const clears=view.cleared.length;cancelCurrent();cancelCurrent();
  assert.equal(view.cleared.length,clears+1,'cleared on removal without repeat cleanup');
});

test('clear, sticker replacement or session unmount cancels a still decoding preview',async t=>{
  let complete!:(value:ImageBitmap)=>void;
  decoder(t,()=>new Promise(resolve=>{complete=resolve;}));
  const view=canvas(),decoded=bitmap();let errors=0;
  const cancel=paintMessageImagePreview(view.node,file,()=>{errors++;});cancel();
  complete(decoded.value);await settled();
  assert.equal(view.drawn.length,0);assert.equal(errors,0);assert.equal(decoded.state.closed,1);
});

test('a rejected decode after cancellation cannot publish an error to the next selection',async t=>{
  let reject!:(cause:Error)=>void;
  decoder(t,()=>new Promise((_resolve,fail)=>{reject=fail;}));
  const view=canvas();let errors=0;
  const cancel=paintMessageImagePreview(view.node,file,()=>{errors++;});cancel();
  reject(new Error('old decode failed'));await settled();
  assert.equal(errors,0);assert.equal(view.drawn.length,0);
});

test('drawing failure reports a preview error and still closes its bitmap',async t=>{
  const decoded=bitmap();decoder(t,async()=>decoded.value);
  const view=canvas();view.context.drawImage=()=>{throw new Error('context lost');};let errors=0;
  const cancel=paintMessageImagePreview(view.node,file,()=>{errors++;});await settled();cancel();
  assert.equal(errors,1);assert.equal(decoded.state.closed,1);
});

test('preview rejection causes no upload and cannot replace original bytes or key after an unknown upload',async t=>{
  const client=new PortalClient();client.csrfToken='synthetic-session';
  const requests:RequestInit[]=[],key='same-original-upload-key',peer='10000000-0000-4000-8000-000000000001';
  t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{
    requests.push(init!);
    if(requests.length===1)throw new Error('unknown upload response');
    return Response.json({image_id:'10000000-0000-4000-8000-000000000002',content_type:'image/webp',byte_size:128});
  });
  await assert.rejects(uploadMessageImage(client,peer,file,key),(error:unknown)=>error instanceof ApiError&&error.network);
  decoder(t,async original=>{assert.equal(original,file);throw new Error('preview decoder rejected');});
  let errors=0;const cancel=paintMessageImagePreview(canvas().node,file,()=>{errors++;});await settled();cancel();
  assert.equal(errors,1);assert.equal(requests.length,1,'preview never posts or retries');
  await uploadMessageImage(client,peer,file,key);
  assert.equal(requests.length,2);
  for(const request of requests){
    assert.equal(request.body,file);assert.equal(new Headers(request.headers).get('Idempotency-Key'),key);
    assert.deepEqual(new Uint8Array(await (request.body as File).arrayBuffer()),new Uint8Array([1,2,3]));
  }
});
