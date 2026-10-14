import {useEffect,useRef,useState} from 'react';
import type {ArBinding} from '../../../../../packages/asset-storage/ar-target';
import {prepareArImage} from './image';
export function ArContentEditor({disabled,onBinding}:{disabled:boolean;onBinding:(binding:ArBinding|undefined)=>void}){
  const [mode,setMode]=useState<'text'|'effect'|'image'|'video'>('text'),[text,setText]=useState(''),[effect,setEffect]=useState<'sparkle'|'halo'|'confetti'>('sparkle'),[media,setMedia]=useState<{bytes:Uint8Array;mime:string;url:string;name:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),control=useRef<AbortController|null>(null),mediaRef=useRef(media);
  const previewVideo=useRef<HTMLVideoElement>(null);
  useEffect(()=>{if(disabled)previewVideo.current?.pause();},[disabled]);
  useEffect(()=>()=>{generation.current++;control.current?.abort();if(mediaRef.current)URL.revokeObjectURL(mediaRef.current.url);},[]);
  useEffect(()=>{
    onBinding(mode==='text'?text.trim()?{version:1,kind:'text',text}:undefined:mode==='effect'?{version:1,kind:'effect',text,effect}:media?{version:1,kind:mode,text,mime:media.mime,media:media.bytes}:undefined);
  },[mode,text,effect,media,onBinding]);
  async function choose(file?:File){
    if(!file)return;control.current?.abort();const abort=new AbortController();control.current=abort;const serial=++generation.current;setBusy(true);setError('');onBinding(undefined);
    try{
      let blob:Blob=file;
      if(mode==='video'){
        if(!['video/mp4','video/webm'].includes(file.type)||file.size>16*1024*1024||!file.size)throw new Error('影片請使用 16 MB 以下的 MP4 或 WebM。');
      }else{
        const prepared=await prepareArImage(file,abort.signal),image=new Image();image.src=prepared.previewUrl;
        try{await image.decode();const canvas=document.createElement('canvas');canvas.width=prepared.width;canvas.height=prepared.height;canvas.getContext('2d')!.drawImage(image,0,0);blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('圖片處理未完成。')),'image/jpeg',.85));}
        finally{URL.revokeObjectURL(prepared.previewUrl);}
      }
      const bytes=new Uint8Array(await blob.arrayBuffer());if(serial!==generation.current||abort.signal.aborted)return;
      const next={bytes,mime:blob.type,url:URL.createObjectURL(blob),name:file.name};if(mediaRef.current)URL.revokeObjectURL(mediaRef.current.url);mediaRef.current=next;setMedia(next);
    }catch(error){if(serial===generation.current&&!abort.signal.aborted)setError(error instanceof Error?error.message:'媒體未完成，請重試。');}
    finally{if(serial===generation.current)setBusy(false);}
  }
  return <section className="ar-content-editor" aria-label="編輯圖案內容"><div className="ar-content-types" role="group" aria-label="顯示內容類型">{([['text','文字'],['effect','特效'],['image','圖片'],['video','影片']] as const).map(([id,label])=><button type="button" key={id} disabled={disabled||busy} aria-pressed={mode===id} onClick={()=>{generation.current++;control.current?.abort();if(mediaRef.current)URL.revokeObjectURL(mediaRef.current.url);mediaRef.current=null;setMedia(null);setMode(id);setError('');}}>{label}</button>)}</div>
    <label>{mode==='text'?'要顯示的文字':'介紹文字（選填）'}<textarea maxLength={500} value={text} disabled={disabled||busy} rows={3} placeholder="讓掃到圖案的人，看見你想說的話。" onChange={event=>setText(event.target.value)}/></label>
    {mode==='effect'&&<label>選擇特效<select value={effect} disabled={disabled} onChange={event=>setEffect(event.target.value as typeof effect)}><option value="sparkle">星光閃爍</option><option value="halo">光環</option><option value="confetti">彩色紙花</option></select></label>}
    {(mode==='image'||mode==='video')&&<><label>綁定{mode==='image'?'圖片':'影片'}<input type="file" disabled={disabled||busy} accept={mode==='image'?'image/jpeg,image/png,image/webp':'video/mp4,video/webm'} onChange={event=>{void choose(event.target.files?.[0]);event.target.value='';}}/></label><p className="field-hint">{mode==='image'?'圖片會在裝置上縮小，發布時再去除 metadata。':'16 MB 以下。掃到後可按「播放影片」，帶聲音播放由你選擇。'}內容與圖案一起儲存，不需要外部影片網址。</p></>}
    {media&&<div className="ar-media-preview">{mode==='image'?<img src={media.url} alt="綁定圖片預覽"/>:<video ref={previewVideo} src={media.url} controls playsInline preload="metadata"/>}<p>{media.name} · {(media.bytes.length/1024/1024).toFixed(1)} MB</p></div>}
    {busy&&<p role="status">正在準備媒體…</p>}{error&&<p className="banner banner-error" role="alert">{error}</p>}
  </section>;
}
