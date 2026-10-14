import {AR_SDK_URL} from './sdk-location';
export type ArUpdate={type:string;targetIndex:number;worldMatrix:number[]|null};
export interface ArController{
  addImageTargetsFromBuffer(buffer:ArrayBuffer):{dimensions:[number,number][]};
  getProjectionMatrix():number[];dummyRun(video:HTMLVideoElement):Promise<void>;
  processVideo(video:HTMLVideoElement):Promise<void>;stopProcessVideo():void;dispose():void;
  worker?:Worker;tracker?:{dispose?:()=>void};inputLoader?:{dispose?:()=>void};cropDetector?:{dispose?:()=>void};
  workerMatchDone?: (data:{targetIndex:number;modelViewTransform:null})=>void;
  workerTrackDone?: (data:{modelViewTransform:null})=>void;
}
export interface ArSdk{
  Controller:new(options:{inputWidth:number;inputHeight:number;maxTrack:number;warmupTolerance:number;missTolerance:number;onUpdate:(event:ArUpdate)=>void})=>ArController;
  Compiler:new()=>{compileImageTargets(images:CanvasImageSource[],progress:(percent:number)=>void):Promise<unknown>;exportData():Uint8Array};
}
let pending:Promise<ArSdk>|undefined;
export function loadArSdk():Promise<ArSdk>{
  pending??=import(/* @vite-ignore */ AR_SDK_URL).then(module=>module as ArSdk).catch(()=>{pending=undefined;throw new Error('ar_engine_unavailable');});
  return pending;
}
export function disposeArController(controller:ArController|undefined,settled?:Promise<unknown>){
  if(!controller)return;
  try{controller.stopProcessVideo();controller.dispose();}catch{/* stale frame must not keep the camera */}
  // Upstream stop does not settle an outstanding worker request. Drain its
  // closed callbacks so the in-flight frame can release its input tensor.
  controller.workerMatchDone?.({targetIndex:-1,modelViewTransform:null});
  controller.workerTrackDone?.({modelViewTransform:null});controller.worker?.terminate();
  const retire=()=>{
    const tracker=controller.tracker as {featurePointsListT?:{dispose:()=>void}[];imagePixelsListT?:{dispose:()=>void}[];imagePropertiesListT?:{dispose:()=>void}[]}|undefined;
    for(const list of [tracker?.featurePointsListT,tracker?.imagePixelsListT,tracker?.imagePropertiesListT])for(const tensor of list??[])try{tensor.dispose();}catch{/* independently owned tensors */}
    for(const object of [controller.tracker,controller.inputLoader,controller.cropDetector])try{object?.dispose?.();}catch{/* independent resources */}
  };
  if(settled)void settled.catch(()=>{}).finally(retire);else retire();
}
