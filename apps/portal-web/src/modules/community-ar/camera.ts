import {combineArTargets} from '../../../../../packages/asset-storage/ar-target';
import {loadArSdk,disposeArController,type ArController,type ArUpdate} from './sdk';

export function cameraIssue(error:unknown):string{
  const name=error instanceof Error?error.name:'';
  if(name==='NotAllowedError'||name==='SecurityError')return '相機權限尚未開啟。請在瀏覽器的網站設定允許相機，再按「重新開啟」。';
  if(name==='NotFoundError')return '找不到可用相機，可以換一台有相機的裝置。';
  if(name==='NotReadableError')return '相機可能正在被其他 App 使用。關閉它後，再試一次。';
  if(name==='OverconstrainedError')return '這台裝置無法使用目前的相機設定，請重新開啟。';
  if(error instanceof Error&&error.message==='ar_engine_unavailable')return '辨識工具暫時無法載入。請確認網路後重新開啟。';
  if(error instanceof Error&&error.message==='camera_timeout')return '相機啟動等候過久。請確認權限，再重新開啟。';
  if(error instanceof Error&&error.message==='camera_insecure')return '相機需要 HTTPS。請用 Safari 或 Chrome 開啟自由工坊網站。';
  return '相機或辨識未完成啟動，請重新開啟；原本的圖案仍保留。';
}
export class ArCamera{
  private generation=0;private stream?:MediaStream;private controller?:ArController;private video?:HTMLVideoElement;private processing?:Promise<void>;private cancelStartup?:()=>void;
  async start(video:HTMLVideoElement,packets:readonly Uint8Array[],update:(event:ArUpdate,projection:number[],dimensions:[number,number][])=>void){
    this.stop();const generation=this.generation;this.video=video;
    const alive=()=>this.generation===generation;
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('camera_insecure');
    const buffer=combineArTargets(packets);
    // Called synchronously by the Start button, before the first network await.
    const acquisition=navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:640},height:{ideal:480}}}).then(stream=>{
      if(!alive()){stream.getTracks().forEach(track=>track.stop());throw new DOMException('Aborted','AbortError');}this.stream=stream;return stream;
    });
    let timer:ReturnType<typeof setTimeout>|undefined;
    let cancel!:()=>void;const cancellation=new Promise<never>((_,reject)=>{cancel=()=>reject(new DOMException('Aborted','AbortError'));this.cancelStartup=cancel;});
    try{
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{if(alive()){reject(new Error('camera_timeout'));this.stop();}},20000);});
      const startup=async()=>{
      const [stream,sdk]=await Promise.all([acquisition,loadArSdk()]);
      if(!alive())throw new DOMException('Aborted','AbortError');
      video.muted=true;video.playsInline=true;video.srcObject=stream;
      await video.play();if(!alive())throw new DOMException('Aborted','AbortError');
      if(!video.videoWidth||!video.videoHeight)throw new Error('camera_dimensions');
      // MindAR reads the IDL dimensions, not only videoWidth or CSS bounds.
      video.width=video.videoWidth;video.height=video.videoHeight;
      let dimensions:[number,number][]=[];
      const controller=new sdk.Controller({inputWidth:video.width,inputHeight:video.height,maxTrack:1,warmupTolerance:3,missTolerance:8,
        onUpdate:event=>{if(alive()&&this.controller===controller)update(event,controller.getProjectionMatrix(),dimensions);}});
      this.controller=controller;
      dimensions=controller.addImageTargetsFromBuffer(buffer.slice().buffer).dimensions;
      await controller.dummyRun(video);if(!alive())throw new DOMException('Aborted','AbortError');
      const error=()=>{if(alive()){this.stop();update({type:'error',targetIndex:-1,worldMatrix:null},[],[]);}};
      controller.worker?.addEventListener('error',error,{once:true});
      this.processing=controller.processVideo(video);void this.processing.catch(error);
      };
      await Promise.race([startup(),timeout,cancellation]);
    }catch(error){if(alive())this.stop();throw error;}finally{clearTimeout(timer);if(this.cancelStartup===cancel)this.cancelStartup=undefined;}
  }
  async torch(enabled:boolean){
    const track=this.stream?.getVideoTracks()[0];if(!track)throw new Error('camera_stopped');
    const caps=track.getCapabilities() as MediaTrackCapabilities&{torch?:boolean};if(!caps.torch)return false;
    await track.applyConstraints({advanced:[{torch:enabled} as MediaTrackConstraintSet]});return true;
  }
  stop(){
    this.generation++;const cancel=this.cancelStartup;this.cancelStartup=undefined;cancel?.();
    const controller=this.controller,processing=this.processing;this.controller=undefined;this.processing=undefined;disposeArController(controller,processing);
    this.stream?.getTracks().forEach(track=>track.stop());this.stream=undefined;
    if(this.video){this.video.pause();this.video.srcObject=null;}this.video=undefined;
  }
}
