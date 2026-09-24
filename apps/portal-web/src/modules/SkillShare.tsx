import {useEffect,useId,useRef,useState} from 'react';
import './SkillDiscovery.css';

export type SkillShareContent={introductions:string[];illustration_url:string;illustration_alt:string};
type Payload={title:string;text?:string;url:string;copy:string};
type Loaded={bookId:string;content:SkillShareContent|null;error:string};

export function skillSharePath(bookId:string){return `/development/skills/${encodeURIComponent(bookId)}`;}
/** Public share URL; `intro` is the 1-based introduction number used by the public page. */
export function skillShareUrl(bookId:string,intro?:number,origin=window.location.origin){
  const url=new URL(skillSharePath(bookId),origin);if(intro)url.searchParams.set('intro',String(intro));return url.href;
}
const illustrationPath=/^\/brand\/skill-illustrations\/[a-z0-9-]+\.webp$/;
/** Loads authored share introductions and the landscape illustration for one book; throws on missing or invalid content. */
export async function fetchSkillShareContent(bookId:string,signal?:AbortSignal):Promise<SkillShareContent>{
  const response=await fetch(`/api/v1/skills/${encodeURIComponent(bookId)}/share-content`,{credentials:'omit',signal,headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error(response.status===404?'share_content_missing':'share_content_unavailable');
  const data=await response.json() as Partial<SkillShareContent>|null;
  const introductions=Array.isArray(data?.introductions)?data.introductions:[];
  if(!introductions.length||!introductions.every(value=>typeof value==='string'&&value.trim().length>0))throw new Error('share_content_empty');
  const illustration=typeof data?.illustration_url==='string'&&illustrationPath.test(data.illustration_url)?data.illustration_url:'';
  return {introductions,illustration_url:illustration,illustration_alt:illustration&&typeof data?.illustration_alt==='string'?data.illustration_alt:''};
}
/** Uniform index from crypto randomness (rejection sampling); never repeats `avoid` when another choice exists. */
export function randomIntroductionIndex(length:number,avoid?:number){
  if(length<=1)return 0;
  const skip=avoid!==undefined&&Number.isInteger(avoid)&&avoid>=0&&avoid<length,choices=skip?length-1:length;
  const limit=Math.floor(0x100000000/choices)*choices,buffer=new Uint32Array(1);
  let value:number;do{crypto.getRandomValues(buffer);value=buffer[0];}while(value>=limit);
  const index=value%choices;return skip&&index>=avoid!?index+1:index;
}

export function SkillShare({bookId,title}:{bookId?:string;title:string}){
  const [loading,setLoading]=useState(false),[loaded,setLoaded]=useState<Loaded|null>(null),[index,setIndex]=useState(0);
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[manual,setManual]=useState(false);
  const id=useId(),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),manualField=useRef<HTMLTextAreaElement>(null);
  // Every reroll, close, book change or unmount bumps the generation so late async results are ignored.
  const generation=useRef(0),request=useRef<AbortController|null>(null);
  useEffect(()=>{
    generation.current++;request.current?.abort();request.current=null;
    setLoaded(null);setLoading(false);setOpen(false);setBusy(false);setStatus('');setManual(false);
    return()=>{generation.current++;request.current?.abort();request.current=null;};
  },[bookId]);
  useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();else if(!open&&dialog.current?.open)dialog.current.close();},[open]);
  useEffect(()=>{if(manual&&open){manualField.current?.focus();manualField.current?.select();}},[manual,open]);
  if(!bookId)return null;
  const current=loaded?.bookId===bookId?loaded:null,introductions=current?.content?.introductions??[];
  const introduction=introductions[index]??'',url=skillShareUrl(bookId,introduction?index+1:undefined);
  const payload:Payload=introduction?{title:`${title} · 自由工坊`,text:introduction,url,copy:`${introduction}\n${url}`}:{title:`${title} · 自由工坊`,url,copy:url};
  function resetStatus(){generation.current++;setStatus('');setManual(false);setBusy(false);}
  async function load(show:boolean){
    const target=bookId!,controller=new AbortController(),run=++generation.current;
    request.current?.abort();request.current=controller;setLoading(true);setStatus('');setManual(false);
    let next:Loaded;
    try{const content=await fetchSkillShareContent(target,controller.signal);next={bookId:target,content,error:''};}
    catch(error){
      if(controller.signal.aborted)return;
      next={bookId:target,content:null,error:error instanceof Error&&error.message==='share_content_missing'?'這本技能書還沒有分享介紹，可以先分享連結。':'分享介紹暫時無法載入，可以重試或先分享連結。'};
    }
    if(run!==generation.current||controller.signal.aborted)return;
    request.current=null;setLoaded(next);setIndex(next.content?randomIntroductionIndex(next.content.introductions.length):0);setLoading(false);
    if(show)setOpen(true);
  }
  function close(){resetStatus();request.current?.abort();request.current=null;setLoading(false);dialog.current?.close();setOpen(false);trigger.current?.focus();}
  function reroll(){resetStatus();setIndex(value=>randomIntroductionIndex(introductions.length,value));}
  function fallback(message:string){setManual(true);setStatus(message);}
  async function copy(value:Payload,run:number){
    if(!navigator.clipboard?.writeText){fallback('無法自動複製，請選取並複製下方內容');return;}
    try{await navigator.clipboard.writeText(value.copy);if(run===generation.current)setStatus(value.text?'已複製介紹與連結':'已複製技能連結');}
    catch{if(run===generation.current)fallback('無法自動複製，請選取並複製下方內容');}
  }
  async function send(){
    const value=payload;resetStatus();const run=generation.current;setBusy(true);
    try{
      if(typeof navigator.share==='function'){
        // Called directly inside the click so browsers keep the user activation.
        try{await navigator.share(value.text?{title:value.title,text:value.text,url:value.url}:{title:value.title,url:value.url});if(run===generation.current)setStatus('分享已送出');}
        catch(error){if(run!==generation.current||(error as {name?:string}|null)?.name==='AbortError')return;fallback('系統分享沒有完成，請選取並複製下方內容');}
        return;
      }
      await copy(value,run);
    }finally{if(run===generation.current)setBusy(false);}
  }
  async function copyOnly(){const value=payload;resetStatus();const run=generation.current;setBusy(true);try{await copy(value,run);}finally{if(run===generation.current)setBusy(false);}}
  return <div className="skill-share">
    <button ref={trigger} type="button" className="btn btn-ghost" disabled={loading&&!open} aria-haspopup="dialog" onClick={()=>void load(true)}>{loading&&!open?'正在準備分享…':'分享技能'}</button>
    <dialog ref={dialog} className="skill-share-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`} data-book-id={bookId} onCancel={event=>{event.stopPropagation();event.preventDefault();close();}} onClose={event=>{event.stopPropagation();setOpen(false);}}>
      {open&&current&&<div className="skill-share-preview">
        <header className="skill-share-head"><h2 id={`${id}-title`}>分享「{title}」</h2><button type="button" className="btn btn-ghost" onClick={close} aria-label="關閉分享預覽">關閉</button></header>
        {current.content?<>
          <p className="skill-share-count">介紹 {index+1}／{introductions.length}</p>
          <blockquote className="skill-share-text" id={`${id}-text`} aria-live="polite">{introduction}</blockquote>
        </>:<div className="skill-share-error" id={`${id}-text`} role="alert"><p>{current.error}</p><button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>void load(false)}>{loading?'重新載入中…':'重試'}</button></div>}
        <p className="skill-share-url">{url}</p>
        <div className="skill-share-actions">
          {introductions.length>1&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={reroll}><span aria-hidden="true">🎲 </span>換一句</button>}
          <button type="button" className="btn btn-primary" disabled={busy||loading} onClick={()=>void send()}>{current.content?'分享':'分享連結'}</button>
          <button type="button" className="btn btn-ghost" disabled={busy||loading} onClick={()=>void copyOnly()}>{current.content?'複製介紹與連結':'複製連結'}</button>
        </div>
        {status&&<p className="skill-share-status" role="status">{status}</p>}
        {manual&&<div className="field"><label htmlFor={`${id}-manual`}>手動複製分享內容</label><textarea ref={manualField} id={`${id}-manual`} value={payload.copy} readOnly rows={4} onFocus={event=>event.currentTarget.select()}/></div>}
      </div>}
    </dialog>
  </div>;
}
