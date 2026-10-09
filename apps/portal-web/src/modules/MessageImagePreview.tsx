import {useLayoutEffect,useRef,useState} from 'react';

/** Preview pixels only: the original File never becomes a DOM URL or upload replacement. */
export function paintMessageImagePreview(canvas:HTMLCanvasElement,file:File,onFailure:()=>void):()=>void{
  let active=true,context:CanvasRenderingContext2D|null=null;
  void (async()=>{
    let bitmap:ImageBitmap|undefined;
    try{
      context=canvas.getContext('2d');
      if(!context)throw new Error('preview_canvas_unavailable');
      context.clearRect(0,0,canvas.width,canvas.height);
      bitmap=await createImageBitmap(file);
      if(!active)return;
      const scale=Math.min(canvas.width/bitmap.width,canvas.height/bitmap.height);
      const width=bitmap.width*scale,height=bitmap.height*scale;
      context.drawImage(bitmap,(canvas.width-width)/2,(canvas.height-height)/2,width,height);
    }catch{
      if(active)onFailure();
    }finally{
      bitmap?.close();
    }
  })();
  return()=>{
    if(!active)return;
    active=false;context?.clearRect(0,0,canvas.width,canvas.height);
  };
}

/** Keyed by the selected attachment; cleanup fences late decode on peer/session changes. */
export function MessageImagePreview({file}:{file:File}){
  const canvas=useRef<HTMLCanvasElement>(null),[failed,setFailed]=useState(false);
  useLayoutEffect(()=>{
    setFailed(false);
    if(canvas.current)return paintMessageImagePreview(canvas.current,file,()=>setFailed(true));
  },[file]);
  return <>
    <canvas ref={canvas} width={128} height={128} role="img" title="待送出的圖片預覽"/>
    {failed&&<span className="messages-meta" role="status">圖片預覽無法載入，原圖仍保留。</span>}
  </>;
}
