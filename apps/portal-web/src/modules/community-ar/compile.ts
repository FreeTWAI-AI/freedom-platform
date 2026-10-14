import {AR_SDK_URL} from './sdk-location';
import {inspectArTarget} from '../../../../../packages/asset-storage/ar-target';

/** Isolated compilation document. Removing it cancels its workers and WebGL
 * resources; a newer image/session never receives an older compile result. */
export function compileArImage(blob:Blob,signal:AbortSignal,progress:(value:number)=>void):Promise<Uint8Array>{
  return new Promise((resolve,reject)=>{
    const frame=document.createElement('iframe');frame.hidden=true;frame.title='AR 圖案處理';frame.setAttribute('sandbox','allow-scripts allow-same-origin');
    const id=crypto.randomUUID();let done=false;
    const finish=(error?:Error,bytes?:Uint8Array)=>{if(done)return;done=true;clearTimeout(timer);window.removeEventListener('message',message);signal.removeEventListener('abort',aborted);frame.remove();if(error)reject(error);else resolve(bytes!);};
    const aborted=()=>finish(new DOMException('Aborted','AbortError'));
    const message=(event:MessageEvent)=>{
      if(event.source!==frame.contentWindow||event.origin!==window.location.origin||event.data?.id!==id)return;
      if(event.data.type==='progress'&&typeof event.data.value==='number')progress(Math.min(99,Math.max(0,Math.round(event.data.value))));
      if(event.data.type==='result')try{const bytes=new Uint8Array(event.data.bytes);inspectArTarget(bytes);progress(100);finish(undefined,bytes);}catch{finish(new Error('圖案細節不足或辨識檔不完整，請換一張圖片再試。'));}
      if(event.data.type==='error')finish(new Error('圖案編譯未完成，請重試或換一張圖片。'));
    };
    const timer=window.setTimeout(()=>finish(new Error('這次編譯等候過久，請重試或換一張較小的圖案。')),120000);
    window.addEventListener('message',message);signal.addEventListener('abort',aborted,{once:true});
    frame.onload=()=>{if(!done)frame.contentWindow?.postMessage({id,blob,sdk:AR_SDK_URL},window.location.origin);};
    // Static trusted script. No project/title/image bytes are interpolated into HTML.
    frame.srcdoc='<!doctype html><html><head><meta charset="utf-8"><title>AR 圖案處理</title></head><body><script type="module" src="/assets/ar-compiler-6af7cac3.js"></script></body></html>';document.body.append(frame);if(signal.aborted)aborted();
  });
}
