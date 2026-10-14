import {useEffect,useRef,useState} from 'react';
import {AR_EXPERIENCE_MAX_BYTES,AR_SCENE_MAX_TARGETS,inspectArExperience} from '../../../../../packages/asset-storage/ar-target';
import {ArCamera,cameraIssue} from './camera';
import {cardTexture,drawArCard,drawArEffect,projectTarget,captureArPhoto,type ArContent} from './render';
import {ArPhotoShare} from './share';
import type {PortalClient} from '../../api';

export type ScanEntry={title:string;url:string};
export type LocalScan={bytes:Uint8Array;content:ArContent};
async function pattern(url:string,signal:AbortSignal){
  if(!/^\/api\/v1\/public\/ar\/[A-Za-z0-9_-]{43}\/pattern$/.test(url))throw new Error('ar_invalid_url');
  const response=await fetch(url,{signal,credentials:'omit',cache:'no-store'});if(!response.ok)throw new Error('ar_pattern_unavailable');
  const reader=response.body?.getReader();if(!reader)throw new Error('ar_pattern_unavailable');const bytes=new Uint8Array(AR_EXPERIENCE_MAX_BYTES);let count=0;
  try{for(;;){const next=await reader.read();if(next.done)break;if(next.value.length>bytes.length-count)throw new Error('ar_pattern_unavailable');bytes.set(next.value,count);count+=next.value.length;}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const result=bytes.slice(0,count);inspectArExperience(result);return result;
}
export function ArScanner({entries,local,client,onClose}:{entries:readonly ScanEntry[];local?:LocalScan;client:PortalClient;onClose?:()=>void}){
  const video=useRef<HTMLVideoElement>(null),overlay=useRef<HTMLCanvasElement>(null),camera=useRef(new ArCamera()),run=useRef(0),abort=useRef<AbortController|null>(null),mounted=useRef(false),owner=useRef(client.sessionGeneration),refreshing=useRef(new Set<number>());
  const [phase,setPhase]=useState<'loading'|'idle'|'starting'|'scanning'|'paused'|'error'>('loading'),[message,setMessage]=useState(''),[found,setFound]=useState<ArContent|null>(null),[photo,setPhoto]=useState<File|null>(null),[photoText,setPhotoText]=useState(''),[torch,setTorch]=useState(false),[capturing,setCapturing]=useState(false);
  const preparedPackets=useRef<Uint8Array[]>([]),mediaUrls=useRef<string[]>([]),[reload,setReload]=useState(0),[sound,setSound]=useState(false);
  const data=useRef<{item:ArContent;texture:HTMLCanvasElement;media?:HTMLImageElement|HTMLVideoElement;until:number}[]>([]),frameAt=useRef(0),lastIndex=useRef(-1);
  const live=(id:number)=>mounted.current&&run.current===id&&client.sessionGeneration===owner.current;
  function clearOverlay(){for(const entry of data.current)if(entry.media instanceof HTMLVideoElement)entry.media.pause();const c=overlay.current?.getContext('2d');if(c)c.clearRect(0,0,c.canvas.width,c.canvas.height);frameAt.current=0;lastIndex.current=-1;setFound(null);}
  function stop(next:'paused'|'idle'='paused'){run.current++;abort.current?.abort();abort.current=null;camera.current.stop();for(const entry of data.current)if(entry.media instanceof HTMLVideoElement)entry.media.pause();refreshing.current.clear();clearOverlay();setTorch(false);setPhase(next);if(next==='paused')setMessage('相機已暫停。可以分享照片，或繼續掃描。');}
  useEffect(()=>{mounted.current=true;const hide=()=>{if(document.visibilityState==='hidden')stop();},pagehide=()=>stop();document.addEventListener('visibilitychange',hide);window.addEventListener('pagehide',pagehide);
    return()=>{mounted.current=false;run.current++;abort.current?.abort();camera.current.stop();document.removeEventListener('visibilitychange',hide);window.removeEventListener('pagehide',pagehide);};},[]);
  useEffect(()=>{const interval=setInterval(()=>{if(lastIndex.current>=0&&(performance.now()-frameAt.current>700||data.current[lastIndex.current]?.until<performance.now()))clearOverlay();if(client.sessionGeneration!==owner.current)stop('idle');},250);return()=>clearInterval(interval);},[client]);
  async function currentContent(entry:ScanEntry,signal:AbortSignal):Promise<ArContent>{
    if(!/^\/api\/v1\/public\/ar\/[A-Za-z0-9_-]{43}$/.test(entry.url))throw new Error('ar_invalid_url');
    return client.get<ArContent>(entry.url.slice('/api/v1'.length),{signal,skipAuthHandler:true,background:true});
  }
  const entryKey=entries.map(entry=>entry.url).join('|');
  useEffect(()=>{
    stop('idle');const id=run.current,control=new AbortController();abort.current=control;setPhase('loading');setMessage('正在載入這次要掃描的圖案…');preparedPackets.current=[];
    for(const url of mediaUrls.current)URL.revokeObjectURL(url);mediaUrls.current=[];data.current=[];
    void (async()=>{
      try{
        const contents:ArContent[]=[];const packets:Uint8Array[]=[];
        if(local){packets.push(local.bytes);contents.push(local.content);}else{
          if(!entries.length||entries.length>AR_SCENE_MAX_TARGETS)throw new Error('ar_scene_empty');
          let total=0;
          for(const entry of entries){const item=await currentContent(entry,control.signal),bytes=await pattern(item.pattern_url,control.signal);total+=bytes.length;if(total>32*1024*1024)throw new Error('ar_scene_size');packets.push(bytes);contents.push(item);if(!live(id))return;}
        }
        const cache=[];
        for(let i=0;i<packets.length;i++){
          const experience=inspectArExperience(packets[i]);let media:HTMLImageElement|HTMLVideoElement|undefined;
          if(experience.binding?.kind==='image'||experience.binding?.kind==='video'){
            const b=experience.binding,url=URL.createObjectURL(new Blob([new Uint8Array(b.media)],{type:b.mime}));mediaUrls.current.push(url);
            if(b.kind==='image'){const img=new Image();img.src=url;await img.decode();media=img;}
            else{const v=document.createElement('video');v.src=url;v.muted=true;v.playsInline=true;v.loop=true;v.preload='metadata';media=v;}
          }
          if(!live(id))return;cache.push({item:contents[i],texture:cardTexture(contents[i]),media,until:local?Infinity:performance.now()+15000});
        }
        if(!live(id))return;preparedPackets.current=packets;data.current=cache;setPhase('idle');setMessage('圖案準備好了，開啟相機開始掃描。');
      }catch(error){if(!live(id)||control.signal.aborted)return;setPhase('error');setMessage(error instanceof Error&&error.message==='ar_scene_empty'?'還沒有可掃描的圖案，請先製作或選擇圖案。':error instanceof Error&&error.message==='ar_scene_size'?'這組媒體超過 32 MB，請返回並選一個圖案掃描。':'圖案或公開內容無法載入，請重試；也可以請分享者確認是否已撤下。');}
    })();
    return()=>{control.abort();for(const entry of data.current)if(entry.media instanceof HTMLVideoElement){entry.media.pause();entry.media.removeAttribute('src');entry.media.load();}for(const url of mediaUrls.current)URL.revokeObjectURL(url);mediaUrls.current=[];};
  },[entryKey,local,reload]);
  async function start(){
    if(phase==='starting'||!preparedPackets.current.length)return;camera.current.stop();const id=run.current,control=new AbortController();abort.current=control;setPhase('starting');setMessage('正在開啟相機…');setPhoto(null);setSound(false);
    try{
      await camera.current.start(video.current!,preparedPackets.current,(event,projection,dimensions)=>{
        if(!live(id))return;if(event.type==='error'){stop();setPhase('error');setMessage('辨識已停止，請重新開啟相機。');return;}if(event.type!=='updateMatrix')return;
        const c=overlay.current?.getContext('2d'),v=video.current;if(!c||!v)return;
        if(c.canvas.width!==v.videoWidth||c.canvas.height!==v.videoHeight){c.canvas.width=v.videoWidth;c.canvas.height=v.videoHeight;}
        c.clearRect(0,0,c.canvas.width,c.canvas.height);
        if(!event.worldMatrix||!dimensions[event.targetIndex]){clearOverlay();return;}
        const cached=data.current[event.targetIndex];if(!cached)return;
        if(cached.until<=performance.now()){
          clearOverlay();if(!local&&!refreshing.current.has(event.targetIndex)){
            refreshing.current.add(event.targetIndex);const index=event.targetIndex;
            void currentContent(entries[index],control.signal).then(item=>{if(live(id))data.current[index]={...data.current[index],item,texture:cardTexture(item),until:performance.now()+15000};}).catch(()=>{if(live(id)){setMessage('公開內容已關閉或暫時無法讀取，請重新選擇圖案。');}}).finally(()=>{if(live(id))refreshing.current.delete(index);});
          }return;
        }
        const quad=projectTarget(event.worldMatrix,projection,dimensions[event.targetIndex],c.canvas.width,c.canvas.height);if(!quad){clearOverlay();return;}
        const aspect=dimensions[event.targetIndex][0]/dimensions[event.targetIndex][1];
        if(cached.media instanceof HTMLImageElement)drawArCard(c,cached.media,quad,cached.media.naturalWidth,cached.media.naturalHeight,aspect);
        else if(cached.media instanceof HTMLVideoElement&&cached.media.readyState>=2)drawArCard(c,cached.media,quad,cached.media.videoWidth,cached.media.videoHeight,aspect);
        else drawArCard(c,cached.texture,quad,undefined,undefined,aspect);
        if(cached.item.binding?.kind==='effect')drawArEffect(c,quad,cached.item.binding.effect??'sparkle',window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:performance.now());
        frameAt.current=performance.now();if(lastIndex.current!==event.targetIndex){for(const entry of data.current)if(entry.media instanceof HTMLVideoElement)entry.media.pause();if(cached.media instanceof HTMLVideoElement)void cached.media.play().catch(()=>{if(live(id))setMessage('請按「播放影片」讓內容開始播放。');});lastIndex.current=event.targetIndex;setFound(cached.item);setMessage('已找到圖案。可以查看完整內容，或拍照留念。');}
      });
      if(live(id)){setPhase('scanning');setMessage('把完整圖案放入鏡頭，慢慢靠近，保持平整與光線。');}
    }catch(error){if(!live(id))return;camera.current.stop();setPhase('error');setMessage(error instanceof Error&&error.message==='ar_scene_empty'?'還沒有可掃描的圖案，請先製作或選擇圖案。':cameraIssue(error));}
  }
  async function capture(){if(capturing)return;const id=run.current;setCapturing(true);try{const file=await captureArPhoto(video.current!,overlay.current!);if(live(id)){setPhoto(file);setPhotoText(local?'我在自由工坊製作了一個 AR 圖案！':`一起用自由工坊 AR 探索圖案與夥伴！ ${window.location.origin}${found?.destination??window.location.pathname}`);}}catch(error){if(live(id))setMessage(error instanceof Error?error.message:'照片未完成，請重試。');}finally{if(mounted.current)setCapturing(false);}}
  const active=phase==='scanning';
  return <section className="ar-scanner" aria-label={local?'試掃圖案':'AR 相機'}>
    <header className="ar-row"><div><p className="eyebrow">FREEDOM AR</p><h2>{local?'先用相機試掃':'讓圖案，帶你認識夥伴'}</h2></div>{onClose&&<button className="btn btn-ghost" type="button" onClick={()=>{stop('idle');onClose();}}>返回</button>}</header>
    <div className={`ar-stage${active?' is-active':''}`}>
      <video ref={video} muted playsInline aria-label="相機即時畫面"/><canvas ref={overlay} aria-hidden="true"/>
      {!active&&<div className="ar-stage-intro"><span className="ar-scan-glyph" aria-hidden="true">⌗</span><strong>{phase==='starting'||phase==='loading'?'準備中…':phase==='paused'?'相機已暫停':'掃衣服圖案、海報或活動名片'}</strong><p>開啟相機後才開始辨識。畫面只在這台裝置處理。</p></div>}
      {active&&!found&&<div className="ar-reticle" aria-hidden="true"/>}
    </div>
    <p className={`ar-status${phase==='error'?' banner banner-error':''}`} role={phase==='error'?'alert':'status'} aria-live="polite">{message||'先選擇要掃的圖案，再開啟相機。'}</p>
    <div className="ar-actions">
      {!active&&<button className="btn btn-primary" type="button" disabled={phase==='starting'||phase==='loading'||!preparedPackets.current.length} onClick={()=>{void start();}}>{phase==='starting'?'準備相機…':phase==='error'?'重新開啟':phase==='paused'?'繼續掃描':'開啟相機'}</button>}
      {(phase==='starting'||phase==='loading')&&<button className="btn btn-ghost" type="button" onClick={()=>stop()}>取消</button>}
      {active&&<><button className="btn btn-primary" type="button" disabled={capturing} onClick={()=>{void capture();}}>{capturing?'正在產生照片…':'拍照'}</button><button className="btn btn-ghost" type="button" onClick={()=>stop()}>暫停相機</button><button className="btn btn-ghost" type="button" aria-pressed={torch} onClick={()=>{const id=run.current;void camera.current.torch(!torch).then(supported=>{if(live(id)){if(supported)setTorch(!torch);else setMessage('這台相機未提供補光燈，請移到光線充足的位置。');}}).catch(()=>{if(live(id))setMessage('補光燈未開啟，可以繼續掃描。');});}}>補光</button></>}
      {phase==='error'&&!preparedPackets.current.length&&<button className="btn btn-ghost" type="button" onClick={()=>setReload(value=>value+1)}>重新載入圖案</button>}
      {phase==='paused'&&!preparedPackets.current.length&&<button className="btn btn-ghost" type="button" onClick={()=>setReload(value=>value+1)}>載入圖案</button>}
      {found?.binding?.kind==='video'&&<button className="btn btn-ghost" type="button" aria-pressed={sound} onClick={()=>{const media=data.current[lastIndex.current]?.media;if(media instanceof HTMLVideoElement){media.muted=sound;setSound(!sound);void media.play().catch(()=>setMessage('影片未開始播放，可以重新掃描後重試。'));}}}>{sound?'關閉聲音':'播放影片／開啟聲音'}</button>}
      {found&&!local&&<a className="btn btn-ghost" href={found.destination} target="_blank" rel="noopener noreferrer" onClick={()=>stop()}>查看內容</a>}
    </div>
    {photo&&<ArPhotoShare file={photo} text={photoText} onClose={()=>setPhoto(null)}/>}
    <details className="ar-tips"><summary>掃不到、鏡頭打不開？</summary><ul><li>衣服拉平、圖案完整入鏡，避開反光和太暗的角落。</li><li>掃描的是已製作的特定圖案，印相同 Logo 不會自動辨識成不同的人。</li><li>LINE、IG 等 App 內的瀏覽器若無法開鏡頭，請用 Safari 或 Chrome 開啟這個頁面。</li></ul><p>AR 顯示分享者的公開內容，不代表身分、出席或合作信用驗證。</p></details>
  </section>;
}
