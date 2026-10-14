// Dedicated image compilation document; messages must come from our parent.
let started=false;
const origin=parent.location.origin;
window.addEventListener('message',async event=>{
  if(started||event.source!==parent||event.origin!==origin||!event.data||typeof event.data.id!=='string'||!(event.data.blob instanceof Blob)||event.data.blob.size>8*1024*1024||!/^\/assets\/mindar-image-[0-9a-f]{8}\.js$/.test(event.data.sdk))return;
  started=true;const {id,blob,sdk}=event.data;const send=value=>parent.postMessage({id,...value},origin);let url;
  window.addEventListener('error',()=>send({type:'error'}),{once:true});window.addEventListener('unhandledrejection',()=>send({type:'error'}),{once:true});
  try{const {Compiler}=await import(sdk),image=new Image();url=URL.createObjectURL(blob);image.src=url;await image.decode();
    const compiler=new Compiler();await compiler.compileImageTargets([image],value=>send({type:'progress',value}));
    // MessagePack export is a view into a larger encoder buffer. Transfer only
    // the used view; trailing capacity is not part of the closed target format.
    const bytes=compiler.exportData().slice();parent.postMessage({id,type:'result',bytes:bytes.buffer},origin,[bytes.buffer]);
  }catch{send({type:'error'});}finally{if(url)URL.revokeObjectURL(url);}
});
