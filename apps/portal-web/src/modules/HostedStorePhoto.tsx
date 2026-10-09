import {useEffect,useId,useRef,useState} from 'react';
import type {ProductView} from '../../../../contracts/guild-launchpad/v1/storefront';
import type {ProductMediaView} from '../../../../contracts/guild-launchpad/v1/hosted-store-media';
import {ApiError,type PortalClient} from '../api';
import {sendProductPhoto,productPhotoFileError} from './hosted-store-photo-client';
import {retainedPhotoFailure,reviewPhotoAttempt,type PhotoAttempt} from './hosted-store-photo-state';

export function HostedStorePhoto({client,tenantId,instanceId,product,media,writable,uploadsEnabled,locked,onState,onSaved}:{
  client:PortalClient;tenantId:string;instanceId:string;product:ProductView;media?:ProductMediaView;writable:boolean;uploadsEnabled:boolean;locked:boolean;
  onState:(dirty:boolean,blocking:boolean)=>void;onSaved:()=>Promise<void>;
}){
  const [file,setFile]=useState<File|null>(null),[attempt,setAttempt]=useState<PhotoAttempt|null>(null);
  const [phase,setPhase]=useState<'idle'|'sending'|'unknown'|'review'|'rejected'>('idle');
  const [message,setMessage]=useState(''),[failedPath,setFailedPath]=useState('');
  const id=useId(),input=useRef<HTMLInputElement>(null),busy=useRef(false),held=useRef<PhotoAttempt|null>(null);
  const stateRef=useRef(onState);stateRef.current=onState;
  useEffect(()=>{stateRef.current(Boolean(file||attempt),phase==='sending'||phase==='unknown');},[file,attempt,phase]);
  useEffect(()=>()=>stateRef.current(false,false),[]);
  function clear(){setFile(null);setAttempt(null);held.current=null;setPhase('idle');if(input.current)input.current.value='';}
  async function send(value:PhotoAttempt){
    if(busy.current)return;busy.current=true;held.current=value;setAttempt(value);setPhase('sending');onState(true,true);setMessage('正在儲存商品照片…');
    try{
      const ack=await sendProductPhoto(client,value);clear();
      setMessage(ack.changed?'已儲存照片變更。重新發布後，公開頁才會更新。':'這項商品已經沒有草稿照片。');
      await onSaved();
    }catch(error){
      const unknown=!(error instanceof ApiError)||error.network||error.timedOut||error.accessExpired;
      const retained=retainedPhotoFailure(value,unknown);held.current=retained;setAttempt(retained);
      if(retained.hadUnknown){setPhase('unknown');setMessage('尚未確認原操作結果。照片與原操作仍保留，請重試確認後再離開。');}
      else if(error instanceof ApiError&&error.status===412){setPhase('review');setMessage('商品已更新，照片仍保留。請核對最新商品後，再明確確認套用。');await onSaved();}
      else {setPhase('rejected');setMessage(error instanceof ApiError?error.message:'照片操作未完成。');}
    }finally{busy.current=false;}
  }
  function fresh(action:'upload'|'remove'){
    if(locked||!writable||busy.current||held.current?.hadUnknown)return;
    if(action==='upload'&&(!file||!uploadsEnabled))return;
    void send(Object.freeze({tenantId,instanceId,productId:product.product_id,expected:product.version,key:crypto.randomUUID(),file:action==='upload'?file:null,action,hadUnknown:false}));
  }
  const photo=media?.photo,path=photo?.read_path;
  const blocked=locked||phase==='sending'||phase==='unknown';
  return <div className="hosted-store-photo stack">
    {photo&&path!==failedPath?<img src={path} alt={product.title} width={photo.width} height={photo.height} onError={()=>setFailedPath(path??'')}/>:<p className="field-hint">{photo?'照片暫時無法讀取。':'尚未加入商品照片。'}</p>}
    {(writable||attempt?.hadUnknown)&&<>
      {uploadsEnabled&&<label htmlFor={id}>商品照片<input ref={input} id={id} type="file" accept="image/png,image/jpeg,image/webp" disabled={blocked} aria-describedby={id+'-hint'} onChange={event=>{
        if(held.current?.hadUnknown)return;const selected=event.target.files?.[0]??null;const error=selected&&productPhotoFileError(selected);
        if(error){setMessage(error);event.target.value='';return;}setFile(selected);setAttempt(null);held.current=null;setPhase('idle');setMessage('');
      }}/></label>}
      {uploadsEnabled&&<p className="field-hint" id={id+'-hint'}>一張靜態照片，PNG、JPEG 或 WebP，最多 2 MiB。儲存後可預覽，公開頁需重新發布。</p>}
      {file&&<p className="field-hint">已選擇：{file.name}</p>}
      <div className="actions">
        {phase==='unknown'?<button type="button" className="btn btn-ghost" onClick={()=>attempt&&void send(attempt)}>重試原照片操作</button>
          :phase==='review'?<button type="button" className="btn btn-ghost" disabled={locked||!attempt||(attempt.action==='upload'&&!uploadsEnabled)} onClick={()=>attempt&&void send(reviewPhotoAttempt(attempt,product.version,crypto.randomUUID()))}>確認以最新商品套用照片變更</button>
          :<>{file&&uploadsEnabled&&<button type="button" className="btn btn-ghost" disabled={blocked} onClick={()=>fresh('upload')}>{photo?'儲存替換照片':'儲存照片'}</button>}
            {photo&&<button type="button" className="btn btn-ghost" disabled={blocked} onClick={()=>{if(window.confirm(`移除「${product.title}」的草稿照片？公開頁會保留到重新發布。`))fresh('remove');}}>移除照片</button>}</>}
        {(file||attempt)&&phase!=='unknown'&&phase!=='sending'&&<button type="button" className="btn btn-ghost" disabled={locked} onClick={()=>{clear();setMessage('');}}>取消照片變更</button>}
      </div>
    </>}
    {message&&<p role="status" className="field-hint">{message}</p>}
  </div>;
}
