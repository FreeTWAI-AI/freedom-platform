import {useId,useState} from 'react';
import './SkillDiscovery.css';

export function skillSharePath(bookId:string){return `/development/skills/${encodeURIComponent(bookId)}`;}
export function SkillShare({bookId,title}:{bookId?:string;title:string}){
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(''),[manual,setManual]=useState(false),id=useId();
  if(!bookId)return null;
  const url=new URL(skillSharePath(bookId),window.location.origin).href;
  async function share(){
    setBusy(true);setStatus('');setManual(false);
    try{
      if(typeof navigator.share==='function'){
        try{await navigator.share({title:`${title} · 自由工坊`,url});setStatus('分享已送出');return;}
        catch(error){if(error instanceof Error&&error.name==='AbortError'){setStatus('');return;}}
      }
      if(!navigator.clipboard?.writeText)throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(url);setStatus('已複製技能連結');
    }catch{setManual(true);setStatus('請選取並複製下方連結');}
    finally{setBusy(false);}
  }
  return <div className="skill-share"><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void share()}>{busy?'正在分享…':'分享技能'}</button>{status&&<p className="skill-share-status" aria-live="polite">{status}</p>}{manual&&<label className="field" htmlFor={id}>技能分享連結<input id={id} value={url} readOnly onFocus={event=>event.currentTarget.select()}/></label>}</div>;
}
